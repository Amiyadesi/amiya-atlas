#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[path = "../../shared/ipc.rs"]
#[allow(dead_code)]
mod ipc;

const EXTENSION_ID: &str = include_str!("../../extension/id.txt");

fn main() {
    let origin = std::env::args().nth(1).unwrap_or_default();
    let expected = format!("chrome-extension://{}", EXTENSION_ID.trim());
    if origin.trim_end_matches('/') != expected { return; }
    let input = std::io::stdin(); let output = std::io::stdout();
    let mut reader = input.lock(); let mut writer = output.lock();
    while let Ok(request) = ipc::read_frame(&mut reader) {
        let response = ipc::call(&request).unwrap_or_else(|_| serde_json::json!({"ok": false, "error": "请打开并解锁 Atlas；若连接失败，请检查浏览器连接状态"}));
        if ipc::write_frame(&mut writer, &response).is_err() { break; }
    }
}
