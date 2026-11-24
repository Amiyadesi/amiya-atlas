<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { VaultSnapshot, Entity } from "../../lib/types";
  import { ASSETS, money } from "../../domain/money";
  import {
    dateToday,
    makeEntry,
    preferences,
    validateLedger,
    type Transaction,
  } from "../../domain/ledger";
  import {
    applyFinanceActions,
    expenseCategory,
    ledgerAccountOptions,
    resolveLedgerAccount,
  } from "../../domain/finance-capture";
  import { frequentEntries } from "../../domain/ledger-view";
  import { orderReport, field } from "../../domain/reports";
  import { confirmDialog } from "../../lib/dialog";
  import { slidingIndicator } from "../../lib/motion";
  export let snapshot: VaultSnapshot,
    original: Transaction | undefined,
    order: Entity | undefined;
  export let save: (next: VaultSnapshot, ids: string[]) => Promise<void>,
    close: () => void;
  let amountInput: HTMLInputElement,
    busy = false,
    error = "",
    customCategory = false;
  $: settings = preferences(snapshot);
  $: presets = frequentEntries(snapshot);
  const kindLabel = (k: string) =>
    k === "SPEND" ? "支出" : k === "INCOME" ? "收入" : "转账";
  let kind: Transaction["kind"] = "SPEND",
    amount = "",
    asset = "CNY",
    accountId = "",
    counterId = "",
    date = dateToday(),
    note = "",
    payee = "",
    projectId = "",
    resourceId = "",
    orderId = "",
    fee = "",
    feeAccountId = "";
  $: accounts = (snapshot.ledgerAccounts ?? []).filter(
    (a) => a.privacy !== "SECRET",
  );
  $: activeAccounts = accounts.filter((a) => !a.archived);
  $: entryAccounts = ledgerAccountOptions(snapshot, asset);
  $: funds = entryAccounts.filter(
    (a) => ["ASSET", "LIABILITY"].includes(a.kind) && a.asset === asset,
  );
  $: counters = entryAccounts.filter(
    (a) =>
      a.id !== accountId &&
      (!a.asset || a.asset === asset) &&
      (kind === "TRANSFER"
        ? ["ASSET", "LIABILITY"].includes(a.kind)
        : a.kind ===
          (kind === "INCOME"
            ? "INCOME"
            : kind === "OPENING"
              ? "EQUITY"
              : "EXPENSE")),
  );
  $: projects = snapshot.entities.filter(
    (e) => e.category === "Project" && e.privacy !== "SECRET",
  );
  $: resources = snapshot.entities.filter(
    (e) =>
      ["Subscription", "Server", "Domain", "AI Provider Account"].includes(
        e.category,
      ) && e.privacy !== "SECRET",
  );
  $: orders = snapshot.entities.filter(
    (e) => e.category === "Order" && e.privacy !== "SECRET",
  );
  $: inferredCategory =
    kind === "SPEND" && !counterId.trim() && note.trim()
      ? expenseCategory(note)
      : "";
  $: showCategoryInput =
    kind !== "TRANSFER" &&
    (customCategory ||
      !counters.length ||
      (!!counterId &&
        !counters.some((c) => c.id === counterId || c.name === counterId)));
  onMount(() => {
    const last = [...(snapshot.transactions ?? [])]
      .reverse()
      .find((t) => t.kind === kind && !t.reversalOf && t.privacy !== "SECRET");
    if (!funds.some((a) => a.id === accountId))
      accountId = funds.find((a) => a.id === last?.legs[0].accountId)?.id ?? "";
    if (!counters.some((a) => a.id === counterId))
      counterId =
        counters.find((a) => a.id === last?.legs[1].accountId)?.id ?? "";
    feeAccountId = activeAccounts.find((a) => a.name === "手续费")?.id ?? "";
    if (original) {
      const t = original;
      kind = t.kind;
      asset = t.legs[0].money.asset;
      amount = t.legs[0].money.amount.replace(/^-/, "");
      accountId = t.legs[0].accountId;
      counterId = t.legs[1].accountId;
      note = t.note ?? "";
      payee = t.payee ?? "";
      projectId = t.legs[1].projectId ?? "";
      resourceId = t.legs[1].resourceId ?? "";
      orderId = t.refs?.orderId ?? "";
      const charge = t.legs
        .slice(2)
        .find(
          (l) => accounts.find((a) => a.id === l.accountId)?.kind === "EXPENSE",
        );
      fee = charge?.money.amount ?? "";
      feeAccountId = charge?.accountId ?? "";
    } else if (order) {
      const report = orderReport(snapshot, order);
      kind = "INCOME";
      orderId = order.id;
      asset = report?.quote.asset ?? "CNY";
      amount = report?.due.amount ?? "";
      projectId = String(field(order, "project") ?? "");
      accountId = "";
      counterId = "";
    }
  });
  function pickKind(next: Transaction["kind"]) {
    kind = next;
    counterId = "";
    customCategory = false;
    fee = "";
    orderId = "";
  }
  async function submit(again: boolean) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      if (kind === "TRANSFER" && (!accountId.trim() || !counterId.trim()))
        throw new Error("请选择或填写转出和转入账户");
      const actions = [] as import("../../domain/ledger").FinanceAction[];
      const account = resolveLedgerAccount(
        snapshot,
        actions,
        accountId,
        "ASSET",
        asset,
        "未指定账户",
      );
      const counter = resolveLedgerAccount(
        snapshot,
        actions,
        counterId,
        kind === "TRANSFER"
          ? "ASSET"
          : kind === "INCOME"
            ? "INCOME"
            : kind === "OPENING"
              ? "EQUITY"
              : "EXPENSE",
        asset,
        kind === "INCOME"
          ? "其他收入"
          : kind === "OPENING"
            ? "期初与调整"
            : expenseCategory(note),
      );
      const feeCategory = fee
        ? resolveLedgerAccount(
            snapshot,
            actions,
            feeAccountId,
            "EXPENSE",
            asset,
            "手续费",
          )
        : undefined;
      const t = makeEntry({
        kind,
        amount: money(amount, asset),
        accountId: account.id,
        counterId: counter.id,
        date,
        note,
        payee,
        projectId,
        resourceId,
        orderId,
        fee: fee ? money(fee, asset) : undefined,
        feeAccountId: feeCategory?.id,
        taxRate: kind === "INCOME" ? settings?.taxRate : undefined,
        reserveAccountId: settings?.reserveAccountId,
      });
      if (
        (snapshot.financeRecords ?? []).some(
          (r) =>
            r.type === "reconciliation" &&
            r.accountId === account.id &&
            r.date >= date,
        ) &&
        !(await confirmDialog({
          title: "仍然入账？",
          description: "这笔记录早于已对账日期。",
          confirmLabel: "确认入账",
        }))
      )
        return;
      const next = applyFinanceActions(snapshot, [
        ...actions,
        { type: "ledger.add", transaction: t, evidence: note || "手动记账" },
      ]);
      validateLedger(next, snapshot);
      await save(next, [t.id]);
      if (!again) {
        close();
        return;
      }
      accountId = account.id;
      counterId = counter.id;
      amount = "";
      note = "";
      payee = "";
      projectId = "";
      resourceId = "";
      orderId = "";
      fee = "";
      await tick();
      amountInput.focus();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

