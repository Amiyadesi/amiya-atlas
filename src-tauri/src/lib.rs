mod ai;
mod cloud;
#[cfg(all(feature = "desktop",target_os="windows"))]
mod bridge;
mod capture;
mod crypto;
mod device_unlock;
#[cfg(feature = "desktop")]
mod desktop;
mod domain;
#[cfg(all(feature = "desktop",not(target_os="android")))]
mod quick_capture;
#[cfg(all(feature="desktop",target_os="android"))]
#[path="quick_capture_mobile.rs"]
mod quick_capture;
mod store;
mod sync;
mod commands;
#[cfg(all(feature = "web-host", not(target_os = "android")))]
mod http;
mod vault;
mod voice;
#[cfg(feature = "desktop")]
pub use desktop::run;
#[cfg(all(feature = "web-host", not(target_os = "android")))]
pub fn run_web() -> domain::Result<()> {
    let dir=std::env::var("RELAKEEP_DATA_DIR").map(std::path::PathBuf::from).unwrap_or_else(|_|{
        #[cfg(windows)] {std::path::PathBuf::from(std::env::var("APPDATA").expect("APPDATA")).join("org.sayori.atlas")}
        #[cfg(not(windows))] {std::env::var("XDG_DATA_HOME").map(std::path::PathBuf::from).unwrap_or_else(|_|std::path::PathBuf::from(std::env::var("HOME").expect("HOME")).join(".local/share")).join("org.sayori.atlas")}
    });
    std::fs::create_dir_all(&dir).map_err(|_|"无法创建数据目录")?;
    let bind=std::env::var("RELAKEEP_BIND").unwrap_or_else(|_|"127.0.0.1:5011".into());
    let origin=std::env::var("RELAKEEP_ORIGIN").unwrap_or_else(|_|"http://localhost:5011".into());
    let parsed=url::Url::parse(&origin).map_err(|_|"RELAKEEP_ORIGIN 无效")?;
    if !["http","https"].contains(&parsed.scheme())||parsed.host_str().is_none()||parsed.path()!="/"||parsed.query().is_some()||parsed.fragment().is_some(){return Err("RELAKEEP_ORIGIN 必须是网站来源地址".into());}
    let token=match std::env::var("RELAKEEP_ACCESS_TOKEN") {Ok(value)=>value,Err(_) if bind.starts_with("127.0.0.1:")=>hex_token(),Err(_)=>return Err("远程网页必须配置 RELAKEEP_ACCESS_TOKEN".into())};
    let shared=std::sync::Arc::new(std::sync::Mutex::new(vault::VaultService::new(dir.join("atlas.sqlite"))));
    let handle=http::start(shared.clone(),&bind,token,origin.clone())?;
    if bind.starts_with("127.0.0.1:"){println!("{origin}/#access={}",handle.token);}else{println!("Relakeep listening on {bind}");}
    loop {std::thread::sleep(std::time::Duration::from_secs(30));let mut vault=shared.lock().map_err(|_|"Vault 状态不可用")?;vault.expire_if_idle();if vault.unlocked()&&sync::status(&vault)?.automatic{if let Err(error)=sync::run(&mut vault,None){eprintln!("Sync: {error}");}}}
}
#[cfg(all(feature = "web-host", not(target_os = "android")))]
fn hex_token()->String{crypto::CryptoProvider::random::<32>().iter().map(|b|format!("{b:02x}")).collect()}
#[cfg(test)]
mod capture_change_tests;
#[cfg(test)]
mod vault_tests;
pub mod ledger;
