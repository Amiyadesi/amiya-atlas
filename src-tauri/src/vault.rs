use crate::{crypto::{CryptoProvider, EncryptedRecord, KdfParams}, domain::{id, now, Entity, Field, Relation, Event, Result, Snapshot}, store::{RecordStore, SqliteRecordStore}};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::PathBuf, time::{Duration, Instant}};
use zeroize::Zeroizing;

pub const IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MANIFEST_ID: &str = "manifest";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultMeta {
    pub vault_id: String,
    pub format_version: u32,
    pub kdf_name: String,
    pub kdf_params: KdfParams,
    pub salt: Vec<u8>,
    pub cipher_suite: String,
    pub wrapped_key: EncryptedRecord,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest { revision: u64, record_hashes: Vec<(String, String)> }

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
enum Record { Entity(Entity), Relation(Relation), Event(Event), Capture(crate::capture::Capture), Proposal(crate::capture::ProposalRecord), AiConfig(crate::ai::AiConfig) }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Backup { format: String, version: u32, meta: VaultMeta, records: Vec<EncryptedRecord> }

pub struct VaultService {
    pub path: PathBuf,
    key: Option<Zeroizing<[u8; 32]>>,
    meta: Option<VaultMeta>,
    last_activity: Instant,
}

impl VaultService {
    pub fn new(path: PathBuf) -> Self { Self { path, key: None, meta: None, last_activity: Instant::now() } }
    fn store(&self) -> Result<SqliteRecordStore> { SqliteRecordStore::open(&self.path) }
    pub fn exists(&self) -> bool { self.path.exists() }
    pub fn unlocked(&self) -> bool { self.key.is_some() && self.last_activity.elapsed() < IDLE_TIMEOUT }
    pub fn expire_if_idle(&mut self) -> bool { if self.key.is_some() && self.last_activity.elapsed() >= IDLE_TIMEOUT { self.lock(); true } else { false } }
    pub fn touch(&mut self) -> Result<()> { self.expire_if_idle(); if !self.unlocked() { return Err("Vault 已锁定，请重新解锁".into()); } self.last_activity = Instant::now(); Ok(()) }

    pub fn initialize(&mut self, password: &str) -> Result<()> {
        if self.exists() { return Err("本地 Vault 已存在".into()); }
        if password.chars().count() < 12 || password.len() > 4096 { return Err("主密码至少 12 个字符".into()); }
        if let Some(parent) = self.path.parent() { std::fs::create_dir_all(parent).map_err(|_| "无法创建应用数据目录")?; }
        let key = Zeroizing::new(CryptoProvider::random::<32>());
        let mut meta = VaultMeta { vault_id: id(), format_version: 1, kdf_name: "Argon2id".into(), kdf_params: KdfParams::default(), salt: CryptoProvider::random::<16>().to_vec(), cipher_suite: "XChaCha20-Poly1305".into(), wrapped_key: EncryptedRecord { id: "key".into(), nonce: vec![], ciphertext: vec![] } };
        let kek = CryptoProvider::derive_key(password, &meta.salt, &meta.kdf_params)?;
        meta.wrapped_key = CryptoProvider::encrypt(&kek, "key".into(), key.as_ref(), &wrap_aad(&meta)?)?;
        let records = encode_snapshot(&key, &meta, &Snapshot::default())?;
        self.store()?.write(&meta, &records)?;
        self.key = Some(key); self.meta = Some(meta); self.last_activity = Instant::now(); Ok(())
    }

    pub fn unlock(&mut self, password: &str) -> Result<Snapshot> {
        self.lock();
        if !self.exists() { return Err("尚未创建 Vault".into()); }
        let (meta, records) = self.store()?.read()?.ok_or_else(|| "Vault 缺失库头".to_string())?;
        let key = unlock_key(&meta, password)?;
        let snapshot = decode_snapshot(&key, &meta, &records)?;
        self.key = Some(key); self.meta = Some(meta); self.last_activity = Instant::now(); Ok(snapshot)
    }

    pub fn lock(&mut self) { self.key = None; self.meta = None; }
    pub fn load(&self) -> Result<Snapshot> {
        if !self.unlocked() { return Err("Vault 已锁定".into()); }
        let key = self.key.as_ref().ok_or("Vault 已锁定")?;
        let (meta, records) = self.store()?.read()?.ok_or("Vault 缺失库头")?;
        if self.meta.as_ref().map(|m| &m.vault_id) != Some(&meta.vault_id) { return Err("本地 Vault 已被替换，请重新解锁".into()); }
        decode_snapshot(key, &meta, &records)
    }

    pub fn save(&mut self, mut snapshot: Snapshot, unlink_ids: &[String]) -> Result<Snapshot> {
        self.touch()?;
        snapshot.validate()?;
        let current = self.load()?;
        if snapshot.revision != current.revision { return Err("数据已在插件或其他入口更新；请刷新后重试".into()); }
        for entity in &current.entities {
            if !snapshot.entities.iter().any(|e| e.id == entity.id) && current.relations.iter().any(|r| r.source_id == entity.id || r.target_id == entity.id) && !unlink_ids.contains(&entity.id) { return Err("实体仍有关系；需要明确确认解除关系后删除".into()); }
        }
        snapshot.revision += 1;
        // ponytail: rewrite encrypted rows in one transaction; use incremental writes above 20k entities.
        let key = self.key.as_ref().ok_or("Vault 已锁定")?;
        let meta = self.meta.as_ref().ok_or("Vault 元数据缺失")?;
        self.store()?.write(meta, &encode_snapshot(key, meta, &snapshot)?)?;
        Ok(snapshot)
    }

    pub fn capture(&mut self, title: &str, url: &str, identity_id: &str) -> Result<(Snapshot, String)> {
        self.touch()?;
        let mut snapshot = self.load()?;
        if title.len() > 2000 || url.len() > 8192 { return Err("捕获内容过长".into()); }
        let identity = snapshot.entities.iter().find(|e| e.id == identity_id && (e.category == "Identity" || e.category == "Email") && e.status == "ACTIVE").ok_or("选择的身份不存在或未启用")?;
        let relation_type = if identity.category == "Email" { "REGISTERED_WITH" } else { "AUTHENTICATES_WITH" };
        let origin = clean_origin(url)?;
        let existing = snapshot.entities.iter().find(|e| e.category == "Website Account" && e.fields.iter().any(|f| f.key == "origin" && f.value.as_str() == Some(&origin)) && snapshot.relations.iter().any(|r| r.source_id == e.id && r.target_id == identity_id && r.kind == relation_type)).map(|e| e.id.clone());
        if let Some(entity_id) = existing { return Ok((snapshot, entity_id)); }
        let entity_id = id(); let timestamp = now();
        snapshot.entities.push(Entity { id: entity_id.clone(), name: if title.trim().is_empty() { url::Url::parse(&origin).map_err(|_| "URL 无效")?.host_str().unwrap_or("Website Account").into() } else { title.chars().take(200).collect() }, template_id: Some("website-account".into()), category: "Website Account".into(), status: "ACTIVE".into(), privacy: "PRIVATE".into(), tags: vec!["captured".into()], fields: vec![Field { id: id(), entity_id: entity_id.clone(), key: "origin".into(), value_type: "url".into(), value: origin.into(), privacy: "PRIVATE".into(), searchable: true, source_of_truth: None }], created_at: timestamp.clone(), updated_at: timestamp.clone() });
        snapshot.relations.push(Relation { id: id(), source_id: entity_id.clone(), kind: relation_type.into(), target_id: identity_id.into(), note: None, privacy: "PRIVATE".into(), created_at: timestamp });
        Ok((self.save(snapshot, &[])?, entity_id))
    }

    pub fn backup(&self) -> Result<String> {
        self.load()?;
        let (meta, records) = self.store()?.read()?.ok_or("Vault 缺失库头")?;
        serde_json::to_string(&Backup { format: "amiya-atlas-backup".into(), version: 1, meta, records }).map_err(|_| "备份生成失败".into())
    }

    pub fn restore(&mut self, payload: &str, password: &str) -> Result<Snapshot> {
        if payload.len() > 64 * 1024 * 1024 { return Err("备份超过 64 MiB".into()); }
        let backup: Backup = serde_json::from_str(payload).map_err(|_| "不是有效 Atlas 加密备份")?;
        if backup.format != "amiya-atlas-backup" || backup.version != 1 { return Err("不支持的备份格式".into()); }
        let key = unlock_key(&backup.meta, password)?;
        let snapshot = decode_snapshot(&key, &backup.meta, &backup.records)?;
        if let Some(parent) = self.path.parent() { std::fs::create_dir_all(parent).map_err(|_| "无法创建数据目录")?; }
        if self.exists() { let preserved = self.path.with_extension(format!("before-restore-{}.sqlite", id())); std::fs::copy(&self.path, preserved).map_err(|_| "无法保留恢复前的数据库，已停止恢复")?; }
        self.store()?.write(&backup.meta, &backup.records)?;
        self.key = Some(key); self.meta = Some(backup.meta); self.last_activity = Instant::now(); Ok(snapshot)
    }
}

fn wrap_aad(meta: &VaultMeta) -> Result<Vec<u8>> { serde_json::to_vec(&("amiya-atlas:wrap:v1", &meta.vault_id, meta.format_version, &meta.kdf_name, &meta.kdf_params, &meta.salt, &meta.cipher_suite)).map_err(|_| "库头编码失败".into()) }
fn record_aad(meta: &VaultMeta, row_id: &str) -> Vec<u8> { format!("amiya-atlas:record:v1:{}:{row_id}", meta.vault_id).into_bytes() }
fn unlock_key(meta: &VaultMeta, password: &str) -> Result<Zeroizing<[u8; 32]>> {
    if uuid::Uuid::parse_str(&meta.vault_id).is_err() || meta.format_version != 1 || meta.cipher_suite != "XChaCha20-Poly1305" || meta.kdf_name != "Argon2id" { return Err("不支持或损坏的 Vault 格式".into()); }
    let kek = CryptoProvider::derive_key(password, &meta.salt, &meta.kdf_params)?; let plain = CryptoProvider::decrypt(&kek, &meta.wrapped_key, &wrap_aad(meta)?)?;
    if plain.len() != 32 { return Err("Vault Key 损坏".into()); }
    let mut key = Zeroizing::new([0u8; 32]); key.copy_from_slice(&plain); Ok(key)
}
fn record_hash(record: &EncryptedRecord) -> String { let mut hash = Sha256::new(); hash.update(&record.nonce); hash.update(&record.ciphertext); format!("{:x}", hash.finalize()) }
pub fn encode_snapshot(key: &[u8; 32], meta: &VaultMeta, snapshot: &Snapshot) -> Result<Vec<EncryptedRecord>> {
    snapshot.validate()?;
    let logical = snapshot.entities.iter().cloned().map(Record::Entity).chain(snapshot.relations.iter().cloned().map(Record::Relation)).chain(snapshot.events.iter().cloned().map(Record::Event)).chain(snapshot.captures.iter().cloned().map(Record::Capture)).chain(snapshot.proposals.iter().cloned().map(Record::Proposal)).chain(snapshot.ai_config.iter().cloned().map(Record::AiConfig));
    let mut records = Vec::new();
    for record in logical { let row_id = id(); let plain = Zeroizing::new(serde_json::to_vec(&record).map_err(|_| "记录编码失败")?); records.push(CryptoProvider::encrypt(key, row_id.clone(), &plain, &record_aad(meta, &row_id))?); }
    let mut hashes: Vec<_> = records.iter().map(|r| (r.id.clone(), record_hash(r))).collect(); hashes.sort();
    let plain = Zeroizing::new(serde_json::to_vec(&Manifest { revision: snapshot.revision, record_hashes: hashes }).map_err(|_| "完整性清单生成失败")?);
    records.push(CryptoProvider::encrypt(key, MANIFEST_ID.into(), &plain, &record_aad(meta, MANIFEST_ID))?);
    if records.len() > 260_002 || records.iter().map(|record| record.ciphertext.len()).sum::<usize>() > 64 * 1024 * 1024 { return Err("记录容量超过限制，未修改数据库".into()); }
    Ok(records)
}
fn decode_snapshot(key: &[u8; 32], meta: &VaultMeta, records: &[EncryptedRecord]) -> Result<Snapshot> {
    if records.len() > 260_002 || records.iter().map(|r| r.ciphertext.len()).sum::<usize>() > 64 * 1024 * 1024 { return Err("记录容量超过限制".into()); }
    let mut ids = HashSet::new(); for record in records { if !ids.insert(&record.id) || record.id.len() > 100 { return Err("重复或无效存储 ID".into()); } }
    let manifest = records.iter().find(|r| r.id == MANIFEST_ID).ok_or("完整性清单缺失，数据已损坏")?;
    let plain = CryptoProvider::decrypt(key, manifest, &record_aad(meta, MANIFEST_ID))?; let manifest: Manifest = serde_json::from_slice(&plain).map_err(|_| "完整性清单损坏")?;
    let mut actual: Vec<_> = records.iter().filter(|r| r.id != MANIFEST_ID).map(|r| (r.id.clone(), record_hash(r))).collect(); actual.sort(); if actual != manifest.record_hashes { return Err("完整性校验失败：记录缺失或被篡改".into()); }
    let mut snapshot = Snapshot { revision: manifest.revision, ..Snapshot::default() };
    for record in records.iter().filter(|r| r.id != MANIFEST_ID) { let bytes = CryptoProvider::decrypt(key, record, &record_aad(meta, &record.id))?; match serde_json::from_slice::<Record>(&bytes).map_err(|_| "加密记录结构损坏")? { Record::Entity(e) => snapshot.entities.push(e), Record::Relation(r) => snapshot.relations.push(r), Record::Event(ev) => snapshot.events.push(ev), Record::Capture(c) => snapshot.captures.push(c), Record::Proposal(p) => snapshot.proposals.push(p), Record::AiConfig(c) => { if snapshot.ai_config.replace(c).is_some() { return Err("重复模型配置".into()); } } } }
    snapshot.validate()?; Ok(snapshot)
}
pub fn clean_origin(raw: &str) -> Result<String> { let mut parsed = url::Url::parse(raw).map_err(|_| "网页 URL 无效")?; if !["http", "https"].contains(&parsed.scheme()) || parsed.host_str().is_none() { return Err("仅接受 http/https 网页".into()); } parsed.set_username("").map_err(|_| "URL 无效")?; parsed.set_password(None).map_err(|_| "URL 无效")?; Ok(parsed.origin().ascii_serialization()) }
