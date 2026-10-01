mod bridge;
mod crypto;
mod domain;
mod store;
mod vault;

use domain::{AtlasFile, CaptureRequest, GraphService, Result, Snapshot};
use serde::Serialize;
use std::{path::PathBuf, sync::{Arc, Mutex}};
use tauri::{Manager, State};
use vault::VaultService;

#[derive(Clone)]
pub struct AppState { pub vault: Arc<Mutex<VaultService>> }
impl Default for AppState { fn default() -> Self { Self { vault: Arc::new(Mutex::new(VaultService::new(PathBuf::new()))) } } }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status { exists: bool, unlocked: bool, entity_count: usize, bridge_error: Option<String> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportPreview { entity_count: usize, relation_count: usize, event_count: usize, duplicate_entity_count: usize, duplicate_relation_count: usize, duplicate_event_count: usize }

#[tauri::command]
fn vault_status(state: State<'_, AppState>) -> Result<Status> {
    let mut vault = state.vault.lock().map_err(|_| "Vault 状态不可用".to_string())?;
    vault.expire_if_idle();
    let count = if vault.unlocked() { vault.load().map(|s| s.entities.len()).unwrap_or(0) } else { 0 };
    Ok(Status { exists: vault.exists(), unlocked: vault.unlocked(), entity_count: count, bridge_error: None })
}

#[tauri::command]
fn initialize_vault(password: String, state: State<'_, AppState>) -> Result<()> { state.vault.lock().map_err(|_| "Vault 状态不可用".to_string())?.initialize(&password) }
#[tauri::command]
fn unlock_vault(password: String, state: State<'_, AppState>) -> Result<()> { state.vault.lock().map_err(|_| "Vault 状态不可用".to_string())?.unlock(&password).map(|_| ()) }
#[tauri::command]
fn lock_vault(state: State<'_, AppState>) -> Result<()> { state.vault.lock().map_err(|_| "Vault 状态不可用".to_string())?.lock(); Ok(()) }
#[tauri::command]
fn load_snapshot(state: State<'_, AppState>) -> Result<Snapshot> { state.vault.lock().map_err(|_| "Vault 状态不可用".to_string())?.load() }
#[tauri::command]
fn save_snapshot(snapshot: Snapshot, unlink_ids: Option<Vec<String>>, state: State<'_, AppState>) -> Result<Snapshot> { state.vault.lock().map_err(|_| "Vault 状态不可用".to_string())?.save(snapshot, &unlink_ids.unwrap_or_default()) }

#[tauri::command]
fn search_snapshot(query: String, state: State<'_, AppState>) -> Result<Vec<String>> { let vault = state.vault.lock().map_err(|_| "Vault 状态不可用".to_string())?; Ok(GraphService::search(&vault.load()?, &query)) }
#[tauri::command]
fn impact_lookup(entity_id: String, hops: usize, state: State<'_, AppState>) -> Result<Vec<String>> { let vault = state.vault.lock().map_err(|_| "Vault 状态不可用".to_string())?; Ok(GraphService::impact(&vault.load()?, &entity_id, hops)) }

#[tauri::command]
fn import_atlas_json(text: String, state: State<'_, AppState>) -> Result<Snapshot> {
    let imported = domain::parse_import(&text)?; let mut vault = state.vault.lock().map_err(|_| "Vault 状态不可用".to_string())?; let current = vault.load()?; vault.save(current.merge(&imported)?, &[])
}

#[tauri::command]
fn preview_atlas_json(text: String, state: State<'_, AppState>) -> Result<ImportPreview> {
    let imported = domain::parse_import(&text)?;
    let vault = state.vault.lock().map_err(|_| "Vault 状态不可用".to_string())?;
    let current = vault.load()?;
    let entity_ids: std::collections::HashSet<_> = current.entities.iter().map(|entity| entity.id.as_str()).collect();
    let relation_ids: std::collections::HashSet<_> = current.relations.iter().map(|relation| relation.id.as_str()).collect();
    let event_ids: std::collections::HashSet<_> = current.events.iter().map(|event| event.id.as_str()).collect();
    let relation_keys: std::collections::HashSet<_> = current.relations.iter().map(|relation| (relation.source_id.as_str(), relation.kind.as_str(), relation.target_id.as_str())).collect();
    Ok(ImportPreview {
        entity_count: imported.entities.len(),
        relation_count: imported.relations.len(),
        event_count: imported.events.len(),
        duplicate_entity_count: imported.entities.iter().filter(|entity| entity_ids.contains(entity.id.as_str())).count(),
        duplicate_relation_count: imported.relations.iter().filter(|relation| relation_ids.contains(relation.id.as_str()) || relation_keys.contains(&(relation.source_id.as_str(), relation.kind.as_str(), relation.target_id.as_str()))).count(),
        duplicate_event_count: imported.events.iter().filter(|event| event_ids.contains(event.id.as_str())).count(),
    })
}

#[tauri::command]
fn export_redacted(mask_private: bool, state: State<'_, AppState>) -> Result<String> {
    let vault = state.vault.lock().map_err(|_| "Vault 状态不可用".to_string())?; let snapshot = vault.load()?.redacted(mask_private); serde_json::to_string_pretty(&AtlasFile { format: "amiya-atlas".into(), version: 1, snapshot }).map_err(|_| "导出失败".into())
}

#[tauri::command]
fn export_backup(state: State<'_, AppState>) -> Result<String> { state.vault.lock().map_err(|_| "Vault 状态不可用".to_string())?.backup() }
#[tauri::command]
fn import_backup(payload: String, password: String, state: State<'_, AppState>) -> Result<Snapshot> { state.vault.lock().map_err(|_| "Vault 状态不可用".to_string())?.restore(&payload, &password) }
#[tauri::command]
fn capture_website_account(request: CaptureRequest, state: State<'_, AppState>) -> Result<Snapshot> { state.vault.lock().map_err(|_| "Vault 状态不可用".to_string())?.capture(&request.title, &request.url, &request.identity_id).map(|(snapshot, _)| snapshot) }

#[tauri::command]
fn open_vaultwarden(reference: String) -> Result<()> { domain::valid_url(&reference)?; open::that(reference).map_err(|_| "无法打开 Vaultwarden 引用".into()) }

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            let state = app.state::<AppState>();
            let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
            state.vault.lock().map_err(|_| "Vault 状态不可用")?.path = app_dir.join("atlas.sqlite");
            bridge::start(state.vault.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![vault_status, initialize_vault, unlock_vault, lock_vault, load_snapshot, save_snapshot, search_snapshot, impact_lookup, import_atlas_json, preview_atlas_json, export_redacted, export_backup, import_backup, capture_website_account, open_vaultwarden])
        .run(tauri::generate_context!())
        .expect("error while running Amiya Atlas");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn entity(id: &str, name: &str, privacy: &str) -> domain::Entity {
        domain::Entity { id: id.into(), name: name.into(), template_id: Some("project".into()), category: "Project".into(), status: "ACTIVE".into(), privacy: privacy.into(), tags: vec![], fields: vec![], created_at: domain::now(), updated_at: domain::now() }
    }
    #[test]
    fn vault_round_trip_and_wrong_password() {
        let path = std::env::temp_dir().join(format!("atlas-test-{}.sqlite", uuid::Uuid::new_v4()));
        let mut vault = VaultService::new(path.clone());
        vault.initialize("correct horse battery staple").unwrap();
        let mut snapshot = Snapshot::default();
        snapshot.entities.push(domain::Entity { id: "e1".into(), name: "Private service".into(), template_id: Some("project".into()), category: "Project".into(), status: "ACTIVE".into(), privacy: "PRIVATE".into(), tags: vec![], fields: vec![], created_at: domain::now(), updated_at: domain::now() });
        vault.save(snapshot, &[]).unwrap(); vault.lock();
        let raw = fs::read_to_string(&path).unwrap_or_default(); assert!(!raw.contains("Private service"));
        assert!(vault.unlock("wrong password wrong").is_err());
        vault.unlock("correct horse battery staple").unwrap(); assert_eq!(vault.load().unwrap().entities[0].name, "Private service");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn relation_delete_requires_explicit_unlink() {
        let path = std::env::temp_dir().join(format!("atlas-delete-test-{}.sqlite", uuid::Uuid::new_v4()));
        let mut vault = VaultService::new(path.clone());
        vault.initialize("correct horse battery staple").unwrap();
        let mut snapshot = Snapshot { revision: 0, entities: vec![entity("e1", "Source", "PRIVATE"), entity("e2", "Target", "PRIVATE")], relations: vec![domain::Relation { id: "r1".into(), source_id: "e1".into(), kind: "RELATED_TO".into(), target_id: "e2".into(), note: None, privacy: "PRIVATE".into(), created_at: domain::now() }], events: vec![] };
        snapshot = vault.save(snapshot, &[]).unwrap();
        let mut pruned = snapshot.clone(); pruned.entities.retain(|e| e.id != "e1"); pruned.relations.clear();
        assert!(vault.save(pruned.clone(), &[]).is_err());
        let saved = vault.save(pruned, &["e1".into()]).unwrap();
        assert_eq!(saved.entities.len(), 1); assert!(saved.relations.is_empty());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn redaction_removes_secret_topology_and_masks_private_data() {
        let mut snapshot = Snapshot { revision: 1, entities: vec![entity("e1", "Private source", "PRIVATE"), entity("e2", "Secret target", "SECRET")], relations: vec![domain::Relation { id: "r1".into(), source_id: "e1".into(), kind: "RELATED_TO".into(), target_id: "e2".into(), note: Some("private note".into()), privacy: "PRIVATE".into(), created_at: domain::now() }], events: vec![domain::Event { id: "ev1".into(), entity_id: "e1".into(), kind: "REVIEW".into(), due_at: Some("2026-12-01".into()), recurrence: None, policy: Some("REVIEW".into()), status: "UPCOMING".into(), note: None }] };
        snapshot.entities[0].fields.push(domain::Field { id: "f1".into(), entity_id: "e1".into(), key: "note".into(), value_type: "text".into(), value: "private value".into(), privacy: "PRIVATE".into(), searchable: true, source_of_truth: None });
        let redacted = snapshot.redacted(true);
        assert_eq!(redacted.entities.len(), 1); assert!(redacted.relations.is_empty()); assert!(redacted.events.is_empty());
        assert!(redacted.entities[0].name.starts_with("Asset ")); assert_eq!(redacted.entities[0].fields[0].value, "");
        assert!(!serde_json::to_string(&redacted).unwrap().contains("SECRET"));
    }

}
