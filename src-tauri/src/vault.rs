use crate::{crypto::{CryptoProvider, EncryptedRecord, KdfParams}, domain::{id, now, Entity, Field, Relation, Event, Result, Snapshot}, store::{RecordStore, SqliteRecordStore}};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::PathBuf, time::{Duration, Instant}};
use zeroize::{Zeroize, Zeroizing};
use std::io::Write;

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
enum Record { Entity(Entity), Relation(Relation), Event(Event), Capture(crate::capture::Capture), Proposal(crate::capture::ProposalRecord), AiConfig(crate::ai::AiConfig), CloudSession(crate::cloud::CloudSession), LedgerAccount(crate::ledger::Account), Transaction(crate::ledger::Transaction), AllocationRule(crate::ledger::Allocation), FinanceRecord(serde_json::Value) }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Backup { format: String, version: u32, meta: VaultMeta, records: Vec<EncryptedRecord> }

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceKey { version: u32, vault_id: String, key: [u8; 32] }
impl Drop for DeviceKey { fn drop(&mut self) { self.key.zeroize(); } }

pub struct VaultService {
    pub path: PathBuf,
    key: Option<Zeroizing<[u8; 32]>>,
    meta: Option<VaultMeta>,
    last_activity: Instant,
    idle_timeout: Option<Duration>,
}

