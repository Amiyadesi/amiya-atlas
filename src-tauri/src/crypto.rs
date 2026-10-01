use crate::domain::Result;
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{aead::{Aead, Payload}, KeyInit, XChaCha20Poly1305, XNonce};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KdfParams { pub memory_kib: u32, pub iterations: u32, pub lanes: u32 }
impl Default for KdfParams { fn default() -> Self { Self { memory_kib: 65_536, iterations: 3, lanes: 4 } } }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EncryptedRecord { pub id: String, pub nonce: Vec<u8>, pub ciphertext: Vec<u8> }

pub struct CryptoProvider;
impl CryptoProvider {
    pub fn random<const N: usize>() -> [u8; N] { let mut value = [0; N]; OsRng.fill_bytes(&mut value); value }
    pub fn derive_key(password: &str, salt: &[u8], params: &KdfParams) -> Result<Zeroizing<[u8; 32]>> {
        if !(8_192..=262_144).contains(&params.memory_kib) || !(1..=10).contains(&params.iterations) || !(1..=8).contains(&params.lanes) || salt.len() != 16 || password.len() > 4096 { return Err("KDF 参数或密码格式无效".into()); }
        let argon_params = Params::new(params.memory_kib, params.iterations, params.lanes, Some(32)).map_err(|_| "KDF 参数无效")?;
        let mut key = Zeroizing::new([0u8; 32]);
        Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params).hash_password_into(password.as_bytes(), salt, key.as_mut()).map_err(|_| "密码派生失败")?;
        Ok(key)
    }
    pub fn encrypt(key: &[u8; 32], record_id: String, value: &[u8], aad: &[u8]) -> Result<EncryptedRecord> {
        let nonce = Self::random::<24>();
        let cipher = XChaCha20Poly1305::new(key.into());
        let ciphertext = cipher.encrypt(XNonce::from_slice(&nonce), Payload { msg: value, aad }).map_err(|_| "加密失败")?;
        Ok(EncryptedRecord { id: record_id, nonce: nonce.to_vec(), ciphertext })
    }
    pub fn decrypt(key: &[u8; 32], record: &EncryptedRecord, aad: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        if record.nonce.len() != 24 || record.ciphertext.len() < 16 { return Err("加密记录损坏".into()); }
        XChaCha20Poly1305::new(key.into()).decrypt(XNonce::from_slice(&record.nonce), Payload { msg: &record.ciphertext, aad }).map(Zeroizing::new).map_err(|_| "认证失败：密码错误或数据被篡改".into())
    }
}
