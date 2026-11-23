use crate::domain::Result;
use reqwest::blocking::Client;
use semver::Version;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{collections::HashMap, io::Read, time::Duration};
use url::Url;

const CURRENT: &str = env!("CARGO_PKG_VERSION");
const MIRROR: &str = "https://atlas.sayori.org/downloads";
const RELEASES: &str = "https://github.com/Amiyadesi/amiya-atlas/releases";
const API: &str = "https://api.github.com/repos/Amiyadesi/amiya-atlas/releases";
const PROXY: &str = "https://gh-proxy.org";

#[cfg(target_os = "android")]
const PLATFORM: &str = "android";
#[cfg(target_os = "linux")]
const PLATFORM: &str = "linuxDeb";
#[cfg(not(any(target_os = "linux", target_os = "android")))]
const PLATFORM: &str = "windows";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    current_version: &'static str,
    latest_version: String,
    has_update: bool,
    platform: &'static str,
    source_used: &'static str,
    released_at: Option<String>,
    notes: String,
    release_page_url: String,
    mirror_url: Option<String>,
    github_proxy_url: Option<String>,
    github_url: Option<String>,
    filename: Option<String>,
    sha256: Option<String>,
    fallback_note: Option<String>,
}

fn version(value: &str) -> Result<Version> {
    Version::parse(value.strip_prefix('v').unwrap_or(value)).map_err(|_| "发布版本号无效".into())
}

fn https(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| "更新地址无效")?;
    if !value.starts_with("https://")
        || value.contains('\\')
        || value.chars().any(|c| c.is_whitespace() || c.is_control())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("更新地址必须是不含凭据的 HTTPS 网址".into());
    }
    Ok(url)
}

fn proxy(custom: Option<&str>) -> Result<Url> {
    let url = https(
        custom
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(PROXY),
    )?;
    if url.query().is_some() || url.fragment().is_some() {
        return Err("镜像前缀不能包含查询参数或片段".into());
    }
    Ok(url)
}

pub fn allowed_url(value: &str, custom: Option<&str>) -> Result<Url> {
    let url = https(value)?;
    let prefix = proxy(custom)?;
    if url.origin() == prefix.origin()
        || (url.port().is_none()
            && matches!(
                url.host_str(),
                Some(
                    "atlas.sayori.org"
                        | "github.com"
                        | "objects.githubusercontent.com"
                        | "release-assets.githubusercontent.com"
                        | "gh-proxy.org"
                        | "ghfast.top"
                )
            ))
    {
        Ok(url)
    } else {
        Err("不允许打开此更新来源".into())
    }
}