{#if error}<p class="error" role="alert">{error}</p>{/if}
<form
  class="entry-form"
  on:submit|preventDefault={(e) =>
    submit(e.submitter?.getAttribute("value") === "again")}
>
  {#if presets.length}<div class="entry-presets" aria-label="常用组合">
      {#each presets as p}<button
          type="button"
          class="secondary"
          on:click={() => {
            kind = p.kind;
            asset = p.asset;
            accountId = p.account.id;
            counterId = p.counter.id;
            customCategory = false;
            fee = "";
            orderId = "";
          }}>{p.counter.name} · {p.account.name} · {kindLabel(p.kind)}</button
        >{/each}
    </div>{/if}
  <div class="entry-kinds-row">
    <div
      class="segmented entry-kinds"
      role="group"
      aria-label="记账类型"
      use:slidingIndicator
    >
      {#each [["SPEND", "支出"], ["INCOME", "收入"], ["TRANSFER", "转账"]] as [value, label]}<button
          type="button"
          aria-pressed={kind === value}
          on:click={() => pickKind(value as Transaction["kind"])}>{label}</button
        >{/each}
    </div>
    {#if kind === "OPENING"}
      <span class="opening-pill">期初余额</span>
    {/if}
  </div>
  <div class="entry-amount">
    <label
      ><span class="sr-only">金额</span><input
        aria-label="金额"
        bind:this={amountInput}
        bind:value={amount}
        required
        inputmode="decimal"
        placeholder="0.00"
      /></label
    ><label
      ><span class="sr-only">币种</span><select
        aria-label="币种"
        bind:value={asset}
        on:change={() => {
          accountId = "";
          counterId = "";
        }}
        >{#each ASSETS as a}<option value={a.code}>{a.code}</option
          >{/each}</select
      ></label
    >
  </div>
  {#if kind !== "TRANSFER" && counters.length}<div
      class="entry-categories"
      aria-label="分类"
    >
      {#each counters as category}
        {@const selected =
          counterId === category.id || counterId === category.name}
        {@const autoMatched =
          !selected && inferredCategory === category.name}
        <button
          type="button"
          class:active={selected}
          class:inferred={autoMatched}
          aria-pressed={selected}
          title={autoMatched ? "已按备注自动识别，保存时生效" : undefined}
          on:click={() => {
            counterId = selected ? "" : category.id;
            customCategory = false;
          }}>{category.name}</button
        >
      {/each}
      <button
        type="button"
        class="custom-chip"
        class:active={showCategoryInput}
        aria-pressed={showCategoryInput}
        on:click={() => {
          if (showCategoryInput) {
            customCategory = false;
            if (!counters.some((c) => c.id === counterId || c.name === counterId)) {
              counterId = "";
            }
          } else {
            customCategory = true;
            if (counters.some((c) => c.id === counterId)) {
              counterId = "";
            }
          }
        }}>＋ 自定义</button
      >
    </div>{/if}
  <div class="form-grid">
    <label
      >{kind === "INCOME" || kind === "OPENING" ? "收款账户" : "付款账户"}<input
        aria-label="账户"
        list="entry-funds"
        value={funds.find((a) => a.id === accountId)?.name ?? accountId}
        on:input={(e) => (accountId = e.currentTarget.value)}
        placeholder="未指定账户"
        maxlength="200"
        required={kind === "TRANSFER" || kind === "OPENING"}
      /><datalist id="entry-funds"
        >{#each funds as a}<option value={a.name}></option>{/each}</datalist
      ></label
    >{#if kind === "TRANSFER"}<label
        >转入账户<input
          aria-label="转入账户"
          value={funds.find((a) => a.id === counterId)?.name ?? counterId}
          on:input={(e) => (counterId = e.currentTarget.value)}
          list="entry-funds"
          maxlength="200"
          required
        /></label
      >{:else if showCategoryInput}<label
        >分类<input
          aria-label="分类"
          value={counters.find((a) => a.id === counterId)?.name ?? counterId}
          on:input={(e) => (counterId = e.currentTarget.value)}
          list="entry-categories"
          placeholder={kind === "INCOME"
            ? "其他收入"
            : kind === "OPENING"
              ? "期初与调整"
              : inferredCategory || "其他支出"}
          maxlength="200"
        /><datalist id="entry-categories"
          >{#each counters as a}<option value={a.name}
            ></option>{/each}</datalist
        ></label
      >{/if}<label>日期<input type="date" bind:value={date} required /></label
    ><label class:full-span={!showCategoryInput && kind !== "TRANSFER"}
      >备注<input
        bind:value={note}
        placeholder={inferredCategory
          ? `自动归类：${inferredCategory}`
          : "可选，如 午饭 / 咖啡"}
        maxlength="5000"
      /></label
    >
  </div>
  <details class="entry-more">
    <summary>更多选项</summary>
    <div class="form-grid reveal-in">
      {#if projects.length}<label
          >项目<select bind:value={projectId}
            ><option value="">无</option>{#each projects as p}<option
                value={p.id}>{p.name}</option
              >{/each}</select
          ></label
        >{/if}{#if resources.length}<label
          >资源<select bind:value={resourceId}
            ><option value="">无</option>{#each resources as r}<option
                value={r.id}>{r.name}</option
              >{/each}</select
          ></label
        >{/if}
      {#if kind === "INCOME"}{#if orders.length}<label
            >订单<select bind:value={orderId}
              ><option value="">无</option>{#each orders as o}<option
                  value={o.id}>{o.name}</option
                >{/each}</select
            ></label
          >{/if}<label>平台手续费<input bind:value={fee} inputmode="decimal" /></label
        >{#if fee}<label
            >手续费分类<select bind:value={feeAccountId} required
              ><option value="">选择</option>
              >{#each activeAccounts.filter((a) => a.kind === "EXPENSE") as a}<option
                  value={a.id}>{a.name}</option
                >{/each}</select
            ></label
          >{/if}{/if}
      <label>交易对方<input bind:value={payee} maxlength="500" /></label>
    </div>
    {#if kind !== "OPENING"}
      <button
        type="button"
        class="text-button opening-toggle"
        on:click={() => pickKind("OPENING")}>需要录入账户期初余额？</button
      >
    {/if}
  </details>
  <button class="primary" disabled={busy}>{busy ? "保存中…" : "保存"}</button>
  <button type="submit" value="again" class="secondary" disabled={busy}
    >保存并再记一笔</button
  >
</form>

<style>
  .entry-presets,
  .entry-categories,
  .entry-kinds-row,
  .entry-amount {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .entry-presets,
  .entry-categories {
    overflow: auto;
    scrollbar-width: none;
    margin-bottom: 12px;
  }
  .entry-presets button,
  .entry-categories button {
    flex: none;
    background: var(--surface-raised);
    color: var(--muted);
    border: 1px solid transparent;
    border-radius: 99px;
    padding: 6px 12px;
    font-size: 13px;
  }
  .entry-kinds-row {
    margin: 10px 0 12px;
    gap: 10px;
  }
  .entry-kinds {
    display: inline-flex;
  }
  .opening-pill {
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 4px 10px;
    border-radius: 99px;
  }
  .entry-categories button.active {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 550;
  }
  .entry-categories button.inferred {
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
    color: var(--accent);
    background: color-mix(in srgb, var(--accent-soft) 55%, var(--surface-raised));
  }
  .entry-categories button.custom-chip {
    background: transparent;
    border: 1px dashed var(--border-strong);
  }
  .entry-categories button.custom-chip.active {
    border-style: solid;
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
  }
  .entry-amount {
    padding: 0 0 12px;
  }
  .entry-amount label:first-child {
    min-width: 0;
    flex: 1;
  }
  .entry-amount input {
    font-size: 36px;
    line-height: 1.3;
    font-variant-numeric: tabular-nums;
    border: 0;
    background: transparent;
    padding: 0;
    width: 100%;
  }
  .entry-amount select {
    width: 84px;
  }
  .form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 9px 12px;
  }
  .form-grid .full-span {
    grid-column: 1 / -1;
  }
  .form-grid label,
  .form-grid input,
  .form-grid select {
    min-width: 0;
    width: 100%;
  }
  .entry-more {
    margin: 10px 0 16px;
  }
  .entry-more summary {
    cursor: pointer;
    padding: 5px 0;
    color: var(--muted);
    font-size: 13px;
    user-select: none;
  }
  .opening-toggle {
    margin-top: 8px;
    font-size: 12px;
  }
  .entry-form > .primary,
  .entry-form > .secondary {
    width: 100%;
    min-height: 42px;
  }
  .entry-form > .secondary {
    margin-top: 5px;
    background: transparent;
    color: var(--accent);
    border: 0;
  }
</style>
