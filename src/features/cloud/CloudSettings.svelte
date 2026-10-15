<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { invoke } from "../../lib/runtime";
  export let changed: () => Promise<void>;
  let connected = false,
    email = "",
    busy = false,
    message = "",
    userCode = "",
    balance: { monthly: number; topup: number; total: number } | null = null;
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
      await changed();
      await refresh();
    } catch (e) {
      if (!disposed) {
        userCode = "";
        message = typeof e === "string" ? e : "登录失败，请重新连接";
      }
    }
  }
  async function connect() {
    await run(async () => {
      if (timer) clearTimeout(timer);
      const result = await invoke<{ userCode: string }>("cloud_device_start");
      userCode = result.userCode;
      timer = setTimeout(() => void poll(), 5000);
    });
  }
  async function logout() {
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
    await run(async () => {
      const key = kind + ":" + currency;
      const requestId = purchases.get(key) ?? crypto.randomUUID();
      purchases.set(key, requestId);
      const result = await invoke<{ url: string }>("cloud_request", {
        path: "/api/account/checkout",
        body: { kind, currency, requestId },
      });
      await invoke("cloud_open_payment", { url: result.url });
    });
  }
  async function portal() {
    await run(async () => {
      const result = await invoke<{ url: string }>("cloud_request", {
        path: "/api/account/portal",
        body: {},
      });
      await invoke("cloud_open_payment", { url: result.url });
    });
  }
  onMount(() => {
    void run(refresh);
  });
  onDestroy(() => {
    disposed = true;
    if (timer) clearTimeout(timer);
  });
</script>

<div class="cloud-settings">
  <div class="cloud-intro">
    <strong>官网账户</strong>
  </div>
  {#if features && !features.cloud}<span>云服务未开放</span>{/if}
  {#if connected}<div class="cloud-account">
      <span>{email}</span><button disabled={busy} on:click={logout}
        >退出登录</button
      >
    </div>
    <div class="cloud-balance">
      <strong>{balance?.total ?? "—"} <small>次可用</small></strong><span
        >本月 {balance?.monthly ?? "—"} · 永久加量 {balance?.topup ?? "—"}</span
      ><button disabled={busy} on:click={() => run(refresh)}>刷新</button>
    </div>
    {#if features?.billing}<div class="cloud-actions">
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
    <button disabled={busy || !features?.billing} on:click={portal}
      >管理订阅 / 付款</button
    >{/if}
  {:else}<button
      class="connect"
      disabled={busy || !!userCode}
      on:click={connect}>登录</button
    >{/if}
  {#if userCode}<div class="device-code">{userCode}</div>
    <p role="status">在浏览器核对设备码，批准连接。</p>{/if}
  <button
    disabled={busy}
    on:click={() =>
      run(async () => {
        await invoke("cloud_open", { path: "/pricing" });
      })}>查看套餐</button
  >
  {#if message}<p class="status" role="status">{message}</p>{/if}
</div>

<style>
  .cloud-settings {
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .cloud-intro {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
  }
  p {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
    line-height: 1.8;
  }
  button {
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: 7px;
    padding: 8px 13px;
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    align-self: flex-start;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .connect {
    background: #8163a2;
    color: #ffffff;
  }
  .cloud-account,
  .cloud-balance {
    display: flex;
    align-items: center;
    gap: 18px;
    flex-wrap: wrap;
  }
  .cloud-account button,
  .cloud-balance button {
    margin-left: auto;
  }
  .cloud-account span {
    font-size: 14px;
  }
  .cloud-balance {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px;
    background: #f1ebf7;
  }
  .cloud-balance strong {
    font-size: 30px;
  }
  .cloud-balance strong small {
    font-size: 12px;
    font-weight: 400;
  }
  .cloud-balance span {
    font-size: 12px;
    color: var(--muted);
  }
  .cloud-actions {
    display: flex;
    gap: 12px;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .cloud-actions label {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 11px;
    color: var(--muted);
  }
  select {
    font: inherit;
    border: 1px solid var(--border);
    padding: 8px;
    border-radius: 7px;
    background: var(--surface);
    color: var(--text);
  }
  .device-code {
    font-size: 26px;
    letter-spacing: 0.15em;
    font-family: monospace;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    text-align: center;
    color: #8163a2;
  }
  .status {
    color: #6e5187;
    background: #f0eaf7;
    border: 1px solid #d9cae7;
    padding: 12px;
    border-radius: 6px;
  }
</style>
