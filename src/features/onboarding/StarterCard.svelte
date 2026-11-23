<script lang="ts">
  import type { VaultSnapshot } from "../../lib/types";
  import { createStarterHubs } from "./starter";
  import type { ImportTab } from "../../domain/importers/types";
  export let snapshot: VaultSnapshot,
    open: (tab: ImportTab) => void,
    quick: () => void,
    save: (s: VaultSnapshot, message: string) => Promise<void>;
  let dismissed = localStorage.getItem("relakeep:starter-dismissed") === "1",
    hubs = false,
    mail = "",
    phone = "",
    wallet = "",
    ledger = true,
    busy = false,
    error = "";
  function dismiss() {
    localStorage.setItem("relakeep:starter-dismissed", "1");
    dismissed = true;
  }
  async function create() {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await save(
        createStarterHubs(snapshot, mail, phone, wallet, ledger),
        "核心枢纽已保存",
      );
      mail = phone = wallet = "";
      hubs = false;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

{#if !dismissed && snapshot.entities.filter((e) => e.privacy !== "SECRET").length < 5}
  <section class="starter">
    <header>
      <div>
        <h2>从哪里开始？</h2>
        <p>带来已有记录，或先记下今天的一笔。</p>
      </div>
      <button class="icon-button" aria-label="关闭起步引导" on:click={dismiss}
        >×</button
      >
    </header>
    <div class="paths">
      <div>
        <strong>从外部软件导入</strong>
        <div class="links">
          <button on:click={() => open("assets")}>Bitwarden / 浏览器</button
          ><button on:click={() => open("bills")}>微信 / 支付宝账单</button>
        </div>
      </div>
      <button class="path" aria-expanded={hubs} on:click={() => (hubs = !hubs)}
        >30 秒先建 3 个核心枢纽</button
      ><button class="path" on:click={quick}>先记今天的一笔开销</button>
    </div>
    {#if hubs}<form on:submit|preventDefault={create}>
        <label
          >主力邮箱<input
            type="email"
            bind:value={mail}
            placeholder="name@example.com"
          /></label
        ><label
          >主力手机号<input
            type="tel"
            bind:value={phone}
            placeholder="含区号亦可"
          /></label
        ><label
          >常用支付方式 / 钱包<input
            bind:value={wallet}
            placeholder="例如：微信"
          /></label
        >
        {#if wallet.trim()}<label class="check"
            ><input type="checkbox" bind:checked={ledger} />同时建立 CNY
            账本账户</label
          >{/if}<button
          class="primary"
          disabled={busy || !(mail.trim() || phone.trim() || wallet.trim())}
          >保存已填项目</button
        >
      </form>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </section>{/if}

<style>
  .starter {
    padding: 18px 20px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    margin: 18px 0;
  }
  header,
  .paths,
  .links,
  form {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  header {
    justify-content: space-between;
  }
  h2 {
    font-size: 17px;
    margin: 0;
  }
  p {
    margin: 3px 0;
    color: var(--muted);
    font-size: 13px;
  }
  .paths {
    margin-top: 14px;
    align-items: stretch;
  }
  .paths > div,
  .path {
    flex: 1 1 155px;
    text-align: left;
    padding: 10px;
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 13px;
  }
  .links {
    gap: 7px;
    margin-top: 5px;
  }
  .links button {
    padding: 0;
    background: none;
    color: var(--accent);
    font-size: 12px;
  }
  .path:hover {
    background: var(--accent-soft);
  }
  form {
    margin-top: 14px;
    align-items: end;
  }
  form label {
    flex: 1 1 145px;
    min-width: 0;
    font-size: 12px;
  }
  form input {
    width: 100%;
  }
  .check input {
    width: auto;
  }
</style>
