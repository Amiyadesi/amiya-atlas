import compare from "semver/functions/compare.js";
import { z } from "zod";
import { invoke, isTauri } from "./runtime";

export const APP_VERSION = "0.9.5";
export const compareSemver = compare;
const MIRROR = "https://atlas.sayori.org/downloads";
const RELEASES = "https://github.com/Amiyadesi/amiya-atlas/releases";
const API = "https://api.github.com/repos/Amiyadesi/amiya-atlas/releases";
const DEFAULT_PROXY = "https://gh-proxy.org";
const PREF_KEY = "relakeep:update-prefs";

const prefsSchema = z.object({
  source: z.enum(["auto", "cn", "github"]).catch("auto"),
  autoCheck: z.boolean().catch(true),
  customMirror: z.string().catch(""),
  lastCheckedAt: z.number().int().nonnegative().catch(0),
  dismissedVersion: z.string().catch(""),
});
export type UpdatePrefs = z.infer<typeof prefsSchema>;
export function getUpdatePrefs(): UpdatePrefs {
  try { return prefsSchema.parse(JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}")); }
  catch { return prefsSchema.parse({}); }
}
export function saveUpdatePrefs(prefs: UpdatePrefs) {
  githubProxyPrefix(prefs.customMirror);
  localStorage.setItem(PREF_KEY, JSON.stringify(prefsSchema.parse(prefs)));
}

type Platform = "android" | "windows" | "linuxDeb" | "linuxWeb";
export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  platform: Platform;
  sourceUsed: "cn" | "github";
  releasedAt: string | null;
  notes: string;
  releasePageUrl: string;
  mirrorUrl: string | null;
  githubProxyUrl: string | null;
  githubUrl: string | null;
  filename: string | null;
  sha256: string | null;
  fallbackNote: string | null;
}

function https(value: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("请输入完整的 HTTPS 网址"); }
  if (!value.startsWith("https://") || /[\\\s\u0000-\u001f\u007f]/u.test(value) || url.username || url.password)
    throw new Error("更新地址必须是不含凭据的 HTTPS 网址");
  return url;
}
export function githubProxyPrefix(custom: string) {
  const url = https(custom.trim() || DEFAULT_PROXY);
  if (url.href.includes("?") || url.href.includes("#")) throw new Error("镜像前缀不能包含查询参数或片段");
  return url.href.replace(/\/+$/, "");
}
const trustedHosts = ["atlas.sayori.org", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "gh-proxy.org", "ghfast.top"];
export async function openUpdateDownload(value: string, customMirror = "") {
  const url = https(value);
  const proxyOrigin = new URL(githubProxyPrefix(customMirror)).origin;
  if (!(trustedHosts.includes(url.hostname) && !url.port) && url.origin !== proxyOrigin)
    throw new Error("不允许打开此更新来源");
  if (isTauri) await invoke("open_update_url", {url: url.href, customMirror});
  else window.open(url.href, "_blank", "noopener,noreferrer");
}

const assetSchema = z.object({
  version: z.string(), filename: z.string(), mirrorUrl: z.string(), githubUrl: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i).nullish(),
});
const mirrorSchema = z.object({
  version: z.string(), releasedAt: z.string().nullish(), notes: z.string(),
  assets: z.object({linuxWeb: assetSchema}),
});
const githubSchema = z.object({
  tag_name: z.string(), body: z.string().nullish(), html_url: z.string(), published_at: z.string().nullish(),
  draft: z.boolean().optional(), prerelease: z.boolean().optional(),
  assets: z.array(z.object({name: z.string(), browser_download_url: z.string(), digest: z.string().nullish()})),
});
type Release = z.infer<typeof githubSchema>;

