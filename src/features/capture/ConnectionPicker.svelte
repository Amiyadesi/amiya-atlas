<script lang="ts">
  import type { Entity } from "../../lib/types";
  import { categoryLabel } from "../../lib/record-labels";
  export let entities: Entity[];
  export let categories: string[];
  export let createCategory: string;
  export let label: string;
  export let add: (value: {
    id?: string;
    name: string;
    category: string;
  }) => void;
  let query = "",
    open = false;
  let newCategory = createCategory;
  $: if (!categories.includes(newCategory)) newCategory = createCategory;
  $: createCategories = [createCategory, ...categories].filter(
    (category, index, all) =>
      all.findIndex(
        (value) => categoryLabel(value) === categoryLabel(category),
      ) === index,
  );
  $: matches = entities
    .filter(
      (e) =>
        categories.includes(e.category) &&
        e.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    )
    .slice(0, 6);
  function choose(value: { id?: string; name: string; category: string }) {
    add(value);
    query = "";
    open = false;
  }
</script>

<div class="connection-picker">
  <input
    aria-label={label}
    bind:value={query}
    placeholder="搜索或新建"
    maxlength="500"
    autocomplete="off"
    on:focus={() => (open = true)}
    on:input={() => (open = true)}
    on:keydown={(e) => {
      if (e.key === "Escape") open = false;
      if (e.key === "Enter") {
        e.preventDefault();
        if (matches.length === 1) choose(matches[0]);
      }
    }}
  />
  {#if open}<div class="choices">
      {#each matches as entity}<button
          type="button"
          on:click={() => choose(entity)}
          ><strong>{entity.name}</strong><small
            >{categoryLabel(entity.category)}</small
          ></button
        >{/each}
      {#if query.trim() && !entities.some((e) => categories.includes(e.category) && e.name.toLocaleLowerCase() === query
                .trim()
                .toLocaleLowerCase())}<div class="create-choice">
          <button
            type="button"
            on:click={() =>
              choose({ name: query.trim(), category: newCategory })}
            >＋ 新建“{query.trim()}” ></button
          >{#if createCategories.length > 1}<select
              bind:value={newCategory}
              aria-label={`${label}的新建类型`}
              >{#each createCategories as category}<option value={category}
                  >{categoryLabel(category)}</option
                >{/each}</select
            >{:else}<small>{categoryLabel(newCategory)}</small>{/if}
        </div>{/if}
      <button type="button" class="close-picker" on:click={() => (open = false)}
        >收起</button
      >
    </div>{/if}
</div>

<style>
  .connection-picker {
    position: relative;
    min-width: 0;
  }
  input {
    box-sizing: border-box;
    width: 100%;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    border-radius: 6px;
    padding: 9px 10px;
    font: inherit;
  }
  .choices {
    position: absolute;
    inset: 100% 0 auto;
    z-index: 4;
    max-height: 270px;
    overflow: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 8px 20px #0002;
  }
  button {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    text-align: left;
    width: 100%;
    padding: 10px;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
  }
  button:hover,
  button:focus-visible {
    background: var(--surface-alt);
  }
  small {
    color: var(--muted);
    white-space: nowrap;
  }
  .create-choice {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-right: 10px;
  }
  .create-choice button {
    flex: 1;
    min-width: 0;
  }
  select {
    max-width: 135px;
    padding: 6px;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    font: inherit;
  }
  .close-picker {
    color: var(--muted);
    font-size: 12px;
  }
</style>
