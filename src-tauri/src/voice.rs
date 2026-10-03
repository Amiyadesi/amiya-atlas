use crate::{ai::ModelProgress, domain::Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

const MODEL_NAME: &str = "Whisper Small Q5_1";
const MODEL_FILE: &str = "ggml-small-q5_1.bin";
const MODEL_BYTES: u64 = 190085487;
const MODEL_SHA: &str = "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb";
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small-q5_1.bin";
const RUNTIME_DIR: &str = "runtime-whisper-b5130";
#[cfg(all(windows, target_arch = "x86_64"))]
const RUNTIME_URL: &str =
    "https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip";
#[cfg(all(windows, target_arch = "x86_64"))]
const RUNTIME_SHA: &str = "f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c";
pub const MAX_WAV_BYTES: usize = 44 + 16000 * 2 * 60;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub supported: bool,
    pub ready: bool,
    pub model: &'static str,
    pub prerequisite: Option<&'static str>,
}
fn prerequisite() -> Option<&'static str> {
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        let system = std::env::var_os("WINDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
            .join("System32");
        if ["MSVCP140.dll", "VCRUNTIME140.dll", "VCRUNTIME140_1.dll"]
            .iter()
            .any(|name| !system.join(name).is_file())
        {
            return Some("Microsoft Visual C++ v14 x64 运行库");
        }
    }
    None
}
pub fn runtime_path(dir: &Path) -> PathBuf {
    dir.join(RUNTIME_DIR)
        .join("Release")
        .join(if cfg!(windows) {
            "whisper-cli.exe"
        } else {
            "whisper-cli"
        })
}
pub fn model_path(dir: &Path) -> PathBuf {
    dir.join("voice-models").join(MODEL_FILE)
}
pub fn status(dir: &Path) -> VoiceStatus {
    VoiceStatus {
        supported: cfg!(all(windows, target_arch = "x86_64")),
        ready: prerequisite().is_none()
            && runtime_path(dir).is_file()
            && std::fs::metadata(model_path(dir)).is_ok_and(|m| m.len() == MODEL_BYTES),
        model: MODEL_NAME,
        prerequisite: prerequisite(),
    }
}

/// The only accepted audio format is the bounded PCM WAV produced by our recorder.
pub fn validate_wav(wav: &[u8]) -> Result<()> {
    if wav.len() < 44 + 5600 * 2 || wav.len() > MAX_WAV_BYTES {
        return Err("录音需在 0.35–60 秒之间".into());
    }
    let u32_at = |at| u32::from_le_bytes(wav[at..at + 4].try_into().unwrap());
    let u16_at = |at| u16::from_le_bytes(wav[at..at + 2].try_into().unwrap());
    if &wav[..4] != b"RIFF"
        || &wav[8..16] != b"WAVEfmt "
        || u32_at(4) as usize != wav.len() - 8
        || u32_at(16) != 16
        || u16_at(20) != 1
        || u16_at(22) != 1
        || u32_at(24) != 16000
        || u32_at(28) != 32000
        || u16_at(32) != 2
        || u16_at(34) != 16
        || &wav[36..40] != b"data"
        || u32_at(40) as usize != wav.len() - 44
        || (wav.len() - 44) % 2 != 0
    {
        return Err("录音格式无效，需要 16 kHz 单声道 PCM WAV".into());
    }
    let energy = wav[44..]
        .chunks_exact(2)
        .map(|s| {
            let sample = i16::from_le_bytes([s[0], s[1]]) as f64 / 32768.0;
            sample * sample
        })
        .sum::<f64>()
        / ((wav.len() - 44) / 2) as f64;
    if energy.sqrt() < 0.001 {
        return Err("没有听到声音，请检查麦克风或重新录音".into());
    }
    Ok(())
}