function normalized(raw: string) {
  if (raw.trim() !== raw) throw new Error("发布版本号无效");
  compare(raw, APP_VERSION);
  return raw.replace(/^v/, "");
}
function namedVersion(filename: string) {
  const match = /^Relakeep_([^_]+)_/.exec(filename);
  return match && normalized(match[1]);
}
function result(sourceUsed: "cn" | "github", latestVersion: string, notes: string, releasedAt: string | null | undefined, releasePageUrl: string): UpdateCheckResult {
  return {currentVersion: APP_VERSION, latestVersion, hasUpdate: compare(latestVersion, APP_VERSION) > 0,
    platform: "linuxWeb", sourceUsed, releasedAt: releasedAt ?? null, notes, releasePageUrl,
    mirrorUrl: null, githubProxyUrl: null, githubUrl: null, filename: null, sha256: null, fallbackNote: null};
}
function attachAsset(info: UpdateCheckResult, asset: z.infer<typeof assetSchema>, tag: string, proxy: string) {
  const {filename, mirrorUrl, githubUrl, sha256} = asset;
  if (!/^[a-zA-Z0-9._+-]+linux-web\.tar\.gz$/.test(filename) ||
      mirrorUrl !== MIRROR + "/" + filename || githubUrl !== RELEASES + "/download/" + tag + "/" + filename)
    throw new Error("发布文件名或下载来源无效");
  return {...info, filename, mirrorUrl, githubUrl, githubProxyUrl: proxy + "/" + githubUrl, sha256: sha256 ?? null};
}

async function fetchJson(url: string): Promise<unknown> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15_000);
  try {
    const response = await fetch(url, {credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store", signal: abort.signal});
    if (!response.ok) throw new Error("HTTP " + response.status);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("发布信息为空");
    const decoder = new TextDecoder();
    let bytes = 0, text = "";
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2_000_000) { abort.abort(); throw new Error("发布信息过大"); }
      text += decoder.decode(value, {stream:true});
    }
    try { return JSON.parse(text + decoder.decode()); }
    catch { throw new Error("发布信息不是有效的 JSON"); }
  } finally { clearTimeout(timeout); }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("发布信息格式无效");
  return parsed.data;
}

async function mirrorCheck(proxy: string) {
  const data = parse(mirrorSchema, await fetchJson(MIRROR + "/releases.json"));
  normalized(data.version);
  const asset = data.assets.linuxWeb, latest = normalized(asset.version), named = namedVersion(asset.filename);
  if (named && named !== latest) throw new Error("安装包版本与清单不符");
  return attachAsset(result("cn", latest, data.notes, data.releasedAt, "https://atlas.sayori.org/download"), asset, "v" + latest, proxy);
}

async function githubCheck(proxy: string) {
  let release = parse(githubSchema, await fetchJson(API + "/latest"));
  const forWeb = (r: Release) => r.assets.find(a => a.name.endsWith("linux-web.tar.gz"));
  if (!forWeb(release)) {
    const recent = parse(z.array(githubSchema), await fetchJson(API + "?per_page=30"));
    release = recent.find(r => !r.draft && !r.prerelease && forWeb(r)) ?? release;
  }
  const tag = release.tag_name, releaseVersion = normalized(tag), asset = forWeb(release);
  if (release.html_url !== RELEASES + "/tag/" + tag) throw new Error("GitHub 发布页地址无效");
  const latest = (asset && namedVersion(asset.name)) || releaseVersion;
  const info = result("github", latest, release.body ?? "", release.published_at, release.html_url);
  if (!asset) return info;
  return attachAsset(info, parse(assetSchema, {
    version: latest, filename: asset.name, mirrorUrl: MIRROR + "/" + asset.name, githubUrl: asset.browser_download_url,
    sha256: asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : null,
  }), tag, proxy);
}

export async function checkForUpdate({source, customMirror}: UpdatePrefs): Promise<UpdateCheckResult> {
  const proxy = githubProxyPrefix(customMirror);
  if (isTauri) return invoke("check_app_update", {source, customMirror});
  if (source === "github") return githubCheck(proxy);
  try { return await mirrorCheck(proxy); }
  catch (error) {
    if (source !== "auto") throw error;
    try { return {...await githubCheck(proxy), fallbackNote: "国内镜像不可用，已改用国际 GitHub 源。"}; }
    catch (second) { throw new Error(`国内镜像：${error}；GitHub：${second}`); }
  }
}
