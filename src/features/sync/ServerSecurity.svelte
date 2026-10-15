<script lang="ts">
  import { onMount } from "svelte";
  import { selfAuth, selfRequest } from "../../lib/selfhost-auth";
  let enabled = false, recordEnvironment = false, passkeysAvailable = false, password = "", code = "", totpURI = "", recovery: string[] = [], deviceCode = new URLSearchParams(location.search).get("user_code") ?? "";
  let keys: Array<{ id: string; name?: string }> = [], sessions: Array<{ token: string; userAgent?: string | null; ipAddress?: string | null; createdAt: string | Date }> = [];
  let error = "", busy = false, notice = "";
  async function run(task: () => Promise<void>) { busy = true; error = ""; try { await task(); } catch (e) { error = e instanceof Error ? e.message : String(e); } finally { busy = false; } }
  async function refresh() {
    const session = await selfAuth.getSession(); if (session.error || !session.data) throw new Error("请重新登录"); enabled = !!session.data.user.twoFactorEnabled;
    const settings = await selfRequest<{ enabled: boolean; passkeys: boolean }>("/api/security/environment"); recordEnvironment = settings.enabled; passkeysAvailable = settings.passkeys && window.isSecureContext;
    if (passkeysAvailable) { const result = await selfAuth.passkey.listUserPasskeys(); if (result.error) throw new Error(result.error.message); keys = result.data ?? []; }
    const result = await selfAuth.listSessions(); if (result.error) throw new Error(result.error.message); sessions = result.data ?? [];
  }
  onMount(() => { void run(refresh); });
  async function enable() { await run(async () => { const result = await selfAuth.twoFactor.enable({ password }); if (result.error) throw new Error(result.error.message); if (!result.data || result.data.method !== "totp") throw new Error("未返回验证器设置"); totpURI = result.data.totpURI; recovery = result.data.backupCodes; password = ""; }); }
  async function verify() { await run(async () => { const result = await selfAuth.twoFactor.verifyTotp({ code }); if (result.error) throw new Error(result.error.message); totpURI = ""; code = ""; await refresh(); }); }
</script>
<section class="panel settings-panel">
  <h2>服务器登录</h2>
  {#if deviceCode}<form class="security-form" on:submit|preventDefault={() => run(async () => { await selfRequest("/api/auth/device?user_code=" + encodeURIComponent(deviceCode)); await selfRequest("/api/auth/device/approve", { userCode: deviceCode }); notice = "设备已连接"; deviceCode = ""; history.replaceState(null,"",location.pathname); })}><label>设备码<input bind:value={deviceCode} required /></label><button class="primary" disabled={busy}>允许这台设备同步</button></form>{/if}
  <h3>两步验证</h3>
  {#if totpURI}<a class="secondary" href={totpURI}>在验证器中打开</a><label>密钥<input readonly value={new URL(totpURI).searchParams.get("secret") ?? ""} /></label><form class="security-form" on:submit|preventDefault={verify}><label>验证码<input bind:value={code} required inputmode="numeric" autocomplete="one-time-code" /></label><button class="primary" disabled={busy}>确认开启</button></form>
  {:else}<form class="security-form" on:submit|preventDefault={enabled ? () => run(async () => { if (!confirm("关闭两步验证？")) return; const result = await selfAuth.twoFactor.disable({ password }); if (result.error) throw new Error(result.error.message); password = ""; await refresh(); }) : enable}><label>当前密码<input type="password" bind:value={password} required autocomplete="current-password" /></label><button class="secondary" disabled={busy}>{enabled ? "关闭两步验证" : "开启两步验证"}</button></form>{/if}
  {#if recovery.length}<label>恢复码<textarea readonly rows="5" value={recovery.join("\n")}></textarea></label><button class="text-button" on:click={() => recovery = []}>已保存</button>{/if}
  {#if passkeysAvailable}<h3>通行密钥</h3><button class="secondary" disabled={busy} on:click={() => run(async () => { const result = await selfAuth.passkey.addPasskey({ name: new Date().toLocaleDateString() }); if (result.error) throw new Error(result.error.message); await refresh(); })}>添加通行密钥</button>{#each keys as key}<div class="preference-row"><span>{key.name ?? "通行密钥"}</span><button class="text-button" disabled={busy} on:click={() => run(async () => { if (!confirm("删除这把通行密钥？")) return; const result = await selfAuth.passkey.deletePasskey({ id: key.id }); if (result.error) throw new Error(result.error.message); await refresh(); })}>删除</button></div>{/each}{/if}
  <label class="environment-toggle"><input type="checkbox" bind:checked={recordEnvironment} disabled={busy} on:change={() => run(async () => { await selfRequest("/api/security/environment", { enabled: recordEnvironment }); await refresh(); })} />记录登录环境</label>
  {#each sessions as session}<div class="preference-row"><span>{new Date(session.createdAt).toLocaleString()}{#if session.userAgent}<small>{session.userAgent}</small>{/if}{#if session.ipAddress}<small>{session.ipAddress}</small>{/if}</span><button class="text-button" disabled={busy} on:click={() => run(async () => { const result = await selfAuth.revokeSession({ token: session.token }); if (result.error) throw new Error(result.error.message); await refresh(); })}>退出</button></div>{/each}
  {#if error}<p class="error" role="alert">{error}</p>{/if}{#if notice}<p role="status">{notice}</p>{/if}
</section>
<style>.security-form{display:grid;gap:12px;margin:16px 0}label{display:grid;gap:7px}.environment-toggle{display:flex;gap:10px;margin:24px 0}.environment-toggle input{width:auto}h3{margin-top:24px}small{display:block;overflow-wrap:anywhere}textarea{font-family:monospace}</style>
