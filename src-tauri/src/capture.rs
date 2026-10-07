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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attributes_to_remove: Vec<String>,
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
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposedRemoval {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_updated_at: Option<String>,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entities_to_delete: Vec<ProposedRemoval>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relations_to_delete: Vec<ProposedRemoval>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events_to_delete: Vec<ProposedRemoval>,
}
#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeRecords {
    pub entities: Vec<Entity>,
    pub relations: Vec<Relation>,
    pub events: Vec<Event>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalUndo {
    pub applied_revision: u64,
    pub before: ChangeRecords,
    pub after: ChangeRecords,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undo: Option<ProposalUndo>,
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
            || !["text", "clipboard", "voice"].contains(&capture.input_type.as_str())
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
        if proposal.undo.as_ref().is_some_and(|undo| {
            serde_json::to_vec(undo).map_or(true, |bytes| bytes.len() > 512 * 1024)
        }) {
            return Err("变更过大，无法保留撤销记录，请拆分输入".into());
        }
    }
    Ok(())
}

fn clauses(text: &str) -> impl Iterator<Item = &str> {
    text.split(['，', ',', '。', '!', '！', '?', '？', ';', '；', '\n'])
}
fn has_delete_intent(text: &str) -> bool {
    clauses(text).any(|part| {
        let part = part.to_lowercase().replace('’', "'");
        let compact = part.split_whitespace().collect::<String>();
        [
            "删除", "删掉", "删去", "移除", "忘掉", "delete", "remove", "forget",
        ]
        .iter()
        .any(|word| part.contains(word))
            && ![
                "不要删",
                "别删",
                "不能删",
                "不想删",
                "不用删",
                "不要移除",
                "不要忘",
                "do not delete",
                "don't delete",
                "never delete",
                "do not remove",
                "don't remove",
                "never remove",
                "do not forget",
                "don't forget",
                "never forget",
            ]
            .iter()
            .any(|word| part.contains(word))
            && ![
                "不要", "别", "不能", "不想", "不用", "请勿", "勿", "不", "暂不", "先不",
            ]
            .iter()
            .any(|prefix| {
                ["删除", "删掉", "删去", "删", "移除", "忘掉", "忘"]
                    .iter()
                    .any(|verb| compact.contains(&format!("{prefix}{verb}")))
            })
    })
}
fn has_removal_intent(text: &str) -> bool {
    let text = text.to_lowercase();
    has_delete_intent(&text)
        || [
            "解绑",
            "解除",
            "去掉",
            "清空",
            "不再绑定",
            "不再关联",
            "unlink",
            "disconnect",
        ]
        .iter()
        .any(|word| text.contains(word))
        || (text.contains("取消") && text.contains("提醒"))
}
fn explicit_entity_deletion(raw: &str, entity: &Entity, current: &Snapshot) -> bool {
    let name = normalized(&entity.name);
    clauses(raw).any(|part| {
        let part = part.to_lowercase();
        if !has_delete_intent(&part) {
            return false;
        }
        let scoped = [
            "属性",
            "字段",
            "月费",
            "费用",
            "备注",
            "提醒",
            "关联",
            "关系",
            "绑定",
            "field",
            "attribute",
            "reminder",
            "event",
            "relation",
            "link",
        ]
        .iter()
        .any(|word| part.contains(word));
        let entire = [
            "整条",
            "整个",
            "连同",
            "及其",
            "和它的",
            "以及它的",
            "entire",
            "including",
        ]
        .iter()
        .any(|word| part.contains(word));
        if scoped && !entire {
            return false;
        }
        if part.contains(&name) {
            return current
                .entities
                .iter()
                .filter(|e| e.privacy != "SECRET" && normalized(&e.name) == name)
                .count()
                == 1;
        }
        name.split(|c: char| !c.is_alphanumeric())
            .filter(|token| token.chars().count() >= 3)
            .any(|token| {
                part.contains(token)
                    && current
                        .entities
                        .iter()
                        .filter(|e| e.privacy != "SECRET" && normalized(&e.name).contains(token))
                        .count()
                        == 1
            })
    })
}
fn removal_mentions(raw: &str, entity: &Entity) -> bool {
    let name = normalized(&entity.name);
    clauses(raw).any(|part| {
        let part = part.to_lowercase();
        has_removal_intent(&part)
            && (part.contains(&name)
                || name
                    .split(|c: char| !c.is_alphanumeric())
                    .filter(|token| token.chars().count() >= 3)
                    .any(|token| part.contains(token)))
    })
}
#[derive(Default)]
pub struct RemovalTargets {
    pub entities: HashSet<String>,
    pub relations: HashSet<String>,
    pub events: HashSet<String>,
}
fn validate_removals(
    current: &Snapshot,
    capture: &Capture,
    proposal: &Proposal,
) -> Result<RemovalTargets> {
    let mut targets = RemovalTargets::default();
    let visible = |id: &str| {
        current
            .entities
            .iter()
            .any(|e| e.id == id && e.privacy != "SECRET")
    };
    for item in &proposal.entities_to_delete {
        evidence(&item.evidence, &capture.raw_text)?;
        nonempty(&item.id, 200)?;
        let entity = current
            .entities
            .iter()
            .find(|e| e.id == item.id && e.privacy != "SECRET")
            .ok_or("待删除记忆不存在或不可访问")?;
        if !explicit_entity_deletion(&capture.raw_text, entity, current) {
            return Err("停用不等于删除；请明确说出要删除的记忆名称".into());
        }
        if entity.updated_at.as_str()
            != item
                .expected_updated_at
                .as_deref()
                .ok_or("删除缺少版本信息，请重新解析")?
        {
            return Err("待删除记忆已变化，请重新解析".into());
        }
        if !targets.entities.insert(item.id.clone())
            || proposal
                .entities_to_update
                .iter()
                .any(|e| e.id.as_ref() == Some(&item.id))
        {
            return Err("重复删除，或同一记忆同时修改和删除".into());
        }
        if entity.fields.iter().any(|f| f.privacy == "SECRET") {
            return Err("这项记忆含秘密字段，请手动处理，或选择停用保留".into());
        }
    }
    if (!proposal.relations_to_delete.is_empty() || !proposal.events_to_delete.is_empty())
        && !has_removal_intent(&capture.raw_text)
    {
        return Err("解除关联或移除提醒需要原文依据".into());
    }
    for item in &proposal.relations_to_delete {
        evidence(&item.evidence, &capture.raw_text)?;
        let relation = current
            .relations
            .iter()
            .find(|r| {
                r.id == item.id
                    && r.privacy != "SECRET"
                    && visible(&r.source_id)
                    && visible(&r.target_id)
            })
            .ok_or("待删除关联不存在或不可访问")?;
        for id in [&relation.source_id, &relation.target_id] {
            if !removal_mentions(
                &capture.raw_text,
                current.entities.iter().find(|e| &e.id == id).unwrap(),
            ) {
                return Err("解除关联的对象不明确，请补充两端名称".into());
            }
        }
        if !targets.relations.insert(item.id.clone())
            || proposal.relations_to_create.iter().any(|r| {
                r.from == relation.source_id
                    && r.to == relation.target_id
                    && r.kind == relation.kind
            })
        {
            return Err("重复或互相冲突的关联操作".into());
        }
    }
    for item in &proposal.events_to_delete {
        evidence(&item.evidence, &capture.raw_text)?;
        let event = current
            .events
            .iter()
            .find(|e| e.id == item.id && visible(&e.entity_id))
            .ok_or("待删除事件不存在或不可访问")?;
        if !removal_mentions(
            &capture.raw_text,
            current
                .entities
                .iter()
                .find(|e| e.id == event.entity_id)
                .unwrap(),
        ) {
            return Err("待删除提醒的对象不明确，请补充名称".into());
        }
        if !targets.events.insert(item.id.clone())
            || proposal.events_to_create.iter().any(|e| {
                e.entity_ref == event.entity_id
                    && e.kind == event.kind
                    && e.due_at == event.due_at.as_deref().unwrap_or("")
                    && event.policy.as_deref() == Some(&e.policy)
            })
        {
            return Err("重复或互相冲突的事件操作".into());
        }
    }
    for relation in &current.relations {
        if targets.entities.contains(&relation.source_id)
            || targets.entities.contains(&relation.target_id)
        {
            if relation.privacy == "SECRET"
                || !visible(&relation.source_id)
                || !visible(&relation.target_id)
            {
                return Err("此删除涉及隐藏关联，请先手动处理，或选择停用保留".into());
            }
            targets.relations.insert(relation.id.clone());
        }
    }
    for event in &current.events {
        if targets.entities.contains(&event.entity_id) {
            targets.events.insert(event.id.clone());
        }
    }
    Ok(targets)
}

