<script lang="ts">
  import {
    ENTITY_TYPES,
    STATUSES,
    attributeLabel,
  } from "../../domain/proposal";
  import type {
    Proposal,
    ProposalRecord,
    TextCapture,
  } from "../../domain/proposal";
  import type { Entity } from "../../lib/types";
  import { RELATION_TYPES } from "../../lib/types";
  import type { VaultSnapshot } from "../../lib/types";
  import { proposalDiff } from "../../domain/changes";
  import type { ProposalChange } from "../../domain/changes";
  import ProposalDiff from "./ProposalDiff.svelte";
  export let record: ProposalRecord;
  export let capture: TextCapture;
  export let entities: Entity[];
  export let snapshot: VaultSnapshot;
  export let busy = false;
  export let onConfirm: (content: Proposal) => Promise<void>;
  export let onLater: (content: Proposal) => Promise<void>;
  export let onRetry: () => Promise<void>;
  let draft: Proposal;
  let loadedId = "";
  let validationError = "";
  let invalidAttributes = new Set<string>();
  $: if (record.id !== loadedId) {
    draft = structuredClone(record.content);
    loadedId = record.id;
    validationError = "";
    invalidAttributes = new Set();
  }
  $: references = [
    ...entities
      .filter((e) => e.privacy !== "SECRET")
      .map((e) => ({ id: e.id, name: e.name })),
    ...draft.entitiesToCreate.map((e) => ({ id: e.ref, name: e.name })),
  ];
  $: changes = [...draft.entitiesToCreate, ...draft.entitiesToUpdate];
  $: changeCount = proposalDiff(draft, snapshot).length;
  $: hasChanges = changeCount > 0;
  $: destructive = !!(
    draft.entitiesToDelete?.length ||
    draft.relationsToDelete?.length ||
    draft.eventsToDelete?.length ||
    draft.entitiesToUpdate.some((e) => e.attributesToRemove?.length)
  );
  $: stale =
    (destructive && record.baseRevision !== snapshot.revision) ||
    draft.entitiesToUpdate.some(
      (e) =>
        entities.find((existing) => existing.id === e.id)?.updatedAt !==
        e.expectedUpdatedAt,
    ) ||
    (draft.entitiesToDelete ?? []).some(
      (e) =>
        entities.find((existing) => existing.id === e.id)?.updatedAt !==
        e.expectedUpdatedAt,
    );
  function cancelDiff(change: ProposalChange) {
    if (change.category === "记忆") {
      if (change.kind === "remove") {
        const edges = new Set(
          snapshot.relations
            .filter((r) => r.sourceId === change.id || r.targetId === change.id)
            .map((r) => r.id),
        );
        const events = new Set(
          snapshot.events
            .filter((e) => e.entityId === change.id)
            .map((e) => e.id),
        );
        draft = {
          ...draft,
          entitiesToDelete: draft.entitiesToDelete?.filter(
            (e) => e.id !== change.id,
          ),
          relationsToDelete: draft.relationsToDelete?.filter(
            (r) => !edges.has(r.id),
          ),
          eventsToDelete: draft.eventsToDelete?.filter(
            (e) => !events.has(e.id),
          ),
        };
      } else {
        const index = changes.findIndex(
          (e) => ("ref" in e ? e.ref : e.id) === change.id,
        );
        if (index >= 0) removeEntity(index);
      }
    } else if (change.category === "关联") {
      draft =
        change.kind === "remove"
          ? {
              ...draft,
              relationsToDelete: draft.relationsToDelete?.filter(
                (r) => r.id !== change.id,
              ),
            }
          : {
              ...draft,
              relationsToCreate: draft.relationsToCreate.filter(
                (r) => `${r.from}:${r.type}:${r.to}` !== change.id,
              ),
            };
    } else
      draft =
        change.kind === "remove"
          ? {
              ...draft,
              eventsToDelete: draft.eventsToDelete?.filter(
                (e) => e.id !== change.id,
              ),
            }
          : {
              ...draft,
              eventsToCreate: draft.eventsToCreate.filter(
                (e) => `${e.entityRef}:${e.type}:${e.dueAt}` !== change.id,
              ),
            };
  }
  function attribute(
    item: (typeof changes)[number],
    key: string,
    text: string,
  ) {
    const old = item.attributes[key];
    const token = `${"ref" in item ? item.ref : item.id}:${key}`;
    if (typeof old === "number") {
      const value = Number(text);
      if (!text.trim() || !Number.isFinite(value)) {
        invalidAttributes = new Set([...invalidAttributes, token]);
        validationError = "数字属性需要有效数字";
        return;
      }
      item.attributes[key] = value;
    } else if (typeof old === "boolean") item.attributes[key] = text === "true";
    else if (Array.isArray(old))
      item.attributes[key] = text
        .split(/[,，]/)
        .map((value) => value.trim())
        .filter(Boolean);
    else item.attributes[key] = text;
    invalidAttributes.delete(token);
    invalidAttributes = new Set(invalidAttributes);
    validationError = invalidAttributes.size ? "数字属性需要有效数字" : "";
    draft = draft;
  }
  async function confirm() {
    if (invalidAttributes.size) return;
    validationError = "";
    try {
      await onConfirm(draft);
    } catch (e) {
      validationError = e instanceof Error ? e.message : String(e);
    }
  }
  async function later() {
    if (invalidAttributes.size) return;
    validationError = "";
    try {
      await onLater(draft);
    } catch (e) {
      validationError = e instanceof Error ? e.message : String(e);
    }
  }
  function removeEntity(index: number) {
    const item = changes[index];
    const ref = "ref" in item ? item.ref : item.id;
    invalidAttributes = new Set(
      [...invalidAttributes].filter((key) => !key.startsWith(`${ref}:`)),
    );
    validationError = invalidAttributes.size ? "数字属性需要有效数字" : "";
    draft.entitiesToCreate = draft.entitiesToCreate.filter((e) => e !== item);
    draft.entitiesToUpdate = draft.entitiesToUpdate.filter((e) => e !== item);
    draft.relationsToCreate = draft.relationsToCreate.filter(
      (r) => r.from !== ref && r.to !== ref,
    );
    draft.eventsToCreate = draft.eventsToCreate.filter(
      (e) => e.entityRef !== ref,
    );
    draft = draft;
  }
