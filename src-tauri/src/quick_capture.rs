use crate::{desktop::AppState, domain::Result};
use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    pub action: &'static str,
    pub key: &'static str,
    pub registered: bool,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCaptureStatus {
    pub enabled: bool,
    pub shortcuts: Vec<ShortcutStatus>,
}
fn bindings() -> [(&'static str, &'static str, Shortcut); 3] {
    #[cfg(target_os = "macos")]
    let modifier = Modifiers::SUPER;
    #[cfg(not(target_os = "macos"))]
    let modifier = Modifiers::CONTROL;
    let capture_modifier = Some(modifier | Modifiers::SHIFT);
    let quick_modifier = Some(modifier | Modifiers::ALT);
    [
        (
            "text",
            "Ctrl/⌘ Shift Space",
            Shortcut::new(capture_modifier, Code::Space),
        ),
        (
            "clipboard",
            "Ctrl/⌘ Alt V",
            Shortcut::new(quick_modifier, Code::KeyV),
        ),
        (
            "voice",
            "Ctrl/⌘ Alt R",
            Shortcut::new(quick_modifier, Code::KeyR),
        ),
    ]
}
pub fn configure(app: &tauri::AppHandle, enabled: bool) -> Result<QuickCaptureStatus> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|_| "无法更新全局快捷键，请重启 Atlas 后重试")?;
    let status = QuickCaptureStatus {
        enabled,
        shortcuts: bindings()
            .into_iter()
            .map(|(action, key, shortcut)| ShortcutStatus {
                action,
                key,
                registered: enabled && app.global_shortcut().register(shortcut).is_ok(),
            })
            .collect(),
    };
    *app.state::<AppState>()
        .quick_capture
        .lock()
        .map_err(|_| "快捷键状态不可用")? = status.clone();
    Ok(status)
}
pub fn initialize(app: &tauri::AppHandle) -> Result<()> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "应用目录不可用")?
        .join("quick-capture-settings.json");
    let enabled = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<bool>(&bytes).ok())
        .unwrap_or(true);
    configure(app, enabled)?;
    Ok(())
}
pub fn save(app: &tauri::AppHandle, enabled: bool) -> Result<QuickCaptureStatus> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "应用目录不可用")?
        .join("quick-capture-settings.json");
    std::fs::write(path, if enabled { "true" } else { "false" })
        .map_err(|_| "快捷键设置保存失败")?;
    configure(app, enabled)
}
pub fn handle(app: &tauri::AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state() != ShortcutState::Pressed {
        return;
    }
    let Some((action, _, _)) = bindings()
        .into_iter()
        .find(|(_, _, binding)| binding == shortcut)
    else {
        return;
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("atlas-quick-capture", action);
    }
}
