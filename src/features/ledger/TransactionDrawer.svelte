<script lang="ts">
  import { onMount } from "svelte";
  import type { Transaction } from "../../domain/ledger";
  import { formatMoney } from "../../domain/money";
  export let entry: Transaction,
    accountLabel: (id: string) => string,
    kindLabel: (v: string) => string,
    amount: string;
  export let showEntries: boolean, reversed: boolean, busy: boolean;
  export let close: () => void,
    repeat: () => void,
    subscribe: () => void,
    reverse: () => void;
  let dialog: HTMLDialogElement;
  onMount(() => dialog.showModal());
</script>

<dialog
  class="app-dialog drawer"
  bind:this={dialog}
  on:cancel|preventDefault={close}
  aria-labelledby="tx-title"
>
  <header>
    <span>{entry.occurredAt} · {kindLabel(entry.kind)}</span><button
      class="icon-button"
      on:click={close}
      aria-label="关闭流水详情">×</button
    >
  </header>
  <h2 id="tx-title">{entry.note || entry.payee || kindLabel(entry.kind)}</h2>
  <strong
    class="amount"
    class:income={entry.kind === "INCOME"}
    class:expense={entry.kind === "SPEND"}>{amount}</strong
  >
  <dl>
    <div>
      <dt>账户</dt>
      <dd>{accountLabel(entry.legs[0].accountId)}</dd>
    </div>
    <div>
      <dt>{entry.kind === "TRANSFER" ? "转入账户" : "对方分录"}</dt>
      <dd>{accountLabel(entry.legs[1].accountId)}</dd>
    </div>
    {#if entry.payee}<div>
        <dt>交易对方</dt>
        <dd>{entry.payee}</dd>
      </div>{/if}{#if entry.source.import}<div>
        <dt>来源</dt>
        <dd>{entry.source.import}</dd>
      </div>{/if}
  </dl>
  <details open={showEntries}>
    <summary>复式分录 · {entry.legs.length}</summary
    >{#each entry.legs as leg}<div class="leg">
        <span>{accountLabel(leg.accountId)}</span><b>{formatMoney(leg.money)}</b
        >
      </div>{/each}
  </details>
  <footer>
    {#if !entry.reversalOf}<button class="primary" on:click={repeat}
        >再来一笔</button
      >{#if entry.kind === "SPEND"}<button
          class="secondary"
          on:click={subscribe}>转为订阅资产</button
        >{/if}{/if}
    <button
      class="text-button"
      disabled={busy || reversed || !!entry.reversalOf}
      on:click={reverse}>{reversed ? "已冲正" : "冲正"}</button
    >
  </footer>
</dialog>

<style>
  .drawer {
    inset: 0 0 0 auto;
    margin: 0;
    width: min(435px, 94vw);
    max-width: 100%;
    height: 100dvh;
    max-height: 100dvh;
    padding: 25px;
    border-radius: 12px 0 0 12px;
    overflow: auto;
  }
  header,
  dl div,
  .leg,
  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 9px;
  }
  header,
  dt {
    color: var(--muted);
    font-size: 13px;
  }
  h2 {
    overflow-wrap: anywhere;
    margin: 30px 0 8px;
  }
  .amount {
    color: var(--info);
    font-size: 26px;
    font-variant-numeric: tabular-nums;
  }
  .income {
    color: var(--income);
  }
  .expense {
    color: var(--expense);
  }
  dl {
    margin: 26px 0;
  }
  dl div,
  .leg {
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  dd {
    margin: 0;
  }
  summary {
    cursor: pointer;
    color: var(--accent);
  }
  footer {
    margin-top: 26px;
    justify-content: flex-start;
    flex-wrap: wrap;
  }
  @media (max-width: 650px) {
    .drawer {
      inset: auto 0 0;
      margin: 0;
      width: 100%;
      height: auto;
      max-height: 85dvh;
      border-radius: 14px 14px 0 0;
      padding: 18px 18px calc(20px + env(safe-area-inset-bottom));
    }
  }
</style>
