<script lang="ts">
  import { APP_VERSION, compareSemver, githubProxyPrefix, type UpdatePrefs, type UpdateCheckResult } from "../../lib/updater";
  import { isMobile, isWindows, isTauri } from "../../lib/runtime";
  import Icon from "../../lib/Icon.svelte";
  import { slidingIndicator } from "../../lib/motion";

  export let prefs: UpdatePrefs;
  export let info: UpdateCheckResult | null;
  export let checking: boolean;
  export let error: string;
  export let check: () => void;
  export let change: (value: Partial<UpdatePrefs>) => void;
  export let open: (url: string) => void;

  const sources = [
    ["auto", "自动（优先国内）"], ["cn", "国内镜像源"], ["github", "国际 GitHub 源"],
  ] as const;
  const nativePlatform = isMobile ? "Android" : isWindows ? "Windows" : "Linux";
  const platformNames = {android: "Android", windows: "Windows", linuxDeb: "Linux", linuxWeb: "Web"};
  $: platform = info ? platformNames[info.platform] : isTauri ? nativePlatform : "Web";
  $: copyUrl = info && (info.sourceUsed === "github" ? info.githubUrl : info.mirrorUrl);
  let copied = "", manualCopy = "";
  let mirrorDraft = prefs.customMirror, mirrorError = "";
  $: {
    try {
      githubProxyPrefix(mirrorDraft);
      mirrorError = "";
    } catch (e) { mirrorError = e instanceof Error ? e.message : String(e); }
  }
  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      copied = url; manualCopy = "";
    } catch { manualCopy = url; }
  }
  function checkedAt(timestamp: number) {
    return new Date(timestamp).toLocaleString("zh-CN", {month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"});
  }
</script>

<section class="panel settings-panel" id="app-update" aria-labelledby="update-title" tabindex="-1">
  <div class="section-heading">
    <h2 id="update-title">应用更新</h2>
    <span class="badge">{platform} <span>·</span> v{APP_VERSION}</span>
  </div>
  <div class="source-row">
    <strong>更新来源</strong>
    <div class="segmented" role="group" aria-label="更新来源" use:slidingIndicator>
      {#each sources as [source, title]}
        <button aria-pressed={prefs.source === source} on:click={() => change({source})}>{title}</button>
      {/each}
    </div>
  </div>
  <div class="preference-row">
    <strong>启动时自动检查更新</strong>
    <button class="preference-switch" role="switch" aria-label="启动时自动检查更新"
      class:enabled={prefs.autoCheck} aria-checked={prefs.autoCheck} on:click={() => change({autoCheck: !prefs.autoCheck})}><span></span></button>
  </div>
  <details>
    <summary>自定义国内镜像前缀</summary>
    <input type="url" aria-label="自定义国内镜像前缀" placeholder="https://gh-proxy.org/"
      autocomplete="off" spellcheck="false" bind:value={mirrorDraft} on:change={() => {if (!mirrorError) change({customMirror: mirrorDraft.trim()});}}
      aria-invalid={!!mirrorError} aria-describedby="mirror-help" />
    <small id="mirror-help">{mirrorError || "仅用于 GitHub 加速下载。留空使用 gh-proxy.org。"}</small>
  </details>
  <div class="button-row check">
    <button class="primary" disabled={checking || !!mirrorError} on:click={check}>
      {#if checking}<span class="spinner" aria-hidden="true"></span> 正在检查…{:else}检查更新{/if}
    </button>
    {#if prefs.lastCheckedAt}<small>上次检查 {checkedAt(prefs.lastCheckedAt)}</small>{/if}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if info}
    <div class="result reveal-in" aria-live="polite">
      <div class="result-heading">
        <strong>{!info.filename ? "此发布暂无本平台安装包" : info.hasUpdate ? "发现新版本 v" + info.latestVersion : "已是最新版本"}</strong>
        <span class="badge">{info.sourceUsed === "cn" ? "国内镜像" : "国际 GitHub"}</span>
        {#if info.releasedAt}<time datetime={info.releasedAt}>{info.releasedAt.slice(0, 10)}</time>{/if}
      </div>
      {#if info.fallbackNote}<small>{info.fallbackNote}</small>{/if}
      {#if info.notes}<p class="notes">{info.notes}</p>{/if}
      {#if info.filename}
        <small class="package">{info.platform === "linuxWeb" ? "Linux 网页服务端" : platform}安装包 · v{info.latestVersion}{compareSemver(info.latestVersion, info.currentVersion) < 0 ? "（早于当前版本）" : ""}</small>
        <div class="button-row">
          {#if info.mirrorUrl}<button class={info.hasUpdate && info.sourceUsed === "cn" ? "primary" : "secondary"} on:click={() => open(info!.mirrorUrl!)}>国内镜像下载（官网直连）</button>{/if}
          {#if info.githubProxyUrl && info.githubProxyUrl !== info.mirrorUrl}<button class="secondary" on:click={() => open(info!.githubProxyUrl!)}>GitHub 镜像加速下载</button>{/if}
          {#if info.githubUrl}<button class={info.hasUpdate && info.sourceUsed === "github" ? "primary" : "secondary"} on:click={() => open(info!.githubUrl!)}>国际 GitHub 源下载</button>{/if}
        </div>
      {/if}
      <div class="links">
        {#if copyUrl}<button class="text-button copy-btn" class:copied={copied === copyUrl} title={copyUrl} on:click={() => copy(copyUrl!)}>{#if copied === copyUrl}<Icon name="Check" /> 已复制下载链接{:else}复制下载链接{/if}</button>{/if}
        <button class="text-button" on:click={() => open(info!.releasePageUrl)}>查看发布页 ↗</button>
      </div>
      {#if manualCopy && manualCopy === copyUrl}<label>请手动复制下载链接<input readonly value={manualCopy} on:focus={e => e.currentTarget.select()} /></label>{/if}
    </div>
  {/if}
</section>

<style>
  #app-update { scroll-margin: 16px; }
  .source-row, .result-heading, .links { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .source-row { justify-content: space-between; padding-bottom: 16px; }
  .source-row strong { font-size: 13px; font-weight: 500; }
  .segmented { max-width: 100%; flex-wrap: wrap; }
  .badge { background: var(--accent-soft); color: var(--accent); padding: 3px 8px; border-radius: 5px; font-size: 12px; font-weight: 550; }
  .badge span { margin: 0 2px; }
  summary { cursor: pointer; color: var(--muted); font-size: 13px; }
  input { width: 100%; margin: 9px 0 4px; }
  small, time { color: var(--muted); font-size: 12px; }
  .check { margin-top: 18px; }
  .spinner { display: inline-block; width: 12px; height: 12px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  .result { border-top: 1px solid var(--border); margin-top: 18px; padding-top: 16px; overflow-wrap: anywhere; }
  .result-heading { margin-bottom: 7px; }
  .result-heading strong { font-size: 15px; }
  .notes { white-space: pre-wrap; max-height: 14rem; overflow: auto; margin: 10px 0; font-size: 14px; }
  .package { display: block; margin: 14px 0 7px; }
  .links { margin-top: 10px; }
  .copy-btn { display: inline-flex; align-items: center; gap: 4px; }
  .copy-btn.copied { color: var(--income); }
  .copy-btn :global(svg) { width: 14px; height: 14px; }
</style>
