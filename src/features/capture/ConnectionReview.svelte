<script lang="ts">
  import { onMount } from "svelte";
  import { fieldConnections } from "../../domain/relationships";
  import { saveSnapshot } from "../../lib/api";
  import { relationLabel } from "../../lib/record-labels";
  import type { VaultSnapshot } from "../../lib/types";
  export let snapshot: VaultSnapshot;
  export let saved: (value: VaultSnapshot) => void;
  export let close: () => void;
  const base = structuredClone(snapshot),
    proposal = fieldConnections(base);
  const names = new Map(
    [...base.entities, ...proposal.entities].map((e) => [e.id, e.name]),
  );
  let chosen = new Set(proposal.relations.map((r) => r.id)),
    busy = false,
    error = "",
    dialog: HTMLDialogElement;
  onMount(() => dialog.showModal());
  async function save() {
    busy = true;
    error = "";
    try {
      const relations = proposal.relations.filter((r) => chosen.has(r.id));
      const ids = new Set(relations.flatMap((r) => [r.sourceId, r.targetId]));
      const value = await saveSnapshot({
        ...base,
        entities: [
          ...base.entities,
          ...proposal.entities.filter((e) => ids.has(e.id)),
        ],
        relations: [...base.relations, ...relations],
      });
      saved(value);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="connection-review-title"
  on:cancel|preventDefault={() => {
    if (!busy) close();
  }}
>
  <header>
    <h2 id="connection-review-title">从已有字段补全关联</h2>
    <button
      class="text-button"
      aria-label="关闭"
      disabled={busy}
      on:click={close}>×</button
    >
  </header>
  <div class="connection-list">
    {#each proposal.relations as r}<label
        ><input
          type="checkbox"
          disabled={busy}
          checked={chosen.has(r.id)}
          on:change={(e) => {
            const next = new Set(chosen);
            e.currentTarget.checked ? next.add(r.id) : next.delete(r.id);
            chosen = next;
          }}
        /><span
          ><strong>{names.get(r.sourceId)}</strong><small
            >{relationLabel(r.type)}</small
          ><strong>{names.get(r.targetId)}</strong></span
        ></label
      >{:else}<p>没有可直接补全的字段</p>{/each}
  </div>
  {#if proposal.ambiguous.length}<p>
      有 {proposal.ambiguous.length} 条记录存在重名对象，请单独编辑。
    </p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <footer>
    <button class="secondary" disabled={busy} on:click={close}>取消</button
    ><button class="primary" disabled={busy || !chosen.size} on:click={save}
      >{busy ? "保存中…" : `保存 ${chosen.size} 条关联`}</button
    >
  </footer>
</dialog>

<style>
  dialog {
    width: min(760px, calc(100vw - 28px));
    max-height: 85dvh;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    border-radius: 12px;
    padding: 24px;
  }
  dialog::backdrop {
    background: #25202c66;
  }
  header,
  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  h2 {
    font-size: 20px;
    margin: 0;
  }
  .connection-list {
    overflow: auto;
    max-height: 60dvh;
    margin: 20px 0;
  }
  label {
    display: flex;
    gap: 14px;
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
    align-items: center;
    font-size: 14px;
  }
  label span {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
  }
  small {
    color: var(--muted);
  }
  input {
    accent-color: var(--accent);
  }
  footer {
    justify-content: flex-end;
  }
</style>
