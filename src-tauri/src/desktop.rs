use crate::{ai, bridge, capture, domain, vault};
use domain::{AtlasFile, CaptureRequest, GraphService, Result, Snapshot};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager, State};
use vault::VaultService;

#[derive(Clone)]
pub struct AppState {
    pub vault: Arc<Mutex<VaultService>>,
    pub local_runtime: Arc<Mutex<ai::LocalRuntime>>,
}
impl Default for AppState {
    fn default() -> Self {
        Self {
            vault: Arc::new(Mutex::new(VaultService::new(PathBuf::new()))),
            local_runtime: Arc::new(Mutex::new(ai::LocalRuntime::default())),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    exists: bool,
    unlocked: bool,
    entity_count: usize,
    bridge_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportPreview {
    entity_count: usize,
    relation_count: usize,
    event_count: usize,
    duplicate_entity_count: usize,
    duplicate_relation_count: usize,
    duplicate_event_count: usize,
}

#[tauri::command]
fn vault_status(state: State<'_, AppState>) -> Result<Status> {
    let mut vault = state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用".to_string())?;
    vault.expire_if_idle();
    let count = if vault.unlocked() {
        vault.load().map(|s| s.entities.len()).unwrap_or(0)
    } else {
        0
    };
    Ok(Status {
        exists: vault.exists(),
        unlocked: vault.unlocked(),
        entity_count: count,
        bridge_error: None,
    })
}

#[tauri::command]
fn initialize_vault(password: String, state: State<'_, AppState>) -> Result<()> {
    state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用".to_string())?
        .initialize(&password)
}
#[tauri::command]
fn unlock_vault(password: String, state: State<'_, AppState>) -> Result<()> {
    state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用".to_string())?
        .unlock(&password)
        .map(|_| ())
}
#[tauri::command]
fn lock_vault(state: State<'_, AppState>) -> Result<()> {
    state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用".to_string())?
        .lock();
    Ok(())
}
#[tauri::command]
fn load_snapshot(state: State<'_, AppState>) -> Result<Snapshot> {
    state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用".to_string())?
        .load()
}
#[tauri::command]
fn save_snapshot(
    snapshot: Snapshot,
    unlink_ids: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Snapshot> {
    state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用".to_string())?
        .save(snapshot, &unlink_ids.unwrap_or_default())
}

#[tauri::command]
fn search_snapshot(query: String, state: State<'_, AppState>) -> Result<Vec<String>> {
    let vault = state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用".to_string())?;
    Ok(GraphService::search(&vault.load()?, &query))
}
#[tauri::command]
fn impact_lookup(
    entity_id: String,
    hops: usize,
    state: State<'_, AppState>,
) -> Result<Vec<String>> {
    let vault = state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用".to_string())?;
    Ok(GraphService::impact(&vault.load()?, &entity_id, hops))
}

#[tauri::command]
fn import_atlas_json(text: String, state: State<'_, AppState>) -> Result<Snapshot> {
    let imported = domain::parse_import(&text)?;
    let mut vault = state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用".to_string())?;
    let current = vault.load()?;
    vault.save(current.merge(&imported)?, &[])
}

#[tauri::command]
fn preview_atlas_json(text: String, state: State<'_, AppState>) -> Result<ImportPreview> {
    let imported = domain::parse_import(&text)?;
    let vault = state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用".to_string())?;
    let current = vault.load()?;
    let entity_ids: std::collections::HashSet<_> = current
        .entities
        .iter()
        .map(|entity| entity.id.as_str())
        .collect();
    let relation_ids: std::collections::HashSet<_> = current
        .relations
        .iter()
        .map(|relation| relation.id.as_str())
        .collect();
    let event_ids: std::collections::HashSet<_> = current
        .events
        .iter()
        .map(|event| event.id.as_str())
        .collect();
    let relation_keys: std::collections::HashSet<_> = current
        .relations
        .iter()
        .map(|relation| {
            (
                relation.source_id.as_str(),
                relation.kind.as_str(),
                relation.target_id.as_str(),
            )
        })
        .collect();
    Ok(ImportPreview {
        entity_count: imported.entities.len(),
        relation_count: imported.relations.len(),
        event_count: imported.events.len(),
        duplicate_entity_count: imported
            .entities
            .iter()
            .filter(|entity| entity_ids.contains(entity.id.as_str()))
            .count(),
        duplicate_relation_count: imported
            .relations
            .iter()
            .filter(|relation| {
                relation_ids.contains(relation.id.as_str())
                    || relation_keys.contains(&(
                        relation.source_id.as_str(),
                        relation.kind.as_str(),
                        relation.target_id.as_str(),
                    ))
            })
            .count(),
        duplicate_event_count: imported
            .events
            .iter()
            .filter(|event| event_ids.contains(event.id.as_str()))
            .count(),
    })
}

#[tauri::command]
fn export_redacted(mask_private: bool, state: State<'_, AppState>) -> Result<String> {
    let vault = state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用".to_string())?;
    let snapshot = vault.load()?.redacted(mask_private);
    serde_json::to_string_pretty(&AtlasFile {
        format: "amiya-atlas".into(),
        version: 1,
        snapshot,
    })
    .map_err(|_| "导出失败".into())
}

#[tauri::command]
fn export_backup(state: State<'_, AppState>) -> Result<String> {
    state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用".to_string())?
        .backup()
}
#[tauri::command]
fn import_backup(
    payload: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<Snapshot> {
    state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用".to_string())?
        .restore(&payload, &password)
}
#[tauri::command]
fn capture_website_account(
    request: CaptureRequest,
    state: State<'_, AppState>,
) -> Result<Snapshot> {
    state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用".to_string())?
        .capture(&request.title, &request.url, &request.identity_id)
        .map(|(snapshot, _)| snapshot)
}

#[tauri::command]
fn open_vaultwarden(reference: String) -> Result<()> {
    domain::valid_url(&reference)?;
    open::that(reference).map_err(|_| "无法打开 Vaultwarden 引用".into())
}

#[tauri::command]
fn begin_text_capture(text: String, state: State<'_, AppState>) -> Result<Snapshot> {
    if text.trim().is_empty() || text.chars().count() > 10000 {
        return Err("请输入 1–10000 字的记忆".into());
    }
    domain::reject_credential(&text)?;
    let mut vault = state.vault.lock().map_err(|_| "Vault 状态不可用")?;
    let mut snapshot = vault.load()?;
    snapshot.captures.push(capture::Capture {
        id: domain::id(),
        raw_text: text.trim().into(),
        input_type: "text".into(),
        timestamp: domain::now(),
        status: "PENDING".into(),
    });
    vault.save(snapshot, &[])
}
#[tauri::command]
fn stage_proposal(
    capture_id: String,
    mut content: capture::Proposal,
    provider: String,
    state: State<'_, AppState>,
) -> Result<Snapshot> {
    let mut vault = state.vault.lock().map_err(|_| "Vault 状态不可用")?;
    let mut snapshot = vault.load()?;
    let input = snapshot
        .captures
        .iter()
        .find(|c| c.id == capture_id && c.status == "PENDING")
        .ok_or("原始输入不存在或已处理")?;
    for item in &mut content.entities_to_update {
        let entity = snapshot
            .entities
            .iter()
            .find(|e| Some(&e.id) == item.id.as_ref() && e.privacy != "SECRET")
            .ok_or("待更新实体不存在")?;
        item.expected_updated_at = Some(entity.updated_at.clone());
    }
    capture::apply_proposal(&snapshot, input, &content)?;
    for record in snapshot
        .proposals
        .iter_mut()
        .filter(|p| p.capture_id == capture_id && p.status == "PENDING")
    {
        record.status = "DISMISSED".into();
    }
    snapshot.proposals.push(capture::ProposalRecord {
        id: domain::id(),
        capture_id,
        status: "PENDING".into(),
        content,
        provider,
        created_at: domain::now(),
        entity_ids: vec![],
    });
    vault.save(snapshot, &[])
}
#[tauri::command]
fn confirm_proposal(
    proposal_id: String,
    content: capture::Proposal,
    state: State<'_, AppState>,
) -> Result<Snapshot> {
    let mut vault = state.vault.lock().map_err(|_| "Vault 状态不可用")?;
    let snapshot = vault.load()?;
    let record = snapshot
        .proposals
        .iter()
        .find(|p| p.id == proposal_id)
        .ok_or("提案不存在")?;
    if record.status == "CONFIRMED" {
        return Ok(snapshot);
    }
    if record.status != "PENDING" {
        return Err("提案已被撤回，请重新解析".into());
    }
    let input = snapshot
        .captures
        .iter()
        .find(|c| c.id == record.capture_id && c.status == "PENDING")
        .ok_or("原文已处理")?;
    // Preserve the staged version guard, even when the user edits the other proposal fields.
    for update in &content.entities_to_update {
        let staged = record
            .content
            .entities_to_update
            .iter()
            .find(|u| u.id == update.id)
            .ok_or("修改目标已变化，请重新解析")?;
        if update.expected_updated_at != staged.expected_updated_at {
            return Err("提案版本已变化，请重新解析".into());
        }
    }
    let (mut next, entity_ids) = capture::apply_proposal(&snapshot, input, &content)?;
    let proposal = next
        .proposals
        .iter_mut()
        .find(|p| p.id == proposal_id)
        .unwrap();
    proposal.status = "CONFIRMED".into();
    proposal.content = content;
    proposal.entity_ids = entity_ids;
    next.captures
        .iter_mut()
        .find(|c| c.id == record.capture_id)
        .unwrap()
        .status = "CONFIRMED".into();
    vault.save(next, &[])
}
#[tauri::command]
fn revise_proposal(
    proposal_id: String,
    content: capture::Proposal,
    state: State<'_, AppState>,
) -> Result<Snapshot> {
    let mut vault = state.vault.lock().map_err(|_| "Vault 状态不可用")?;
    let mut snapshot = vault.load()?;
    let record = snapshot
        .proposals
        .iter()
        .find(|p| p.id == proposal_id && p.status == "PENDING")
        .ok_or("提案不存在或已处理")?;
    let input = snapshot
        .captures
        .iter()
        .find(|c| c.id == record.capture_id && c.status == "PENDING")
        .ok_or("原文已处理")?;
    for update in &content.entities_to_update {
        let staged = record
            .content
            .entities_to_update
            .iter()
            .find(|u| u.id == update.id)
            .ok_or("修改目标已变化，请重新解析")?;
        if update.expected_updated_at != staged.expected_updated_at {
            return Err("提案版本已变化，请重新解析".into());
        }
    }
    capture::apply_proposal(&snapshot, input, &content)?;
    snapshot
        .proposals
        .iter_mut()
        .find(|p| p.id == proposal_id)
        .unwrap()
        .content = content;
    vault.save(snapshot, &[])
}
#[tauri::command]
fn dismiss_capture(capture_id: String, state: State<'_, AppState>) -> Result<Snapshot> {
    let mut vault = state.vault.lock().map_err(|_| "Vault 状态不可用")?;
    let mut snapshot = vault.load()?;
    let input = snapshot
        .captures
        .iter_mut()
        .find(|c| c.id == capture_id && c.status == "PENDING")
        .ok_or("原文不存在或已处理")?;
    input.status = "DISMISSED".into();
    for record in snapshot
        .proposals
        .iter_mut()
        .filter(|p| p.capture_id == capture_id && p.status == "PENDING")
    {
        record.status = "DISMISSED".into();
    }
    vault.save(snapshot, &[])
}
#[tauri::command]
fn save_ai_config(config: ai::AiConfig, state: State<'_, AppState>) -> Result<Snapshot> {
    config.validate()?;
    let mut vault = state.vault.lock().map_err(|_| "Vault 状态不可用")?;
    let mut snapshot = vault.load()?;
    snapshot.ai_config = Some(config);
    vault.save(snapshot, &[])
}
#[tauri::command]
async fn ai_health(
    config: ai::AiConfig,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<bool> {
    let runtime = state.local_runtime.clone();
    let dir = app.path().app_data_dir().map_err(|_| "应用目录不可用")?;
    tauri::async_runtime::spawn_blocking(move || {
        if config.kind == "local"
            && runtime
                .lock()
                .map_err(|_| "本地模型状态不可用")?
                .start(&dir)
                .is_err()
        {
            return Ok(false);
        }
        ai::health(&config)
    })
    .await
    .map_err(|_| "模型检查中断".to_string())?
}
#[tauri::command]
async fn ai_chat(
    request: ai::ChatRequest,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String> {
    // Require an unlocked vault even though this command has no data-writing capability.
    state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用")?
        .touch()?;
    let runtime = state.local_runtime.clone();
    let dir = app.path().app_data_dir().map_err(|_| "应用目录不可用")?;
    tauri::async_runtime::spawn_blocking(move || {
        if request.config.kind == "local" {
            runtime
                .lock()
                .map_err(|_| "本地模型状态不可用")?
                .start(&dir)?;
        }
        ai::chat(&request)
    })
    .await
    .map_err(|_| "模型请求中断".to_string())?
}
#[tauri::command]
async fn prepare_local_model(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<()> {
    state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用")?
        .touch()?;
    let runtime = state.local_runtime.clone();
    let dir = app.path().app_data_dir().map_err(|_| "应用目录不可用")?;
    tauri::async_runtime::spawn_blocking(move || {
        runtime
            .lock()
            .map_err(|_| "本地模型状态不可用")?
            .prepare(&dir, |progress| {
                let _ = app.emit("atlas-model-progress", progress);
            })
    })
    .await
    .map_err(|_| "模型准备中断".to_string())?
}

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
        .invoke_handler(tauri::generate_handler![
            vault_status,
            initialize_vault,
            unlock_vault,
            lock_vault,
            load_snapshot,
            save_snapshot,
            search_snapshot,
            impact_lookup,
            import_atlas_json,
            preview_atlas_json,
            export_redacted,
            export_backup,
            import_backup,
            capture_website_account,
            open_vaultwarden,
            begin_text_capture,
            stage_proposal,
            confirm_proposal,
            revise_proposal,
            dismiss_capture,
            save_ai_config,
            ai_health,
            ai_chat,
            prepare_local_model
        ])
        .run(tauri::generate_context!())
        .expect("error while running Amiya Atlas");
}
