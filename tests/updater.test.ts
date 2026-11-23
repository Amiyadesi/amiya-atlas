import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../web/static/downloads/releases.json";
import {
  APP_VERSION, checkForUpdate, compareSemver, getUpdatePrefs, openUpdateDownload, saveUpdatePrefs,
} from "../src/lib/updater";

const origin = "https://github.com/Amiyadesi/amiya-atlas/releases";
const api = "https://api.github.com/repos/Amiyadesi/amiya-atlas/releases";
const mirror = "https://atlas.sayori.org/downloads";
const filename = "Relakeep_0.10.0_linux-web.tar.gz";
const asset = {name: filename, browser_download_url: origin + "/download/v0.10.0/" + filename};
const release = {tag_name: "v0.10.0", html_url: origin + "/tag/v0.10.0", published_at: "2026-11-23", body: "更新说明",
  assets: [{name: "app-arm64.apk", browser_download_url: "unused"}, asset]};
const prefs = {source: "auto", autoCheck: true, customMirror: "", dismissedVersion: "", lastCheckedAt: 0} as const;
afterEach(() => vi.unstubAllGlobals());

describe("update checks", () => {
  it("compares full semantic versions, normalizes tags and ignores build metadata", () => {
    for (const [a,b] of [["0.9.4","0.9.3"],["0.10.0","0.9.9"],["0.9.4","0.9.4-rc.2"],["0.9.4-rc.10","0.9.4-rc.2"]]) {
      expect(compareSemver(a,b)).toBe(1);
      expect(compareSemver(b,a)).toBe(-1);
    }
    expect(compareSemver("v0.9.4", "0.9.4+build")).toBe(0);
    expect(() => compareSemver("0.9.04", APP_VERSION)).toThrow();
  });

  it("persists the source, prefix, startup throttle and dismissal; damaged preferences recover", () => {
    const store = new Map();
    vi.stubGlobal("localStorage", {getItem: (k: string) => store.get(k), setItem: (k: string,v: string) => store.set(k,v)});
    expect(getUpdatePrefs()).toEqual(prefs);
    const saved = {...prefs, source: "cn" as const, autoCheck: false, customMirror: "https://mirror.example/", lastCheckedAt: 42, dismissedVersion: "0.10.0"};
    saveUpdatePrefs(saved);
    expect(getUpdatePrefs()).toEqual(saved);
    store.set("relakeep:update-prefs", "{");
    expect(getUpdatePrefs()).toEqual(prefs);
    store.set("relakeep:update-prefs", '{"source":"other","autoCheck":false}');
    expect(getUpdatePrefs()).toEqual({...prefs, autoCheck:false});
  });

  it("reads live mirror metadata without credentials and compares the server package, not the browser OS or overall release", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({...manifest,version:"9.9.9"}));
    vi.stubGlobal("fetch", fetcher);
    const a = manifest.assets.linuxWeb;
    expect(await checkForUpdate(prefs)).toMatchObject({platform:"linuxWeb", sourceUsed:"cn", currentVersion:APP_VERSION,
      latestVersion:a.version, hasUpdate:compareSemver(a.version,APP_VERSION)>0, githubProxyUrl:"https://gh-proxy.org/"+a.githubUrl,
      githubUrl:a.githubUrl, mirrorUrl:a.mirrorUrl, filename:a.filename});
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(mirror + "/releases.json",expect.objectContaining({credentials:"omit", cache:"no-store"}));
  });

  it.each(["offline","invalid","spoofed"])("auto falls back on %s and builds all three URLs", async reason => {
    const fetcher = vi.fn();
    if (reason === "offline") fetcher.mockRejectedValueOnce(new Error("offline"));
    else if (reason === "invalid") fetcher.mockResolvedValueOnce(Response.json({assets:{}}));
    else fetcher.mockResolvedValueOnce(Response.json({...manifest,assets:{linuxWeb:{...manifest.assets.linuxWeb,mirrorUrl:"https://evil.example/app"}}}));
    vi.stubGlobal("fetch",fetcher.mockResolvedValueOnce(Response.json(release)));
    const result = await checkForUpdate({...prefs, customMirror:"https://mirror.example/prefix/"});
    expect(result).toMatchObject({hasUpdate:true, latestVersion:"0.10.0", sourceUsed:"github", fallbackNote:expect.stringContaining("国内镜像"),
      releasePageUrl:release.html_url, notes:release.body, releasedAt:release.published_at, filename,
      githubUrl:asset.browser_download_url, mirrorUrl:mirror+"/"+filename,
      githubProxyUrl:"https://mirror.example/prefix/"+asset.browser_download_url});
    expect(fetcher.mock.calls.map(c => c[0])).toEqual([mirror + "/releases.json", api+"/latest"]);
  });

  it("finds the prior stable platform build when the latest release only shipped Android", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({...release,assets:release.assets.slice(0,1)}))
      .mockResolvedValueOnce(Response.json([{...release,prerelease:true,body:"beta"},release]));
    vi.stubGlobal("fetch", fetcher);
    const result = await checkForUpdate({...prefs, source:"github"});
    expect(result.filename).toBe(filename);
    expect(result.notes).toBe(release.body);
    expect(fetcher.mock.calls.map(c=>c[0])).toEqual([api+"/latest",api+"?per_page=30"]);
  });

  it("does not fabricate downloads when the platform has no asset", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({...release,assets:[]})).mockResolvedValueOnce(Response.json([])));
    expect(await checkForUpdate({...prefs,source:"github"})).toMatchObject({latestVersion:"0.10.0",filename:null,mirrorUrl:null,githubUrl:null});
  });

  it("honors explicit sources and rejects invalid custom prefixes before any request", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null,{status:503}));
    vi.stubGlobal("fetch",fetcher);
    for (const customMirror of ["http://x.test", "https://me@x.test", "https://x.test/?url="])
      await expect(checkForUpdate({...prefs, customMirror})).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(checkForUpdate({...prefs, source:"cn"})).rejects.toThrow("503");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(checkForUpdate(prefs)).rejects.toThrow(/国内镜像.*GitHub/);
  });

  it("pins origins on browser opens, including custom ports and credential-free HTTPS", async () => {
    const open = vi.fn();
    vi.stubGlobal("window",{open});
    for (const url of ["javascript:alert(1)", "http://github.com", "https://github.com.evil.test", "https://me@github.com", "https://github.com:444/", "https://mirror.test/"])
      await expect(openUpdateDownload(url,"https://mirror.test:444/")).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    await openUpdateDownload("https://mirror.test:444/asset","https://mirror.test:444/prefix");
    expect(open).toHaveBeenCalledWith("https://mirror.test:444/asset","_blank","noopener,noreferrer");
  });

  it("delegates to native commands without fetching in the webview", async () => {
    const invoke = vi.fn().mockResolvedValue({sourceUsed:"cn"});
    vi.doMock("../src/lib/runtime", () => ({isTauri:true, invoke}));
    vi.resetModules();
    try {
      const native = await import("../src/lib/updater");
      const customMirror = "https://mirror.test/prefix";
      await native.checkForUpdate({...prefs, source:"cn", customMirror});
      await native.openUpdateDownload(mirror + "/" + filename, customMirror);
      expect(invoke.mock.calls).toEqual([
        ["check_app_update", {source:"cn", customMirror}],
        ["open_update_url", {url:mirror + "/" + filename, customMirror}],
      ]);
    } finally { vi.doUnmock("../src/lib/runtime"); vi.resetModules(); }
  });
});
