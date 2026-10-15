use crate::domain::Result;
use zeroize::Zeroizing;

#[cfg(windows)]
fn transform(input: &[u8], decrypt: bool) -> Result<Zeroizing<Vec<u8>>> {
    use std::{ptr, slice};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN},
    };
    use zeroize::Zeroize;
    if input.is_empty() || input.len() > 16 * 1024 { return Err("设备解锁数据无效".into()); }
    let mut bytes = Zeroizing::new(input.to_vec());
    let source = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_mut_ptr() };
    let mut entropy = b"org.sayori.atlas:device-unlock:v1".to_vec();
    let entropy = CRYPT_INTEGER_BLOB { cbData: entropy.len() as u32, pbData: entropy.as_mut_ptr() };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() };
    // DPAPI uses the current Windows account; never enable machine-wide decryption.
    let ok = unsafe {
        if decrypt {
            CryptUnprotectData(&source, ptr::null_mut(), &entropy, ptr::null(), ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        } else {
            CryptProtectData(&source, ptr::null(), &entropy, ptr::null(), ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        }
    };
    if ok == 0 { return Err("Windows 账户无法处理设备解锁凭据，请使用主密码".into()); }
    if output.pbData.is_null() { return Err("Windows 返回空的设备解锁凭据".into()); }
    let result = unsafe {
        let data = slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let result = Zeroizing::new(data.to_vec());
        data.zeroize();
        LocalFree(output.pbData.cast());
        result
    };
    Ok(result)
}

pub fn protect(input: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    #[cfg(windows)] { transform(input, false) }
    #[cfg(not(windows))] { let _ = input; Err("设备解锁仅支持 Windows".into()) }
}
pub fn unprotect(input: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    #[cfg(windows)] { transform(input, true) }
    #[cfg(not(windows))] { let _ = input; Err("设备解锁仅支持 Windows".into()) }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn device_protection_round_trip_and_tamper() {
        let input = b"local-only-example-vault-key";
        let encrypted = protect(input).unwrap();
        assert!(!encrypted.windows(input.len()).any(|w| w == input));
        assert_eq!(unprotect(&encrypted).unwrap().as_slice(), input);
        let mut damaged = encrypted.to_vec();
        let last = damaged.len() - 1;
        damaged[last] ^= 1;
        assert!(unprotect(&damaged).is_err());
    }
}
