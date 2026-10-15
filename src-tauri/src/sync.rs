use crate::{domain::{Result, Snapshot}, vault::VaultService};
use reqwest::{blocking::{Client, Response}, header::{ETAG, IF_MATCH, IF_NONE_MATCH}, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, io::Read, time::Duration};
use zeroize::Zeroizing;

const LIMIT: u64 = 128 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config { #[serde(default = "webdav")] pub kind: String, pub url: String, pub username: String, pub password: String, pub automatic: bool }
fn webdav() -> String { "webdav".into() }
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State { config: Config, baseline: Option<Snapshot>, last_sync: Option<String>, #[serde(default)] conflicts: Vec<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status { pub configured: bool, pub kind: String, pub url: String, pub username: String, pub automatic: bool, pub last_sync: Option<String>, pub conflicts: Vec<String> }

fn read(vault: &VaultService) -> Result<Option<State>> {
    vault.read_local("sync")?.map(|bytes| serde_json::from_slice(&bytes).map_err(|_| "同步设置损坏".into())).transpose()
}
fn write(vault: &VaultService, state: &State) -> Result<()> {
    vault.seal_local("sync", &Zeroizing::new(serde_json::to_vec(state).map_err(|_| "同步设置编码失败")?))
}
pub fn status(vault: &VaultService) -> Result<Status> {
    Ok(match read(vault)? { Some(s) => view(&s, s.conflicts.clone()), None => Status {configured:false,kind:webdav(),url:String::new(),username:String::new(),automatic:false,last_sync:None,conflicts:vec![]} })
}
fn view(s: &State, conflicts: Vec<String>) -> Status { Status {configured:true,kind:s.config.kind.clone(),url:s.config.url.clone(),username:s.config.username.clone(),automatic:s.config.automatic,last_sync:s.last_sync.clone(),conflicts} }
pub fn configure(vault: &mut VaultService, mut config: Config) -> Result<Status> {
    vault.touch()?;
    config.url = config.url.trim().to_string();
    if !["webdav","server"].contains(&config.kind.as_str()) {return Err("同步类型无效".into());}
    let parsed = url::Url::parse(&config.url).map_err(|_| "WebDAV 地址无效")?;
    let loopback = matches!(parsed.host_str(), Some("localhost"|"127.0.0.1"|"[::1]"));
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() || parsed.query().is_some() || parsed.fragment().is_some() || !(parsed.scheme()=="https" || parsed.scheme()=="http" && loopback) || config.username.len()>500 || config.password.len()>8192 { return Err("WebDAV 需要 HTTPS；本机可用 HTTP。填写不含账号密码的文件地址。".into()); }
    if config.url.ends_with('/') { config.url.push_str("relakeep.atlas-backup.json"); }
    let previous = read(vault)?;
    let same = previous.as_ref().is_some_and(|s| s.config.kind==config.kind && s.config.url==config.url && s.config.username==config.username);
    if config.password.is_empty() {
        if same { config.password = previous.as_ref().unwrap().config.password.clone(); }
        else { return Err("请输入 WebDAV 应用密码".into()); }
    }
    let state = State { config, baseline:if same {previous.as_ref().unwrap().baseline.clone()} else {None},last_sync:if same {previous.as_ref().unwrap().last_sync.clone()} else {None}, conflicts:vec![] };
    write(vault, &state)?;
    Ok(view(&state, vec![]))
}
fn client() -> Result<Client> { Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(40)).build().map_err(|_| "同步网络不可用".into()) }
fn authorize(req: reqwest::blocking::RequestBuilder, config: &Config) -> reqwest::blocking::RequestBuilder { if config.kind=="server" {req.bearer_auth(&config.password)} else {req.basic_auth(&config.username,Some(&config.password))} }
fn remote(client: &Client, config: &Config) -> Result<Option<(String,String)>> {
    let response = authorize(client.get(&config.url).header("Accept-Encoding","identity"),config).send().map_err(|_| "连接失败，稍后自动重试")?;
    if response.status()==StatusCode::NOT_FOUND { return Ok(None); }
    if response.status()==StatusCode::UNAUTHORIZED && config.kind=="server" {return Err("服务器登录已过期，请重新连接".into());}
    if !response.status().is_success() { return Err(format!("WebDAV 返回 {}",response.status().as_u16())); }
    let etag = response.headers().get(ETAG).and_then(|h|h.to_str().ok()).filter(|tag| tag.starts_with('"') && tag.ends_with('"')).ok_or("WebDAV 未提供强 ETag，无法保护并发修改")?.to_string();
    Ok(Some((body(response)?,etag)))
}
fn body(response: Response) -> Result<String> {
    if response.content_length().is_some_and(|size|size>LIMIT) {return Err("同步文件过大".into());}
    let mut bytes=Vec::new();response.take(LIMIT+1).read_to_end(&mut bytes).map_err(|_|"同步下载失败")?;
    if bytes.len() as u64>LIMIT{return Err("同步文件过大".into());}
    String::from_utf8(bytes).map_err(|_|"远端文件编码无效".into())
}
fn put(client: &Client, config: &Config, payload: String, etag: Option<&str>) -> Result<()> {
    let req = authorize(client.put(&config.url),config).header("Content-Type","application/json");
    let response = match etag {Some(tag)=>req.header(IF_MATCH,tag),None=>req.header(IF_NONE_MATCH,"*")}.body(payload).send().map_err(|_|"上传未确认，稍后自动重试")?;
    if response.status()==StatusCode::PRECONDITION_FAILED{return Err("远端又有更新，请重试同步".into());}
    if !response.status().is_success(){return Err(format!("WebDAV 上传返回 {}",response.status().as_u16()));}
    Ok(())
}
pub fn portable(snapshot: &Snapshot) -> Snapshot { let mut value=snapshot.clone();value.revision=0;value.ai_config=None;value.cloud_session=None;value }
fn equal(a: &Snapshot,b: &Snapshot)->Result<bool>{Ok(serde_json::to_value(portable(a)).map_err(|_|"同步编码失败")?==serde_json::to_value(portable(b)).map_err(|_|"同步编码失败")?)}

pub fn run(vault: &mut VaultService, strategy: Option<&str>) -> Result<Status> {
    if !vault.unlocked(){return Err("Vault 已锁定".into());}
    if strategy.is_some_and(|s|s!="local"&&s!="remote"){return Err("冲突选择无效".into());}
    let Some(mut state)=read(vault)? else {return status(vault);};
    let client=client()?;
    let local=portable(&vault.load()?);
    let Some((payload,etag))=remote(&client,&state.config)? else {
        if state.baseline.is_some(){return Err("远端文件被删除，已暂停上传；重新连接后可创建新副本".into());}
        put(&client,&state.config,vault.sync_backup(&local)?,None)?;
        state.baseline=Some(local);state.last_sync=Some(crate::domain::now());write(vault,&state)?;return Ok(view(&state,vec![]));
    };
    let downloaded=portable(&vault.decode_sync(&payload)?);
    let base=state.baseline.clone().unwrap_or_default();
    let (merged,conflicts)=merge(&base,&local,&downloaded,strategy)?;
    if !conflicts.is_empty() && strategy.is_none(){state.conflicts=conflicts.clone();write(vault,&state)?;return Ok(view(&state,conflicts));}
    if strategy.is_some() {vault.preserve_sync(&payload)?;}
    if !equal(&merged,&downloaded)? {put(&client,&state.config,vault.sync_backup(&merged)?,Some(&etag))?;}
    if !equal(&merged,&local)? {vault.apply_sync(merged.clone())?;}
    state.baseline=Some(merged);state.last_sync=Some(crate::domain::now());state.conflicts.clear();write(vault,&state)?;
    Ok(view(&state,vec![]))
}
pub fn adopt(vault: &mut VaultService,password:&str)->Result<Status>{
    let mut state=read(vault)?.ok_or("请先配置 WebDAV")?;
    let (payload,_)=remote(&client()?,&state.config)?.ok_or("远端尚无记忆库")?;
    let snapshot=vault.restore(&payload,password)?;
    state.baseline=Some(portable(&snapshot));state.last_sync=Some(crate::domain::now());write(vault,&state)?;
    Ok(view(&state,vec![]))
}
pub fn server_origin(input:&str)->Result<String>{
    let raw=input.trim();let value=if raw.contains("://"){raw.into()}else{format!("https://{raw}")};
    let parsed=url::Url::parse(&value).map_err(|_|"服务器地址无效")?;
    let loopback=matches!(parsed.host_str(),Some("localhost"|"127.0.0.1"|"[::1]"));
    if parsed.host_str().is_none()||!parsed.username().is_empty()||parsed.password().is_some()||parsed.query().is_some()||parsed.fragment().is_some()||parsed.path()!="/"||!(parsed.scheme()=="https"||parsed.scheme()=="http"&&loopback){return Err("填写服务器 IP＋端口或域名，远程连接需要 HTTPS".into());}
    Ok(parsed.origin().ascii_serialization())
}
pub fn server_start(url:&str)->Result<Value>{
    let origin=server_origin(url)?;
    let res=client()?.post(format!("{origin}/api/auth/device/code")).json(&serde_json::json!({"client_id":"relakeep-sync"})).send().map_err(|_|"连接服务器失败")?;
    if !res.status().is_success(){return Err("服务器授权暂不可用".into());}
    let value:Value=serde_json::from_str(&body(res)?).map_err(|_|"服务器响应无效")?;
    let code=value["device_code"].as_str().filter(|v|v.len()<=500&&!v.is_empty()).ok_or("设备码无效")?;
    let user=value["user_code"].as_str().filter(|v|v.len()<=32&&v.chars().all(|c|c.is_ascii_alphanumeric()||c=='-')).ok_or("显示码无效")?;
    Ok(serde_json::json!({"deviceCode":code,"userCode":user,"url":origin,"verificationUrl":format!("{origin}/?device=1&user_code={user}")}))
}
pub fn server_poll(vault:&mut VaultService,url:&str,device_code:&str,automatic:bool)->Result<Value>{
    vault.touch()?;let origin=server_origin(url)?;
    if device_code.is_empty()||device_code.len()>500{return Err("设备码无效".into());}
    let res=client()?.post(format!("{origin}/api/auth/device/token")).json(&serde_json::json!({"client_id":"relakeep-sync","device_code":device_code,"grant_type":"urn:ietf:params:oauth:grant-type:device_code"})).send().map_err(|_|"连接服务器失败")?;
    let status=res.status();let value:Value=serde_json::from_str(&body(res)?).map_err(|_|"授权响应无效")?;
    if !status.is_success(){return match value["error"].as_str(){Some("authorization_pending"|"slow_down")=>Ok(serde_json::json!({"pending":true})),_=>Err("授权已过期或被拒绝，请重新连接".into())};}
    let token=value["access_token"].as_str().filter(|s|!s.is_empty()&&s.len()<=8192).ok_or("授权会话缺失")?;
    let result=configure(vault,Config{kind:"server".into(),url:format!("{origin}/api/sync"),username:String::new(),password:token.into(),automatic})?;
    Ok(serde_json::json!({"pending":false,"status":result}))
}
pub fn initialize_server(vault:&mut VaultService)->Result<()> {
    if let Ok(url)=std::env::var("RELAKEEP_SELF_SYNC_URL") { let old=read(vault)?;if old.is_none()||old.as_ref().is_some_and(|s|s.config.kind=="server"&&s.config.url==url) { configure(vault,Config {kind:"server".into(),url,username:String::new(),password:std::env::var("RELAKEEP_ACCESS_TOKEN").map_err(|_|"服务器密钥缺失")?,automatic:true})?; } }
    Ok(())
}

fn merge(base:&Snapshot,local:&Snapshot,remote:&Snapshot,strategy:Option<&str>)->Result<(Snapshot,Vec<String>)>{
    let b=serde_json::to_value(portable(base)).map_err(|_|"同步基线编码失败")?;
    let l=serde_json::to_value(portable(local)).map_err(|_|"本机同步编码失败")?;
    let r=serde_json::to_value(portable(remote)).map_err(|_|"远端同步编码失败")?;
    let mut output=serde_json::json!({"revision":0,"entities":[],"relations":[],"events":[],"captures":[],"proposals":[]});
    let mut conflicts=vec![];
    for key in ["entities","relations","events","captures","proposals","ledgerAccounts","transactions","allocationRules","financeRecords","opaqueRecords"]{
        output[key]=serde_json::json!([]);
        let index=|value:&Value|->BTreeMap<String,Value>{value[key].as_array().into_iter().flatten().map(|item|(if key=="opaqueRecords"{format!("{}:{}",item["kind"].as_str().unwrap(),item["data"]["id"].as_str().unwrap())}else{item["id"].as_str().expect("validated record ID").to_string()},item.clone())).collect()};
        let bi=index(&b);let li=index(&l);let ri=index(&r);
        let ids:std::collections::BTreeSet<_>=bi.keys().chain(li.keys()).chain(ri.keys()).collect();
        for id in ids {
            let before=bi.get(id);let here=li.get(id);let there=ri.get(id);
            let value=if key=="transactions" || key=="opaqueRecords" {
                if here.is_some()&&there.is_some()&&here!=there {return Err("不可变流水或未知记录发生冲突，已保留两端数据".into());}here.or(there).or(before)
            } else if here==there {here} else if here==before {there} else if there==before {here} else {
                let name=here.or(there).and_then(|v|v["name"].as_str().or(v["rawText"].as_str())).unwrap_or(id);
                conflicts.push(name.chars().take(80).collect());
                if strategy==Some("remote"){there}else{here}
            };
            if let Some(value)=value {output[key].as_array_mut().unwrap().push(value.clone());}
        }
    }
    let mut merged:Snapshot=serde_json::from_value(output).map_err(|_|"合并结构无效")?;
    crate::ledger::deduplicate(&mut merged.transactions)?;
    if let Err(error)=merged.validate(){
        return Err(format!("合并需要先处理关联冲突：{error}。两端数据均未修改"));
    }
    Ok((merged,conflicts))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_additions_merge_and_same_item_conflicts(){
        let capture=|id:&str,text:&str|crate::capture::Capture{id:id.into(),raw_text:text.into(),input_type:"text".into(),timestamp:crate::domain::now(),status:"PENDING".into()};
        let mut local=Snapshot::default();local.captures.push(capture("a","email"));
        let mut remote=Snapshot::default();remote.captures.push(capture("b","phone"));
        let (merged,conflicts)=merge(&Snapshot::default(),&local,&remote,None).unwrap();assert_eq!(merged.captures.len(),2);assert!(conflicts.is_empty());
        remote.captures=local.captures.clone();remote.captures[0].raw_text="changed".into();
        assert_eq!(merge(&Snapshot::default(),&local,&remote,None).unwrap().1.len(),1);
        assert_eq!(merge(&Snapshot::default(),&local,&remote,Some("remote")).unwrap().0.captures[0].raw_text,"changed");
    }
}
