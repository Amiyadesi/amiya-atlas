use crate::domain::Result;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::Read, time::Duration};
use zeroize::Zeroize;

pub const ORIGIN: &str = "https://atlas.sayori.org";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudSession {
    pub token: String,
    pub email: String,
    pub expires_at: i64,
}
impl std::fmt::Debug for CloudSession {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result { f.debug_struct("CloudSession").field("expires_at",&self.expires_at).finish_non_exhaustive() }
}
impl Drop for CloudSession { fn drop(&mut self) { self.token.zeroize(); } }
impl CloudSession {
    pub fn validate(&self)->Result<()> {
        if self.token.len()<20 || self.token.len()>8192 || self.token.chars().any(char::is_control) || self.email.len()>320 || self.expires_at<=0 { return Err("云会话损坏，请重新登录".into()); }
        Ok(())
    }
}
pub struct DeviceFlow { pub code:String, pub expires_at:i64 }
impl Drop for DeviceFlow { fn drop(&mut self) { self.code.zeroize(); } }

pub fn request(path:&str, body:Option<&Value>, token:Option<&str>)->Result<Value> {
    if !["/api/auth/device/code","/api/auth/device/token","/api/auth/get-session","/api/auth/sign-out","/api/account/balance","/api/account/ai","/api/account/checkout","/api/account/portal","/api/features"].contains(&path) { return Err("云接口无效".into()); }
    let client=Client::builder().connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(if path=="/api/account/ai"{140}else{30})).redirect(reqwest::redirect::Policy::none()).build().map_err(|_|"无法建立云连接")?;
    let url=format!("{ORIGIN}{path}");
    let mut req=if let Some(value)=body {
        if value.to_string().len()>256*1024 { return Err("云请求过大".into()); }
        client.post(&url).json(value)
    } else {client.get(&url)};
    if let Some(token)=token {req=req.bearer_auth(token);}
    let response=req.send().map_err(|_|"云连接中断；重试相同请求不会重复扣费")?;
    let status=response.status();
    let mut bytes=Vec::new();response.take(1024*1024+1).read_to_end(&mut bytes).map_err(|_|"云响应读取失败")?;
    if bytes.len()>1024*1024 {return Err("云响应过大".into());}
    let value:Value=serde_json::from_slice(&bytes).map_err(|_|"官网未返回有效数据")?;
    if !status.is_success() {
        if path=="/api/auth/device/token" && matches!(value["error"].as_str(),Some("authorization_pending"|"slow_down")) {return Ok(json!({"pending":true}));}
        return Err(value["message"].as_str().or(value["error_description"].as_str()).unwrap_or("云请求失败，请登录或稍后重试").chars().take(500).collect());
    }
    Ok(value)
}
pub fn open_page(path:&str)->Result<()> {
    if !["/login","/pricing","/account","/guide","/privacy","/refunds"].contains(&path) {return Err("官网页面无效".into());}
    open::that(format!("{ORIGIN}{path}")).map_err(|_|"无法打开系统浏览器".into())
}
pub fn open_payment(url:&str)->Result<()> {
    let parsed=url::Url::parse(url).map_err(|_|"付款地址无效")?;
    if parsed.scheme()!="https" || !matches!(parsed.host_str(),Some("checkout.stripe.com"|"billing.stripe.com")) || !parsed.username().is_empty() || parsed.password().is_some() {return Err("付款地址无效".into());}
    open::that(url).map_err(|_|"无法打开付款页面".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rejects_arbitrary_cloud_targets() { assert!(request("https://example.invalid",None,None).is_err()); assert!(open_page("//evil.invalid").is_err()); assert!(open_payment("http://checkout.stripe.com").is_err()); }
    #[test] fn session_debug_does_not_leak() { let s=CloudSession{token:"private_session_token_123456".into(),email:"private@example.invalid".into(),expires_at:1};s.validate().unwrap();assert!(!format!("{s:?}").contains("private")); }
}
