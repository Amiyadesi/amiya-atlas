use crate::{ai, bridge, capture, domain, quick_capture, vault, voice};
use domain::{AtlasFile, CaptureRequest, GraphService, Result, Snapshot};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager, State};
use vault::VaultService;

#[derive(Clone)]
pub struct AppState {
    pub vault: Arc<Mutex<VaultService>>,
    pub local_runtime: Arc<Mutex<ai::LocalRuntime>>,
    pub voice_io: Arc<Mutex<()>>,
    pub voice_cancel: Arc<AtomicU64>,
    pub quick_capture: Arc<Mutex<quick_capture::QuickCaptureStatus>>,
}
impl Default for AppState {
    fn default() -> Self {
        Self {
            vault: Arc::new(Mutex::new(VaultService::new(PathBuf::new()))),
            local_runtime: Arc::new(Mutex::new(ai::LocalRuntime::default())),
            voice_io: Arc::new(Mutex::new(())),
            voice_cancel: Arc::new(AtomicU64::new(0)),
            quick_capture: Arc::new(Mutex::new(quick_capture::QuickCaptureStatus::default())),
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
    state.voice_cancel.fetch_add(1, Ordering::SeqCst);
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
fn begin_text_capture(
    text: String,
    input_type: Option<String>,
    state: State<'_, AppState>,
) -> Result<Snapshot> {
    if text.trim().is_empty() || text.chars().count() > 10000 {
        return Err("请输入 1–10000 字的记忆".into());
    }
    domain::reject_credential(&text)?;
    let input_type = input_type.unwrap_or_else(|| "text".into());
    if !["text", "clipboard", "voice"].contains(&input_type.as_str()) {
        return Err("输入来源无效".into());
    }
    let mut vault = state.vault.lock().map_err(|_| "Vault 状态不可用")?;
    let mut snapshot = vault.load()?;
    snapshot.captures.push(capture::Capture {
        id: domain::id(),
        raw_text: text.trim().into(),
        input_type,
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
    capture::stage_versions(&snapshot, &mut content)?;
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
        base_revision: Some(snapshot.revision + 1),
        undo: None,
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
    if snapshot
        .proposals
        .iter()
        .any(|p| p.id == proposal_id && p.status == "CONFIRMED")
    {
        return Ok(snapshot);
    }
    let (next, unlink_ids) = capture::confirm(&snapshot, &proposal_id, &content)?;
    vault.save(next, &unlink_ids)
}
#[tauri::command]
fn undo_proposal(proposal_id: String, state: State<'_, AppState>) -> Result<Snapshot> {
    let mut vault = state.vault.lock().map_err(|_| "Vault 状态不可用")?;
    let snapshot = vault.load()?;
    let (next, unlink_ids) = capture::undo(&snapshot, &proposal_id)?;
    vault.save(next, &unlink_ids)
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
    capture::guard_staged(&snapshot, record, &content)?;
    capture::apply_proposal(&snapshot, input, &content)?;
    snapshot
        .proposals
        .iter_mut()
        .find(|p| p.id == proposal_id)
        .unwrap()
        .content = content;
    snapshot
        .proposals
        .iter_mut()
        .find(|p| p.id == proposal_id)
        .unwrap()
        .base_revision = Some(snapshot.revision + 1);
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
async fn prepare_local_model(
    model: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<()> {
    state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用")?
        .touch()?;
    let runtime = state.local_runtime.clone();
    let dir = app.path().app_data_dir().map_err(|_| "应用目录不可用")?;
    let model = model.unwrap_or_else(|| ai::DEFAULT_MODEL.into());
    tauri::async_runtime::spawn_blocking(move || {
        runtime
            .lock()
            .map_err(|_| "本地模型状态不可用")?
            .prepare(&dir, &model, |progress| {
                let _ = app.emit("atlas-model-progress", progress);
            })
    })
    .await
    .map_err(|_| "模型准备中断".to_string())?
}

#[tauri::command]
async fn warm_local_model(
    config: ai::AiConfig,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<()> {
    state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用")?
        .touch()?;
    let runtime = state.local_runtime.clone();
    let dir = app.path().app_data_dir().map_err(|_| "应用目录不可用")?;
    tauri::async_runtime::spawn_blocking(move || {
        if config.kind != "local" {
            return Ok(());
        }
        runtime
            .lock()
            .map_err(|_| "本地模型状态不可用")?
            .start(&dir)?;
        ai::warm(&config)
    })
    .await
    .map_err(|_| "模型预热中断".to_string())?
}
#[tauri::command]
fn voice_status(app: tauri::AppHandle) -> Result<voice::VoiceStatus> {
    Ok(voice::status(
        &app.path().app_data_dir().map_err(|_| "应用目录不可用")?,
    ))
}
#[tauri::command]
fn open_voice_prerequisite() -> Result<()> {
    open::that("https://aka.ms/vc14/vc_redist.x64.exe")
        .map_err(|_| "无法打开官方下载，请使用浏览器访问 Microsoft Visual C++ v14 下载页".into())
}
#[tauri::command]
async fn prepare_voice_model(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<()> {
    state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用")?
        .touch()?;
    let guard = state.voice_io.clone();
    let dir = app.path().app_data_dir().map_err(|_| "应用目录不可用")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard.try_lock().map_err(|_| "语音正在使用，请稍后重试")?;
        voice::prepare(&dir, |progress| {
            let _ = app.emit("atlas-voice-progress", progress);
        })
    })
    .await
    .map_err(|_| "语音准备中断".to_string())?
}
#[tauri::command]
async fn transcribe_voice(
    wav_base64: String,
    language: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用")?
        .touch()?;
    if wav_base64.len() > ((voice::MAX_WAV_BYTES + 2) / 3) * 4 {
        return Err("录音超过 60 秒".into());
    }
    let encoded = zeroize::Zeroizing::new(wav_base64);
    let wav = STANDARD
        .decode(encoded.as_bytes())
        .map_err(|_| "录音编码无效")?;
    let guard = state.voice_io.clone();
    let cancel = state.voice_cancel.clone();
    let generation = cancel.load(Ordering::SeqCst);
    let dir = app.path().app_data_dir().map_err(|_| "应用目录不可用")?;
    let text = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard
            .try_lock()
            .map_err(|_| "已有语音正在转写，请稍后重试")?;
        voice::transcribe(&dir, wav, &language, generation, &cancel)
    })
    .await
    .map_err(|_| "语音转写中断")??;
    state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用")?
        .touch()?;
    Ok(text)
}
#[tauri::command]
fn cancel_voice_transcription(state: State<'_, AppState>) {
    state.voice_cancel.fetch_add(1, Ordering::SeqCst);
}
#[tauri::command]
fn read_capture_clipboard(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用")?
        .touch()?;
    let text = app
        .clipboard()
        .read_text()
        .map_err(|_| "无法读取剪贴板文字，请手动粘贴")?;
    if text.trim().is_empty() || text.chars().count() > 10000 {
        return Err("剪贴板需要 1–10000 字的文字".into());
    }
    domain::reject_credential(&text)?;
    Ok(text.trim().into())
}
#[tauri::command]
fn quick_capture_status(state: State<'_, AppState>) -> Result<quick_capture::QuickCaptureStatus> {
    Ok(state
        .quick_capture
        .lock()
        .map_err(|_| "快捷键状态不可用")?
        .clone())
}
#[tauri::command]
fn set_quick_capture_enabled(
    enabled: bool,
    app: tauri::AppHandle,
) -> Result<quick_capture::QuickCaptureStatus> {
    quick_capture::save(&app, enabled)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(quick_capture::handle)
                .build(),
        )
        .manage(AppState::default())
        .setup(|app| {
            let state = app.state::<AppState>();
            let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
            state.vault.lock().map_err(|_| "Vault 状态不可用")?.path = app_dir.join("atlas.sqlite");
            bridge::start(state.vault.clone());
            quick_capture::initialize(app.handle())?;
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
            undo_proposal,
            revise_proposal,
            dismiss_capture,
            save_ai_config,
            ai_health,
            ai_chat,
            prepare_local_model,
            warm_local_model,
            voice_status,
            open_voice_prerequisite,
            prepare_voice_model,
            transcribe_voice,
            cancel_voice_transcription,
            read_capture_clipboard,
            quick_capture_status,
            set_quick_capture_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running Amiya Atlas");
}
