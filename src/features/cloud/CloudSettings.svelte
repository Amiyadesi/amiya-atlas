<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { invoke, isTauri, isSelfhost, isPersistent } from "../../lib/runtime";
  import { selfRequest } from "../../lib/selfhost-auth";
  import { confirmDialog } from "../../lib/dialog";
  import Icon from "../../lib/Icon.svelte";
  export let summary:boolean, open:()=>void;
  export let changed: () => Promise<void>;
  let connected = false,
    email = "",
    busy = false,
    message = "",
    userCode = "",
    balance: {
      monthly: number;
      topup: number;
      total: number;
      unlimited?: boolean;
      canChooseModels?: boolean;
      selectedModel?: string;
      models?: Array<{ id: string; name: string }>;
    } | null = null;
  let verificationUrl = "",
    selectedModel = "";
  let features: { billing: boolean; cloud: boolean } | null = null;
  let currency = "cny";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const purchases = new Map<string, string>();
  async function refresh() {
    purchases.clear();
    const state = await invoke<{ connected: boolean; email?: string }>(
      "cloud_status",
    );
    connected = state.connected;
    email = state.email ?? "";
    features = await invoke("cloud_request", { path: "/api/features" });
    balance = connected
      ? await invoke("cloud_request", { path: "/api/account/balance" })
      : null;
    selectedModel = balance?.selectedModel ?? "";
  }
  async function run(task: () => Promise<void>) {
    busy = true;
    message = "";
    try {
      await task();
    } catch (e) {
      message =
        typeof e === "string"
          ? e
          : e instanceof Error
            ? e.message
            : "操作失败，请重试";
    } finally {
      busy = false;
    }
  }
  async function poll() {
    if (disposed) return;
    try {
      const result = await invoke<{ pending?: boolean; connected?: boolean }>(
        "cloud_device_poll",
      );
      if (disposed) return;
      if (result.pending) {
        timer = setTimeout(() => void poll(), 5000);
        return;
      }
      userCode = "";
      message = "已登录";
      await refresh();
      await changed();
      if (isSelfhost) {
        try {
          await selfRequest("/api/security/cloud-link", {});
        } catch {
          message = "已登录；服务器尚未关联，可在同步设置中重试";
        }
      }
    } catch (e) {
      if (!disposed) {
        userCode = "";
        message = typeof e === "string" ? e : "登录失败，请重新连接";
      }
    }
  }
  async function connect() {
    const tab = !isTauri ? window.open("about:blank", "_blank") : null;
    if (tab) tab.opener = null;
    await run(async () => {
      if (timer) clearTimeout(timer);
      const result = await invoke<{
        userCode: string;
        verificationUrl?: string;
      }>("cloud_device_start");
      userCode = result.userCode;
      verificationUrl =
        result.verificationUrl ??
        `https://atlas.sayori.org/device?user_code=${encodeURIComponent(result.userCode)}`;
      if (tab) tab.location.href = verificationUrl;
      timer = setTimeout(() => void poll(), 5000);
    });
    if (!userCode && tab) tab.close();
  }
  async function logout() {
    if (
      !(await confirmDialog({
        title: "退出官网账户？",
        description: "本地加密记录不会受影响，退出后云模型将暂停使用。",
        confirmLabel: "退出登录",
        danger: true,
      }))
    )
      return;
    await run(async () => {
      if (timer) clearTimeout(timer);
      userCode = "";
      try {
        await invoke("cloud_logout");
      } finally {
        await changed();
        await refresh();
      }
    });
  }
  async function buy(kind: string) {
    const tab = !isTauri ? window.open("about:blank", "_blank") : null;
    if (tab) tab.opener = null;
    await run(async () => {
      const key = kind + ":" + currency;
      const requestId = purchases.get(key) ?? crypto.randomUUID();
      purchases.set(key, requestId);
      const result = await invoke<{ url: string }>("cloud_request", {
        path: "/api/account/checkout",
        body: { kind, currency, requestId },
      });
      if (isTauri) await invoke("cloud_open_payment", { url: result.url });
      else if (tab) tab.location.href = result.url;
      else throw new Error("请允许打开付款页面后重试");
    });
    if (message && tab) tab.close();
  }
  async function portal() {
    const tab = !isTauri ? window.open("about:blank", "_blank") : null;
    if (tab) tab.opener = null;
    await run(async () => {
      const result = await invoke<{ url: string }>("cloud_request", {
        path: "/api/account/portal",
        body: {},
      });
      if (isTauri) await invoke("cloud_open_payment", { url: result.url });
      else if (tab) tab.location.href = result.url;
      else throw new Error("请允许打开付款页面后重试");
    });
    if (message && tab) tab.close();
  }
  onMount(() => {
    if(isPersistent) void run(refresh);
  });
  onDestroy(() => {
    disposed = true;
    if (timer) clearTimeout(timer);
  });