pub fn stage_versions(current: &Snapshot, proposal: &mut Proposal) -> Result<()> {
    for item in &mut proposal.entities_to_update {
        let entity = current
            .entities
            .iter()
            .find(|e| Some(&e.id) == item.id.as_ref() && e.privacy != "SECRET")
            .ok_or("待更新实体不存在")?;
        if item
            .expected_updated_at
            .as_ref()
            .is_some_and(|version| version != &entity.updated_at)
        {
            return Err("记忆已变化，请重新解析".into());
        }
        item.expected_updated_at = Some(entity.updated_at.clone());
    }
    for item in &mut proposal.entities_to_delete {
        let entity = current
            .entities
            .iter()
            .find(|e| e.id == item.id && e.privacy != "SECRET")
            .ok_or("待删除实体不存在")?;
        if item
            .expected_updated_at
            .as_ref()
            .is_some_and(|version| version != &entity.updated_at)
        {
            return Err("待删除记忆已变化，请重新解析".into());
        }
        item.expected_updated_at = Some(entity.updated_at.clone());
    }
    Ok(())
}
pub fn guard_staged(current: &Snapshot, record: &ProposalRecord, content: &Proposal) -> Result<()> {
    let destructive = !content.entities_to_delete.is_empty()
        || !content.relations_to_delete.is_empty()
        || !content.events_to_delete.is_empty()
        || content
            .entities_to_update
            .iter()
            .any(|e| !e.attributes_to_remove.is_empty());
    if destructive && record.base_revision != Some(current.revision) {
        return Err("记忆库已变化，请重新解析后确认删除".into());
    }
    for item in &content.entities_to_update {
        let staged = record
            .content
            .entities_to_update
            .iter()
            .find(|e| e.id == item.id)
            .ok_or("修改目标已变化，请重新解析")?;
        if item.expected_updated_at != staged.expected_updated_at {
            return Err("提案版本已变化，请重新解析".into());
        }
    }
    for (items, staged) in [
        (
            &content.entities_to_delete,
            &record.content.entities_to_delete,
        ),
        (
            &content.relations_to_delete,
            &record.content.relations_to_delete,
        ),
        (&content.events_to_delete, &record.content.events_to_delete),
    ] {
        for item in items {
            if !staged
                .iter()
                .any(|e| e.id == item.id && e.expected_updated_at == item.expected_updated_at)
            {
                return Err("删除目标或版本已变化，请重新解析".into());
            }
        }
    }
    Ok(())
}

