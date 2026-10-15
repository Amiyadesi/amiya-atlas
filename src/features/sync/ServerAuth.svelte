<script lang="ts">
  import { onMount } from "svelte";
  import { selfAuth, selfRequest } from "../../lib/selfhost-auth";
  export let authenticated: () => Promise<void>;
  let setup = false, available = false, email = "", password = "", setupToken = "", code = "", factor = false, recovery = false, busy = false, error = "";
  async function run(task: () => Promise<void>) { busy = true; error = ""; try { await task(); } catch (e) { error = e instanceof Error ? e.message : String(e); } finally { busy = false; } }
  onMount(() => { void run(async () => { const value = await selfRequest<{ required: boolean; passkeys: boolean }>("/api/setup"); setup = value.required; available = value.passkeys && window.isSecureContext; }); });
  async function signIn() { await run(async () => {
    if (setup) { await selfRequest("/api/setup", { email, password, setupToken }); }
    else { const result = await selfAuth.signIn.email({ email, password }); if (result.error) throw new Error(result.error.message); if (result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect) { factor = true; password = ""; return; } }
    password = ""; setupToken = ""; await authenticated();
  }); }
  async function verify() { await run(async () => { const result = recovery ? await selfAuth.twoFactor.verifyBackupCode({ code }) : await selfAuth.twoFactor.verifyTotp({ code }); if (result.error) throw new Error(result.error.message); code = ""; await authenticated(); }); }
</script>
{#if factor}
  <form on:submit|preventDefault={verify}><label>{recovery ? "恢复码" : "验证码"}<input bind:value={code} required autocomplete="one-time-code" inputmode={recovery ? "text" : "numeric"} /></label><button class="primary" disabled={busy}>验证</button><button type="button" class="text-button" on:click={() => recovery = !recovery}>{recovery ? "使用验证器" : "使用恢复码"}</button></form>
{:else}
  <form on:submit|preventDefault={signIn}>
    {#if setup}<label>设置码<input type="password" bind:value={setupToken} required autocomplete="off" /></label>{/if}
    <label>邮箱<input type="email" bind:value={email} required autocomplete="username" /></label>
    <label>密码<input type="password" bind:value={password} required minlength={setup ? 12 : undefined} autocomplete={setup ? "new-password" : "current-password"} /></label>
    <button class="primary" disabled={busy}>{setup ? "创建登录账户" : "登录"}</button>
  </form>
  {#if !setup && available}<button class="secondary" disabled={busy} on:click={() => run(async () => { const result = await selfAuth.signIn.passkey(); if (result.error) throw new Error(result.error.message); await authenticated(); })}>使用通行密钥</button>{/if}
{/if}
{#if error}<p class="error" role="alert">{error}</p>{/if}
