use crate::{domain::Result, vault::{clean_origin, VaultService}};
use serde::Deserialize;
use serde_json::Value;
use interprocess::local_socket::traits::ListenerExt;
use std::{sync::{Arc, Mutex}, thread};

#[path = "../../shared/ipc.rs"]
mod ipc;

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Request {
    PrepareCapture { title: String, url: String, favicon: Option<String> },
    CommitCapture { title: String, url: String, favicon: Option<String>, identity_id: String },
}

pub fn start(vault: Arc<Mutex<VaultService>>) {
    thread::Builder::new().name("atlas-native-bridge".into()).spawn(move || {
        let listener = match ipc::listener() { Ok(listener) => listener, Err(_) => return };
        for stream in listener.incoming().flatten() { let vault = vault.clone(); thread::spawn(move || handle(stream, vault)); }
    }).ok();
}

fn handle(mut stream: interprocess::local_socket::Stream, vault: Arc<Mutex<VaultService>>) {
    let response = match ipc::read_frame(&mut stream).map_err(|_| "请求格式无效".to_string()).and_then(|value| { let request: Request = serde_json::from_value(value).map_err(|_| "请求格式无效".to_string())?; dispatch(request, &vault) }) {
        Ok(data) => serde_json::json!({"ok": true, "data": data}),
        Err(error) => serde_json::json!({"ok": false, "error": error}),
    };
    let _ = ipc::write_frame(&mut stream, &response);
}

fn dispatch(request: Request, vault: &Arc<Mutex<VaultService>>) -> Result<Value> {
    let mut service = vault.lock().map_err(|_| "Vault 状态锁定失败".to_string())?;
    if !service.unlocked() { return Err("Atlas 未运行或仍处于锁定状态".into()); }
    match request {
        Request::PrepareCapture { title, url, favicon } => {
            let origin = clean_origin(&url)?;
            let snapshot = service.load()?;
            let list: Vec<_> = snapshot.entities.into_iter().filter(|e| e.category == "Identity" || e.category == "Email").map(|e| serde_json::json!({"id": e.id, "name": e.name, "category": e.category})).collect();
            Ok(serde_json::json!({"page": {"title": title, "url": origin, "favicon": favicon}, "identities": list}))
        }
        Request::CommitCapture { title, url, identity_id, favicon } => {
            let _ = favicon; let (snapshot, entity_id) = service.capture(&title, &url, &identity_id)?;
            Ok(serde_json::json!({"entityId": entity_id, "snapshot": snapshot}))
        }
    }
}
