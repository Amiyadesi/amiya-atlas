<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "../../lib/Icon.svelte";
  export let mode: "bill" | "asset",
    close: () => void,
    recording = false,
    busy = false;
  let dialog: HTMLDialogElement;
  onMount(() => {
    dialog.showModal();
    return () => dialog.close();
  });
</script>

<dialog
  class="app-dialog quick-sheet"
  bind:this={dialog}
  aria-label="快速记录"
  on:cancel|preventDefault={() => {
    if (!busy) close();
  }}
>
  <div class="sheet-handle"></div>
  <header>
    <div class="segmented" role="group" aria-label="记录类型">
      <button
        aria-pressed={mode === "bill"}
        disabled={recording || busy}
        on:click={() => (mode = "bill")}>记一笔</button
      >
      <button
        aria-pressed={mode === "asset"}
        disabled={busy}
        on:click={() => (mode = "asset")}>记资产</button
      >
    </div>
    <button
      class="icon-button"
      aria-label="关闭快速输入"
      disabled={busy}
      on:click={close}><Icon name="Close" /></button
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
      padding: 8px max(18px, env(safe-area-inset-right))
        calc(16px + env(safe-area-inset-bottom))
        max(18px, env(safe-area-inset-left));
      border-radius: 22px 22px 0 0;
    }
    .sheet-handle {
      height: 4px;
      width: 36px;
      background: var(--border-strong);
      border-radius: 9px;
      margin: 0 auto 12px;
    }
    @media (prefers-reduced-motion: no-preference) {
      .quick-sheet[open] {
        animation: sheet-in 0.2s ease-out;
      }
      @keyframes sheet-in {
        from {
          transform: translateY(48px);
          opacity: 0.5;
        }
      }
    }
  }
</style>
