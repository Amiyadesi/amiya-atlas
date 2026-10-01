use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions, Stream, ToNsName};
use serde_json::Value;
use std::io::{self, Read, Write};

pub const MAX_MESSAGE: usize = 1024 * 1024;

pub fn read_frame(reader: &mut impl Read) -> io::Result<Value> {
    let mut header = [0u8; 4]; reader.read_exact(&mut header)?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_MESSAGE { return Err(io::Error::new(io::ErrorKind::InvalidData, "message length")); }
    let mut bytes = vec![0; length]; reader.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid JSON"))
}
pub fn write_frame(writer: &mut impl Write, value: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    if bytes.len() > MAX_MESSAGE { return Err(io::Error::new(io::ErrorKind::InvalidData, "message length")); }
    writer.write_all(&(bytes.len() as u32).to_le_bytes())?; writer.write_all(&bytes)?; writer.flush()
}

#[cfg(windows)]
fn current_sid() -> io::Result<String> {
    use windows_sys::Win32::{Foundation::{CloseHandle, LocalFree}, Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER, Authorization::ConvertSidToStringSidW}, System::Threading::{GetCurrentProcess, OpenProcessToken}};
    unsafe {
        let mut token = std::ptr::null_mut(); if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 { return Err(io::Error::last_os_error()); }
        let mut size = 0; GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
        let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
        let ok = GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), size, &mut size); CloseHandle(token); if ok == 0 { return Err(io::Error::last_os_error()); }
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>(); let mut text = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 { return Err(io::Error::last_os_error()); }
        let mut length = 0; while *text.add(length) != 0 { length += 1; }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, length)); LocalFree(text.cast()); Ok(sid)
    }
}
pub fn socket_name() -> io::Result<String> {
    #[cfg(windows)] { Ok(format!("amiya-atlas-{}", current_sid()?)) }
    #[cfg(not(windows))] { Ok("amiya-atlas".into()) }
}
pub fn listener() -> io::Result<interprocess::local_socket::Listener> {
    let name = socket_name()?.to_ns_name::<GenericNamespaced>()?;
    #[cfg(windows)] {
        use interprocess::os::windows::{local_socket::ListenerOptionsExt, security_descriptor::SecurityDescriptor};
        let sddl = widestring::U16CString::from_str(format!("D:P(A;;GA;;;{})", current_sid()?)).map_err(|_| io::Error::other("SID format"))?;
        ListenerOptions::new().name(name).security_descriptor(SecurityDescriptor::deserialize(&sddl)?).create_sync()
    }
    #[cfg(not(windows))] { ListenerOptions::new().name(name).create_sync() }
}
#[allow(dead_code)]
pub fn call(request: &Value) -> io::Result<Value> { let name = socket_name()?.to_ns_name::<GenericNamespaced>()?; let mut stream = Stream::connect(name)?; write_frame(&mut stream, request)?; read_frame(&mut stream) }
