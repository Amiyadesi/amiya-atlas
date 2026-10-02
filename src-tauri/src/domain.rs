use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;
pub const RELATIONS: &[&str] = &["REGISTERED_WITH", "AUTHENTICATES_WITH", "RECOVERS_WITH", "OWNS_ADDRESS", "MANAGES", "USES", "DEPENDS_ON", "HOSTS", "HOSTED_ON", "CONNECTED_VIA", "EXPOSED_AT", "SOURCE_IN", "DEPLOYED_ON", "PAID_BY", "BILLED_FOR", "ISSUED_BY", "STORED_IN", "RELATED_TO", "OWNS", "MANAGED_BY"];

fn private() -> String { "PRIVATE".into() }
fn active() -> String { "ACTIVE".into() }
pub fn now() -> String { Utc::now().to_rfc3339() }
pub fn id() -> String { Uuid::new_v4().to_string() }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Field {
    pub id: String,
    pub entity_id: String,
    pub key: String,
    pub value_type: String,
    pub value: Value,
    #[serde(default = "private")]
    pub privacy: String,
    #[serde(default)]
    pub searchable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_of_truth: Option<SourceOfTruth>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceOfTruth {
    pub kind: String,
    pub provider: Option<String>,
    pub reference: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entity {
    pub id: String,
    pub name: String,
    pub template_id: Option<String>,
    #[serde(default)]
    pub category: String,
    #[serde(default = "active")]
    pub status: String,
    #[serde(default = "private")]
    pub privacy: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub fields: Vec<Field>,
    #[serde(default = "now")]
    pub created_at: String,
    #[serde(default = "now")]
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Relation {
    pub id: String,
    pub source_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub target_id: String,
    pub note: Option<String>,
    #[serde(default = "private")]
    pub privacy: String,
    #[serde(default = "now")]
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    pub id: String,
    pub entity_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub due_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_precision: Option<String>,
    pub recurrence: Option<String>,
    pub policy: Option<String>,
    pub status: String,
    pub note: Option<String>,
}

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    #[serde(default)]
    pub revision: u64,
    pub entities: Vec<Entity>,
    pub relations: Vec<Relation>,
    pub events: Vec<Event>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub captures: Vec<crate::capture::Capture>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub proposals: Vec<crate::capture::ProposalRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_config: Option<crate::ai::AiConfig>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AtlasFile {
    pub format: String,
    pub version: u32,
    pub snapshot: Snapshot,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureRequest {
    pub title: String,
    pub url: String,
    pub favicon: Option<String>,
    pub identity_id: String,
}

impl Snapshot {
    pub fn validate(&self) -> Result<()> {
        if self.entities.len() > 20_000 || self.relations.len() > 100_000 || self.events.len() > 100_000 { return Err("清单超过 V0.1 容量限制".into()); }
        let mut ids = HashSet::new();
        let mut entities = HashSet::new();
        for e in &self.entities {
            unique_id(&mut ids, &e.id)?;
            entities.insert(e.id.as_str());
            check_text(&e.name, 500, false)?;
            check_text(&e.category, 100, true)?;
            if !["ACTIVE", "NEEDS_REVIEW", "PLANNED", "ARCHIVED", "INACTIVE"].contains(&e.status.as_str()) { return Err("无效资产状态".into()); }
            privacy(&e.privacy)?;
            timestamp(&e.created_at)?; timestamp(&e.updated_at)?;
            for tag in &e.tags { check_text(tag, 100, true)?; }
            for f in &e.fields {
                unique_id(&mut ids, &f.id)?;
                if f.entity_id != e.id { return Err("字段归属与实体不一致".into()); }
                check_text(&f.key, 100, false)?;
                privacy(&f.privacy)?;
                let key: String = f.key.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect();
                if ["password", "passwd", "pwd", "cvv", "cvc", "pin", "apikey", "apitoken", "accesstoken", "refreshtoken", "privatekey", "otpseed", "totpsecret", "pan", "cardnumber", "密码", "口令", "私钥"].contains(&key.as_str()) { return Err("凭据请保存在 Vaultwarden；Atlas 仅接受引用".into()); }
                let valid = match f.value_type.as_str() {
                    "text" => f.value.is_string(), "number" => f.value.is_number(), "boolean" => f.value.is_boolean(),
                    "date" => f.value.as_str().is_some_and(|s| s.is_empty() || date(s).is_ok()),
                    "url" => f.value.as_str().is_some_and(|s| s.is_empty() || valid_url(s).is_ok()), "json" => true, _ => false,
                };
                if !valid { return Err("字段类型与值不一致".into()); }
                let value = serde_json::to_string(&f.value).map_err(|_| "字段无法序列化")?;
                if value.len() > 100_000 { return Err("字段内容过长".into()); }
                reject_credential(&value)?;
                if let Some(s) = &f.source_of_truth {
                    if s.kind != "ATLAS" && s.kind != "EXTERNAL" { return Err("无效数据来源".into()); }
                    if let Some(p) = &s.provider { check_text(p, 200, true)?; }
                    if let Some(r) = &s.reference { check_text(r, 2000, true)?; if r.contains("://") { valid_url(r)?; } }
                }
            }
        }
        let mut edges = HashSet::new();
        for r in &self.relations {
            unique_id(&mut ids, &r.id)?;
            if !entities.contains(r.source_id.as_str()) || !entities.contains(r.target_id.as_str()) { return Err("关系引用了不存在的实体".into()); }
            if r.source_id == r.target_id { return Err("不支持实体关联自身".into()); }
            if !RELATIONS.contains(&r.kind.as_str()) { return Err("未知关系类型".into()); }
            if !edges.insert((&r.source_id, &r.kind, &r.target_id)) { return Err("重复关系".into()); }
            privacy(&r.privacy)?; timestamp(&r.created_at)?;
            if let Some(note) = &r.note { check_text(note, 5000, true)?; }
        }
        for ev in &self.events {
            unique_id(&mut ids, &ev.id)?;
            if !entities.contains(ev.entity_id.as_str()) { return Err("事件引用了不存在的实体".into()); }
            if !["EXPIRY", "RENEWAL", "REVIEW", "PAYMENT_DUE", "CUSTOM", "CANCELLATION", "REMINDER"].contains(&ev.kind.as_str()) { return Err("未知事件类型".into()); }
            if !["UPCOMING", "DONE", "DISMISSED", "UNKNOWN"].contains(&ev.status.as_str()) { return Err("未知事件状态".into()); }
            if ev.status == "UPCOMING" && ev.due_at.is_none() { return Err("即将到期事件需要明确日期；未知日期请标记 UNKNOWN".into()); }
            if let Some(d) = &ev.due_at { if let Some(p) = &ev.due_precision { crate::capture::event_date(d, p)?; } else { date(d)?; } }
            if let Some(p) = &ev.policy { if !["AUTO_RENEW", "MANUAL", "DO_NOT_RENEW", "REVIEW"].contains(&p.as_str()) { return Err("未知续费策略".into()); } }
            if let Some(r) = &ev.recurrence { if !["monthly", "yearly"].contains(&r.as_str()) { return Err("首版仅支持 monthly/yearly 重复标记".into()); } }
            if let Some(note) = &ev.note { check_text(note, 5000, true)?; }
        }
        crate::capture::validate_records(self)?;
        if let Some(config) = &self.ai_config { config.validate()?; }
        Ok(())
    }

    pub fn delete_entity(&mut self, entity_id: &str, unlink: bool) -> Result<()> {
        if !self.entities.iter().any(|e| e.id == entity_id) { return Err("实体不存在".into()); }
        if !unlink && self.relations.iter().any(|r| r.source_id == entity_id || r.target_id == entity_id) { return Err("实体仍有关系，请明确确认解除关系后删除".into()); }
        self.entities.retain(|e| e.id != entity_id);
        self.events.retain(|e| e.entity_id != entity_id);
        self.relations.retain(|r| r.source_id != entity_id && r.target_id != entity_id);
        Ok(())
    }

    pub fn merge(&self, imported: &Snapshot) -> Result<Snapshot> {
        imported.validate()?;
        let mut out = self.clone();
        for e in &imported.entities {
            if let Some(existing) = out.entities.iter().find(|x| x.id == e.id) {
                if serde_json::to_value(existing).unwrap() != serde_json::to_value(e).unwrap() { return Err("导入 ID 与现有数据冲突；请先备份或导入空库".into()); }
            } else { out.entities.push(e.clone()); }
        }
        for r in &imported.relations {
            if let Some(existing) = out.relations.iter().find(|x| x.id == r.id) {
                if serde_json::to_value(existing).unwrap() != serde_json::to_value(r).unwrap() { return Err("导入关系 ID 冲突".into()); }
            } else if !out.relations.iter().any(|x| x.source_id == r.source_id && x.kind == r.kind && x.target_id == r.target_id) { out.relations.push(r.clone()); }
        }
        for ev in &imported.events {
            if let Some(existing) = out.events.iter().find(|x| x.id == ev.id) {
                if serde_json::to_value(existing).unwrap() != serde_json::to_value(ev).unwrap() { return Err("导入事件 ID 冲突".into()); }
            } else { out.events.push(ev.clone()); }
        }
        out.validate()?;
        Ok(out)
    }

    pub fn redacted(&self, mask_private: bool) -> Self {
        let mut out = self.clone();
        out.captures.clear(); out.proposals.clear(); out.ai_config = None;
        let secret_ids: HashSet<_> = out.entities.iter().filter(|e| e.privacy == "SECRET").map(|e| e.id.clone()).collect();
        out.entities.retain(|e| !secret_ids.contains(&e.id));
        for (i, e) in out.entities.iter_mut().enumerate() {
            if mask_private && e.privacy != "PUBLIC" { e.name = format!("Asset {}", i + 1); e.tags.clear(); }
            e.fields.retain(|f| f.privacy != "SECRET");
            for f in &mut e.fields {
                f.source_of_truth = None;
                if mask_private && f.privacy == "PRIVATE" { f.value = match f.value_type.as_str() { "number" => Value::from(0), "boolean" => Value::Bool(false), "json" => Value::Null, _ => Value::String(String::new()) }; f.searchable = false; }
            }
        }
        out.relations.retain(|r| r.privacy != "SECRET" && !secret_ids.contains(&r.source_id) && !secret_ids.contains(&r.target_id));
        out.events.retain(|ev| !secret_ids.contains(&ev.entity_id));
        for r in &mut out.relations { if mask_private && r.privacy == "PRIVATE" { r.note = None; } }
        if mask_private { out.events.clear(); }
        // IDs may contain personal names in imported data; replace them in shareable exports.
        let mut remap = HashMap::new();
        for e in &mut out.entities { let next = id(); remap.insert(e.id.clone(), next.clone()); e.id = next; for f in &mut e.fields { f.id = id(); f.entity_id = e.id.clone(); } }
        for r in &mut out.relations { r.id = id(); r.source_id = remap[&r.source_id].clone(); r.target_id = remap[&r.target_id].clone(); }
        for ev in &mut out.events { ev.id = id(); ev.entity_id = remap[&ev.entity_id].clone(); }
        out
    }
}

pub struct GraphService;
impl GraphService {
    pub fn search(snapshot: &Snapshot, query: &str) -> Vec<String> {
        let query = query.trim().to_lowercase();
        let direct: HashSet<_> = snapshot.entities.iter().filter(|e| e.privacy != "SECRET" && (e.name.to_lowercase().contains(&query) || e.category.to_lowercase().contains(&query) || e.tags.iter().any(|s| s.to_lowercase().contains(&query)) || e.fields.iter().any(|f| f.privacy != "SECRET" && f.searchable && format!("{} {}", f.key, f.value).to_lowercase().contains(&query)))).map(|e| e.id.as_str()).collect();
        snapshot.entities.iter().filter(|e| direct.contains(e.id.as_str()) || snapshot.relations.iter().any(|r| r.privacy != "SECRET" && ((r.source_id == e.id && direct.contains(r.target_id.as_str())) || (r.target_id == e.id && direct.contains(r.source_id.as_str()))))).map(|e| e.id.clone()).collect()
    }
    pub fn impact(snapshot: &Snapshot, entity_id: &str, hops: usize) -> Vec<String> {
        let mut seen = HashSet::from([entity_id.to_string()]);
        let mut queue = VecDeque::from([(entity_id.to_string(), 0)]);
        while let Some((current, depth)) = queue.pop_front() {
            if depth >= hops.min(2) { continue; }
            for r in snapshot.relations.iter().filter(|r| r.privacy != "SECRET" && (r.source_id == current || r.target_id == current)) {
                let next = if r.source_id == current { &r.target_id } else { &r.source_id };
                if seen.insert(next.clone()) { queue.push_back((next.clone(), depth + 1)); }
            }
        }
        seen.remove(entity_id); let mut out: Vec<_> = seen.into_iter().collect(); out.sort(); out
    }
}

pub fn date(s: &str) -> Result<()> {
    if NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok() || DateTime::parse_from_rfc3339(s).is_ok() { Ok(()) } else { Err("日期必须为 YYYY-MM-DD 或 RFC3339".into()) }
}
fn timestamp(s: &str) -> Result<()> { DateTime::parse_from_rfc3339(s).map(|_| ()).map_err(|_| "无效时间戳".into()) }
fn privacy(s: &str) -> Result<()> { if ["PUBLIC", "PRIVATE", "SECRET"].contains(&s) { Ok(()) } else { Err("未知隐私级别".into()) } }
fn unique_id<'a>(ids: &mut HashSet<&'a str>, value: &'a str) -> Result<()> { if value.is_empty() || value.len() > 200 || !ids.insert(value) { Err("缺失或重复 ID".into()) } else { Ok(()) } }
fn check_text(s: &str, max: usize, empty: bool) -> Result<()> { if (!empty && s.trim().is_empty()) || s.len() > max * 4 { return Err("文本缺失或超过长度限制".into()); } reject_credential(s) }
pub fn reject_credential(value: &str) -> Result<()> {
    if value.contains("PRIVATE KEY-----") || value.contains("otpauth://") || value.contains("sk-proj-") || value.contains("ghp_") || value.contains("github_pat_") { return Err("检测到凭据，请改用 Vaultwarden 引用".into()); }
    Ok(())
}
pub fn valid_url(value: &str) -> Result<()> {
    let url = url::Url::parse(value).map_err(|_| "URL 无效")?;
    if !["http", "https"].contains(&url.scheme()) || !url.username().is_empty() || url.password().is_some() { return Err("仅接受不含凭据的 http/https URL".into()); }
    if url.query_pairs().any(|(k, _)| ["token", "key", "api_key", "access_token", "auth", "password", "secret", "signature"].contains(&k.to_lowercase().as_str())) { return Err("URL 含凭据参数，请保存在 Vaultwarden".into()); }
    Ok(())
}
pub fn parse_import(text: &str) -> Result<Snapshot> {
    if text.len() > 32 * 1024 * 1024 { return Err("导入文件超过 32 MiB".into()); }
    let file: AtlasFile = serde_json::from_str(text).map_err(|_| "不是有效 Atlas JSON；请检查文件格式")?;
    if file.format != "amiya-atlas" || file.version != 1 { return Err("不支持的 Atlas 文件版本".into()); }
    file.snapshot.validate()?; Ok(file.snapshot)
}
