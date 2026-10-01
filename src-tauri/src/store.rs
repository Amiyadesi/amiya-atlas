use crate::{crypto::EncryptedRecord, domain::Result, vault::VaultMeta};
use rusqlite::{params, Connection};
use std::path::Path;

type StoredRecords = (VaultMeta, Vec<EncryptedRecord>);
type VaultMetaRow = (String, u32, String, String, Vec<u8>, String, Vec<u8>, Vec<u8>);

pub trait RecordStore: Send {
    fn read(&self) -> Result<Option<StoredRecords>>;
    fn write(&mut self, meta: &VaultMeta, records: &[EncryptedRecord]) -> Result<()>;
}

#[allow(dead_code)]
#[derive(Default)]
pub struct MemoryRecordStore { pub data: Option<(VaultMeta, Vec<EncryptedRecord>)> }
impl RecordStore for MemoryRecordStore {
    fn read(&self) -> Result<Option<StoredRecords>> { Ok(self.data.clone()) }
    fn write(&mut self, meta: &VaultMeta, records: &[EncryptedRecord]) -> Result<()> { self.data = Some((meta.clone(), records.to_vec())); Ok(()) }
}

pub struct SqliteRecordStore { connection: Connection }
impl SqliteRecordStore {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path).map_err(|_| "无法打开本地数据库")?;
        connection.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
            CREATE TABLE IF NOT EXISTS vault_meta (vault_id TEXT PRIMARY KEY, format_version INTEGER NOT NULL, kdf_name TEXT NOT NULL, kdf_params_json TEXT NOT NULL, salt BLOB NOT NULL, cipher_suite TEXT NOT NULL, wrap_nonce BLOB NOT NULL, wrapped_vault_key BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS encrypted_records (id TEXT PRIMARY KEY, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
            INSERT OR IGNORE INTO schema_migrations VALUES (1, datetime('now')); ").map_err(|_| "数据库初始化失败")?;
        Ok(Self { connection })
    }
}
impl RecordStore for SqliteRecordStore {
    fn read(&self) -> Result<Option<StoredRecords>> {
        let count: i64 = self.connection.query_row("SELECT COUNT(*) FROM vault_meta", [], |r| r.get(0)).map_err(|_| "数据库元数据读取失败")?;
        if count == 0 { return Ok(None); }
        if count != 1 { return Err("数据库包含重复库头".into()); }
        let (vault_id, version, kdf, params_json, salt, cipher, nonce, wrapped): VaultMetaRow = self.connection.query_row("SELECT * FROM vault_meta", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).map_err(|_| "数据库元数据损坏")?;
        let meta = VaultMeta { vault_id, format_version: version, kdf_name: kdf, kdf_params: serde_json::from_str(&params_json).map_err(|_| "KDF 元数据损坏")?, salt, cipher_suite: cipher, wrapped_key: EncryptedRecord { id: "key".into(), nonce, ciphertext: wrapped } };
        let mut stmt = self.connection.prepare("SELECT id, nonce, ciphertext FROM encrypted_records ORDER BY id").map_err(|_| "记录读取失败")?;
        let records = stmt.query_map([], |r| Ok(EncryptedRecord { id: r.get(0)?, nonce: r.get(1)?, ciphertext: r.get(2)? })).map_err(|_| "记录读取失败")?.collect::<std::result::Result<Vec<_>, _>>().map_err(|_| "记录损坏")?;
        Ok(Some((meta, records)))
    }
    fn write(&mut self, meta: &VaultMeta, records: &[EncryptedRecord]) -> Result<()> {
        let tx = self.connection.transaction().map_err(|_| "无法启动存储事务")?;
        tx.execute("DELETE FROM encrypted_records", []).map_err(|_| "存储事务失败")?;
        tx.execute("DELETE FROM vault_meta", []).map_err(|_| "存储事务失败")?;
        tx.execute("INSERT INTO vault_meta VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", params![meta.vault_id,meta.format_version,meta.kdf_name,serde_json::to_string(&meta.kdf_params).map_err(|_| "KDF 序列化失败")?,meta.salt,meta.cipher_suite,meta.wrapped_key.nonce,meta.wrapped_key.ciphertext]).map_err(|_| "库头写入失败")?;
        {
            let mut stmt = tx.prepare("INSERT INTO encrypted_records VALUES (?1,?2,?3)").map_err(|_| "记录事务失败")?;
            for record in records { stmt.execute(params![record.id,record.nonce,record.ciphertext]).map_err(|_| "记录写入失败")?; }
        }
        tx.commit().map_err(|_| "存储提交失败".into())
    }
}