fn changed_records<T: Serialize + Clone>(
    before: &[T],
    after: &[T],
    id: impl Fn(&T) -> &str,
) -> Result<(Vec<T>, Vec<T>)> {
    let serialized = |items: &[T]| -> Result<HashMap<String, Value>> {
        items
            .iter()
            .map(|item| {
                Ok((
                    id(item).into(),
                    serde_json::to_value(item).map_err(|_| "变更记录编码失败")?,
                ))
            })
            .collect()
    };
    let old = serialized(before)?;
    let new = serialized(after)?;
    Ok((
        before
            .iter()
            .filter(|item| old.get(id(item)) != new.get(id(item)))
            .cloned()
            .collect(),
        after
            .iter()
            .filter(|item| old.get(id(item)) != new.get(id(item)))
            .cloned()
            .collect(),
    ))
}
pub fn confirm(
    current: &Snapshot,
    proposal_id: &str,
    content: &Proposal,
) -> Result<(Snapshot, Vec<String>)> {
    let record = current
        .proposals
        .iter()
        .find(|p| p.id == proposal_id)
        .ok_or("提案不存在")?;
    if record.status == "CONFIRMED" {
        return Ok((current.clone(), vec![]));
    }
    if record.status != "PENDING" {
        return Err("提案已撤回".into());
    }
    guard_staged(current, record, content)?;
    let input = current
        .captures
        .iter()
        .find(|c| c.id == record.capture_id && c.status == "PENDING")
        .ok_or("原文已处理")?;
    let (mut next, ids) = apply_proposal(current, input, content)?;
    let (before_entities, after_entities) =
        changed_records(&current.entities, &next.entities, |e| &e.id)?;
    let (before_relations, after_relations) =
        changed_records(&current.relations, &next.relations, |r| &r.id)?;
    let (before_events, after_events) = changed_records(&current.events, &next.events, |e| &e.id)?;
    let undo = ProposalUndo {
        applied_revision: current.revision + 1,
        before: ChangeRecords {
            entities: before_entities,
            relations: before_relations,
            events: before_events,
        },
        after: ChangeRecords {
            entities: after_entities,
            relations: after_relations,
            events: after_events,
        },
    };
    for proposal in &mut next.proposals {
        proposal.undo = None;
    }
    let proposal = next
        .proposals
        .iter_mut()
        .find(|p| p.id == proposal_id)
        .unwrap();
    proposal.status = "CONFIRMED".into();
    proposal.content = content.clone();
    proposal.entity_ids = ids;
    proposal.undo = Some(undo);
    next.captures
        .iter_mut()
        .find(|c| c.id == record.capture_id)
        .unwrap()
        .status = "CONFIRMED".into();
    next.validate()?;
    Ok((
        next,
        content
            .entities_to_delete
            .iter()
            .map(|e| e.id.clone())
            .collect(),
    ))
}
pub fn undo(current: &Snapshot, proposal_id: &str) -> Result<(Snapshot, Vec<String>)> {
    let record = current
        .proposals
        .iter()
        .find(|p| p.id == proposal_id && p.status == "CONFIRMED")
        .ok_or("这次变更不能撤销")?;
    let undo = record.undo.as_ref().ok_or("这次变更不能撤销")?;
    if undo.applied_revision != current.revision {
        return Err("记忆库已有新的操作，不能覆盖后续变更；请用新提案修正".into());
    }
    let mut next = current.clone();
    let entity_ids: HashSet<_> = undo
        .before
        .entities
        .iter()
        .chain(&undo.after.entities)
        .map(|e| &e.id)
        .collect();
    let relation_ids: HashSet<_> = undo
        .before
        .relations
        .iter()
        .chain(&undo.after.relations)
        .map(|r| &r.id)
        .collect();
    let event_ids: HashSet<_> = undo
        .before
        .events
        .iter()
        .chain(&undo.after.events)
        .map(|e| &e.id)
        .collect();
    next.entities.retain(|e| !entity_ids.contains(&e.id));
    next.entities.extend(undo.before.entities.clone());
    next.relations.retain(|r| !relation_ids.contains(&r.id));
    next.relations.extend(undo.before.relations.clone());
    next.events.retain(|e| !event_ids.contains(&e.id));
    next.events.extend(undo.before.events.clone());
    let proposal = next
        .proposals
        .iter_mut()
        .find(|p| p.id == proposal_id)
        .unwrap();
    proposal.status = "PENDING".into();
    proposal.entity_ids.clear();
    proposal.undo = None;
    proposal.base_revision = Some(current.revision + 1);
    next.captures
        .iter_mut()
        .find(|c| c.id == record.capture_id)
        .ok_or("原文缺失")?
        .status = "PENDING".into();
    next.validate()?;
    let removed = undo
        .after
        .entities
        .iter()
        .filter(|e| !next.entities.iter().any(|old| old.id == e.id))
        .map(|e| e.id.clone())
        .collect();
    Ok((next, removed))
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
        || proposal.entities_to_delete.len() > 20
        || proposal.relations_to_delete.len() > 50
        || proposal.events_to_delete.len() > 30
    {
        return Err("提案过大，请拆分输入".into());
    }
    if proposal.entities_to_create.is_empty()
        && proposal.entities_to_update.is_empty()
        && proposal.relations_to_create.is_empty()
        && proposal.events_to_create.is_empty()
        && proposal.entities_to_delete.is_empty()
        && proposal.relations_to_delete.is_empty()
        && proposal.events_to_delete.is_empty()
    {
        return Err("提案没有可保存的记忆".into());
    }
    let mut next = current.clone();
    let removals = validate_removals(current, capture, proposal)?;
    next.entities.retain(|e| !removals.entities.contains(&e.id));
    next.relations
        .retain(|r| !removals.relations.contains(&r.id));
    next.events.retain(|e| !removals.events.contains(&e.id));
    let mut refs: HashMap<String, String> = current
        .entities
        .iter()
        .filter(|e| e.privacy != "SECRET" && !removals.entities.contains(&e.id))
        .map(|e| (e.id.clone(), e.id.clone()))
        .collect();
    let mut changed = removals.entities.clone();
    for relation in current
        .relations
        .iter()
        .filter(|r| removals.relations.contains(&r.id))
    {
        changed.insert(relation.source_id.clone());
        changed.insert(relation.target_id.clone());
    }
    for event in current
        .events
        .iter()
        .filter(|e| removals.events.contains(&e.id))
    {
        changed.insert(event.entity_id.clone());
    }
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
    // Preserve legacy categories/template IDs for matched records.
    if item.id.is_some() && canonical_type(&entity.category) != item.kind {
        return Err("更新不可静默改变实体类型，请修改提案或重新说明".into());
    }
    entity.status = item.status.clone();
    if item.attributes_to_remove.len() > 50 {
        return Err("待删除属性过多".into());
    }
    if !item.attributes_to_remove.is_empty() {
        if item.id.is_none() || !has_removal_intent(&capture.raw_text) {
            return Err("只有明确提出的已有属性才能删除".into());
        }
        if !removal_mentions(&capture.raw_text, entity) {
            return Err("待删除属性的对象不明确，请补充名称".into());
        }
        let mut keys = HashSet::new();
        for key in &item.attributes_to_remove {
            nonempty(key, 100)?;
            let field = entity
                .fields
                .iter()
                .find(|f| &f.key == key)
                .ok_or("待删除属性不存在")?;
            if field.privacy == "SECRET"
                || !keys.insert(key)
                || item.attributes.contains_key(key)
                || (key == "notes" && !item.notes.is_empty())
            {
                return Err("待删除属性重复、不可访问或与修改冲突".into());
            }
        }
        entity
            .fields
            .retain(|f| !item.attributes_to_remove.contains(&f.key));
    }
    entity.name = item.name.trim().into();
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