pub fn transcript_from_json(bytes: &[u8]) -> Result<String> {
    if bytes.len() > 128 * 1024 {
        return Err("转写结果过长".into());
    }
    let output: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "语音模型返回了无效结果")?;
    let segments = output["transcription"]
        .as_array()
        .ok_or("语音模型没有返回文字")?;
    let mut text = String::new();
    for segment in segments {
        let part = segment["text"].as_str().ok_or("转写片段无效")?;
        text.push_str(part);
        if text.chars().count() > 10000 {
            return Err("转写超过 10000 字，请分段记录".into());
        }
    }
    let text = text.trim();
    if text.is_empty() {
        return Err("没有识别到语言，请重新录音".into());
    }
    Ok(text.into())
}
struct OwnedProcess(Child);
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub fn transcribe(
    dir: &Path,
    mut wav: Vec<u8>,
    language: &str,
    generation: u64,
    cancellation: &AtomicU64,
) -> Result<String> {
    use zeroize::Zeroize;
    validate_wav(&wav)?;
    if !["auto", "zh", "en", "ja"].contains(&language) {
        return Err("不支持的转写语言".into());
    }
    if generation != cancellation.load(Ordering::SeqCst) {
        return Err("转写已取消".into());
    }
    if !status(dir).ready {
        return Err("请先在设置中下载并准备语音模型".into());
    }
    // Private, uniquely named temporary directory; Drop removes both WAV and transcript, even on errors.
    let temp = tempfile::Builder::new()
        .prefix("voice-")
        .tempdir_in(dir)
        .map_err(|_| "无法创建临时录音目录")?;
    let input = temp.path().join("input.wav");
    let output = temp.path().join("result");
    std::fs::write(&input, &wav).map_err(|_| "临时录音写入失败")?;
    wav.zeroize();
    let executable = runtime_path(dir);
    let mut command = Command::new(&executable);
    command
        .current_dir(executable.parent().unwrap())
        .args(["-m"])
        .arg(model_path(dir))
        .args(["-f"])
        .arg(input)
        .args(["-of"])
        .arg(&output)
        .args([
            "-oj",
            "-l",
            language,
            "-t",
            &crate::ai::cpu_threads().to_string(),
            "-bs",
            "1",
            "-bo",
            "1",
            "-nf",
            "-np",
            "-nt",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = OwnedProcess(
        command
            .spawn()
            .map_err(|_| "语音运行时无法启动，请重新准备语音模型")?,
    );
    let started = Instant::now();
    loop {
        if cancellation.load(Ordering::SeqCst) != generation {
            return Err("转写已取消".into());
        }
        if started.elapsed() > Duration::from_secs(120) {
            return Err("转写超时，请缩短录音后重试".into());
        }
        if let Some(exit) = child.0.try_wait().map_err(|_| "语音进程状态不可用")? {
            if !exit.success() {
                #[cfg(windows)]
                if exit
                    .code()
                    .is_some_and(|code| matches!(code as u32, 0xC0000135 | 0xC0000139))
                {
                    return Err("语音运行时缺少依赖或版本过旧，请更新 Microsoft Visual C++ v14 x64 运行库后重试".into());
                }
                return Err("语音转写失败，请检查录音或重新准备语音模型".into());
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let file = std::fs::File::open(output.with_extension("json")).map_err(|_| "转写结果缺失")?;
    let mut bytes = Vec::new();
    file.take(128 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "转写结果读取失败")?;
    let result = transcript_from_json(&bytes);
    bytes.zeroize();
    result
}

fn download(
    url: &str,
    target: &Path,
    sha: &str,
    limit: u64,
    stage: &str,
    progress: &impl Fn(ModelProgress),
) -> Result<()> {
    let part = target.with_extension("part");
    let result = (|| {
        let client = reqwest::blocking::Client::builder()
            .https_only(true)
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(1800))
            .build()
            .map_err(|_| "无法创建语音下载连接")?;
        let mut file = std::fs::File::create(&part).map_err(|_| "无法写入语音下载文件")?;
        let mut hash = Sha256::new();
        let mut completed = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        let mut last = Instant::now();
        // Some model CDNs serve a bounded range even for the initial request. Resume within this download.
        for _ in 0..8 {
            let start = completed;
            let mut request = client.get(url);
            if start > 0 {
                request = request.header(reqwest::header::RANGE, format!("bytes={start}-"));
            }
            let mut response = request.send().map_err(|_| "语音下载连接失败，请重试")?;
            if !(response.status() == reqwest::StatusCode::OK && start == 0
                || response.status() == reqwest::StatusCode::PARTIAL_CONTENT)
            {
                return Err("语音文件下载失败，请稍后重试".into());
            }
            if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
                let range_start = response
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.strip_prefix("bytes "))
                    .and_then(|v| v.split_once('-'))
                    .and_then(|(start, _)| start.parse::<u64>().ok());
                if range_start != Some(start) {
                    return Err("语音下载分段无效，请重试".into());
                }
            }
            if response
                .content_length()
                .is_some_and(|n| n > limit - completed)
            {
                return Err("语音下载超过容量限制".into());
            }
            loop {
                let count = response
                    .read(&mut buffer)
                    .map_err(|_| "语音下载中断，请重试")?;
                if count == 0 {
                    break;
                }
                completed += count as u64;
                if completed > limit {
                    return Err("语音下载超过容量限制".into());
                }
                file.write_all(&buffer[..count])
                    .map_err(|_| "语音文件写入失败")?;
                hash.update(&buffer[..count]);
                if last.elapsed() >= Duration::from_millis(200) {
                    progress(ModelProgress {
                        stage: stage.into(),
                        completed,
                        total: limit,
                    });
                    last = Instant::now();
                }
            }
            if completed == limit {
                break;
            }
            if completed == start {
                return Err("语音下载未完成，请重试".into());
            }
        }
        if completed != limit {
            return Err("语音下载未完成，请重试".into());
        }
        file.sync_all().map_err(|_| "语音文件保存失败")?;
        drop(file);
        if format!("{:x}", hash.finalize()) != sha {
            return Err("语音文件校验失败，下载内容未执行".into());
        }
        if target.exists() {
            std::fs::remove_file(target).map_err(|_| "无法替换语音文件")?;
        }
        std::fs::rename(&part, target).map_err(|_| "语音文件安装失败")?;
        Ok(())
    })();
    let _ = std::fs::remove_file(part);
    result
}

pub fn prepare(dir: &Path, progress: impl Fn(ModelProgress)) -> Result<()> {
    if let Some(name) = prerequisite() {
        return Err(format!(
            "请先安装 {name}，然后重试；语音设置页提供官方下载入口"
        ));
    }
    std::fs::create_dir_all(dir.join("voice-models")).map_err(|_| "无法创建语音模型目录")?;
    if !runtime_path(dir).is_file() {
        install_runtime(dir, &progress)?;
    }
    if !std::fs::metadata(model_path(dir)).is_ok_and(|m| m.len() == MODEL_BYTES) {
        download(
            MODEL_URL,
            &model_path(dir),
            MODEL_SHA,
            MODEL_BYTES,
            "下载本地语音模型",
            &progress,
        )?;
    }
    progress(ModelProgress {
        stage: "语音模型已就绪".into(),
        completed: 1,
        total: 1,
    });
    Ok(())
}
#[cfg(not(all(windows, target_arch = "x86_64")))]
fn install_runtime(_: &Path, _: &impl Fn(ModelProgress)) -> Result<()> {
    Err("一键语音目前支持 Windows x64 桌面版".into())
}
#[cfg(all(windows, target_arch = "x86_64"))]
fn install_runtime(dir: &Path, progress: &impl Fn(ModelProgress)) -> Result<()> {
    let archive = dir.join("whisper-runtime.zip");
    download(
        RUNTIME_URL,
        &archive,
        RUNTIME_SHA,
        8573270,
        "下载语音运行时",
        progress,
    )?;
    let staging = tempfile::Builder::new()
        .prefix("whisper-install-")
        .tempdir_in(dir)
        .map_err(|_| "无法创建语音解压目录")?;
    let mut zip =
        zip::ZipArchive::new(std::fs::File::open(&archive).map_err(|_| "无法读取语音运行时")?)
            .map_err(|_| "语音压缩包损坏")?;
    let mut total = 0u64;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|_| "语音压缩包损坏")?;
        let relative = entry.enclosed_name().ok_or("语音压缩包包含非法路径")?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("语音压缩包不可包含符号链接".into());
        }
        total += entry.size();
        if total > 64 * 1024 * 1024 {
            return Err("语音解压超过限制".into());
        }
        let target = staging.path().join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|_| "语音解压失败")?;
        } else {
            std::fs::create_dir_all(target.parent().unwrap()).map_err(|_| "语音解压失败")?;
            std::io::copy(
                &mut entry,
                &mut std::fs::File::create(&target).map_err(|_| "语音解压失败")?,
            )
            .map_err(|_| "语音解压失败")?;
        }
    }
    if !staging.path().join("Release/whisper-cli.exe").is_file() {
        return Err("语音运行时缺少执行文件".into());
    }
    let target = dir.join(RUNTIME_DIR);
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|_| "无法替换语音运行时")?;
    }
    std::fs::rename(staging.path(), target).map_err(|_| "语音运行时安装失败")?;
    drop(zip);
    let _ = std::fs::remove_file(archive);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wav() -> Vec<u8> {
        let samples = 16000;
        let mut wav = Vec::new();
        wav.extend(b"RIFF");
        wav.extend((36 + samples * 2u32).to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16u32.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(16000u32.to_le_bytes());
        wav.extend(32000u32.to_le_bytes());
        wav.extend(2u16.to_le_bytes());
        wav.extend(16u16.to_le_bytes());
        wav.extend(b"data");
        wav.extend((samples * 2u32).to_le_bytes());
        for _ in 0..samples {
            wav.extend(1000i16.to_le_bytes());
        }
        wav
    }
    #[test]
    fn rejects_malformed_oversized_and_silent_recordings() {
        let mut bytes = wav();
        assert!(validate_wav(&bytes).is_ok());
        bytes[24] = 0;
        assert!(validate_wav(&bytes).is_err());
        let mut bytes = wav();
        bytes[44..].fill(0);
        assert!(validate_wav(&bytes).is_err());
        assert!(validate_wav(&[]).is_err());
        assert!(validate_wav(&vec![0; MAX_WAV_BYTES + 1]).is_err());
    }
    #[test]
    fn joins_real_cli_segments_and_bounds_output() {
        assert_eq!(
            transcript_from_json(br#"{"transcription":[{"text":" Hello"},{"text":" Atlas."}]}"#)
                .unwrap(),
            "Hello Atlas."
        );
        assert!(transcript_from_json(br#"{"transcription":[]}"#).is_err());
        assert!(transcript_from_json(&vec![b' '; 128 * 1024 + 1]).is_err());
    }
    #[test]
    fn canceled_requests_do_not_start_processes() {
        assert_eq!(
            transcribe(Path::new("."), wav(), "auto", 0, &AtomicU64::new(1)).unwrap_err(),
            "转写已取消"
        );
    }
    #[test]
    fn real_runtime_transcribes_public_sample_without_leaving_audio() {
        let Ok(dir) = std::env::var("ATLAS_TEST_WHISPER_DIR") else {
            return;
        };
        let dir = Path::new(&dir);
        if !status(dir).ready {
            prepare(dir, |_| {}).unwrap();
        }
        let audio = std::fs::read(dir.join("jfk.wav")).unwrap();
        // Upstream sample may contain ancillary WAV chunks; test fixture is canonicalized by the smoke script.
        let text = transcribe(dir, audio, "en", 0, &AtomicU64::new(0)).unwrap();
        assert!(text.to_lowercase().contains("country"), "{text}");
        if dir.join("zh.wav").is_file() {
            let text = transcribe(
                dir,
                std::fs::read(dir.join("zh.wav")).unwrap(),
                "auto",
                0,
                &AtomicU64::new(0),
            )
            .unwrap();
            assert!(text.contains("九点") && text.contains("五点"), "{text}");
        }
        assert!(!std::fs::read_dir(dir).unwrap().any(|p| {
            let name = p.unwrap().file_name();
            let name = name.to_string_lossy();
            name.starts_with("voice-") && name != "voice-models"
        }));
    }
}