fn suffix(platform: &str) -> &str {
    match platform {
        "android" => "arm64.apk",
        "windows" => "x64-setup.exe",
        "linuxDeb" => "amd64.deb",
        "linuxWeb" => "linux-web.tar.gz",
        _ => unreachable!("unknown platform"),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Asset {
    version: String,
    filename: String,
    mirror_url: String,
    github_url: String,
    sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: String,
    released_at: Option<String>,
    notes: String,
    assets: HashMap<String, Asset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    published_at: Option<String>,
    body: Option<String>,
    assets: Vec<GithubAsset>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

impl UpdateCheckResult {
    fn new(
        platform: &'static str,
        source: &'static str,
        latest: Version,
        released_at: Option<String>,
        notes: String,
        page: String,
    ) -> Self {
        Self {
            current_version: CURRENT,
            has_update: latest
                .cmp_precedence(&version(CURRENT).expect("Cargo version"))
                .is_gt(),
            latest_version: latest.to_string(),
            platform,
            source_used: source,
            released_at,
            notes,
            release_page_url: page,
            mirror_url: None,
            github_proxy_url: None,
            github_url: None,
            filename: None,
            sha256: None,
            fallback_note: None,
        }
    }

    fn with_asset(mut self, asset: Asset, tag: &str, proxy: &Url) -> Result<Self> {
        let name = &asset.filename;
        if !name.ends_with(suffix(self.platform))
            || !name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b".-_+".contains(&c))
            || asset.github_url != format!("{RELEASES}/download/{tag}/{name}")
            || asset.mirror_url != format!("{MIRROR}/{name}")
        {
            return Err("发布文件名或下载来源无效".into());
        }
        if asset
            .sha256
            .as_ref()
            .is_some_and(|s| s.len() != 64 || !s.bytes().all(|c| c.is_ascii_hexdigit()))
        {
            return Err("发布文件的 SHA-256 格式无效".into());
        }
        self.github_proxy_url = Some(format!(
            "{}/{}",
            proxy.as_str().trim_end_matches('/'),
            asset.github_url
        ));
        self.github_url = Some(asset.github_url);
        self.mirror_url = Some(asset.mirror_url);
        self.filename = Some(asset.filename);
        self.sha256 = asset.sha256;
        Ok(self)
    }
}

fn from_manifest(
    mut manifest: Manifest,
    platform: &'static str,
    proxy: &Url,
) -> Result<UpdateCheckResult> {
    version(&manifest.version)?;
    let asset = manifest
        .assets
        .remove(platform)
        .ok_or("清单缺少本平台安装包")?;
    let latest = version(&asset.version)?;
    let tag = format!("v{latest}");
    if let Some(named) = named_version(&asset.filename)? {
        if named != latest {
            return Err("安装包版本与清单不符".into());
        }
    }
    UpdateCheckResult::new(
        platform,
        "cn",
        latest,
        manifest.released_at,
        manifest.notes,
        "https://atlas.sayori.org/download".into(),
    )
    .with_asset(asset, &tag, proxy)
}

fn named_version(name: &str) -> Result<Option<Version>> {
    name.strip_prefix("Relakeep_")
        .and_then(|s| s.split_once('_'))
        .map(|(v, _)| version(v))
        .transpose()
}

fn from_github(release: Release, platform: &'static str, proxy: &Url) -> Result<UpdateCheckResult> {
    let tag = release.tag_name;
    let mut latest = version(&tag)?;
    if release.html_url != format!("{RELEASES}/tag/{tag}") {
        return Err("GitHub 发布页地址无效".into());
    }
    let asset = release
        .assets
        .into_iter()
        .find(|a| a.name.ends_with(suffix(platform)));
    if let Some(a) = &asset {
        if let Some(named) = named_version(&a.name)? {
            latest = named;
        }
    }
    let info = UpdateCheckResult::new(
        platform,
        "github",
        latest,
        release.published_at,
        release.body.unwrap_or_default(),
        release.html_url,
    );
    match asset {
        None => Ok(info),
        Some(a) => info.with_asset(
            Asset {
                version: tag.clone(),
                mirror_url: format!("{MIRROR}/{}", a.name),
                filename: a.name,
                github_url: a.browser_download_url,
                sha256: a
                    .digest
                    .and_then(|s| s.strip_prefix("sha256:").map(str::to_owned)),
            },
            &tag,
            proxy,
        ),
    }
}

fn fetch<T: DeserializeOwned>(client: &Client, url: &str) -> Result<T> {
    let response = client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("更新请求失败：{e}"))?;
    let mut bytes = Vec::new();
    response
        .take(2_000_001)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取发布信息")?;
    if bytes.len() > 2_000_000 {
        return Err("发布信息过大".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "发布信息格式无效".into())
}

pub fn check(source: &str, custom: Option<&str>) -> Result<UpdateCheckResult> {
    let proxy = proxy(custom)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(format!("Relakeep/{CURRENT}"))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法创建更新连接")?;
    let cn = || {
        from_manifest(
            fetch(&client, &format!("{MIRROR}/releases.json"))?,
            PLATFORM,
            &proxy,
        )
    };
    let github = || {
        let mut release: Release = fetch(&client, &format!("{API}/latest"))?;
        // A release may ship only Android. Prefer the last stable package for this platform.
        let matches = |r: &Release| r.assets.iter().any(|a| a.name.ends_with(suffix(PLATFORM)));
        if !matches(&release) {
            let recent: Vec<Release> = fetch(&client, &format!("{API}?per_page=30"))?;
            if let Some(previous) = recent
                .into_iter()
                .find(|r| !r.draft && !r.prerelease && matches(r))
            {
                release = previous;
            }
        }
        from_github(release, PLATFORM, &proxy)
    };
    match source {
        "cn" => cn(),
        "github" => github(),
        "auto" => cn().or_else(|first| {
            let mut info = github().map_err(|e| format!("国内镜像：{first}；GitHub：{e}"))?;
            info.fallback_note = Some("国内镜像不可用，已改用国际 GitHub 源。".into());
            Ok(info)
        }),
        _ => Err("未知更新来源".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn semantic_precedence() {
        for (a, b) in [
            ("0.9.4", "0.9.3"),
            ("0.10.0", "0.9.9"),
            ("v0.9.4", "0.9.4-rc.2"),
            ("1.0.0-rc.10", "1.0.0-rc.2"),
        ] {
            assert!(version(a)
                .unwrap()
                .cmp_precedence(&version(b).unwrap())
                .is_gt());
        }
        assert_eq!(version("v0.9.4").unwrap(), version("0.9.4").unwrap());
        assert!(version("0.9.04").is_err());
        assert!(version("0.9.4+build")
            .unwrap()
            .cmp_precedence(&version("0.9.4").unwrap())
            .is_eq());
    }

    #[test]
    fn mirror_uses_asset_not_overall_version() {
        let manifest: Manifest =
            serde_json::from_str(include_str!("../../web/static/downloads/releases.json")).unwrap();
        let expected = manifest.assets["windows"].version.clone();
        let info = from_manifest(manifest, "windows", &proxy(None).unwrap()).unwrap();
        assert_eq!(info.latest_version, expected);
        assert_eq!(
            info.github_proxy_url,
            Some(format!("{PROXY}/{}", info.github_url.unwrap()))
        );
    }

    #[test]
    fn github_matches_platform_and_pins_repo() {
        let base = json!({"tag_name":"v1.0.1","html_url":format!("{RELEASES}/tag/v1.0.1"),"published_at":null,"body":"Notes",
            "assets":[{"name":"app-arm64.apk","browser_download_url":"unused"},{"name":"Relakeep_1.0.0_amd64.deb","browser_download_url":format!("{RELEASES}/download/v1.0.1/Relakeep_1.0.0_amd64.deb")}]});
        let parse = |value| {
            from_github(
                serde_json::from_value(value).unwrap(),
                "linuxDeb",
                &proxy(Some("https://mirror.example/p/")).unwrap(),
            )
        };
        let info = parse(base.clone()).unwrap();
        assert_eq!(info.latest_version, "1.0.0");
        assert_eq!(
            info.github_proxy_url,
            Some(format!(
                "https://mirror.example/p/{}",
                info.github_url.unwrap()
            ))
        );
        let mut wrong = base;
        wrong["assets"][1]["browser_download_url"] = json!("https://github.com/elsewhere/bad");
        assert!(parse(wrong).is_err());
    }

    #[test]
    fn opening_checks_exact_https_origin() {
        for url in [
            "http://github.com/a",
            "file:///tmp/a",
            "https://github.com.evil.test/a",
            "https://me@github.com/a",
            "https://github.com:444/a",
            "https://mirror.example:444/a",
            "https://github.com\\@evil.test/a",
        ] {
            assert!(
                allowed_url(url, Some("https://mirror.example/dl")).is_err(),
                "{url}"
            );
        }
        for url in [
            RELEASES,
            PROXY,
            "https://ghfast.top/a",
            "https://mirror.example/dl/a",
        ] {
            assert!(allowed_url(url, Some("https://mirror.example/dl")).is_ok());
        }
        assert!(proxy(Some("http://mirror.example")).is_err());
        assert!(proxy(Some("https://mirror.example/?url=")).is_err());
    }
}
