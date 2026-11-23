use crate::{commands, domain::Result, vault::VaultService};
use serde_json::{json,Value};
use std::{io::Read, sync::{Arc,Mutex}, thread};
use tiny_http::{Header,Response,Server};

mod assets { include!(concat!(env!("OUT_DIR"),"/web_assets.rs")); }

#[derive(Clone)]
pub struct WebHandle { pub port: u16, pub token: String }
pub fn start(vault:Arc<Mutex<VaultService>>, bind:&str, token:String, origin:String)->Result<WebHandle>{
    let server=Server::http(bind).map_err(|_|"网页端口被占用")?;
    let port=server.server_addr().to_ip().ok_or("网页监听地址无效")?.port();
    if token.len()<32 || token.len()>512 {return Err("网页访问口令至少 32 个字符".into());}
    let handle=WebHandle{port,token:token.clone()};
    thread::Builder::new().name("relakeep-web".into()).spawn(move||{
        for mut req in server.incoming_requests(){
            let host=req.headers().iter().find(|h|h.field.equiv("Host")).map(|h|h.value.as_str()).unwrap_or("");
            let expected=url::Url::parse(&origin).expect("validated web origin");
            let expected_host=match expected.port(){Some(p)=>format!("{}:{p}",expected.host_str().unwrap()),None=>expected.host_str().unwrap().to_string()};
            let request_origin=req.headers().iter().find(|h|h.field.equiv("Origin")).map(|h|h.value.as_str());
            if host!=expected_host || request_origin.is_some_and(|o|o!=origin){let _=req.respond(Response::from_string("Forbidden").with_status_code(403));continue;}
            let path=req.url().split('?').next().unwrap_or("/");
            if path=="/api/runtime"{let _=req.respond(reply(json!({"platform":"web","persistent":true})));continue;}
            if path=="/api/invoke"&&req.method()==&tiny_http::Method::Post{
                let provided=req.headers().iter().find(|h|h.field.equiv("Authorization")).map(|h|h.value.as_str()).unwrap_or("");
                if provided!=format!("Bearer {token}"){let _=req.respond(Response::from_string("Unauthorized").with_status_code(401));continue;}
                let mut body=Vec::new();let read=req.as_reader().take(128*1024*1024+1).read_to_end(&mut body);
                let result=if read.is_err()||body.len()>128*1024*1024{Err("请求超过容量限制".into())}else{
                    serde_json::from_slice::<Value>(&body).map_err(|_|"请求格式无效".into()).and_then(|v|{
                        let command=v["command"].as_str().ok_or("命令缺失")?;
                        commands::dispatch(command,v["args"].clone(),&vault)
                    })
                };
                let _=req.respond(reply(match result{Ok(data)=>json!({"ok":true,"data":data}),Err(error)=>json!({"ok":false,"error":error})}));
                continue;
            }
            if req.method()!=&tiny_http::Method::Get{let _=req.respond(Response::from_string("Method not allowed").with_status_code(405));continue;}
            let asset=if path=="/"{"index.html"}else{path.trim_start_matches('/')};
            if let Some(bytes)=assets::asset(asset){
                let mime=if asset.ends_with(".js"){"text/javascript"}else if asset.ends_with(".css"){"text/css"}else if asset.ends_with(".svg"){"image/svg+xml"}else if asset.ends_with(".html"){"text/html; charset=utf-8"}else{"application/octet-stream"};
                let data=if asset=="index.html"{String::from_utf8_lossy(bytes).replacen("<html","<html data-relakeep-host",1).into_bytes()}else{bytes.to_vec()};
                let _=req.respond(Response::from_data(data).with_header(header("Content-Type",mime)).with_header(header("Cache-Control","no-store")).with_header(header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.coinbase.com; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")));
            }else{let _=req.respond(Response::from_string("Not found").with_status_code(404));}
        }
    }).map_err(|_|"网页服务启动失败")?;
    Ok(handle)
}
fn header(key:&str,value:&str)->Header{Header::from_bytes(key,value).expect("static HTTP header")}
fn reply(value:Value)->Response<std::io::Cursor<Vec<u8>>>{Response::from_string(value.to_string()).with_header(header("Content-Type","application/json")).with_header(header("Cache-Control","no-store"))}

