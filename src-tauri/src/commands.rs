use crate::{ai, capture, domain::{self, AtlasFile, Result}, sync, vault::VaultService};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T> { serde_json::from_value(args[key].clone()).map_err(|_|format!("参数 {key} 无效")) }

pub fn dispatch(command: &str, args: Value, shared: &Arc<Mutex<VaultService>>) -> Result<Value> {
    if ["ai_chat","ai_health"].contains(&command) {shared.lock().map_err(|_|"Vault 状态不可用")?.touch()?;}
    if command=="ai_chat" {return Ok(json!(ai::chat(&arg(&args,"request")?)?));}
    if command=="ai_health" {return Ok(json!(ai::health(&arg(&args,"config")?)?));}
    let mut vault=shared.lock().map_err(|_|"Vault 状态不可用")?;
    match command {
        "vault_status"=>{vault.expire_if_idle();Ok(json!({"exists":vault.exists(),"unlocked":vault.unlocked(),"entityCount":if vault.unlocked(){vault.load()?.entities.len()}else{0},"deviceUnlockEnabled":false,"idleMinutes":vault.idle_minutes()}))},
        "set_idle_minutes"=>{vault.set_idle_minutes(arg(&args,"minutes")?)?;Ok(Value::Null)},
        "initialize_vault"=>{vault.initialize(&arg::<String>(&args,"password")?)?;sync::initialize_server(&mut vault)?;Ok(Value::Null)},
        "unlock_vault"=>{vault.unlock(&arg::<String>(&args,"password")?)?;sync::initialize_server(&mut vault)?;Ok(Value::Null)},
        "lock_vault"=>{vault.lock();Ok(Value::Null)},
        "load_snapshot"=>Ok(json!(vault.load()?)),
        "save_snapshot"=>Ok(json!(vault.save(arg(&args,"snapshot")?,&args["unlinkIds"].as_array().into_iter().flatten().filter_map(|v|v.as_str().map(String::from)).collect::<Vec<_>>())?)),
        "export_backup"=>Ok(json!(vault.backup()?)),
        "import_backup"=>{let snapshot=vault.restore(&arg::<String>(&args,"payload")?,&arg::<String>(&args,"password")?)?;sync::initialize_server(&mut vault)?;Ok(json!(snapshot))},
        "export_redacted"=>Ok(json!(serde_json::to_string_pretty(&AtlasFile{format:"amiya-atlas".into(),version:1,snapshot:vault.load()?.redacted(arg(&args,"maskPrivate")?)}).map_err(|_|"导出失败")?)),
        "preview_atlas_json"=>{
            let imported=domain::parse_import(&arg::<String>(&args,"text")?)?;let current=vault.load()?;
            Ok(json!({"entityCount":imported.entities.len(),"relationCount":imported.relations.len(),"eventCount":imported.events.len(),"duplicateEntityCount":imported.entities.iter().filter(|e|current.entities.iter().any(|v|v.id==e.id)).count(),"duplicateRelationCount":imported.relations.iter().filter(|r|current.relations.iter().any(|v|v.id==r.id || (v.source_id==r.source_id&&v.kind==r.kind&&v.target_id==r.target_id))).count(),"duplicateEventCount":imported.events.iter().filter(|e|current.events.iter().any(|v|v.id==e.id)).count()}))
        },
        "import_atlas_json"=>{let imported=domain::parse_import(&arg::<String>(&args,"text")?)?;let snapshot=vault.load()?.merge(&imported)?;Ok(json!(vault.save(snapshot,&[])?))},
        "capture_website_account"=>{let req:domain::CaptureRequest=arg(&args,"request")?;Ok(json!(vault.capture(&req.title,&req.url,&req.identity_id)?.0))},
        "begin_text_capture"=>{
            let text:String=arg(&args,"text")?;if text.trim().is_empty()||text.chars().count()>10000{return Err("请输入 1–10000 字的记忆".into());}domain::reject_credential(&text)?;
            let kind=args["inputType"].as_str().unwrap_or("text");if !["text","voice","clipboard"].contains(&kind){return Err("输入来源无效".into());}
            let mut s=vault.load()?;s.captures.push(capture::Capture{id:domain::id(),raw_text:text.trim().into(),input_type:kind.into(),timestamp:domain::now(),status:"PENDING".into()});Ok(json!(vault.save(s,&[])?))
        },
        "stage_proposal"=>{
            let id:String=arg(&args,"captureId")?;let mut content:capture::Proposal=arg(&args,"content")?;let mut s=vault.load()?;
            let input=s.captures.iter().find(|c|c.id==id&&c.status=="PENDING").ok_or("原文已处理")?;capture::stage_versions(&s,&mut content)?;capture::apply_proposal(&s,input,&content)?;
            for p in s.proposals.iter_mut().filter(|p|p.capture_id==id&&p.status=="PENDING"){p.status="DISMISSED".into();}
            s.proposals.push(capture::ProposalRecord{id:domain::id(),capture_id:id,status:"PENDING".into(),content,provider:arg(&args,"provider")?,created_at:domain::now(),entity_ids:vec![],base_revision:Some(s.revision+1),undo:None});Ok(json!(vault.save(s,&[])?))
        },
        "confirm_proposal"=>{let s=vault.load()?;let id:String=arg(&args,"proposalId")?;if s.proposals.iter().any(|p|p.id==id&&p.status=="CONFIRMED"){return Ok(json!(s));}let (next,unlinks)=capture::confirm(&s,&id,&arg(&args,"content")?)?;Ok(json!(vault.save(next,&unlinks)?))},
        "undo_proposal"=>{let (next,unlinks)=capture::undo(&vault.load()?,&arg::<String>(&args,"proposalId")?)?;Ok(json!(vault.save(next,&unlinks)?))},
        "revise_proposal"=>{
            let id:String=arg(&args,"proposalId")?;let content:capture::Proposal=arg(&args,"content")?;let mut s=vault.load()?;
            let p=s.proposals.iter().find(|p|p.id==id&&p.status=="PENDING").ok_or("提案已处理")?;let input=s.captures.iter().find(|c|c.id==p.capture_id&&c.status=="PENDING").ok_or("原文已处理")?;
            capture::guard_staged(&s,p,&content)?;capture::apply_proposal(&s,input,&content)?;let revision=s.revision+1;
            let p=s.proposals.iter_mut().find(|p|p.id==id).unwrap();p.content=content;p.base_revision=Some(revision);Ok(json!(vault.save(s,&[])?))
        },
        "dismiss_capture"=>{let id:String=arg(&args,"captureId")?;let mut s=vault.load()?;s.captures.iter_mut().find(|c|c.id==id&&c.status=="PENDING").ok_or("原文已处理")?.status="DISMISSED".into();for p in s.proposals.iter_mut().filter(|p|p.capture_id==id&&p.status=="PENDING"){p.status="DISMISSED".into();}Ok(json!(vault.save(s,&[])?))},
        "save_ai_config"=>{let config:ai::AiConfig=arg(&args,"config")?;config.validate()?;let mut s=vault.load()?;s.ai_config=Some(config);Ok(json!(vault.save(s,&[])?))},
        "sync_status"=>Ok(json!(sync::status(&vault)?)),
        "sync_configure"=>Ok(json!(sync::configure(&mut vault,arg(&args,"config")?)?)),
        "sync_run"=>Ok(json!(sync::run(&mut vault,args["strategy"].as_str())?)),
        "sync_adopt"=>Ok(json!(sync::adopt(&mut vault,&arg::<String>(&args,"password")?)?)),
        "sync_server_start"=>sync::server_start(&arg::<String>(&args,"url")?),
        "sync_server_poll"=>sync::server_poll(&mut vault,&arg::<String>(&args,"url")?,&arg::<String>(&args,"deviceCode")?,arg(&args,"automatic")?),
        "sync_disconnect"=>{vault.clear_sync()?;Ok(Value::Null)},
        "voice_status"=>Ok(json!({"supported":false,"ready":false,"model":"","prerequisite":null})),
        "quick_capture_status"=>Ok(json!({"enabled":false,"shortcuts":[]})),
        "warm_local_model"=>Ok(Value::Null),
        _=>Err("当前入口不支持此操作".into())
    }
}
