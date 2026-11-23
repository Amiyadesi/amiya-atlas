<script lang="ts">
  import { confirmDialog } from "../../lib/dialog";
  import { ASSETS, money, type Money } from "../../domain/money";
  import { onMount, onDestroy } from "svelte";
  import { saveSnapshot } from "../../lib/api";
  import { newId, nowIso, RELATION_TYPES, TEMPLATES } from "../../lib/types";
  import type {
    Entity,
    Field,
    LifecycleEvent,
    Relation,
    VaultSnapshot,
    ValueType,
  } from "../../lib/types";
  import { attributeLabel } from "../../domain/proposal";
  import {
    categoryLabel,
    eventLabel,
    RECORD_TYPES,
    relationLabel,
    statusLabel,
    TAG_SUGGESTIONS,
  } from "../../lib/record-labels";
  import {
    TAG_ICONS,
    tagName,
    tagIcon,
    isFavorite,
    withTagIcon,
  } from "../../lib/record-tags";
  import {
    connectionSlots,
    connectionGaps,
    connectionHints,
    slotRelations,
    type ConnectionSlot,
  } from "../../domain/relationships";
  import ConnectionPicker from "./ConnectionPicker.svelte";
  export let snapshot: VaultSnapshot;
  export let initial:Entity|undefined=undefined;
  export let entity: Entity | undefined = undefined;
  export let saved: (value: VaultSnapshot, id: string) => void;
  export let close: () => void;
  const base = structuredClone(snapshot);
  let disposed = false;
  const timestamp = nowIso();
  let draft: Entity = entity
    ? structuredClone(entity)
    : initial ? structuredClone(initial) : {
        id: newId("entity"),
        name: "",
        category: "Account",
        status: "ACTIVE",
        privacy: "PRIVATE",
        tags: [],
        fields: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
  let fields = draft.fields
    .filter((field) => field.privacy !== "SECRET")
    .map((field) => ({
      ...field,
      asset: field.valueType === "money" ? (field.value as Money).asset : "CNY",
      text:
        field.valueType === "money"
          ? (field.value as Money).amount
          : field.valueType === "json"
            ? JSON.stringify(field.value)
            : String(field.value ?? ""),
    }));
  let tags = draft.tags.join("，");
  let customCategory = !RECORD_TYPES.includes(draft.category);
  let categoryChoice = customCategory ? "CUSTOM" : draft.category;
  let relations = structuredClone(
    snapshot.relations.filter(
      (item) =>
        item.privacy !== "SECRET" &&
        (item.sourceId === draft.id || item.targetId === draft.id),
    ),
  );
  let events = structuredClone(
    snapshot.events.filter((item) => item.entityId === draft.id),
  );
  let busy = false,
    error = "";
  let created: Entity[] = [],
    connectionError = "";
  export let showRelations = false;
  let relationsSection: HTMLDetailsElement;
  let dialog: HTMLDialogElement;
  $: others = [...snapshot.entities, ...created].filter(
    (item) => item.id !== draft.id && item.privacy !== "SECRET",
  );
  $: tagValues = tags
    .split(/[,，\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
  $: slots = connectionSlots(draft.category);
  $: gaps = connectionGaps(draft, {
    relations: [
      ...base.relations.filter((r) => r.privacy === "SECRET"),
      ...relations,
    ],
  });
  $: hintEntity = {
    ...draft,
    fields: fields.map((f) => ({ ...f, value: f.text })),
  };
  onMount(() => {
    dialog.showModal();
    if (showRelations) relationsSection.querySelector("button")?.focus();
  });
  onDestroy(() => {
    disposed = true;
  });
  async function presets() {
    if (fields.length && !await confirmDialog({title: "替换当前字段？", description: "现有字段将替换为所选类型的预设字段。", danger: true, confirmLabel: "替换字段"})) return;
    const template =
      TEMPLATES.find((item) => item.category === draft.category) ??
      TEMPLATES.find(
        (item) =>
          item.category ===
          (draft.category === "Account"
            ? "Website Account"
            : draft.category === "Phone / SIM"
              ? "SIM"
              : draft.category),
      );
    draft.templateId = template?.id;
    fields = (template?.fields ?? []).map((field) => ({
      ...field,
      id: newId("field"),
      entityId: draft.id,
      value: "",
      asset: "CNY",
      text: "",
    }));
  }
  function addField() {
    fields = [
      ...fields,
      {
        id: newId("field"),
        entityId: draft.id,
        key: "",
        valueType: "text",
        value: "",
        asset: "CNY",
        text: "",
        privacy: "PRIVATE",
        searchable: true,
      },
    ];
  }
  function toggleTag(tag: string) {
    const values = tags
      .split(/[,，\n]/)
      .map((value) => value.trim())
      .filter(Boolean);
    tags = (
      values.some((value) => tagName(value) === tag)
        ? values.filter((value) => tagName(value) !== tag)
        : [...values, tag === "收藏" ? "⭐ 收藏" : tag]
    ).join("，");
  }
  function connect(
    slot: ConnectionSlot,
    value: { id?: string; name: string; category: string },
  ) {
    const matches = others.filter(
      (e) =>
        e.name.toLocaleLowerCase() === value.name.toLocaleLowerCase() &&
        slot.categories.includes(e.category),
    );
    if (!value.id && matches.length > 1) {
      connectionError = `“${value.name}”有重名记录，请搜索并选择`;
      return;
    }
    let target = value.id ? others.find((e) => e.id === value.id) : matches[0];
    if (value.id && !target) throw new Error("关联对象已不存在，请重新选择");
    if (!target) {
      target = {
        id: newId("entity"),
        name: value.name,
        category: value.category,
        status: connectionSlots(value.category).some((s) => s.required)
          ? "NEEDS_REVIEW"
          : "ACTIVE",
        privacy: "PRIVATE",
        tags: [],
        fields: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      created = [...created, target];
    }
    const type =
      slot.key === "login"
        ? target.category === "Email" ||
          target.category === "Phone / SIM" ||
          target.category === "SIM"
          ? "REGISTERED_WITH"
          : "AUTHENTICATES_WITH"
        : slot.type;
    if (
      !relations.some(
        (r) =>
          r.sourceId === draft.id &&
          r.targetId === target.id &&
          r.type === type,
      )
    )
      relations = [
        ...relations,
        {
          id: newId("relation"),
          sourceId: draft.id,
          targetId: target.id,
          type,
          privacy: "PRIVATE",
          createdAt: nowIso(),
        },
      ];
    connectionError = "";
  }
  function convert(field: (typeof fields)[number]): Field {
    let value: unknown = field.text;
    if (field.valueType === "number") {
      value = Number(field.text);
      if (!field.text.trim() || !Number.isFinite(value))
        throw new Error(`${field.key}：请输入数字`);
    }
    if (field.valueType === "boolean") {
      if (!["true", "false"].includes(field.text))
        throw new Error(`${field.key}：请选择是或否`);
      value = field.text === "true";
    }
    if (field.valueType === "json") {
      try {
        value = JSON.parse(field.text);
      } catch {
        throw new Error(`${field.key}：JSON 格式不正确`);
      }
    }
    if (field.valueType === "money") value = money(field.text, field.asset);
    const { text: _, asset: _asset, ...original } = field;
    return { ...original, key: field.key.trim(), value };
  }
  async function save(asReview = false) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      const next = structuredClone(base);
      const updated: Entity = {
        ...draft,
        name: draft.name.trim(),
        tags: [
          ...new Set(
            tags
              .split(/[,，\n]/)
              .map((value) => value.trim())
              .filter(Boolean),
          ),
        ],
        fields: [
          ...fields.filter((f) => f.text.trim()).map(convert),
          ...draft.fields.filter((field) => field.privacy === "SECRET"),
        ],
        updatedAt: nowIso(),
      };
      if (!updated.name) throw new Error("请输入名称");
      if (asReview) updated.status = "NEEDS_REVIEW";
      if (gaps.length && updated.status !== "NEEDS_REVIEW") {
        connectionError = `请选择${gaps.map((slot) => slot.label).join("、")}`;
        dialog
          .querySelector("#asset-connections")
          ?.scrollIntoView({ block: "center" });
        return;
      }
      if (
        new Set(updated.fields.map((field) => field.key)).size !==
        updated.fields.length
      )
        throw new Error("字段名称不能重复");
      const index = next.entities.findIndex((item) => item.id === draft.id);
      if (index < 0) next.entities.push(updated);
      else next.entities[index] = updated;
      next.entities.push(
        ...created.filter((e) =>
          relations.some((r) => r.sourceId === e.id || r.targetId === e.id),
        ),
      );
      next.relations = [
        ...next.relations.filter(
          (item) =>
            item.privacy === "SECRET" ||
            (item.sourceId !== draft.id && item.targetId !== draft.id),
        ),
        ...relations,
      ];
      next.events = [
        ...next.events.filter((item) => item.entityId !== draft.id),
        ...events.map((item) => ({ ...item, dueAt: item.dueAt || undefined })),
      ];
      const result = await saveSnapshot(next);
      if (!disposed) saved(result, draft.id);
    } catch (value) {
      error = value instanceof Error ? value.message : String(value);
    } finally {
      busy = false;
    }
  }
  async function remove() {
    if (!entity || busy) return;
    const referenced = snapshot.relations.some(
      (item) => item.sourceId === draft.id || item.targetId === draft.id,
    );
    if (
      !await confirmDialog({title: `删除“${draft.name}”？`, description: referenced ? "这条记录的全部关联也将解除，其他记录保留。" : undefined, danger: true, confirmLabel: "删除记录"})
    )
      return;
    busy = true;
    error = "";
    try {
      const next = structuredClone(base);
      next.entities = next.entities.filter((item) => item.id !== draft.id);
      next.relations = next.relations.filter(
        (item) => item.sourceId !== draft.id && item.targetId !== draft.id,
      );
      next.events = next.events.filter((item) => item.entityId !== draft.id);
      const result = await saveSnapshot(next, referenced ? [draft.id] : []);
      if (!disposed) saved(result, "");
    } catch (value) {
      error = value instanceof Error ? value.message : String(value);
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="manual-editor"
  aria-labelledby="manual-title"
  on:cancel|preventDefault={() => {
    if (!busy) close();
  }}
>
  <form on:submit|preventDefault={() => save()}>
    <header>
      <h2 id="manual-title">{entity ? "编辑记录" : "新建记录"}</h2>
      <button
        type="button"
        class="text-button"
        aria-label="关闭"
        disabled={busy}
        on:click={close}>×</button
      >
    </header>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="editor-grid">
      <label
        >名称<input bind:value={draft.name} required maxlength="500" /></label
      >
      <label
        >类型<select
          bind:value={categoryChoice}
          on:change={() => {
            customCategory = categoryChoice === "CUSTOM";
            draft.category = customCategory ? "" : categoryChoice;
          }}
        >
          {#each RECORD_TYPES as type}<option value={type}
              >{categoryLabel(type)}</option
            >{/each}
          <option value="CUSTOM">自定义</option>
        </select></label
      >
      {#if customCategory}<label
          >自定义类型<input
            bind:value={draft.category}
            required
            maxlength="100"
          /></label
        >{/if}
      <label
        >状态<select bind:value={draft.status}
          >{#each ["ACTIVE", "NEEDS_REVIEW", "PLANNED", "ARCHIVED", "INACTIVE"] as state}<option
              value={state}>{statusLabel(state)}</option
            >{/each}</select
        ></label
      >
      <label
        >可见性<select bind:value={draft.privacy}
          ><option value="PRIVATE">私有</option><option value="PUBLIC"
            >公开</option
          ></select
        ></label
      >
    </div>
    <label
      >标签<input
        bind:value={tags}
        placeholder="用逗号分隔，也可自定义"
        maxlength="1000"
      /></label
    >
    <div class="tag-options">
      {#each TAG_SUGGESTIONS as tag}<button
          type="button"
          class="example-chip"
          class:chosen={tagValues.some((value) => tagName(value) === tag)}
          on:click={() => toggleTag(tag)}>{tag}</button
        >{/each}
    </div>
    {#if tagValues.length}<div class="tag-options">
        {#each tagValues as tag, i}<label class="tag-icon-choice"
            >{tagName(tag)}<select
              aria-label={`${tagName(tag)}图案`}
              value={tagIcon(tag)}
              on:change={(e) =>
                (tags = tagValues
                  .map((t, index) =>
                    index === i ? withTagIcon(t, e.currentTarget.value) : t,
                  )
                  .join("，"))}
              >{#if !TAG_ICONS.includes(tagIcon(tag))}<option
                  value={tagIcon(tag)}>{tagIcon(tag)}</option
                >{/if}{#each TAG_ICONS.filter((icon) => icon || !isFavorite(tag)) as icon}<option
                  value={icon}>{icon || "无图案"}</option
                >{/each}</select
            ></label
          >{/each}
      </div>{/if}
    {#if slots.length}<section
        id="asset-connections"
        class="connection-fields"
        aria-label="资产关联"
      >
        {#each slots as slot (slot.key)}<div class="connection-field">
            <span>{slot.label}</span>
            <div>
              {#each slotRelations(slot, draft.id, relations) as relation (relation.id)}{@const other =
                  others.find(
                    (e) =>
                      e.id ===
                      (relation.sourceId === draft.id
                        ? relation.targetId
                        : relation.sourceId),
                  )}
                {#if other}<span class="connection-chip"
                    >{other.name}<button
                      type="button"
                      class="text-button"
                      aria-label={`解除${other.name}关联`}
                      on:click={() =>
                        (relations = relations.filter(
                          (r) => r.id !== relation.id,
                        ))}>×</button
                    ></span
                  >{/if}
              {/each}
              <ConnectionPicker
                entities={others}
                categories={slot.categories}
                createCategory={slot.createCategory}
                label={slot.label}
                add={(value) => connect(slot, value)}
              />
              {#if !slotRelations(slot, draft.id, relations).length}{#each connectionHints(hintEntity, slot) as hint}<button
                    type="button"
                    class="text-button field-hint"
                    on:click={() => connect(slot, hint)}
                    >关联“{hint.name}”</button
                  >{/each}{/if}
            </div>
          </div>{/each}
        {#if connectionError}<p class="error" role="alert">
            {connectionError}
          </p>{/if}
      </section>{/if}
    <div class="section-heading">
      <h3>字段</h3>
      <div class="button-row">
        <button type="button" class="text-button" on:click={presets}
          >使用类型模板</button
        ><button type="button" class="secondary" on:click={addField}
          >＋ 字段</button
        >
      </div>
    </div>
    {#each fields as field, i (field.id)}<div class="editor-row field-row">
        <label
          >字段<input
            bind:value={field.key}
            placeholder="如尾号、余额、备注"
            required
            maxlength="100"
            aria-label={attributeLabel(field.key) || "字段名称"}
          /></label
        >
        <label
          >值{#if field.valueType === "money"}<span class="money-input"
              ><input
                bind:value={field.text}
                inputmode="decimal"
                placeholder="0.00"
                aria-label="金额"
              /><select bind:value={field.asset} aria-label="币种"
                >{#each ASSETS as asset}<option value={asset.code}
                    >{asset.code}</option
                  >{/each}</select
              ></span
            >{:else if field.key === "billing_period"}<select
              bind:value={field.text}
              ><option value="">选择周期</option><option value="monthly"
                >月付</option
              ><option value="quarterly">季付</option><option value="yearly"
                >年付</option
              ><option value="usage">按量</option></select
            >{:else if field.key === "avoidable_project" || field.key === "project"}<select
              bind:value={field.text}
              ><option value="">无</option
              >{#each snapshot.entities.filter((e) => e.category === "Project" && e.privacy !== "SECRET") as p}<option
                  value={p.id}>{p.name}</option
                >{/each}</select
            >{:else if field.valueType === "boolean"}<select
              bind:value={field.text}
              required
              ><option value="">请选择</option><option value="true">是</option
              ><option value="false">否</option></select
            >{:else}<input
              bind:value={field.text}
              type={field.valueType === "url" ? "url" : "text"}
              placeholder={field.valueType === "date" ? "YYYY-MM-DD" : ""}
              inputmode={field.valueType === "number" ? "decimal" : undefined}
              required
              maxlength="100000"
            />{/if}</label
        >
        <label
          >格式<select bind:value={field.valueType}
            >{#each [["money", "金额"], ["text", "文字"], ["number", "数字"], ["date", "日期"], ["url", "网址"], ["boolean", "是否"], ["json", "JSON"]] as [value, label]}<option
                {value}>{label}</option
              >{/each}</select
          ></label
        >
        <label
          >隐私<select bind:value={field.privacy}
            ><option value="PRIVATE">私有</option><option value="PUBLIC"
              >公开</option
            ></select
          ></label
        >
        <button
          type="button"
          class="text-button remove-row"
          aria-label="删除字段"
          on:click={() => (fields = fields.filter((_, index) => i !== index))}
          >×</button
        >
      </div>{/each}
    <details open={showRelations} bind:this={relationsSection}>
      <summary>更多关联</summary>
      <div class="section-heading">
        <h3>关联</h3>
        <button
          type="button"
          class="secondary"
          disabled={!others.length}
          on:click={() =>
            (relations = [
              ...relations,
              {
                id: newId("relation"),
                sourceId: draft.id,
                targetId: others[0].id,
                type: "RELATED_TO",
                privacy: "PRIVATE",
                createdAt: nowIso(),
              },
            ])}>＋ 关联</button
        >
      </div>
      {#each relations as relation (relation.id)}<div
          class="editor-row relation-edit-row"
        >
          <label
            >方向<select
              value={relation.sourceId === draft.id ? "out" : "in"}
              on:change={(event) => {
                const other =
                  relation.sourceId === draft.id
                    ? relation.targetId
                    : relation.sourceId;
                relation.sourceId =
                  event.currentTarget.value === "out" ? draft.id : other;
                relation.targetId =
                  event.currentTarget.value === "out" ? other : draft.id;
              }}
              ><option value="out">这条记录 → 对方</option><option value="in"
                >对方 → 这条记录</option
              ></select
            ></label
          >
          <label
            >关系<select bind:value={relation.type}
              >{#each RELATION_TYPES as type}<option value={type}
                  >{relationLabel(type)}</option
                >{/each}</select
            ></label
          >
          <label
            >对方<select
              value={relation.sourceId === draft.id
                ? relation.targetId
                : relation.sourceId}
              on:change={(event) => {
                if (relation.sourceId === draft.id)
                  relation.targetId = event.currentTarget.value;
                else relation.sourceId = event.currentTarget.value;
              }}
              >{#each others as other}<option value={other.id}
                  >{other.name}</option
                >{/each}</select
            ></label
          >
          <button
            type="button"
            class="text-button remove-row"
            aria-label="删除关联"
            on:click={() =>
              (relations = relations.filter((item) => item.id !== relation.id))}
            >×</button
          >
        </div>{/each}
    </details>
    <div class="section-heading">
      <h3>提醒</h3>
      <button
        type="button"
        class="secondary"
        on:click={() =>
          (events = [
            ...events,
            {
              id: newId("event"),
              entityId: draft.id,
              type: "REMINDER",
              dueAt: "",
              status: "UPCOMING",
              policy: "MANUAL",
            },
          ])}>＋ 提醒</button
      >
    </div>
    {#each events as event (event.id)}<div class="editor-row event-edit-row">
        <label
          >事项<select bind:value={event.type}
            >{#each ["EXPIRY", "RENEWAL", "REVIEW", "PAYMENT_DUE", "CANCELLATION", "REMINDER", "CUSTOM"] as type}<option
                value={type}>{eventLabel(type)}</option
              >{/each}</select
          ></label
        >
        <label
          >日期<input
            type="text"
            bind:value={event.dueAt}
            placeholder="YYYY-MM-DD"
            required
            on:input={() =>
              (event.duePrecision =
                event.dueAt?.length === 4
                  ? "year"
                  : event.dueAt?.length === 7
                    ? "month"
                    : "day")}
          /></label
        >
        <label
          >处理<select bind:value={event.policy}
            ><option value="MANUAL">手动</option><option value="AUTO_RENEW"
              >自动续费</option
            ><option value="DO_NOT_RENEW">不续费</option><option value="REVIEW"
              >待检查</option
            ></select
          ></label
        >
        <label
          >状态<select bind:value={event.status}
            ><option value="UPCOMING">待处理</option><option value="DONE"
              >已完成</option
            ><option value="DISMISSED">已忽略</option><option value="UNKNOWN"
              >待确认</option
            ></select
          ></label
        >
        <button
          type="button"
          class="text-button remove-row"
          aria-label="删除提醒"
          on:click={() =>
            (events = events.filter((item) => item.id !== event.id))}>×</button
        >
      </div>{/each}
    <footer>
      {#if entity}<button
          type="button"
          class="text-button danger"
          disabled={busy}
          on:click={remove}>删除记录</button
        >{/if}
      <div class="button-row">
        <button type="button" class="secondary" disabled={busy} on:click={close}
          >取消</button
        >{#if gaps.length && draft.status !== "NEEDS_REVIEW"}<button
            type="button"
            class="secondary"
            disabled={busy}
            on:click={() => save(true)}>存为待整理</button
          >{/if}<button type="submit" class="primary" disabled={busy}
          >{busy ? "保存中…" : "保存"}</button
        >
      </div>
    </footer>
  </form>
</dialog>

<style>
  .manual-editor {
    width: min(900px, calc(100vw - 24px));
    max-height: calc(100dvh - 40px);
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    color: var(--text);
    padding: 24px;
  }
  .manual-editor::backdrop {
    background: #25202c66;
  }
  form {
    display: grid;
    gap: 16px;
  }
  header,
  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  footer {
    border-top: 1px solid var(--border);
    padding-top: 18px;
  }
  footer .button-row {
    margin-left: auto;
  }
  h2,
  h3 {
    margin: 0;
  }
  label {
    display: grid;
    gap: 6px;
    color: var(--muted);
    font-size: 12px;
  }
  input,
  select {
    min-width: 0;
    width: 100%;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 9px 10px;
    font: inherit;
  }
  .editor-grid {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr 1fr;
    gap: 12px;
  }
  .editor-row {
    display: grid;
    gap: 10px;
    align-items: end;
  }
  .field-row {
    grid-template-columns: 1fr 2fr 90px 70px 24px;
  }
  .relation-edit-row {
    grid-template-columns: 1fr 1fr 2fr 24px;
  }
  .event-edit-row {
    grid-template-columns: 1fr 1fr 1fr 1fr 24px;
  }
  .tag-options {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
  }
  .tag-icon-choice {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .tag-icon-choice select {
    width: auto;
  }
  .connection-fields {
    display: grid;
    gap: 14px;
    padding: 16px 0;
    border-block: 1px solid var(--border);
  }
  .connection-field {
    display: grid;
    grid-template-columns: 140px minmax(0, 1fr);
    align-items: start;
    gap: 12px;
    font-size: 13px;
  }
  .connection-field > span {
    padding-top: 10px;
    color: var(--muted);
  }
  .connection-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--surface-raised);
    padding: 2px 8px;
    margin: 0 6px 6px 0;
    border-radius: 5px;
  }
  .field-hint {
    font-size: 12px;
  }
  .chosen {
    border-color: var(--accent);
    color: var(--accent);
  }
  .remove-row {
    padding: 8px 0;
    font-size: 22px;
  }
  .danger {
    color: var(--expense);
  }
  @media (max-width: 650px) {
    .editor-grid,
    .editor-row {
      grid-template-columns: 1fr 1fr;
    }
    .manual-editor {
      padding: 18px;
    }
    .remove-row {
      justify-self: end;
    }
  }
</style>