impl VaultService {
    pub fn new(path: PathBuf) -> Self { Self { path, key: None, meta: None, last_activity: Instant::now(), idle_timeout: None } }
    fn store(&self) -> Result<SqliteRecordStore> { SqliteRecordStore::open(&self.path) }
    pub fn exists(&self) -> bool { self.path.exists() }
    pub fn seal_local(&self, name: &str, value: &[u8]) -> Result<()> {
        let key = self.key.as_ref().filter(|_| self.unlocked()).ok_or("Vault 已锁定")?;
        let record = CryptoProvider::encrypt(key, name.into(), value, name.as_bytes())?;
        let path = self.path.with_extension(name);
        let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("数据目录不可用")?).map_err(|_| "无法保存同步设置")?;
        file.write_all(&serde_json::to_vec(&record).map_err(|_| "同步设置编码失败")?).map_err(|_| "同步设置写入失败")?;
        file.as_file().sync_all().map_err(|_| "同步设置写入失败")?;
        file.persist(path).map_err(|_| "同步设置保存失败")?;
        Ok(())
    }
    pub fn read_local(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
        let key = self.key.as_ref().filter(|_| self.unlocked()).ok_or("Vault 已锁定")?;
        let path = self.path.with_extension(name);
        if !path.exists() { return Ok(None); }
        let bytes = std::fs::read(path).map_err(|_| "同步设置读取失败")?;
        if bytes.len() > 128 * 1024 * 1024 { return Err("同步设置超过容量限制".into()); }
        let record = serde_json::from_slice(&bytes).map_err(|_| "同步设置损坏")?;
        Ok(Some(CryptoProvider::decrypt(key, &record, name.as_bytes())?))
    }
    pub fn clear_sync(&self) -> Result<()> {
        match std::fs::remove_file(self.path.with_extension("sync")) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("无法关闭同步".into()),
        }
    }
    pub fn sync_backup(&self, snapshot: &Snapshot) -> Result<String> {
        let key = self.key.as_ref().filter(|_| self.unlocked()).ok_or("Vault 已锁定")?;
        let meta = self.meta.as_ref().ok_or("Vault 元数据缺失")?.clone();
        serde_json::to_string(&Backup { format: "amiya-atlas-backup".into(), version: 1, records: encode_snapshot(key, &meta, snapshot)?, meta }).map_err(|_| "同步备份生成失败".into())
    }
    pub fn decode_sync(&self, payload: &str) -> Result<Snapshot> {
        if payload.len() > 128 * 1024 * 1024 { return Err("同步文件超过容量限制".into()); }
        let backup: Backup = serde_json::from_str(payload).map_err(|_| "远端不是络笺加密备份")?;
        if backup.format != "amiya-atlas-backup" || backup.version != 1 { return Err("远端备份版本不支持".into()); }
        let meta = self.meta.as_ref().ok_or("Vault 已锁定")?;
        if backup.meta.vault_id != meta.vault_id { return Err("REMOTE_VAULT_DIFFERENT".into()); }
        if wrap_aad(&backup.meta)? != wrap_aad(meta)? || backup.meta.wrapped_key.nonce != meta.wrapped_key.nonce || backup.meta.wrapped_key.ciphertext != meta.wrapped_key.ciphertext { return Err("远端库头已更改，已停止同步".into()); }
        decode_snapshot(self.key.as_ref().ok_or("Vault 已锁定")?, &backup.meta, &backup.records)
    }
    pub fn preserve_sync(&self, remote: &str) -> Result<()> {
        let dir = self.path.parent().ok_or("数据目录不可用")?.join("sync-conflicts");
        std::fs::create_dir_all(&dir).map_err(|_| "冲突备份目录无法创建")?;
        let stamp = id();
        std::fs::write(dir.join(format!("{stamp}-local.json")), self.backup()?).map_err(|_| "本机冲突备份失败")?;
        std::fs::write(dir.join(format!("{stamp}-remote.json")), remote).map_err(|_| "远端冲突备份失败")?;
        Ok(())
    }
    pub fn apply_sync(&mut self, mut snapshot: Snapshot) -> Result<Snapshot> {
        let current = self.load()?;
        snapshot.ai_config = current.ai_config;
        snapshot.cloud_session = current.cloud_session;
        snapshot.revision = current.revision + 1;
        snapshot.validate()?;
        let key = self.key.as_ref().ok_or("Vault 已锁定")?;
        let meta = self.meta.as_ref().ok_or("Vault 元数据缺失")?;
        self.store()?.write(meta, &encode_snapshot(key, meta, &snapshot)?)?;
        Ok(snapshot)
    }
    pub fn idle_minutes(&self) -> u32 { self.idle_timeout.map_or(0, |timeout| timeout.as_secs() as u32 / 60) }
    pub fn set_idle_minutes(&mut self, minutes: u32) -> Result<()> {
        if ![0, 5, 15, 30, 60].contains(&minutes) { return Err("自动锁定时间无效".into()); }
        self.touch()?;
        self.seal_local("lock-policy", &serde_json::to_vec(&minutes).map_err(|_| "锁定设置编码失败")?)?;
        self.idle_timeout = if minutes == 0 { None } else { Some(Duration::from_secs(minutes as u64 * 60)) };
        Ok(())
    }
    fn load_lock_policy(&mut self) -> Result<()> {
        self.idle_timeout = None;
        if let Some(bytes) = self.read_local("lock-policy")? {
            let minutes: u32 = serde_json::from_slice(&bytes).map_err(|_| "锁定设置损坏")?;
            if ![0, 5, 15, 30, 60].contains(&minutes) { return Err("锁定设置损坏".into()); }
            self.idle_timeout = if minutes == 0 { None } else { Some(Duration::from_secs(minutes as u64 * 60)) };
        }
        Ok(())
    }
    pub fn unlocked(&self) -> bool { self.key.is_some() && self.idle_timeout.is_none_or(|timeout| self.last_activity.elapsed() < timeout) }
    pub fn expire_if_idle(&mut self) -> bool { if self.key.is_some() && self.idle_timeout.is_some_and(|timeout| self.last_activity.elapsed() >= timeout) { self.lock(); true } else { false } }
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
        self.key = Some(key); self.meta = Some(meta); self.last_activity = Instant::now();
        if let Err(error) = self.load_lock_policy() { self.lock(); return Err(error); }
        Ok(snapshot)
    }

    pub fn lock(&mut self) { self.key = None; self.meta = None; }
    fn device_key_path(&self) -> PathBuf { self.path.with_extension("device-unlock.dpapi") }
    pub fn device_unlock_enabled(&self) -> bool { self.device_key_path().is_file() }
    pub fn set_device_unlock(&mut self, enabled: bool) -> Result<()> {
        self.touch()?;
        if !enabled { return self.forget_device(); }
        self.load()?;
        let meta = self.meta.as_ref().ok_or("Vault 元数据缺失")?;
        let payload = DeviceKey { version: 1, vault_id: meta.vault_id.clone(), key: **self.key.as_ref().ok_or("Vault 已锁定")? };
        let plain = Zeroizing::new(serde_json::to_vec(&payload).map_err(|_| "设备解锁编码失败")?);
        let encrypted = crate::device_unlock::protect(&plain)?;
        let path = self.device_key_path();
        let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("应用目录不可用")?).map_err(|_| "无法创建设备解锁文件")?;
        file.write_all(&encrypted).map_err(|_| "设备解锁保存失败")?;
        file.as_file().sync_all().map_err(|_| "设备解锁保存失败")?;
        file.persist(path).map_err(|_| "设备解锁保存失败")?;
        Ok(())
    }
    pub fn forget_device(&self) -> Result<()> {
        match std::fs::remove_file(self.device_key_path()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("无法关闭设备解锁".into()),
        }
    }
    pub fn unlock_device(&mut self) -> Result<Snapshot> {
        self.lock();
        if !self.exists() { return Err("尚未创建 Vault".into()); }
        let path = self.device_key_path();
        if std::fs::metadata(&path).map_err(|_| "这台电脑尚未开启自动解锁")?.len() > 16 * 1024 { return Err("设备解锁文件损坏".into()); }
        let encrypted = std::fs::read(path).map_err(|_| "设备解锁读取失败")?;
        let plain = crate::device_unlock::unprotect(&encrypted)?;
        let device: DeviceKey = serde_json::from_slice(&plain).map_err(|_| "设备解锁数据损坏")?;
        let (meta, records) = self.store()?.read()?.ok_or("Vault 缺失库头")?;
        if device.version != 1 || device.vault_id != meta.vault_id { return Err("设备凭据与当前 Vault 不匹配，请使用主密码".into()); }
        let key = Zeroizing::new(device.key);
        let snapshot = decode_snapshot(&key, &meta, &records)?;
        self.key = Some(key); self.meta = Some(meta); self.last_activity = Instant::now();
        if let Err(error) = self.load_lock_policy() { self.lock(); return Err(error); }
        Ok(snapshot)
    }
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
        // UI snapshots never contain cloud tokens. Preserve the private encrypted record on every edit.
        snapshot.cloud_session = current.cloud_session.clone();
        crate::ledger::immutable(&current, &snapshot)?;
        for record in &current.opaque_records { if !snapshot.opaque_records.iter().any(|r|r["kind"]==record["kind"]&&r["data"]["id"]==record["data"]["id"]){ snapshot.opaque_records.push(record.clone()); } }
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

    pub fn set_cloud_session(&mut self, session: Option<crate::cloud::CloudSession>) -> Result<()> {
        self.touch()?;
        if let Some(value)=&session { value.validate()?; }
        let mut snapshot=self.load()?;
        snapshot.cloud_session=session;
        snapshot.revision+=1;
        let key=self.key.as_ref().ok_or("Vault 已锁定")?;
        let meta=self.meta.as_ref().ok_or("Vault 元数据缺失")?;
        self.store()?.write(meta,&encode_snapshot(key,meta,&snapshot)?)
    }

    pub fn backup(&self) -> Result<String> {
        self.load()?;
        let (meta, records) = self.store()?.read()?.ok_or("Vault 缺失库头")?;
        serde_json::to_string(&Backup { format: "amiya-atlas-backup".into(), version: 1, meta, records }).map_err(|_| "备份生成失败".into())
    }

    pub fn restore(&mut self, payload: &str, password: &str) -> Result<Snapshot> {
        if payload.len() > 128 * 1024 * 1024 { return Err("备份超过 128 MiB".into()); }
        let backup: Backup = serde_json::from_str(payload).map_err(|_| "不是有效 Atlas 加密备份")?;
        if backup.format != "amiya-atlas-backup" || backup.version != 1 { return Err("不支持的备份格式".into()); }
        let key = unlock_key(&backup.meta, password)?;
        let snapshot = decode_snapshot(&key, &backup.meta, &backup.records)?;
        self.forget_device()?;
        self.clear_sync()?;
        let policy = self.path.with_extension("lock-policy");
        if policy.exists() { std::fs::remove_file(policy).map_err(|_| "无法重置锁定设置")?; }
        if let Some(parent) = self.path.parent() { std::fs::create_dir_all(parent).map_err(|_| "无法创建数据目录")?; }
        if self.exists() { let preserved = self.path.with_extension(format!("before-restore-{}.sqlite", id())); std::fs::copy(&self.path, preserved).map_err(|_| "无法保留恢复前的数据库，已停止恢复")?; }
        self.store()?.write(&backup.meta, &backup.records)?;
        self.key = Some(key); self.meta = Some(backup.meta); self.last_activity = Instant::now(); self.idle_timeout = None; Ok(snapshot)
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
    let logical = snapshot.entities.iter().cloned().map(Record::Entity).chain(snapshot.relations.iter().cloned().map(Record::Relation)).chain(snapshot.events.iter().cloned().map(Record::Event)).chain(snapshot.captures.iter().cloned().map(Record::Capture)).chain(snapshot.proposals.iter().cloned().map(Record::Proposal)).chain(snapshot.ai_config.iter().cloned().map(Record::AiConfig)).chain(snapshot.cloud_session.iter().cloned().map(Record::CloudSession)).chain(snapshot.ledger_accounts.iter().cloned().map(Record::LedgerAccount)).chain(snapshot.transactions.iter().cloned().map(Record::Transaction)).chain(snapshot.allocation_rules.iter().cloned().map(Record::AllocationRule)).chain(snapshot.finance_records.iter().cloned().map(Record::FinanceRecord));
    let mut records = Vec::new();
    for record in logical { let row_id = id(); let plain = Zeroizing::new(serde_json::to_vec(&record).map_err(|_| "记录编码失败")?); records.push(CryptoProvider::encrypt(key, row_id.clone(), &plain, &record_aad(meta, &row_id))?); }
    for record in &snapshot.opaque_records { let row_id=id();let plain=Zeroizing::new(serde_json::to_vec(record).map_err(|_|"未知记录编码失败")?);records.push(CryptoProvider::encrypt(key,row_id.clone(),&plain,&record_aad(meta,&row_id))?); }
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
    for record in records.iter().filter(|r| r.id != MANIFEST_ID) { let bytes = CryptoProvider::decrypt(key, record, &record_aad(meta, &record.id))?; let raw:serde_json::Value=serde_json::from_slice(&bytes).map_err(|_|"加密记录结构损坏")?;let kind=raw["kind"].as_str().ok_or("记录缺少类型")?;if !crate::ledger::known_record(kind){snapshot.opaque_records.push(raw);continue;}match serde_json::from_value::<Record>(raw).map_err(|_| "加密记录结构损坏")? { Record::LedgerAccount(a)=>snapshot.ledger_accounts.push(a),Record::Transaction(t)=>snapshot.transactions.push(t),Record::AllocationRule(a)=>snapshot.allocation_rules.push(a),Record::FinanceRecord(f)=>snapshot.finance_records.push(f), Record::Entity(e) => snapshot.entities.push(e), Record::Relation(r) => snapshot.relations.push(r), Record::Event(ev) => snapshot.events.push(ev), Record::Capture(c) => snapshot.captures.push(c), Record::Proposal(p) => snapshot.proposals.push(p), Record::AiConfig(c) => { if snapshot.ai_config.replace(c).is_some() { return Err("重复模型配置".into()); } }, Record::CloudSession(c) => { if snapshot.cloud_session.replace(c).is_some() {return Err("重复云会话".into());} } } }
    snapshot.validate()?; Ok(snapshot)
}
pub fn clean_origin(raw: &str) -> Result<String> { let mut parsed = url::Url::parse(raw).map_err(|_| "网页 URL 无效")?; if !["http", "https"].contains(&parsed.scheme()) || parsed.host_str().is_none() { return Err("仅接受 http/https 网页".into()); } parsed.set_username("").map_err(|_| "URL 无效")?; parsed.set_password(None).map_err(|_| "URL 无效")?; Ok(parsed.origin().ascii_serialization()) }

#[cfg(test)]
mod lock_policy_tests {
    use super::*;
    #[test]
    fn no_idle_logout_by_default_and_optional_timeout_persists() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = VaultService::new(dir.path().join("atlas.sqlite"));
        vault.initialize("correct horse battery staple").unwrap();
        vault.last_activity = Instant::now() - Duration::from_secs(3600);
        assert!(!vault.expire_if_idle());
        assert!(vault.load().is_ok());
        vault.set_idle_minutes(15).unwrap();
        vault.last_activity = Instant::now() - Duration::from_secs(901);
        assert!(vault.expire_if_idle());
        assert!(vault.load().is_err());
        vault.unlock("correct horse battery staple").unwrap();
        assert_eq!(vault.idle_minutes(), 15);
        assert!(vault.set_idle_minutes(1).is_err());
        vault.set_idle_minutes(0).unwrap();
        vault.lock();
        vault.unlock("correct horse battery staple").unwrap();
        assert_eq!(vault.idle_minutes(), 0);
        let backup = vault.backup().unwrap();
        vault.set_idle_minutes(5).unwrap();
        vault.restore(&backup, "correct horse battery staple").unwrap();
        assert_eq!(vault.idle_minutes(), 0);
    }
}
