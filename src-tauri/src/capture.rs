use crate::domain::{self, Entity, Event, Field, Relation, Result, Snapshot};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

pub const TYPES: &[&str] = &[
    "Generic",
    "Account",
    "Email",
    "Phone / SIM",
    "Bank Account",
    "Payment Card",
    "Subscription",
    "Domain",
    "Server",
    "Service",
    "Project",
    "Repository",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capture {
    pub id: String,
    pub raw_text: String,
    pub input_type: String,
    pub timestamp: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposedEntity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_updated_at: Option<String>,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub status: String,
    pub attributes: BTreeMap<String, Value>,
    pub notes: String,
    pub evidence: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposedRelation {
    pub from: String,
    pub to: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub note: String,
    pub evidence: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposedEvent {
    pub entity_ref: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub due_at: String,
    pub precision: String,
    pub policy: String,
    pub note: String,
    pub evidence: String,
}
#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proposal {
    pub entities_to_create: Vec<ProposedEntity>,
    pub entities_to_update: Vec<ProposedEntity>,
    pub relations_to_create: Vec<ProposedRelation>,
    pub events_to_create: Vec<ProposedEvent>,
    pub uncertainty: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalRecord {
    pub id: String,
    pub capture_id: String,
    pub status: String,
    pub content: Proposal,
    pub provider: String,
    pub created_at: String,
    pub entity_ids: Vec<String>,
}

fn nonempty(value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.chars().count() > max {
        return Err("提案内容缺失或过长".into());
    }
    domain::reject_credential(value)
}
fn evidence(value: &str, input: &str) -> Result<()> {
    if value.trim().is_empty() || !input.contains(value) {
        return Err("提案缺少原文依据".into());
    }
    Ok(())
}
fn normalized(name: &str) -> String {
    name.trim().to_lowercase()
}
pub fn canonical_type(category: &str) -> &str {
    match category {
        "Identity" | "Website Account" | "AI Provider Account" => "Account",
        "SIM" => "Phone / SIM",
        value => value,
    }
}
fn type_template(kind: &str) -> &str {
    match kind {
        "Account" => "website-account",
        "Phone / SIM" => "sim",
        "Bank Account" => "bank-account",
        "Payment Card" => "payment-card",
        "Email" => "email",
        "Subscription" => "subscription",
        "Domain" => "domain",
        "Server" => "server",
        "Project" => "project",
        "Repository" => "repository",
        "Service" => "service",
        _ => "generic",
    }
}
pub fn event_date(value: &str, precision: &str) -> Result<()> {
    match precision {
        "unknown" if value.is_empty() => Ok(()),
        "year" if value.len() == 4 && value.bytes().all(|b| b.is_ascii_digit()) => {
            domain::date(&format!("{value}-01-01"))
        }
        "month" if value.len() == 7 => domain::date(&format!("{value}-01")),
        "day" if value.len() == 10 => domain::date(value),
        _ => Err("事件日期必须保留正确精度".into()),
    }
}

pub fn validate_records(snapshot: &Snapshot) -> Result<()> {
    if snapshot.captures.len() > 20000 || snapshot.proposals.len() > 20000 {
        return Err("捕获或提案数量超过限制".into());
    }
    let mut ids = HashSet::new();
    let mut capture_ids = HashSet::new();
    for capture in &snapshot.captures {
        nonempty(&capture.id, 200)?;
        nonempty(&capture.raw_text, 10000)?;
        domain::date(&capture.timestamp)?;
        if !ids.insert(&capture.id)
            || capture.input_type != "text"
            || !["PENDING", "CONFIRMED", "DISMISSED"].contains(&capture.status.as_str())
        {
            return Err("无效捕获记录".into());
        }
        capture_ids.insert(&capture.id);
    }
    for proposal in &snapshot.proposals {
        nonempty(&proposal.id, 200)?;
        nonempty(&proposal.provider, 200)?;
        domain::date(&proposal.created_at)?;
        if !ids.insert(&proposal.id)
            || !capture_ids.contains(&proposal.capture_id)
            || !["PENDING", "CONFIRMED", "DISMISSED"].contains(&proposal.status.as_str())
        {
            return Err("无效提案记录".into());
        }
        if serde_json::to_vec(&proposal.content)
            .map_err(|_| "提案格式无效")?
            .len()
            > 100000
        {
            return Err("提案内容过长".into());
        }
    }
    Ok(())
}

/** Pure transformation. Parsing/staging calls it for validation only; the confirm command owns the write. */
pub fn apply_proposal(
    current: &Snapshot,
    capture: &Capture,
    proposal: &Proposal,
) -> Result<(Snapshot, Vec<String>)> {
    if proposal.entities_to_create.len() > 20
        || proposal.entities_to_update.len() > 20
        || proposal.relations_to_create.len() > 50
        || proposal.events_to_create.len() > 30
        || proposal.uncertainty.len() > 30
    {
        return Err("提案过大，请拆分输入".into());
    }
    if proposal.entities_to_create.is_empty()
        && proposal.entities_to_update.is_empty()
        && proposal.relations_to_create.is_empty()
        && proposal.events_to_create.is_empty()
    {
        return Err("提案没有可保存的记忆".into());
    }
    let mut next = current.clone();
    let mut refs: HashMap<String, String> = current
        .entities
        .iter()
        .filter(|e| e.privacy != "SECRET")
        .map(|e| (e.id.clone(), e.id.clone()))
        .collect();
    let mut changed = HashSet::new();
    let mut names = HashSet::new();
    let timestamp = domain::now();
    for item in &proposal.entities_to_create {
        let reference = item.r#ref.as_ref().ok_or("新实体缺少 ref")?;
        nonempty(reference, 200)?;
        if item.id.is_some() || item.expected_updated_at.is_some() || refs.contains_key(reference) {
            return Err("新实体引用无效或重复".into());
        }
        let name_key = (normalized(&item.name), item.kind.clone());
        if !names.insert(name_key)
            || current.entities.iter().any(|e| {
                normalized(&e.name) == normalized(&item.name)
                    && canonical_type(&e.category) == item.kind
            })
        {
            return Err("同名同类实体已存在，请重新解析或修改名称".into());
        }
        let id = domain::id();
        refs.insert(reference.clone(), id.clone());
        changed.insert(id.clone());
        let mut entity = Entity {
            id,
            name: item.name.clone(),
            template_id: Some(type_template(&item.kind).into()),
            category: item.kind.clone(),
            status: item.status.clone(),
            privacy: "PRIVATE".into(),
            tags: vec![],
            fields: vec![],
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
        };
        patch_entity(&mut entity, item, capture)?;
        next.entities.push(entity);
    }
    let mut updated_ids = HashSet::new();
    for item in &proposal.entities_to_update {
        let id = item.id.as_ref().ok_or("更新缺少实体 ID")?;
        if item.r#ref.is_some() || !updated_ids.insert(id) {
            return Err("重复或无效实体更新".into());
        }
        let entity = next
            .entities
            .iter_mut()
            .find(|e| &e.id == id && e.privacy != "SECRET")
            .ok_or("更新实体不存在")?;
        if item.expected_updated_at.as_deref() != Some(&entity.updated_at) {
            return Err("记忆已变化，请重新解析后确认".into());
        }
        patch_entity(entity, item, capture)?;
        entity.updated_at = timestamp.clone();
        changed.insert(id.clone());
    }
    let mut edges = HashSet::new();
    for relation in &proposal.relations_to_create {
        evidence(&relation.evidence, &capture.raw_text)?;
        let source = refs.get(&relation.from).ok_or("关系起点不存在")?;
        let target = refs.get(&relation.to).ok_or("关系终点不存在")?;
        let key = (source.clone(), relation.kind.clone(), target.clone());
        if !edges.insert(key)
            || source == target
            || !domain::RELATIONS.contains(&relation.kind.as_str())
        {
            return Err("重复或无效关系".into());
        }
        if !next
            .relations
            .iter()
            .any(|r| &r.source_id == source && &r.target_id == target && r.kind == relation.kind)
        {
            next.relations.push(Relation {
                id: domain::id(),
                source_id: source.clone(),
                kind: relation.kind.clone(),
                target_id: target.clone(),
                note: Some(relation.note.clone()),
                privacy: "PRIVATE".into(),
                created_at: timestamp.clone(),
            });
        }
        changed.insert(source.clone());
        changed.insert(target.clone());
    }
    for event in &proposal.events_to_create {
        evidence(&event.evidence, &capture.raw_text)?;
        if !["EXPIRY", "RENEWAL", "REVIEW", "CANCELLATION", "REMINDER"]
            .contains(&event.kind.as_str())
        {
            return Err("未知提案事件类型".into());
        }
        event_date(&event.due_at, &event.precision)?;
        let entity_id = refs.get(&event.entity_ref).ok_or("事件实体不存在")?.clone();
        if !next.events.iter().any(|e| {
            e.entity_id == entity_id
                && e.kind == event.kind
                && e.due_at.as_deref().unwrap_or("") == event.due_at
                && e.policy.as_deref() == Some(&event.policy)
        }) {
            next.events.push(Event {
                id: domain::id(),
                entity_id: entity_id.clone(),
                kind: event.kind.clone(),
                due_at: if event.due_at.is_empty() {
                    None
                } else {
                    Some(event.due_at.clone())
                },
                due_precision: if event.precision == "unknown" {
                    None
                } else {
                    Some(event.precision.clone())
                },
                recurrence: None,
                policy: Some(event.policy.clone()),
                status: if event.precision == "unknown" {
                    "UNKNOWN"
                } else {
                    "UPCOMING"
                }
                .into(),
                note: Some(event.note.clone()),
            });
        }
        changed.insert(entity_id);
    }
    next.validate()?;
    let mut entity_ids: Vec<_> = changed.into_iter().collect();
    entity_ids.sort();
    Ok((next, entity_ids))
}

fn patch_entity(entity: &mut Entity, item: &ProposedEntity, capture: &Capture) -> Result<()> {
    evidence(&item.evidence, &capture.raw_text)?;
    nonempty(&item.name, 500)?;
    if !TYPES.contains(&item.kind.as_str())
        || item.attributes.len() > 50
        || item.notes.chars().count() > 5000
    {
        return Err("实体类型或属性无效".into());
    }
    entity.name = item.name.trim().into();
    // Preserve legacy categories/template IDs for matched records.
    if item.id.is_some() && canonical_type(&entity.category) != item.kind {
        return Err("更新不可静默改变实体类型，请修改提案或重新说明".into());
    }
    entity.status = item.status.clone();
    let mut attributes = item.attributes.clone();
    if !item.notes.is_empty() {
        let old_note = entity
            .fields
            .iter()
            .find(|f| f.key == "notes")
            .and_then(|f| f.value.as_str())
            .unwrap_or("");
        let note = if old_note.is_empty() || old_note.contains(&item.notes) {
            if old_note.is_empty() {
                item.notes.clone()
            } else {
                old_note.into()
            }
        } else {
            format!("{old_note}\n{}", item.notes)
        };
        attributes.insert("notes".into(), Value::String(note));
    }
    for (key, value) in attributes {
        if !(value.is_string()
            || value.is_number()
            || value.is_boolean()
            || value
                .as_array()
                .is_some_and(|items| items.len() <= 20 && items.iter().all(Value::is_string)))
        {
            return Err("属性必须是简单文本、数字、布尔或文本列表".into());
        }
        let value_type = if value.is_number() {
            "number"
        } else if value.is_boolean() {
            "boolean"
        } else if value.is_array() {
            "json"
        } else {
            "text"
        };
        if let Some(existing) = entity.fields.iter_mut().find(|f| f.key == key) {
            if existing.privacy == "SECRET" {
                return Err("AI 提案不可覆盖秘密字段".into());
            }
            existing.value = value;
            existing.value_type = value_type.into();
        } else {
            entity.fields.push(Field {
                id: domain::id(),
                entity_id: entity.id.clone(),
                key,
                value_type: value_type.into(),
                value,
                privacy: "PRIVATE".into(),
                searchable: true,
                source_of_truth: None,
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Capture {
        Capture {
            id: "c".into(),
            raw_text: "SuperGrok 已经付到 2026 年 12 月，以后不续。".into(),
            input_type: "text".into(),
            timestamp: domain::now(),
            status: "PENDING".into(),
        }
    }
    fn proposal() -> Proposal {
        serde_json::from_value(serde_json::json!({"entitiesToCreate":[{"ref":"grok","name":"SuperGrok","type":"Subscription","status":"ACTIVE","attributes":{},"notes":"","evidence":"SuperGrok"}],"entitiesToUpdate":[],"relationsToCreate":[],"eventsToCreate":[{"entityRef":"grok","type":"EXPIRY","dueAt":"2026-12","precision":"month","policy":"DO_NOT_RENEW","note":"以后不续","evidence":"2026 年 12 月，以后不续"}],"uncertainty":[]})).unwrap()
    }
    #[test]
    fn transformation_keeps_input_unchanged_and_month_precision() {
        let original = Snapshot::default();
        let (next, _) = apply_proposal(&original, &input(), &proposal()).unwrap();
        assert!(original.entities.is_empty());
        assert_eq!(next.events[0].due_at.as_deref(), Some("2026-12"));
        assert_eq!(next.events[0].due_precision.as_deref(), Some("month"));
    }
    #[test]
    fn malformed_relation_or_evidence_cannot_commit() {
        let mut p = proposal();
        p.relations_to_create.push(ProposedRelation {
            from: "grok".into(),
            to: "invented-card".into(),
            kind: "PAID_BY".into(),
            note: "".into(),
            evidence: "SuperGrok".into(),
        });
        assert!(apply_proposal(&Snapshot::default(), &input(), &p).is_err());
        let mut p = proposal();
        p.entities_to_create[0].evidence = "invented fact".into();
        assert!(apply_proposal(&Snapshot::default(), &input(), &p).is_err());
    }
    #[test]
    fn dates_are_not_invented_and_credentials_are_rejected() {
        assert!(event_date("2026-13", "month").is_err());
        assert!(event_date("2026-02-30", "day").is_err());
        let mut p = proposal();
        p.entities_to_create[0]
            .attributes
            .insert("password".into(), Value::String("unsafe".into()));
        assert!(apply_proposal(&Snapshot::default(), &input(), &p).is_err());
    }
}
