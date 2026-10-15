<script lang="ts">
  import { onDestroy } from "svelte";
  import { invoke, isTauri, isMobile, isSelfhost } from "../../lib/runtime";
  import type { SyncStatus } from "../../lib/sync";
  export let status: SyncStatus;
  export let changed: () => Promise<void>;
  let url = status.url, username = status.username, password = "", automatic = status.automatic;
  let kind = status.kind, server = status.kind === "server" ? status.url.replace(/\/api\/sync$/, "") : "";
  let flow: { deviceCode: string; userCode: string; url: string; verificationUrl: string } | null = null;
  let timer: number | undefined;
  onDestroy(() => { if (timer !== undefined) clearInterval(timer); });
  let busy = false, error = "", different = false;
  async function run(task: () => Promise<void>) {
    busy = true; error = "";
    try { await task(); }
    catch (e) { const value = e instanceof Error ? e.message : String(e); different = value === "REMOTE_VAULT_DIFFERENT"; error = different ? "远端是另一份记忆库" : value; }
    finally { busy = false; }
  }
  async function synchronize(strategy?: "local" | "remote") {
    if (strategy && !confirm(`冲突条目${strategy === "local" ? "保留本机" : "使用远端"}版本？两份原始库会保留为加密备份。`)) return;
    await run(async () => { status = await invoke<SyncStatus>("sync_run", { strategy }); await changed(); });
  }
  async function save() {
    await run(async () => {
      if (kind === "server") {
        if (timer !== undefined) clearInterval(timer);
        flow = await invoke("sync_server_start", { url: server });
        const expires = Date.now() + 600000;
        timer = window.setInterval(() => {
          if (busy || !flow) return;
          if (Date.now() >= expires) { clearInterval(timer); flow = null; error = "授权已过期，请重新连接"; return; }
          void run(async () => { if (!flow) return; const result = await invoke<{ pending: boolean; status?: SyncStatus }>("sync_server_poll", { url: flow.url, deviceCode: flow.deviceCode, automatic }); if (result.pending) return; if (!result.status) throw new Error("同步状态缺失"); clearInterval(timer); flow = null; status = result.status; await synchronize(); });
        }, 5000);
        return;
      }
      status = await invoke<SyncStatus>("sync_configure", { config: { kind, url, username, password, automatic } });
      password = "";
      status = await invoke<SyncStatus>("sync_run");
      await changed();
    });
  }
  async function adopt() {
    const secret = prompt("导入远端记忆库将替换本机库，并保留本机加密备份。输入远端主密码以继续。");
    if (!secret) return;
    await run(async () => { status = await invoke<SyncStatus>("sync_adopt", { password: secret }); different = false; await changed(); });
  }
</script>

<section class="panel settings-panel">
  <h2>同步</h2>
  {#if !isSelfhost}
  <div class="button-row"><button class:primary={kind === "server"} class:secondary={kind !== "server"} on:click={() => kind = "server"}>自建服务器</button><button class:primary={kind === "webdav"} class:secondary={kind !== "webdav"} on:click={() => kind = "webdav"}>网盘 / WebDAV</button></div>
  <form on:submit|preventDefault={save} class="sync-form">
    {#if kind === "server"}<label>服务器地址<input bind:value={server} required placeholder="https://atlas.example.com 或 IP:端口" /></label>{:else}<label>WebDAV 文件地址<input type="url" bind:value={url} required placeholder="https://cloud.example/remote.php/dav/files/me/relakeep/" /></label>
    <label>用户名<input bind:value={username} required autocomplete="username" /></label>
    <label>应用密码<input type="password" bind:value={password} required={!status.configured} autocomplete="new-password" placeholder={status.configured ? "已保存" : ""} /></label>{/if}
    <label class="check-label"><input type="checkbox" bind:checked={automatic} />自动同步</label>
    <div class="button-row">
      <button class="primary" disabled={busy}>{busy ? "连接中…" : "保存并同步"}</button>
      {#if status.configured}<button type="button" class="secondary" disabled={busy} on:click={() => synchronize()}>立即同步</button><button type="button" class="text-button" disabled={busy} on:click={() => run(async () => { await invoke("sync_disconnect"); status = await invoke<SyncStatus>("sync_status"); await changed(); })}>断开</button>{/if}
      {#if isTauri && !isMobile}<button type="button" class="secondary" on:click={() => run(async () => { await invoke("web_open"); })}>浏览器打开</button>{/if}
    </div>
  </form>
  {:else}<button class="secondary" disabled={busy} on:click={() => synchronize()}>立即同步</button>{/if}
  {#if flow}<div class="preference-row"><strong>{flow.userCode}</strong><a class="secondary" href={flow.verificationUrl} target="_blank" rel="noreferrer">打开服务器授权</a></div>{/if}
  {#if status.lastSync}<p class="muted">上次同步 {new Date(status.lastSync).toLocaleString()}</p>{/if}
  {#if status.conflicts.length}<div class="sync-conflicts" role="alert"><strong>同步冲突</strong><ul>{#each status.conflicts as item}<li>{item}</li>{/each}</ul><div class="button-row"><button class="secondary" disabled={busy} on:click={() => synchronize("local")}>冲突保留本机</button><button class="secondary" disabled={busy} on:click={() => synchronize("remote")}>冲突使用远端</button></div></div>{/if}
  {#if error}<p class="sync-error" role="alert">{error}</p>{/if}
  {#if different}<button class="secondary" disabled={busy} on:click={adopt}>导入远端记忆库</button>{/if}
</section>
<style>
  .sync-form { display:grid; gap:14px; }
  label { display:grid; gap:7px; font-size:13px; }
  .check-label { display:flex; align-items:center; }
  .check-label input { width:auto; }
  .sync-error { color:#b43c49; }
  .sync-conflicts { border:1px solid #c79872; padding:15px; margin-top:16px; border-radius:7px; }
</style>
