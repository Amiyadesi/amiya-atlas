<script lang="ts">
  import Icon from "../../lib/Icon.svelte";
  import type { VaultSnapshot } from "../../lib/types";
  import { createStarterHubs } from "./starter";
  import type { ImportTab } from "../../domain/importers/types";
  export let snapshot: VaultSnapshot,
    open: (tab: ImportTab) => void,
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

{#if !dismissed && snapshot.entities.filter((e) => e.privacy !== "SECRET").length < 5 && (snapshot.transactions??[]).filter(t=>t.privacy!=="SECRET").length < 5}
  <section class="starter">
    <header>
      <h2>开始使用</h2>
      <button class="icon-button" aria-label="关闭起步引导" on:click={dismiss}><Icon name="Close"/></button>
    </header>
    <button class="path" on:click={()=>open("assets")}><span>从 Bitwarden / 微信支付宝导入</span><Icon name="Chevron"/></button>
    <button class="path" aria-expanded={hubs} on:click={()=>hubs=!hubs}><span>30 秒建 3 个核心枢纽</span><span class="chevron" class:open={hubs}><Icon name="Chevron"/></span></button>
    {#if hubs}<form class="reveal-in" on:submit|preventDefault={create}>
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
  .starter{padding:12px 18px 4px;margin:12px 0;background:var(--surface);border-radius:16px;box-shadow:var(--shadow-sm)}
  header,.path{display:flex;align-items:center;justify-content:space-between}
  header h2{font-size:14px;margin:0;color:var(--muted)}
  .path{width:100%;min-height:42px;text-align:left;padding:8px 0;background:none;color:var(--text);font-size:14px}
  .path+.path{border-top:.5px solid var(--border)}.path :global(svg){color:var(--muted);width:14px}
  .chevron{display:inline-flex;transition:transform var(--dur-base,220ms) var(--ease-out,ease-out)}
  .chevron.open{transform:rotate(90deg)}
  form{display:flex;gap:10px;flex-wrap:wrap;padding:0 0 12px}
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
