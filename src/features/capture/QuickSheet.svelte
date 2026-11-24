<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "../../lib/Icon.svelte";
  import {
    animateDialogClose,
    backdropDismiss,
    sheetDrag,
    slidingIndicator,
  } from "../../lib/motion";
  export let mode: "bill" | "asset",
    close: () => void,
    recording = false,
    busy = false;
  let dialog: HTMLDialogElement;
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
  class="app-dialog quick-sheet"
  bind:this={dialog}
  use:sheetDrag={{ enabled: () => !busy && !recording, onDismiss: close }}
  use:backdropDismiss={{
    enabled: () => !busy && !recording,
    onDismiss: requestClose,
  }}
  aria-label="快速记录"
  on:cancel|preventDefault={requestClose}
>
  <div class="sheet-handle drag-zone" aria-hidden="true"><span></span></div>
  <header class="drag-zone">
    <div
      class="segmented"
      role="group"
      aria-label="记录类型"
      use:slidingIndicator
    >
      <button
        type="button"
        aria-pressed={mode === "bill"}
        disabled={recording || busy}
        on:click={() => (mode = "bill")}>记一笔</button
      >
      <button
        type="button"
        aria-pressed={mode === "asset"}
        disabled={busy}
        on:click={() => (mode = "asset")}>记资产</button
      >
    </div>
    <button
      type="button"
      class="icon-button"
      aria-label="关闭快速输入"
      disabled={busy}
      on:click={requestClose}><Icon name="Close" /></button
    >
  </header>
  <slot />
</dialog>

<style>
  .quick-sheet {
    width: min(490px, calc(100% - 32px));
    max-height: 88dvh;
    margin: auto;
    padding: 20px 24px;
    border: 0;
    border-radius: 22px;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .sheet-handle {
    display: none;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  header .segmented button {
    min-width: 76px;
    min-height: 34px;
  }
  @media (max-width: 600px) {
    .quick-sheet {
      inset: auto 0 0;
      margin: 0;
      width: 100%;
      max-width: 100%;
      max-height: calc(100dvh - env(safe-area-inset-top) - 12px);
      padding: 6px max(18px, env(safe-area-inset-right))
        calc(16px + env(safe-area-inset-bottom))
        max(18px, env(safe-area-inset-left));
      border-radius: 22px 22px 0 0;
      touch-action: pan-y;
    }
    .sheet-handle {
      display: grid;
      place-items: center;
      padding: 8px 0 10px;
      cursor: grab;
      touch-action: none;
    }
    .sheet-handle span {
      height: 4px;
      width: 38px;
      background: var(--border-strong);
      border-radius: 99px;
      opacity: 0.85;
    }
    @media (prefers-reduced-motion: no-preference) {
      .quick-sheet[open] {
        animation: rk-sheet-up var(--dur-sheet, 280ms) var(--ease-out, ease-out)
          backwards;
      }
      .quick-sheet:global(.is-closing) {
        animation: rk-sheet-down var(--dur-micro, 160ms) var(--ease-in, ease-in)
          forwards;
      }
    }
  }
</style>