</script>

<section class="proposal-panel" aria-label="记忆提案">
  <div class="section-heading">
    <div>
      <p class="eyebrow">REVIEW & REMEMBER</p>
      <h2>我理解的是……</h2>
    </div>
    <span class="pill amber">等待你的确认</span>
  </div>
  <p class="muted">
    核对变更，可取消单项或展开修改。确认前，已有记忆保持原样。
  </p>
  <blockquote class="original">{capture.rawText}</blockquote>
  {#if draft.uncertainty.length}<div class="uncertainties">
      <strong>还有不确定的地方</strong>{#each draft.uncertainty as item}<p>
          {item}
        </p>{/each}
    </div>{/if}
  {#if stale}<div class="error" role="alert">
      这份提案之后，记忆库已有变化。请重新理解，查看最新差异。<button
        class="secondary"
        disabled={busy}
        on:click={onRetry}>重新理解</button
      >
    </div>{/if}
  <ProposalDiff content={draft} {snapshot} {busy} onCancel={cancelDiff} />
  <details class="proposal-editor">
    <summary>修改提案</summary>
    {#each changes as entity, index}
      <article class="proposal-entity">
        <div class="proposal-entity-heading">
          <span class="pill">{"ref" in entity ? "新记忆" : "更新已有记忆"}</span
          ><button
            class="text-button danger"
            disabled={busy}
            on:click={() => removeEntity(index)}>移除</button
          >
        </div>
        <div class="form-row">
          <label
            >名称<input
              bind:value={entity.name}
              disabled={busy}
              on:input={() => (draft = draft)}
            /></label
          ><label
            >类型<select
              bind:value={entity.type}
              disabled={busy || "id" in entity}
              on:change={() => (draft = draft)}
              >{#each ENTITY_TYPES as type}<option>{type}</option
                >{/each}</select
            ></label
          >
        </div>
        <div class="attribute-list">
          {#each Object.entries(entity.attributes) as [key, value]}<label
              ><span>{attributeLabel(key)}</span
              >{#if typeof value === "boolean"}<select
                  value={String(value)}
                  disabled={busy}
                  on:change={(e) =>
                    attribute(entity, key, e.currentTarget.value)}
                  ><option value="true">是</option><option value="false"
                    >否</option
                  ></select
                >{:else}<input
                  aria-label={`${entity.name} ${key}`}
                  value={Array.isArray(value) ? value.join(", ") : value}
                  disabled={busy}
                  on:input={(e) =>
                    attribute(entity, key, e.currentTarget.value)}
                />{/if}<button
                class="text-button"
                title="取消此字段变更"
                disabled={busy}
                on:click={() => {
                  delete entity.attributes[key];
                  invalidAttributes.delete(
                    `${"ref" in entity ? entity.ref : entity.id}:${key}`,
                  );
                  invalidAttributes = new Set(invalidAttributes);
                  validationError = invalidAttributes.size
                    ? "数字属性需要有效数字"
                    : "";
                  draft = draft;
                }}>×</button
              ></label
            >{/each}
        </div>
        <details>
          <summary>备注、状态与原文依据</summary><label
            >备注<textarea
              bind:value={entity.notes}
              disabled={busy}
              on:input={() => (draft = draft)}
              rows="2"></textarea></label
          ><label
            >状态<select
              bind:value={entity.status}
              disabled={busy}
              on:change={() => (draft = draft)}
              >{#each STATUSES as status}<option>{status}</option
                >{/each}</select
            ></label
          >
          <p class="evidence">原文依据：{entity.evidence}</p>
        </details>
      </article>
    {/each}
    {#each draft.entitiesToUpdate.filter((e) => e.attributesToRemove?.length) as entity}
      <div class="proposal-entity">
        <h3>{entity.name} · 删除属性</h3>
        {#each entity.attributesToRemove ?? [] as key}<p>
            {attributeLabel(key)}
            <button
              class="text-button"
              disabled={busy}
              on:click={() => {
                entity.attributesToRemove = entity.attributesToRemove?.filter(
                  (k) => k !== key,
                );
                draft = draft;
              }}>取消删除</button
            >
          </p>{/each}
      </div>
    {/each}
    {#if draft.relationsToCreate.length}<h3>关联</h3>{/if}
    {#each draft.relationsToCreate as relation, index}
      <div class="proposal-entity">
        <div class="form-row">
          <label
            >从<select
              bind:value={relation.from}
              disabled={busy}
              on:change={() => (draft = draft)}
              >{#each references as reference}<option value={reference.id}
                  >{reference.name}</option
                >{/each}</select
            ></label
          ><label
            >关系<select
              bind:value={relation.type}
              disabled={busy}
              on:change={() => (draft = draft)}
              >{#each RELATION_TYPES as type}<option>{type}</option
                >{/each}</select
            ></label
          ><label
            >到<select
              bind:value={relation.to}
              disabled={busy}
              on:change={() => (draft = draft)}
              >{#each references as reference}<option value={reference.id}
                  >{reference.name}</option
                >{/each}</select
            ></label
          >
        </div>
        <label
          >关联备注<input
            bind:value={relation.note}
            disabled={busy}
            on:input={() => (draft = draft)}
          /></label
        ><button
          class="text-button danger"
          disabled={busy}
          on:click={() =>
            (draft = {
              ...draft,
              relationsToCreate: draft.relationsToCreate.filter(
                (_, i) => i !== index,
              ),
            })}>移除关联</button
        >
        <p class="evidence">原文依据：{relation.evidence}</p>
      </div>
    {/each}
    {#if draft.eventsToCreate.length}<h3>生命周期</h3>{/if}
    {#each draft.eventsToCreate as event, index}
      <div class="proposal-entity">
        <div class="form-row">
          <label
            >记忆<select
              bind:value={event.entityRef}
              disabled={busy}
              on:change={() => (draft = draft)}
              >{#each references as reference}<option value={reference.id}
                  >{reference.name}</option
                >{/each}</select
            ></label
          ><label
            >事件<select
              bind:value={event.type}
              disabled={busy}
              on:change={() => (draft = draft)}
              >{#each ["EXPIRY", "RENEWAL", "REVIEW", "CANCELLATION", "REMINDER"] as type}<option
                  >{type}</option
                >{/each}</select
            ></label
          >
        </div>
        <div class="form-row">
          <label
            >日期精度<select
              bind:value={event.precision}
              disabled={busy}
              on:change={() => {
                if (event.precision === "unknown") event.dueAt = "";
                draft = draft;
              }}
              ><option value="day">具体日期</option><option value="month"
                >月份</option
              ><option value="year">年份</option><option value="unknown"
                >还不确定</option
              ></select
            ></label
          ><label
            >日期<input
              bind:value={event.dueAt}
              disabled={busy || event.precision === "unknown"}
              placeholder={event.precision === "month"
                ? "2026-12"
                : event.precision === "year"
                  ? "2026"
                  : "2026-12-15"}
              on:input={() => (draft = draft)}
            /></label
          ><label
            >续费策略<select
              bind:value={event.policy}
              disabled={busy}
              on:change={() => (draft = draft)}
              ><option value="DO_NOT_RENEW">不续费</option><option
                value="AUTO_RENEW">自动续费</option
              ><option value="MANUAL">手动续费</option><option value="REVIEW"
                >再决定</option
              ></select
            ></label
          >
        </div>
        <label
          >备注<input
            bind:value={event.note}
            disabled={busy}
            on:input={() => (draft = draft)}
          /></label
        ><button
          class="text-button danger"
          disabled={busy}
          on:click={() =>
            (draft = {
              ...draft,
              eventsToCreate: draft.eventsToCreate.filter(
                (_, i) => i !== index,
              ),
            })}>移除事件</button
        >
        <p class="evidence">原文依据：{event.evidence}</p>
      </div>
    {/each}
  </details>
  {#if validationError}<div class="error" role="alert">
      {validationError}
    </div>{/if}
  <div class="proposal-footer">
    <span class="muted"
      >{changeCount} 项变更{destructive
        ? " · 包含删除，请逐项核对"
        : " · 确认后才写入"}</span
    >
    <div class="button-row">
      <button
        class="secondary"
        disabled={busy || !!invalidAttributes.size || stale || !hasChanges}
        on:click={later}>稍后确认</button
      ><button
        class="primary"
        disabled={busy || !!invalidAttributes.size || stale || !hasChanges}
        on:click={confirm}>{busy ? "正在保存…" : "确认保存"}</button
      >
    </div>
  </div>
</section>
