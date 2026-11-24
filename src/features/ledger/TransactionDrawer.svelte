<script lang="ts">
  import { onMount } from "svelte";
  import type { Transaction } from "../../domain/ledger";
  import { formatMoney, units } from "../../domain/money";
  import Icon from "../../lib/Icon.svelte";
  import {
    animateDialogClose,
    backdropDismiss,
    sheetDrag,
  } from "../../lib/motion";
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
  $: fromLeg =
    entry.kind === "TRANSFER"
      ? (entry.legs.find((l) => units(l.money) < 0n) ?? entry.legs[0])
      : entry.legs[0];
  $: toLeg =
    entry.kind === "TRANSFER"
      ? (entry.legs.find((l) => units(l.money) > 0n) ?? entry.legs[1])
      : entry.legs[1];
  onMount(() => {
    dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  });
  function requestClose() {
    if (busy) return;
    animateDialogClose(dialog, close, 180);
  }
</script>

<dialog
  class="app-dialog drawer"
  bind:this={dialog}
  use:sheetDrag={{ enabled: () => !busy, onDismiss: close }}
  use:backdropDismiss={{ enabled: () => !busy, onDismiss: requestClose }}
  on:cancel|preventDefault={requestClose}
  aria-labelledby="tx-title"
>
  <div class="drawer-handle drag-zone" aria-hidden="true"><span></span></div>
  <header class="drag-zone">
    <span>{entry.occurredAt} · {kindLabel(entry.kind)}</span><button
      type="button"
      class="icon-button"
      disabled={busy}
      on:click={requestClose}
      aria-label="关闭流水详情"><Icon name="Close" /></button
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
      <dt>{entry.kind === "TRANSFER" ? "转出账户" : "账户"}</dt>
      <dd>{accountLabel(fromLeg.accountId)}</dd>
    </div>
    <div>
      <dt>{entry.kind === "TRANSFER" ? "转入账户" : "分类"}</dt>
      <dd>{accountLabel(toLeg.accountId)}</dd>
    </div>
    {#if entry.payee}<div>
        <dt>交易对方</dt>
        <dd>{entry.payee}</dd>
      </div>{/if}{#if entry.source.import}<div>
        <dt>来源</dt>
        <dd>{entry.source.import}</dd>
      </div>{/if}
  </dl>
  <details class="legs-disclosure" open={showEntries}>
    <summary>复式分录 · {entry.legs.length} 条记账明细</summary>
    <div class="legs-list">
      {#each entry.legs as leg}<div class="leg">
          <span>{accountLabel(leg.accountId)}</span><b
            >{formatMoney(leg.money)}</b
          >
        </div>{/each}
    </div>
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
      class:danger={!reversed && !entry.reversalOf}
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
    border-radius: 18px 0 0 18px;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .drawer-handle {
    display: none;
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
    margin: 20px 0 8px;
  }
  .amount {
    color: var(--info);
    font-size: 30px;
    font-weight: 650;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
  }
  .income {
    color: var(--income);
  }
  .expense {
    color: var(--expense);
  }
  dl {
    margin: 22px 0;
  }
  dl div,
  .leg {
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  dd {
    margin: 0;
    font-weight: 500;
  }
  summary {
    cursor: pointer;
    color: var(--accent);
    user-select: none;
  }
  footer {
    margin-top: 24px;
    justify-content: flex-start;
    flex-wrap: wrap;
  }
  @media (prefers-reduced-motion: no-preference) {
    .drawer[open] {
      animation: rk-drawer-in var(--dur-sheet, 280ms) var(--ease-out, ease-out)
        backwards;
    }
    .drawer:global(.is-closing) {
      animation: rk-drawer-out var(--dur-micro, 160ms) var(--ease-in, ease-in)
        forwards;
    }
    .legs-disclosure[open] .legs-list {
      animation: rk-reveal-in var(--dur-micro, 150ms) var(--ease-out, ease-out)
        backwards;
    }
  }
  @media (max-width: 650px) {
    .drawer {
      inset: auto 0 0;
      margin: 0;
      width: 100%;
      height: auto;
      max-height: 85dvh;
      border-radius: 22px 22px 0 0;
      padding: 6px 18px calc(20px + env(safe-area-inset-bottom));
      touch-action: pan-y;
    }
    .drawer-handle {
      display: grid;
      place-items: center;
      padding: 8px 0 8px;
      cursor: grab;
      touch-action: none;
    }
    .drawer-handle span {
      height: 4px;
      width: 38px;
      background: var(--border-strong);
      border-radius: 99px;
      opacity: 0.85;
    }
    @media (prefers-reduced-motion: no-preference) {
      .drawer[open] {
        animation: rk-sheet-up var(--dur-sheet, 280ms) var(--ease-out, ease-out)
          backwards;
      }
      .drawer:global(.is-closing) {
        animation: rk-sheet-down var(--dur-micro, 160ms) var(--ease-in, ease-in)
          forwards;
      }
    }
  }
</style>