</script>

{#if summary}
  <button class="profile-row" on:click={open}><span class="profile-avatar"><Icon name="Account"/></span>
    <span class="profile-name"><strong>{email || "登录官网账户"}</strong><small>{connected?"官网账户":"本地记忆库"}</small></span>
    <span class="profile-status">{connected?(balance?.unlimited?"不限次数":balance?"剩余 "+balance.total+" 次":"额度待刷新"):"本地免费使用"}</span><Icon name="Chevron"/>
  </button>
{:else if !isPersistent}
  <section class="panel"><p>浏览器预览使用临时记忆库。请在应用或自托管版中登录官网账户。</p><a class="text-button" href="https://atlas.sayori.org/pricing" target="_blank" rel="noreferrer">查看套餐</a></section>
{:else}
<div class="cloud-settings">
  {#if features && !features.cloud}<span>云服务未开放</span>{/if}
  {#if connected}<div class="cloud-account">
      <span>{email}</span><button disabled={busy} on:click={logout}
        >退出登录</button
      >
    </div>
    <div class="cloud-balance">
      <strong
        >{balance?.unlimited ? "不限次数" : (balance?.total ?? "—")}
        {#if !balance?.unlimited}<small>次可用</small>{/if}</strong
      >
      {#if !balance?.unlimited}
        <span
          >本月 {balance?.monthly ?? "—"} · 永久加量 {balance?.topup ?? "—"}</span
        >
      {:else}
        <span>已享不限次云端整理额度</span>
      {/if}
      <button disabled={busy} on:click={() => run(refresh)}>刷新</button>
    </div>
    {#if balance?.models?.length}<label
        >云模型<select
          bind:value={selectedModel}
          disabled={busy}
          on:change={() =>
            run(async () => {
              balance = await invoke("cloud_request", {
                path: "/api/account/model",
                body: { model: selectedModel },
              });
              selectedModel = balance?.selectedModel ?? "";
            })}
          >{#each balance.models as model}<option
              value={model.id}
              disabled={!balance.canChooseModels &&
                model.id !== balance.models?.[0].id}>{model.name}</option
            >{/each}</select
        ></label
      >{/if}
    {#if features?.billing}
      {#if !balance?.unlimited}
        <div class="cloud-actions">
          <label
            >币种<select bind:value={currency}
              ><option value="cny">CNY ¥20</option><option value="hkd"
                >HKD HK$23.50</option
              ><option value="usd">USD US$2.99</option></select
            ></label
          ><button
            disabled={busy || !features?.billing}
            on:click={() => buy("monthly")}>月套餐 · 300 次</button
          ><button
            disabled={busy || !features?.billing}
            on:click={() => buy("topup")}>加量包 · 300 次</button
          >
        </div>
      {/if}
      <button disabled={busy || !features?.billing} on:click={portal}
        >管理订阅 / 付款</button
      >
    {/if}
  {:else}<button
      class="connect"
      disabled={busy || !!userCode}
      on:click={connect}>登录</button
    >{/if}
  {#if userCode}<div class="device-code">{userCode}</div>
    <a href={verificationUrl} target="_blank" rel="noreferrer">继续登录</a>{/if}
  {#if !balance?.unlimited}<a
      href="https://atlas.sayori.org/pricing"
      target="_blank"
      rel="noreferrer">查看套餐</a
    >{/if}
  {#if message}<p class="status" role="status">{message}</p>{/if}
</div>
{/if}

<style>
  .cloud-settings{display:grid;gap:0;padding:4px 18px;border-radius:18px;background:var(--surface);box-shadow:var(--shadow-sm)}
  .cloud-settings>label,.cloud-account,.cloud-actions label{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .cloud-settings>label,.cloud-settings>a,.cloud-actions>*,.cloud-account,.cloud-settings>button{min-height:50px;padding:10px 0;text-align:left;border-bottom:.5px solid var(--border)}
  .cloud-account span{overflow-wrap:anywhere;min-width:0}.cloud-account button{flex:none}
  .cloud-settings button,.cloud-settings a{color:var(--accent);font-size:14px;background:none}.cloud-settings button{padding:8px}
  .cloud-actions{display:grid}.cloud-settings select{max-width:70%;background:var(--surface-raised);border:0}
  .cloud-balance{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0 8px;padding:16px 0;border-bottom:.5px solid var(--border)}
  .cloud-balance strong{font-size:30px}.cloud-balance span,.cloud-balance small{color:var(--muted);font-size:12px}
  .cloud-balance span{grid-column:1}.cloud-balance button{grid-column:2;grid-row:1/3;align-self:center}
  .cloud-settings .device-code{font-size:26px;letter-spacing:.15em;text-align:center;color:var(--accent);padding:12px}
  .status{font-size:13px;color:var(--muted);padding:8px 0;margin:0}
</style>
