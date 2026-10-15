use crate::domain::Result;
use serde::Serialize;
#[derive(Clone,Default,Serialize)]
pub struct QuickCaptureStatus {pub enabled:bool,pub shortcuts:Vec<String>}
pub fn save(_: &tauri::AppHandle,_: bool)->Result<QuickCaptureStatus>{Err("手机端不支持全局快捷键".into())}
