<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { VaultSnapshot } from "../../lib/types";
  import type {
    ImportTab,
    AssetPreview,
    BillPreview,
    ColumnMapping,
    BillColumn,
  } from "../../domain/importers/types";
  import { decodeImportedFile } from "../../domain/importers/csv";
  import { parseBitwarden } from "../../domain/importers/bitwarden";
  import { parsePasswords } from "../../domain/importers/passwords";
  import {
    parseBills,
    reviseBillRow,
    type BillOptions,
  } from "../../domain/importers/bills";
  import {
    applyAssetImport,
    applyBillImport,
    assetAdditions,
  } from "../../domain/importers/apply";
  import { formatMoney, ASSETS } from "../../domain/money";
  import { categoryLabel } from "../../lib/record-labels";
  import Icon from "../../lib/Icon.svelte";
  import {
    animateDialogClose,
    backdropDismiss,
    slidingIndicator,
  } from "../../lib/motion";
  export let snapshot: VaultSnapshot;
  export let tab: ImportTab;
  export let close: () => void;
  export let save: (next: VaultSnapshot, message: string) => Promise<void>;
  let dialog: HTMLDialogElement,
    picker: HTMLInputElement,
    preview: AssetPreview | BillPreview | undefined;
  let selected = new Set<string>(),
    subscriptions = new Set<string>(),
    filename = "",
    billText = "",
    error = "",
    autoSwitchNote = "",
    busy = false,
    reading = false,
    drag = false;
  let options: BillOptions = {};
  let editing = "",
    editKind: "SPEND" | "INCOME" | "TRANSFER" = "SPEND",
    editAccount = "",
    editCategory = "";
  function editRow(id: string) {
    if (preview?.kind !== "bills") return;
    const r = preview.rows.find((r) => r.id === id)!;
    editing = id;
    editKind = r.transaction.kind as typeof editKind;
    editAccount = r.account;
    editCategory = r.needsDestination ? "" : r.category;
  }
  function finishRow() {
    if (preview?.kind !== "bills") return;
    try {
      preview = reviseBillRow(
        snapshot,
        preview,
        editing,
        editKind,
        editAccount,
        editCategory,
      );
      subscriptions = new Set(
        [...subscriptions].filter(
          (id) =>
            preview?.kind === "bills" &&
            preview.subscriptions.some((c) => c.entity.id === id),
        ),
      );
      toggle([editing], true);
      error = editing = "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  let search = "",
    filter = "",
    favorites = false,
    hideDuplicates = false,
    page = 0,
    request = 0;
  const columns: Record<BillColumn, string> = {
    date: "日期",
    amount: "金额",
    direction: "收支方向",
    payee: "交易对方",
    note: "备注",
    category: "分类",
    account: "账户",
    asset: "币种",
  };
  const source = { wechat: "微信支付", alipay: "支付宝", generic: "通用 CSV" };
  onMount(() => {
    dialog.showModal();
  });
  onDestroy(() => {
    request++;
    billText = "";
  });
  function reset(next: ImportTab) {
    request++;
    tab = next;
    preview = undefined;
    editing = "";
    filename = billText = error = autoSwitchNote = "";
    reading = drag = false;
    selected = new Set();
    subscriptions = new Set();
    search = filter = "";
    favorites = hideDuplicates = false;
    page = 0;
  }
  function requestClose() {
    if (busy) return;
    animateDialogClose(dialog, close, 180);
  }
  function detectTab(name: string, text: string, fallback: ImportTab): ImportTab {
    const trimmed = text.replace(/^\uFEFF/, "").trimStart();
    if (trimmed.startsWith("{") || /\.json$/i.test(name)) return "assets";
    const lines = trimmed.split(/\r?\n/, 25).map((line) => line.trim());
    const firstHeader = (lines[0] ?? "")
      .toLowerCase()
      .split(",")
      .map((cell) => cell.replace(/^"|"$/g, "").trim());
    const hasPasswordHeader =
      firstHeader.some((h) =>
        [
          "login_uri",
          "login_username",
          "login_password",
          "password",
          "username",
          "url",
          "website",
        ].includes(h),
      ) &&
      firstHeader.some((h) =>
        ["login_password", "password", "login_username", "username"].includes(h),
      );
    if (hasPasswordHeader) return "assets";
    if (
      lines[0]?.startsWith("微信支付账单明细") ||
      lines.some((l) => /^-{4,}.*支付宝|^支付宝(?:账户)?(?:交易)?明细/.test(l))
    ) {
      return "bills";
    }
    const hasBillHeader = lines.some((l) => {
      const cols = l.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
      return (
        cols.includes("交易时间") &&
        (cols.includes("交易对方") || cols.includes("收/支"))
      );
    });
    if (hasBillHeader) return "bills";
    return fallback;
  }
  function install(p: AssetPreview | BillPreview) {
    preview = p;
    selected = new Set(
      p.kind === "assets"
        ? p.rows.filter((r) => !r.duplicate).map((r) => r.id)
        : p.rows.filter((r) => !r.duplicate && !r.excluded).map((r) => r.id),
    );
    subscriptions = new Set();
    page = 0;
  }
  async function read(file?: File) {
    if (!file || busy) return;
    reset(tab);
    options = {};
    const token = request;
    reading = true;
    filename = file.name;
    try {
      const text = decodeImportedFile(await file.arrayBuffer());
      if (token !== request) return;
      const detected = detectTab(file.name, text, tab);
      if (detected !== tab) {
        tab = detected;
        autoSwitchNote =
          detected === "bills"
            ? "已自动识别为账单文件并切换至「账单与流水」"
            : "已自动识别为账号导出文件并切换至「账号与密码管理器」";
      }
      if (tab === "assets")
        install(
          text.trimStart().startsWith("{") || /\.json$/i.test(file.name)
            ? parseBitwarden(text, snapshot)
            : parsePasswords(text, snapshot),
        );
      else {
        const p = parseBills(text, snapshot);
        install(p);
        if (p.format === "generic") billText = text;
      }
    } catch (e) {
      if (token === request)
        error = e instanceof Error ? e.message : "文件无法解析";
    } finally {
      if (token === request) reading = false;
    }
  }
  function remap(mapping: ColumnMapping) {
    try {
      editing = "";
      install(parseBills(billText, snapshot, mapping, options));
      error = "";
    } catch (e) {
      error = String(e);
      preview = undefined;
    }
  }
  $: items =
    preview?.kind === "assets"
      ? preview.rows.map((r) => ({
          id: r.id,
          title: r.entity.name,
          detail: [
            r.login,
            r.folder,
            String(
              r.entity.fields.find((f) => f.key === "origin")?.value ?? "",
            ),
          ]
            .filter(Boolean)
            .join(" · "),
          value: r.hub
            ? r.hub.name
            : r.entity.category === "Payment Card"
              ? [
                  "银行卡",
                  r.entity.fields.find((f) => f.key === "brand")?.value,
                  r.entity.fields.find((f) => f.key === "last4")?.value,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : categoryLabel(r.entity.category),
          status: r.existing
            ? r.enrichment
              ? "补全登录字段"
              : r.relation
                ? "补关联"
                : "已存在"
            : r.duplicate
              ? "文件内重复"
              : "新增",
          duplicate: r.duplicate,
          locked: false,
          favorite: r.favorite,
          group: r.folder,
        }))
      : preview?.kind === "bills"
        ? preview.rows.map((r) => ({
            id: r.id,
            title: r.transaction.payee || r.transaction.note || r.category,
            detail: [r.transaction.occurredAt, r.category, r.account].join(
              " · ",
            ),
            value:
              (r.transaction.kind === "INCOME"
                ? "+"
                : r.transaction.kind === "TRANSFER"
                  ? "↔"
                  : "−") + formatMoney(r.value),
            status: r.duplicate ? "已导入" : r.excluded || r.status || "待入账",
            duplicate: r.duplicate,
            locked: r.duplicate,
            favorite: false,
            group: r.category,
          }))
        : [];
  $: tags = [
    ...new Set(items.flatMap((r) => [r.group, r.status]).filter(Boolean)),
  ];
  $: filtered = items.filter(
    (r) =>
      (!favorites || r.favorite) &&
      (!hideDuplicates || !r.duplicate) &&
      (!filter || r.group === filter || r.status === filter) &&
      [r.title, r.detail, r.status, r.value]
        .join(" ")
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  $: stale = !!preview && preview.revision !== snapshot.revision;
  $: unresolved =
    preview?.kind === "bills"
      ? preview.rows.filter((r) => r.needsDestination && selected.has(r.id))
          .length
      : 0;
  $: pages = Math.max(1, Math.ceil(filtered.length / 60));
  $: visible = filtered.slice(
    Math.min(page, pages - 1) * 60,
    (Math.min(page, pages - 1) + 1) * 60,
  );
  $: eligible = filtered.filter((r) => !r.locked);
  $: all = eligible.length > 0 && eligible.every((r) => selected.has(r.id));
  $: additions =
    preview?.kind === "assets"
      ? assetAdditions(snapshot, preview, { rows: selected })
      : undefined;
  $: count = additions
    ? additions.entities.length +
      additions.relations.length +
      additions.updates.size
    : selected.size + subscriptions.size;
  $: summary =
    preview?.kind === "bills"
      ? "+" +
        selected.size +
        " 笔流水 · 跳过 " +
        preview.duplicateCount +
        " 条重复 · +" +
        subscriptions.size +
        " 项订阅"
      : additions
        ? "+" +
          additions.entities.length +
          " 资产 · +" +
          additions.relations.length +
          " 关联" +
          (additions.updates.size
            ? " · 补全 " + additions.updates.size + " 项"
            : "")
        : "";
  function toggle(ids: string[], on: boolean) {
    const s = new Set(selected);
    for (const id of ids)
      if (on) s.add(id);
      else s.delete(id);
    selected = s;
  }
  async function commit() {
    if (busy || !preview || !count || unresolved) return;
    busy = true;
    try {
      const selection = { rows: selected, subscriptions };
      await save(
        preview.kind === "assets"
          ? applyAssetImport(snapshot, preview, selection)
          : applyBillImport(snapshot, preview, selection),
        "导入完成：" + summary,
      );
      close();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  use:backdropDismiss={{ enabled: () => !busy, onDismiss: requestClose }}
  class="app-dialog import-center"
  aria-labelledby="import-title"
  on:cancel|preventDefault={requestClose}
>
  <header>
    <div>
      <h2 id="import-title">数据导入中心</h2>
      <p class="muted">先预览，再写入记忆库。</p>
    </div>
    <button
      type="button"
      class="icon-button"
      aria-label="关闭导入中心"
      disabled={busy}
      on:click={requestClose}><Icon name="Close" /></button
    >
  </header>
  <div class="import-body">
    <div
      class="segmented"
      role="group"
      aria-label="导入类型"
      use:slidingIndicator
    >
      <button
        type="button"
        aria-pressed={tab === "assets"}
        disabled={busy}
        on:click={() => reset("assets")}>账号与密码管理器</button
      >
      <button
        type="button"
        aria-pressed={tab === "bills"}
        disabled={busy}
        on:click={() => reset("bills")}>账单与流水</button
      >
    </div>
    <p class="security">✓ 纯本地解析 · 绝不读取或保存密码/验证码</p>
    <input
      class="file-input"
      type="file"
      accept=".csv,.json"
      bind:this={picker}
      on:change={(e) => {
        void read(e.currentTarget.files?.[0]);
        e.currentTarget.value = "";
      }}
      aria-label="选择导入文件"
    />
    <button
      class="drop"
      class:drag
      class:compact={!!preview}
      disabled={busy}
      on:dragover|preventDefault={() => (drag = true)}
      on:dragleave={() => (drag = false)}
      on:drop|preventDefault={(e) => {
        drag = false;
        void read(e.dataTransfer?.files[0]);
      }}
      on:click={() => picker.click()}
    >
      <strong
        >{reading
          ? "正在本机解析…"
          : filename || "拖入文件，或点此选择"}</strong
      >
      {#if tab === "assets"}<span
          ><b>Bitwarden 未加密 JSON / CSV</b> · Chrome、Edge、Firefox、Apple、1Password、KeePass
          CSV</span
        >{:else}<span>微信支付 · 支付宝 · 通用银行 / 记账 CSV</span>{/if}
    </button>
    {#if tab === "assets" && !preview}<small class="export-note"
        >原导出文件仍含凭据，导入后请妥善保管或删除。</small
      >{/if}
    {#if autoSwitchNote}<p class="auto-switch reveal-in" role="status">{autoSwitchNote}</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if preview}
      {#if preview.kind === "bills" && preview.format === "generic"}
        {@const mapping = preview.mapping}
        <details open={!preview.rows.length}>
          <summary>自定义列映射</summary>
          <small>更改映射后将重新解析并重置勾选。</small>
          <div class="mapping">
            {#each Object.entries(columns) as [k, label]}<label
                >{label}<select
                  value={mapping[k as BillColumn] ?? ""}
                  on:change={(e) =>
                    remap({ ...mapping, [k]: e.currentTarget.value })}
                  ><option value="">未指定</option
                  >{#each preview.headers.filter(Boolean) as h}<option value={h}
                      >{h}</option
                    >{/each}</select
                ></label
              >{/each}
            <label
              >默认币种<select
                value={options.currency ?? "CNY"}
                on:change={(e) => {
                  options.currency = e.currentTarget.value;
                  remap(mapping);
                }}
                >{#each ASSETS as a}<option>{a.code}</option>{/each}</select
              ></label
            >
            <label
              >日期顺序<select
                value={options.dateOrder ?? "auto"}
                on:change={(e) => {
                  options.dateOrder = e.currentTarget
                    .value as BillOptions["dateOrder"];
                  remap(mapping);
                }}
                ><option value="auto">自动识别</option><option value="mdy"
                  >月 / 日 / 年</option
                ><option value="dmy">日 / 月 / 年</option></select
              ></label
            >
            <label
              >无收支方向列时<select
                value={options.positiveExpense ? "expense" : "income"}
                on:change={(e) => {
                  options.positiveExpense = e.currentTarget.value === "expense";
                  remap(mapping);
                }}
                ><option value="income">正数记收入</option><option
                  value="expense">正数记支出</option
                ></select
              ></label
            >
          </div>
        </details>
      {/if}
      <div class="preview-head">
        <strong
          >{preview.kind === "assets"
            ? preview.format
            : source[preview.format]}</strong
        ><span
          >{items.length} 条记录{#if preview.kind === "assets"}
            · 已剔除 {preview.stripped} 个敏感字段{/if}</span
        >
      </div>
      {#if preview.warnings.length}<details class="warnings">
          <summary>{preview.warnings.length} 条导入提示</summary
          >{#each preview.warnings.slice(0, 30) as w}<p>{w}</p>{/each}
        </details>{/if}
      <div class="filters">
        <input
          type="search"
          aria-label="搜索预览"
          placeholder="搜索名称、账户或分类"
          bind:value={search}
          on:input={() => (page = 0)}
        /><select
          aria-label="筛选分组或状态"
          bind:value={filter}
          on:change={() => (page = 0)}
          ><option value="">全部分组与状态</option>{#each tags as tag}<option
              >{tag}</option
            >{/each}</select
        >
      </div>
      <div class="switches">
        <label
          ><input
            type="checkbox"
            checked={all}
            on:change={(e) =>
              toggle(
                eligible.map((r) => r.id),
                e.currentTarget.checked,
              )}
          />全选筛选结果</label
        >
        {#if preview.kind === "assets"}<label
            ><input
              type="checkbox"
              bind:checked={favorites}
              on:change={() => (page = 0)}
            />仅看收藏</label
          ><button
            class="text-button"
            on:click={() =>
              (selected = new Set(
                items.filter((r) => r.favorite).map((r) => r.id),
              ))}>仅导入收藏</button
          >{/if}
        <label
          ><input
            type="checkbox"
            bind:checked={hideDuplicates}
          />隐藏重复</label
        >{#if preview.kind === "assets"}<button
            class="text-button"
            on:click={() =>
              toggle(
                items.filter((r) => r.duplicate).map((r) => r.id),
                false,
              )}>跳过重复</button
          >{/if}
      </div>
      <div class="table-scroll">
        <table>
          <thead
            ><tr
              ><th>导入</th><th
                >{tab === "assets" ? "资产 / 登录名" : "交易对方 / 账户"}</th
              ><th>{tab === "assets" ? "关联 / 类型" : "金额"}</th><th>状态</th
              ></tr
            ></thead
          >
          <tbody
            >{#each visible as r (r.id)}<tr class:off={!selected.has(r.id)}
                ><td
                  ><input
                    type="checkbox"
                    aria-label={"选择 " + r.title}
                    checked={selected.has(r.id)}
                    disabled={r.locked || busy}
                    on:change={(e) => {
                      toggle([r.id], e.currentTarget.checked);
                      if (
                        e.currentTarget.checked &&
                        preview?.kind === "bills" &&
                        preview.rows.find((v) => v.id === r.id)
                          ?.needsDestination
                      )
                        editRow(r.id);
                    }}
                  /></td
                ><td
                  ><strong>{r.favorite ? "★ " : ""}{r.title}</strong><small
                    >{r.detail}</small
                  ></td
                ><td>{r.value}</td><td
                  >{r.status}{#if preview.kind === "bills" && !r.locked}<button
                      class="text-button"
                      aria-label={"核对 " + r.title}
                      on:click={() => editRow(r.id)}>核对</button
                    >{/if}</td
                ></tr
              >{:else}<tr><td colspan="4">没有符合条件的记录</td></tr
              >{/each}</tbody
          >
        </table>
      </div>
      {#if editing}<form
          class="mapping"
          aria-label="核对流水"
          on:submit|preventDefault={finishRow}
        >
          <label
            >记账方式<select
              bind:value={editKind}
              on:change={() => (editCategory = "")}
              ><option value="SPEND">支出</option><option value="INCOME"
                >收入</option
              ><option value="TRANSFER">内部划转</option></select
            ></label
          >
          <label
            >{editKind === "TRANSFER" ? "转出账户" : "账户"}<input
              bind:value={editAccount}
              required
              maxlength="200"
            /></label
          ><label
            >{editKind === "TRANSFER" ? "转入账户" : "分类"}<input
              bind:value={editCategory}
              required
              maxlength="200"
            /></label
          >
          <div>
            <button class="secondary">采用并勾选</button><button
              type="button"
              class="text-button"
              on:click={() => (editing = "")}>取消</button
            >
          </div>
        </form>{/if}
      {#if stale}<p class="warnings">记忆库已更新，请重新选择文件。</p>{/if}
      {#if unresolved}<p class="warnings">
          请为 {unresolved} 笔划转核对转入账户。
        </p>{/if}
      {#if pages > 1}<div class="pager">
          <button disabled={!page} on:click={() => page--}>上一页</button
          >{Math.min(page + 1, pages)} / {pages}<button
            disabled={page + 1 >= pages}
            on:click={() => page++}>下一页</button
          >
        </div>{/if}
      {#if preview.kind === "bills" && preview.subscriptions.length}<fieldset>
          <legend>顺手创建订阅资产</legend
          >{#each preview.subscriptions as c}<label
              ><input
                type="checkbox"
                checked={subscriptions.has(c.entity.id)}
                on:change={(e) => {
                  const s = new Set(subscriptions);
                  if (e.currentTarget.checked) s.add(c.entity.id);
                  else s.delete(c.entity.id);
                  subscriptions = s;
                }}
              />{c.entity.name} · {formatMoney(c.fee)} / 月</label
            >{/each}
        </fieldset>{/if}
    {/if}
  </div>
  <footer>
    <strong aria-live="polite">{summary || "尚未选择文件"}</strong><button
      class="primary"
      disabled={!count || busy || reading || !!editing || !!unresolved || stale}
      on:click={commit}>{busy ? "正在保存…" : "确认导入"}</button
    >
  </footer>
</dialog>

<style>
  .import-center {
    width: min(840px, calc(100vw - 24px));
    padding: 0;
    max-height: 88dvh;
    overflow: hidden;
  }
  .import-center[open] {
    display: flex;
    flex-direction: column;
  }
  header,
  footer,
  .preview-head,
  .filters,
  .switches,
  .pager {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  header,
  footer {
    justify-content: space-between;
    padding: 18px 24px;
  }
  header {
    border-bottom: 1px solid var(--border);
  }
  h2,
  p {
    margin: 0;
  }
  header p {
    margin-top: 3px;
  }
  .import-body {
    padding: 20px 24px;
    overflow: auto;
  }
  .security {
    color: var(--income);
    font-size: 13px;
    margin: 14px 0;
  }
  .auto-switch {
    margin-top: 10px;
    padding: 8px 12px;
    border-radius: 8px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 12px;
  }
  .export-note {
    display: block;
    margin-top: 6px;
    color: var(--muted);
  }
  .drop b {
    color: var(--accent);
  }
  .file-input {
    display: none;
  }
  .drop {
    width: 100%;
    border: 1px dashed var(--border-strong);
    border-radius: 10px;
    background: var(--surface-raised);
    padding: 30px 14px;
    color: var(--text);
    display: grid;
    gap: 7px;
    text-align: center;
  }
  .drop:hover,
  .drop.drag {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  .compact {
    padding: 12px;
  }
  .drop span,
  small,
  .preview-head span {
    color: var(--muted);
    font-size: 12px;
  }
  .preview-head {
    justify-content: space-between;
    margin: 22px 0 10px;
  }
  .filters input {
    flex: 1;
    min-width: 0;
  }
  .switches {
    flex-wrap: wrap;
    margin: 10px 0;
  }
  .switches label,
  fieldset label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .switches input,
  td input,
  fieldset input {
    width: auto;
    accent-color: var(--accent);
  }
  .table-scroll {
    overflow: auto;
    max-height: 38dvh;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    text-align: left;
    font-size: 13px;
  }
  th,
  td {
    padding: 8px;
    border-bottom: 1px solid var(--border);
    overflow-wrap: anywhere;
  }
  th {
    position: sticky;
    top: 0;
    background: var(--surface-raised);
    font-weight: 500;
    color: var(--muted);
  }
  td strong,
  td small {
    display: block;
  }
  td:nth-child(3) {
    font-variant-numeric: tabular-nums;
  }
  .off td {
    color: var(--muted);
  }
  footer {
    border-top: 1px solid var(--border);
    font-size: 13px;
    flex-wrap: wrap;
  }
  details,
  fieldset {
    margin-top: 12px;
  }
  summary {
    cursor: pointer;
    color: var(--accent);
  }
  .warnings summary {
    color: var(--warning);
  }
  .mapping {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(135px, 1fr));
    gap: 8px;
    padding: 8px 0;
  }
  .mapping label {
    font-size: 12px;
  }
  fieldset {
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  fieldset label {
    margin: 6px;
  }
  .pager {
    justify-content: flex-end;
    font-size: 12px;
  }
  footer .primary {
    margin-left: auto;
  }
  @media (max-width: 550px) {
    header,
    footer,
    .import-body {
      padding: 12px;
    }
    .filters {
      flex-wrap: wrap;
    }
    th,
    td {
      padding: 6px 4px;
    }
    .preview-head {
      flex-wrap: wrap;
    }
  }
</style>
