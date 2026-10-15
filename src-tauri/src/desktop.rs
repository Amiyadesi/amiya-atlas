use crate::{ai, capture, cloud, domain, quick_capture, vault, voice, sync};
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
    pub cloud_device: Arc<Mutex<Option<cloud::DeviceFlow>>>,
    pub pending_cloud: Arc<Mutex<Option<cloud::CloudSession>>>,
}
impl Default for AppState {
    fn default() -> Self {
        Self {
            vault: Arc::new(Mutex::new(VaultService::new(PathBuf::new()))),
            local_runtime: Arc::new(Mutex::new(ai::LocalRuntime::default())),
            voice_io: Arc::new(Mutex::new(())),
            voice_cancel: Arc::new(AtomicU64::new(0)),
            quick_capture: Arc::new(Mutex::new(quick_capture::QuickCaptureStatus::default())),
            cloud_device: Arc::new(Mutex::new(None)),
            pending_cloud: Arc::new(Mutex::new(None)),
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
    device_unlock_enabled: bool,
    idle_minutes: u32,
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
        device_unlock_enabled: vault.device_unlock_enabled(),
        idle_minutes: vault.idle_minutes(),
    })
}

#[tauri::command]
fn initialize_vault(password: String, state: State<'_, AppState>) -> Result<()> {
    let mut vault = state.vault.lock().map_err(|_| "Vault 状态不可用")?;
    vault.initialize(&password)?;
    attach_cloud_sign_in(&mut vault, &state.pending_cloud)
}
#[tauri::command]
fn unlock_vault(password: String, state: State<'_, AppState>) -> Result<()> {
    let mut vault = state.vault.lock().map_err(|_| "Vault 状态不可用")?;
    vault.unlock(&password)?;
    attach_cloud_sign_in(&mut vault, &state.pending_cloud)
}
fn attach_cloud_sign_in(vault: &mut VaultService, pending: &Mutex<Option<cloud::CloudSession>>) -> Result<()> {
    let mut pending = pending.lock().map_err(|_| "登录状态不可用")?;
    if let Some(session) = pending.as_ref() {
        if session.expires_at <= chrono::Utc::now().timestamp_millis() { *pending = None; return Err("官网登录已过期，请重新登录".into()); }
        vault.set_cloud_session(Some(session.clone()))?;
        *pending = None;
    }
    Ok(())
}
#[tauri::command]
fn lock_vault(state: State<'_, AppState>) -> Result<()> {
    state.voice_cancel.fetch_add(1, Ordering::SeqCst);
    *state.cloud_device.lock().map_err(|_| "设备登录状态不可用")? = None;
    *state.pending_cloud.lock().map_err(|_| "登录状态不可用")? = None;
    state
        .vault
        .lock()
        .map_err(|_| "Vault 状态不可用".to_string())?
        .lock();
    Ok(())
}
#[tauri::command]
fn set_device_unlock(enabled: bool, state: State<'_, AppState>) -> Result<()> {
    state.vault.lock().map_err(|_| "Vault 状态不可用")?.set_device_unlock(enabled)
}
#[tauri::command]
fn set_idle_minutes(minutes: u32, state: State<'_, AppState>) -> Result<()> {
    state.vault.lock().map_err(|_| "Vault 状态不可用")?.set_idle_minutes(minutes)
}
#[tauri::command]
fn unlock_device(state: State<'_, AppState>) -> Result<()> {
    let mut vault = state.vault.lock().map_err(|_| "Vault 状态不可用")?;
    vault.unlock_device()?;
    attach_cloud_sign_in(&mut vault, &state.pending_cloud)
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
    #[cfg(target_os="android")] { let _=(app,state); return Err("请在输入框长按粘贴".into()); }
    #[cfg(not(target_os="android"))] {
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

#[tauri::command]
async fn sync_status(state: State<'_,AppState>)->Result<sync::Status>{
    let vault=state.vault.clone();tauri::async_runtime::spawn_blocking(move|| {let guard=vault.lock().map_err(|_|"Vault 状态不可用")?;sync::status(&guard)}).await.map_err(|_|"同步状态中断")?
}
#[tauri::command]
async fn sync_configure(config:sync::Config,state:State<'_,AppState>)->Result<sync::Status>{
    let vault=state.vault.clone();tauri::async_runtime::spawn_blocking(move|| {let mut guard=vault.lock().map_err(|_|"Vault 状态不可用")?;sync::configure(&mut guard,config)}).await.map_err(|_|"同步设置中断")?
}
#[tauri::command]
async fn sync_run(strategy:Option<String>,state:State<'_,AppState>)->Result<sync::Status>{
    let vault=state.vault.clone();tauri::async_runtime::spawn_blocking(move|| {let mut guard=vault.lock().map_err(|_|"Vault 状态不可用")?;sync::run(&mut guard,strategy.as_deref())}).await.map_err(|_|"同步中断")?
}
#[tauri::command]
async fn sync_adopt(password:String,state:State<'_,AppState>)->Result<sync::Status>{
    let vault=state.vault.clone();tauri::async_runtime::spawn_blocking(move|| {let mut guard=vault.lock().map_err(|_|"Vault 状态不可用")?;sync::adopt(&mut guard,&password)}).await.map_err(|_|"同步导入中断")?
}
#[tauri::command]
async fn sync_server_start(url:String,app:tauri::AppHandle)->Result<serde_json::Value>{
    tauri::async_runtime::spawn_blocking(move|| {let value=sync::server_start(&url)?;use tauri_plugin_opener::OpenerExt;app.opener().open_url(value["verificationUrl"].as_str().ok_or("授权地址缺失")?,None::<&str>).map_err(|_|"无法打开系统浏览器")?;Ok(value)}).await.map_err(|_|"服务器授权中断")?
}
#[tauri::command]
async fn sync_server_poll(url:String,device_code:String,automatic:bool,state:State<'_,AppState>)->Result<serde_json::Value>{
    let vault=state.vault.clone();tauri::async_runtime::spawn_blocking(move|| {let mut guard=vault.lock().map_err(|_|"Vault 状态不可用")?;sync::server_poll(&mut guard,&url,&device_code,automatic)}).await.map_err(|_|"服务器授权中断")?
}
#[tauri::command]
fn sync_disconnect(state:State<'_,AppState>)->Result<()>{state.vault.lock().map_err(|_|"Vault 状态不可用")?.clear_sync()}

#[tauri::command]
fn web_open(app:tauri::AppHandle)->Result<()> {
    #[cfg(all(feature="web-host",not(target_os="android")))] {
        let guard=app.state::<WebState>();let handle=guard.0.lock().map_err(|_|"网页状态不可用")?;let handle=handle.as_ref().ok_or("网页端口不可用，请检查 5011 是否已占用")?;
        return open::that(format!("http://localhost:{}/#access={}",handle.port,handle.token)).map_err(|_|"无法打开浏览器".into());
    }
    #[cfg(any(not(feature="web-host"),target_os="android"))] {let _=app;Err("手机端不提供本机网页服务".into())}
}
#[cfg(all(feature="web-host",not(target_os="android")))]
#[derive(Default)]
struct WebState(Mutex<Option<crate::http::WebHandle>>);

#[tauri::command]
async fn save_export_file(filename:String,payload:String,app:tauri::AppHandle)->Result<bool>{
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_fs::{FsExt,OpenOptions};
    if payload.len()>128*1024*1024||!filename.ends_with(".json")||filename.contains(['/', '\\']){return Err("导出文件无效".into());}
    tauri::async_runtime::spawn_blocking(move||{
        let Some(path)=app.dialog().file().set_file_name(filename).add_filter("JSON",&["json"]).blocking_save_file() else{return Ok(false);};
        let mut file=app.fs().open(path,OpenOptions::new().write(true).create(true).truncate(true).clone()).map_err(|_|"无法写入所选文件")?;
        use std::io::Write;file.write_all(payload.as_bytes()).map_err(|_|"导出写入失败")?;file.sync_all().map_err(|_|"导出保存失败")?;Ok(true)
    }).await.map_err(|_|"导出中断")?
}
#[tauri::command]
async fn read_import_file(app:tauri::AppHandle)->Result<Option<String>>{
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_fs::{FsExt,OpenOptions};
    use std::io::Read;
    tauri::async_runtime::spawn_blocking(move||{
        let Some(path)=app.dialog().file().add_filter("JSON",&["json"]).blocking_pick_file() else{return Ok(None);};
        let file=app.fs().open(path,OpenOptions::new().read(true).clone()).map_err(|_|"无法读取所选文件")?;
        let mut text=String::new();file.take(128*1024*1024+1).read_to_string(&mut text).map_err(|_|"文件不是 UTF-8 JSON")?;
        if text.len()>128*1024*1024{return Err("文件超过容量限制".into());}Ok(Some(text))
    }).await.map_err(|_|"文件读取中断")?
}

#[tauri::command]
fn cloud_status(state: State<'_, AppState>) -> Result<serde_json::Value> {
    let vault=state.vault.lock().map_err(|_|"Vault 状态不可用")?;
    let session=vault.load()?.cloud_session;
    Ok(match session {Some(value)=>serde_json::json!({"connected":value.expires_at>chrono::Utc::now().timestamp_millis(),"email":value.email,"expiresAt":value.expires_at}),None=>serde_json::json!({"connected":false})})
}
#[tauri::command]
async fn cloud_device_start(app:tauri::AppHandle,state: State<'_, AppState>) -> Result<serde_json::Value> {
    let device=state.cloud_device.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let value=cloud::request("/api/auth/device/code",Some(&serde_json::json!({"client_id":"relakeep-desktop"})),None)?;
        let code=value["device_code"].as_str().ok_or("设备码缺失")?.to_string();
        let user_code=value["user_code"].as_str().ok_or("设备显示码缺失")?;
        if code.len()>500||user_code.len()>16||!user_code.chars().all(|c|c.is_ascii_alphanumeric()||c=='-') {return Err("设备响应无效".into());}
        let expires=value["expires_in"].as_i64().filter(|v|*v>0&&*v<=900).ok_or("设备有效期无效")?;
        *device.lock().map_err(|_|"设备登录状态不可用")?=Some(cloud::DeviceFlow{code,expires_at:chrono::Utc::now().timestamp_millis()+expires*1000});
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_url(format!("{}/device?user_code={user_code}",cloud::ORIGIN),None::<&str>).map_err(|_|"无法打开系统浏览器")?;
        Ok(serde_json::json!({"userCode":user_code,"expiresIn":expires,"interval":5}))
    }).await.map_err(|_|"设备登录中断")?
}
#[tauri::command]
async fn cloud_device_poll(state: State<'_, AppState>) -> Result<serde_json::Value> {
    let code={let guard=state.cloud_device.lock().map_err(|_|"设备登录状态不可用")?;let flow=guard.as_ref().ok_or("请先发起桌面登录")?;
        if flow.expires_at<=chrono::Utc::now().timestamp_millis(){return Err("设备码已过期，请重新连接".into());}flow.code.clone()};
    let vault=state.vault.clone();let device=state.cloud_device.clone();let pending=state.pending_cloud.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let code=zeroize::Zeroizing::new(code);
        let response=cloud::request("/api/auth/device/token",Some(&serde_json::json!({"client_id":"relakeep-desktop","device_code":code.as_str(),"grant_type":"urn:ietf:params:oauth:grant-type:device_code"})),None)?;
        if response["pending"]==true {return Ok(response);}
        let token=response["access_token"].as_str().ok_or("云会话缺失")?.to_string();
        let seconds=response["expires_in"].as_i64().filter(|v|*v>0&&*v<=60*60*24*31).ok_or("云会话有效期无效")?;
        let info=cloud::request("/api/auth/get-session",None,Some(&token))?;
        let email=info["user"]["email"].as_str().ok_or("云账户缺失")?.to_string();
        let mut guard=device.lock().map_err(|_|"设备登录状态不可用")?;
        if guard.as_ref().map(|f|f.code.as_str())!=Some(code.as_str()) {return Err("设备登录已取消".into());}
        let session=cloud::CloudSession{token,email,expires_at:chrono::Utc::now().timestamp_millis()+seconds*1000};
        let mut vault=vault.lock().map_err(|_|"Vault 状态不可用")?;
        if !vault.unlocked() && vault.device_unlock_enabled() { vault.unlock_device()?; }
        if vault.unlocked() { vault.set_cloud_session(Some(session))?; }
        else { *pending.lock().map_err(|_|"登录状态不可用")?=Some(session); }
        *guard=None;Ok(serde_json::json!({"connected":true}))
    }).await.map_err(|_|"设备登录中断")?
}
#[tauri::command]
async fn cloud_logout(state: State<'_, AppState>) -> Result<()> {
    *state.cloud_device.lock().map_err(|_|"设备登录状态不可用")?=None;
    let token={let mut vault=state.vault.lock().map_err(|_|"Vault 状态不可用")?;let session=vault.load()?.cloud_session;vault.set_cloud_session(None)?;session};
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(session)=token {cloud::request("/api/auth/sign-out",Some(&serde_json::json!({})),Some(&session.token))?;}Ok(())
    }).await.map_err(|_|"云退出中断")?
}
#[tauri::command]
async fn cloud_request(path:String,body:Option<serde_json::Value>,state:State<'_,AppState>)->Result<serde_json::Value> {
    if !["/api/account/balance","/api/account/ai","/api/account/checkout","/api/account/portal","/api/features"].contains(&path.as_str()) {return Err("云接口无效".into());}
    let session={let mut vault=state.vault.lock().map_err(|_|"Vault 状态不可用")?;vault.touch()?;vault.load()?.cloud_session};
    if path!="/api/features" && !session.as_ref().is_some_and(|s|s.expires_at>chrono::Utc::now().timestamp_millis()){return Err("请先在设置中登录官网云账户".into());}
    let vault=state.vault.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let value=cloud::request(&path,body.as_ref(),session.as_ref().map(|s|s.token.as_str()))?;
        vault.lock().map_err(|_|"Vault 状态不可用")?.touch()?;
        Ok(value)
    }).await.map_err(|_|"云请求中断")?
}
#[tauri::command]
fn cloud_open(path:String,app:tauri::AppHandle)->Result<()> {
    if !["/login","/pricing","/account","/guide","/privacy","/refunds"].contains(&path.as_str()){return Err("官网页面无效".into());}
    use tauri_plugin_opener::OpenerExt;app.opener().open_url(format!("{}{path}",cloud::ORIGIN),None::<&str>).map_err(|_|"无法打开浏览器".into())
}
#[tauri::command]
fn cloud_open_payment(url:String)->Result<()> {cloud::open_payment(&url)}

