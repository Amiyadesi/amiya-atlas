use crate::domain::Result;
use reqwest::blocking::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};

pub const LOCAL_URL: &str = "http://127.0.0.1:11435";
pub const DEFAULT_MODEL: &str = "qwen3.5:2b-q4_K_M";
#[cfg(all(windows, target_arch = "x86_64"))]
const RUNTIME_URL: &str =
    "https://github.com/ollama/ollama/releases/download/v0.35.0/ollama-windows-amd64.zip";
#[cfg(all(windows, target_arch = "x86_64"))]
const RUNTIME_SHA256: &str = "d6f7d3dd4f5d013553a78c1e78b2521fcf41d43dd2863e4596cdc046fe6036db";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiConfig {
    pub kind: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub response_format: String,
}
impl std::fmt::Debug for AiConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AiConfig")
            .field("kind", &self.kind)
            .field("model", &self.model)
            .finish_non_exhaustive()
    }
}
impl Default for AiConfig {
    fn default() -> Self {
        Self {
            kind: "local".into(),
            base_url: LOCAL_URL.into(),
            model: DEFAULT_MODEL.into(),
            api_key: String::new(),
            response_format: "json_schema".into(),
        }
    }
}
impl AiConfig {
    pub fn validate(&self) -> Result<()> {
        if !["local", "ollama", "openai-compatible"].contains(&self.kind.as_str())
            || self.model.trim().is_empty()
            || self.model.len() > 200
            || self.api_key.len() > 8192
            || !["json_schema", "json_object", "prompt"].contains(&self.response_format.as_str())
        {
            return Err("模型配置无效".into());
        }
        let url = url::Url::parse(&self.base_url).map_err(|_| "模型地址无效")?;
        let loopback = matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        );
        if url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !(url.scheme() == "https" || url.scheme() == "http" && loopback)
        {
            return Err("远程模型需使用 HTTPS；本机模型可使用 HTTP".into());
        }
        if self.kind == "local"
            && (self.base_url.trim_end_matches('/') != LOCAL_URL
                || self.model != DEFAULT_MODEL
                || !self.api_key.is_empty())
        {
            return Err("Atlas Local 使用固定本机地址和默认模型".into());
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatRequest {
    pub config: AiConfig,
    pub messages: Vec<Message>,
    pub schema: Value,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub role: String,
    pub content: String,
}

fn client(timeout: u64) -> Result<Client> {
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(timeout))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化模型连接".into())
}
fn bounded_json(response: Response) -> Result<Value> {
    if !response.status().is_success() {
        return Err(format!(
            "模型返回 HTTP {}；请检查地址、模型名称和兼容格式",
            response.status().as_u16()
        ));
    }
    let mut data = Vec::new();
    response
        .take(1024 * 1024 + 1)
        .read_to_end(&mut data)
        .map_err(|_| "模型响应读取失败")?;
    if data.len() > 1024 * 1024 {
        return Err("模型响应超过大小限制".into());
    }
    serde_json::from_slice(&data).map_err(|_| "模型响应不是有效 JSON".into())
}
pub fn health(config: &AiConfig) -> Result<bool> {
    config.validate()?;
    let path = if config.kind == "openai-compatible" {
        "models"
    } else {
        "api/tags"
    };
    let mut request = client(5)?.get(format!("{}/{path}", config.base_url.trim_end_matches('/')));
    if !config.api_key.is_empty() {
        request = request.bearer_auth(&config.api_key);
    }
    let response = match request.send() {
        Ok(response) => response,
        Err(_) => return Ok(false),
    };
    let value = match bounded_json(response) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    let found = if config.kind == "openai-compatible" {
        value["data"].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| item["id"].as_str() == Some(&config.model))
        })
    } else {
        value["models"].as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item["name"].as_str() == Some(&config.model)
                    || item["model"].as_str() == Some(&config.model)
            })
        })
    };
    Ok(found)
}
pub fn chat(request: &ChatRequest) -> Result<String> {
    request.config.validate()?;
    if request.messages.is_empty()
        || request.messages.len() > 4
        || request
            .messages
            .iter()
            .any(|m| !["system", "user"].contains(&m.role.as_str()) || m.content.len() > 100000)
        || serde_json::to_vec(&request.schema)
            .map_err(|_| "模型格式无效")?
            .len()
            > 100000
    {
        return Err("模型请求无效或过长".into());
    }
    let config = &request.config;
    let ollama = config.kind != "openai-compatible";
    let mut body = if ollama {
        json!({"model":config.model,"messages":request.messages,"format":request.schema,"stream":false,"think":false,"keep_alive":"2m","options":{"temperature":0,"seed":42,"num_ctx":4096,"num_predict":1536,"num_thread":4,"repeat_penalty":1.0,"presence_penalty":0}})
    } else {
        json!({"model":config.model,"messages":request.messages,"temperature":0.1,"max_tokens":3072,"stream":false})
    };
    if !ollama {
        match config.response_format.as_str() {
            "json_schema" => {
                body["response_format"] = json!({"type":"json_schema","json_schema":{"name":"atlas_proposal","strict":false,"schema":request.schema}});
            }
            "json_object" => {
                body["response_format"] = json!({"type":"json_object"});
            }
            _ => {}
        }
    }
    let path = if ollama {
        "api/chat"
    } else {
        "chat/completions"
    };
    let mut http = client(180)?
        .post(format!("{}/{path}", config.base_url.trim_end_matches('/')))
        .json(&body);
    if !config.api_key.is_empty() {
        http = http.bearer_auth(&config.api_key);
    }
    let response = http.send().map_err(|e| {
        if e.is_timeout() {
            "模型响应超时，原文已保留"
        } else {
            "无法连接模型；请在设置中准备模型或检查连接"
        }
    })?;
    let value = bounded_json(response)?;
    let content = if ollama {
        value["message"]["content"].as_str()
    } else {
        value["choices"][0]["message"]["content"].as_str()
    }
    .ok_or("模型没有返回文本提案")?;
    if content.is_empty() || content.len() > 100000 {
        return Err("模型输出为空或过长，请缩短输入".into());
    }
    Ok(content.into())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProgress {
    pub stage: String,
    pub completed: u64,
    pub total: u64,
}
#[derive(Default)]
pub struct LocalRuntime {
    child: Option<Child>,
}
impl Drop for LocalRuntime {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl LocalRuntime {
    pub fn start(&mut self, app_dir: &Path) -> Result<()> {
        if let Some(child) = &mut self.child {
            if child
                .try_wait()
                .map_err(|_| "本地模型状态不可用")?
                .is_none()
            {
                return Ok(());
            }
        }
        let executable = runtime_executable(app_dir);
        if !executable.exists() {
            return Err("默认模型尚未准备，请在设置中点击下载并准备".into());
        }
        std::fs::create_dir_all(app_dir.join("models")).map_err(|_| "无法创建模型目录")?;
        let mut command = Command::new(executable);
        command
            .arg("serve")
            .env("OLLAMA_HOST", "127.0.0.1:11435")
            .env("OLLAMA_MODELS", app_dir.join("models"))
            .env("OLLAMA_NO_CLOUD", "1")
            .env("OLLAMA_NUM_PARALLEL", "1")
            .env("OLLAMA_MAX_LOADED_MODELS", "1")
            .env("OLLAMA_KEEP_ALIVE", "2m")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        self.child = Some(command.spawn().map_err(|_| "无法启动本地模型运行时")?);
        for _ in 0..100 {
            if self
                .child
                .as_mut()
                .unwrap()
                .try_wait()
                .map_err(|_| "本地模型启动失败")?
                .is_some()
            {
                self.child = None;
                return Err("本地模型启动失败；请检查端口 11435 是否被占用".into());
            }
            if client(1)?
                .get(format!("{LOCAL_URL}/api/version"))
                .send()
                .is_ok_and(|r| r.status().is_success())
            {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.child = None;
        Err("本地模型启动超时".into())
    }
    pub fn prepare(&mut self, app_dir: &Path, progress: impl Fn(ModelProgress)) -> Result<()> {
        if !runtime_executable(app_dir).exists() {
            download_runtime(app_dir, &progress)?;
        }
        progress(ModelProgress {
            stage: "启动本地运行时".into(),
            completed: 0,
            total: 0,
        });
        self.start(app_dir)?;
        if health(&AiConfig::default())? {
            progress(ModelProgress {
                stage: "模型已就绪".into(),
                completed: 1,
                total: 1,
            });
            return Ok(());
        }
        let response = client(3600)?
            .post(format!("{LOCAL_URL}/api/pull"))
            .json(&json!({"model":DEFAULT_MODEL,"stream":true}))
            .send()
            .map_err(|_| "模型下载连接失败，可以稍后重试")?;
        if !response.status().is_success() {
            return Err("本地运行时无法下载默认模型".into());
        }
        let mut reader = BufReader::new(response);
        loop {
            let mut bytes = Vec::new();
            let length = reader
                .by_ref()
                .take(16385)
                .read_until(b'\n', &mut bytes)
                .map_err(|_| "模型下载中断，可以继续重试")?;
            if length == 0 {
                break;
            }
            if length > 16384 {
                return Err("模型下载响应过长".into());
            }
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| "模型下载响应无效")?;
            if value["error"].is_string() {
                return Err("默认模型下载失败，请检查网络后重试".into());
            }
            progress(ModelProgress {
                stage: value["status"].as_str().unwrap_or("下载模型").into(),
                completed: value["completed"].as_u64().unwrap_or(0),
                total: value["total"].as_u64().unwrap_or(0),
            });
        }
        if !health(&AiConfig::default())? {
            return Err("默认模型下载未完成，请重试".into());
        }
        progress(ModelProgress {
            stage: "模型已就绪".into(),
            completed: 1,
            total: 1,
        });
        Ok(())
    }
}
fn runtime_executable(app_dir: &Path) -> PathBuf {
    app_dir
        .join("runtime-ollama-0.35.0")
        .join(if cfg!(windows) {
            "ollama.exe"
        } else {
            "bin/ollama"
        })
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
fn download_runtime(_: &Path, _: &impl Fn(ModelProgress)) -> Result<()> {
    Err("一键本地运行时目前支持 Windows x64；其他平台请在设置中使用现有 Ollama".into())
}

#[cfg(all(windows, target_arch = "x86_64"))]
fn download_runtime(app_dir: &Path, progress: &impl Fn(ModelProgress)) -> Result<()> {
    use sha2::{Digest, Sha256};
    use std::io::Write;
    std::fs::create_dir_all(app_dir).map_err(|_| "无法创建运行时目录")?;
    let archive_path = app_dir.join("ollama-runtime.zip.part");
    let download = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(3600))
        .build()
        .map_err(|_| "无法创建下载连接")?;
    let mut response = download
        .get(RUNTIME_URL)
        .send()
        .map_err(|_| "无法下载本地运行时，请检查网络后重试")?;
    if !response.status().is_success() {
        return Err("运行时下载失败".into());
    }
    let total = response.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&archive_path).map_err(|_| "无法写入运行时文件")?;
    let mut hash = Sha256::new();
    let mut completed = 0u64;
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|_| "运行时下载中断，请重试")?;
        if read == 0 {
            break;
        }
        completed += read as u64;
        if completed > 2 * 1024 * 1024 * 1024 {
            return Err("运行时下载超过限制".into());
        }
        file.write_all(&buffer[..read])
            .map_err(|_| "运行时写入失败，请检查剩余空间")?;
        hash.update(&buffer[..read]);
        progress(ModelProgress {
            stage: "下载本地运行时（首次使用）".into(),
            completed,
            total,
        });
    }
    file.sync_all().map_err(|_| "运行时文件保存失败")?;
    drop(file);
    if format!("{:x}", hash.finalize()) != RUNTIME_SHA256 {
        let _ = std::fs::remove_file(&archive_path);
        return Err("运行时校验失败，未安装或执行下载内容".into());
    }
    let target = app_dir.join("runtime-ollama-0.35.0");
    let staging = app_dir.join("runtime-ollama-0.35.0.unpacking");
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|_| "无法清理上次未完成的解压")?;
    }
    std::fs::create_dir_all(&staging).map_err(|_| "无法创建运行时解压目录")?;
    progress(ModelProgress {
        stage: "校验通过，解压运行时".into(),
        completed: 0,
        total: 0,
    });
    let mut zip =
        zip::ZipArchive::new(std::fs::File::open(&archive_path).map_err(|_| "无法读取运行时")?)
            .map_err(|_| "运行时压缩包无效")?;
    let mut unpacked = 0u64;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|_| "运行时压缩包损坏")?;
        let relative = entry.enclosed_name().ok_or("运行时压缩包含非法路径")?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("运行时压缩包不可包含符号链接".into());
        }
        unpacked += entry.size();
        if unpacked > 10 * 1024 * 1024 * 1024 {
            return Err("运行时解压超过容量限制".into());
        }
        let destination = staging.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(destination).map_err(|_| "运行时解压失败")?;
        } else {
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(|_| "运行时解压失败")?;
            }
            let mut output = std::fs::File::create(destination).map_err(|_| "运行时解压失败")?;
            std::io::copy(&mut entry, &mut output).map_err(|_| "运行时解压失败")?;
        }
    }
    if !staging.join("ollama.exe").exists() {
        return Err("运行时缺少可执行文件".into());
    }
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|_| "无法清理旧运行时")?;
    }
    std::fs::rename(staging, target).map_err(|_| "运行时安装失败")?;
    let _ = std::fs::remove_file(archive_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_credentials_require_https_and_local_is_fixed() {
        assert!(AiConfig::default().validate().is_ok());
        let mut c = AiConfig::default();
        c.base_url = "http://example.com".into();
        assert!(c.validate().is_err());
        c.kind = "openai-compatible".into();
        c.base_url = "https://example.com/v1".into();
        assert!(c.validate().is_ok());
        c.base_url = "https://key:secret@example.com".into();
        assert!(c.validate().is_err());
        c.base_url = "https://example.com/v1?token=secret".into();
        assert!(c.validate().is_err());
    }
}
