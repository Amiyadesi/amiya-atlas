<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { VaultSnapshot } from "../../lib/types";
  import type { Proposal } from "../../domain/proposal";
  import {
    findCommands,
    quickPreview,
    vaultCommands,
    type Command,
  } from "./search";
  import Icon from "../../lib/Icon.svelte";
  export let snapshot: VaultSnapshot;
  export let commands: Command[];
  export let openEntity: (id: string) => void;
  export let explore: (id: string) => void;
  export let account: (id: string) => void;
  export let preview: (raw: string, proposal: Proposal) => Promise<void>;
  export let close: () => void;
  export let failed: (e: unknown) => void;
  let query = "",
    index = 0;
  let dialog: HTMLDialogElement, input: HTMLInputElement;
  $: catalog = [
    ...commands,
    ...vaultCommands(snapshot, openEntity, explore, account),
  ];
  $: quick = quickPreview(query, snapshot);
  $: hits = findCommands(catalog, query);
  $: options = quick.proposal
    ? [
        {
          label: "快速记一笔",
          group: "预览",
          detail: quick.detail,
          run: () => preview(query, quick.proposal!),
        } as Command,
        ...hits,
      ]
    : hits;
  $: active = options[Math.min(index, options.length - 1)];
  onMount(() => {
    dialog.showModal();
    input.focus();
    return () => dialog.close();
  });
  async function run(item?: Command, graph = false) {
    if (!item || item.disabled) return;
    close();
    try {
      if (graph && item.graph) item.graph();
      else await item.run();
    } catch (e) {
      failed(e);
    }
  }
  async function key(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void run(active, e.altKey);
    }
    if (options.length && ["ArrowUp", "ArrowDown"].includes(e.key)) {
      e.preventDefault();
      const available = options.filter((item) => !item.disabled);
      if (!available.length) return;
      const next =
        (available.indexOf(active) +
          (e.key === "ArrowDown" ? 1 : -1) +
          available.length) %
        available.length;
      index = options.indexOf(available[next]);
      await tick();
      document
        .getElementById("command-" + index)
        ?.scrollIntoView({ block: "nearest" });
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="app-dialog palette"
  aria-label="命令面板"
  on:cancel|preventDefault={close}
>
  <div class="query">
    <Icon name="Search" /><input
      bind:this={input}
      bind:value={query}
      role="combobox"
      aria-label="搜索命令、记忆或账户"
      aria-expanded="true"
      aria-autocomplete="list"
      aria-controls="command-list"
      aria-activedescendant={active
        ? "command-" + options.indexOf(active)
        : undefined}
      placeholder="搜索记忆、账户或操作…"
      on:input={() => (index = 0)}
      on:keydown={key}
    /><button class="escape" on:click={close} aria-label="关闭命令面板"
      >Esc</button
    >
  </div>
  <div class="results" role="listbox" id="command-list" aria-label="搜索结果">
    {#each options as item, i}
      {#if !query.trim() && (!i || options[i - 1].group !== item.group)}<div
          class="group"
          role="presentation"
        >
          {item.group}
        </div>{/if}
      <button
        type="button"
        role="option"
        tabindex="-1"
        id={"command-" + i}
        aria-selected={active === item}
        disabled={item.disabled}
        class:active={active === item}
        class:quick={item.group === "预览"}
        on:pointermove={() => (index = i)}
        on:click={() => run(item)}
      >
        <span class="symbol"
          ><Icon
            name={item.group === "记忆"
              ? "Memory"
              : item.group === "账户" || item.group === "预览"
                ? "Ledger"
                : item.group === "页面"
                  ? "Page"
                  : "Action"}
          /></span
        >
        <strong>{item.label}</strong><small>{item.detail ?? item.group}</small>
      </button>
    {:else}<p>没有找到“{query}”</p>{/each}
  </div>
  {#if quick.error}<p role="status">{quick.error}</p>{/if}
  <footer>
    <span><kbd>↑</kbd> <kbd>↓</kbd> 选择</span>{#if active?.graph}<button
        on:click={() => run(active, true)}>探索关联 <kbd>Alt ↵</kbd></button
      >{/if}<span
      ><kbd>↵</kbd> {active?.group === "预览" ? "预览流水" : "打开"}</span
    >
  </footer>
</dialog>

<style>
  .palette {
    padding: 0;
    width: min(580px, calc(100vw - 24px));
    margin: min(16dvh, 110px) auto auto;
    max-height: 80dvh;
  }
  .query,
  .results button,
  footer {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .query {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    color: var(--accent);
  }
  .query input {
    padding: 4px 0;
    border: 0;
    background: transparent;
    outline: 0;
    flex: 1;
    font-size: 16px;
  }
  .escape,
  kbd {
    background: var(--surface-raised);
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 11px;
    margin: 0;
  }
  .results {
    padding: 7px;
    max-height: min(48dvh, 380px);
    overflow-y: auto;
  }
  .results button {
    width: 100%;
    text-align: left;
    color: var(--text);
    background: none;
    padding: 8px 10px;
    border-radius: 7px;
  }
  .results button.active {
    background: var(--accent-soft);
  }
  .results button.quick {
    color: var(--accent);
  }
  .symbol {
    display: grid;
    place-items: center;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    height: 29px;
    width: 29px;
    flex: none;
    color: var(--muted);
  }
  strong {
    font-size: 14px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  small {
    margin-left: auto;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }
  .group {
    padding: 8px 11px 4px;
    color: var(--muted);
    font-size: 11px;
  }
  footer {
    justify-content: flex-end;
    border-top: 1px solid var(--border);
    padding: 9px 14px;
  }
  footer,
  footer button,
  p {
    font-size: 12px;
    color: var(--muted);
  }
  footer button {
    background: none;
  }
  footer span:first-child {
    margin-right: auto;
  }
  p {
    padding: 16px;
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