#[cfg_attr(target_os="android",tauri::mobile_entry_point)]
pub fn run() {
    let builder=tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(not(target_os="android"))]
    let builder=builder.plugin(tauri_plugin_clipboard_manager::init()).plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(quick_capture::handle)
                .build(),
        );
    #[cfg(all(feature="web-host",not(target_os="android")))]
    let builder=builder.manage(WebState::default());
    builder.manage(AppState::default())
        .setup(|app| {
            let state = app.state::<AppState>();
            let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
            state.vault.lock().map_err(|_| "Vault 状态不可用")?.path = app_dir.join("atlas.sqlite");
            #[cfg(not(target_os="android"))] {
                #[cfg(target_os="windows")]
                crate::bridge::start(state.vault.clone());
                quick_capture::initialize(app.handle())?;
            }
            #[cfg(all(feature="web-host",not(target_os="android")))] {
                match crate::http::start(state.vault.clone(),"127.0.0.1:5011",crate::hex_token(),"http://localhost:5011".into()){
                    Ok(handle)=>*app.state::<WebState>().0.lock().map_err(|_|"网页状态不可用")?=Some(handle),
                    Err(error)=>eprintln!("Local web: {error}"),
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_status,
            set_idle_minutes,
            initialize_vault,
            unlock_vault,
            lock_vault,
            set_device_unlock,
            unlock_device,
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
            set_quick_capture_enabled,
            cloud_status,
            cloud_device_start,
            cloud_device_poll,
            cloud_logout,
            cloud_request,
            cloud_open,
            cloud_open_payment
            ,sync_status,sync_configure,sync_run,sync_adopt,sync_disconnect,sync_server_start,sync_server_poll,web_open,save_export_file,read_import_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Relakeep");
}
