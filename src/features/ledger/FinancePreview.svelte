<script lang="ts">
  import {
    dateToday,
    makeEntry,
    transactionSchema,
    type FinanceAction,
    type LedgerAccount,
  } from "../../domain/ledger";
  import {
    applyFinanceActions,
    ledgerAccountOptions,
    materializeFinanceAccounts,
    resolveLedgerAccount,
  } from "../../domain/finance-capture";
  import type { VaultSnapshot } from "../../lib/types";
  import { ASSETS, money, units } from "../../domain/money";
  export let actions: FinanceAction[] = [];
  export let snapshot: VaultSnapshot;
  export let rawText = "手动记账";
  export let changed: () => void;
  export let invalid = false;
  export let busy = false;
  let error = "";
  $: accounts = [
    ...(snapshot.ledgerAccounts ?? []),
    ...actions.flatMap((a) => (a.type === "account.add" ? [a.account] : [])),
  ];
  $: invalid = !!error || !valid(actions, snapshot);
  const label = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  function choices(asset: string, kind: LedgerAccount["kind"]) {
    return ledgerAccountOptions(
      { ...snapshot, ledgerAccounts: accounts },
      asset,
    ).filter(
      (a) =>
        (kind === "ASSET"
          ? ["ASSET", "LIABILITY"].includes(a.kind)
          : a.kind === kind) &&
        (!a.asset || a.asset === asset),
    );
  }
  function counterKind(kind: string): LedgerAccount["kind"] {
    return kind === "TRANSFER"
      ? "ASSET"
      : kind === "INCOME"
        ? "INCOME"
        : kind === "OPENING"
          ? "EQUITY"
          : "EXPENSE";
  }
  function valid(values: FinanceAction[], s: VaultSnapshot) {
    try {
      if (
        values.some(
          (a) =>
            a.type === "ledger.add" &&
            (!transactionSchema.safeParse(a.transaction).success ||
              !a.transaction.legs.some((l) => units(l.money) !== 0n)),
        )
      )
        return false;
      applyFinanceActions(s, materializeFinanceAccounts(s, values));
      return true;
    } catch {
      return false;
    }
  }
  function update() {
    actions = [...actions];
    error = "";
    changed();
  }
  function amount(index: number, leg: number, value: string) {
    const a = actions[index];
    if (a.type !== "ledger.add") return;
    a.transaction.legs[leg].money.amount = value;
    update();
  }
  function simpleAmount(index: number, value: string) {
    const a = actions[index];
    if (a.type !== "ledger.add") return;
    const incoming = ["INCOME", "OPENING"].includes(a.transaction.kind);
    a.transaction.legs[0].money.amount = (incoming ? "" : "-") + value;
    a.transaction.legs[1].money.amount = (incoming ? "-" : "") + value;
    update();
  }
  function choose(index: number, leg: number, value: string) {
    try {
      const next = structuredClone(actions),
        a = next[index];
      if (a.type !== "ledger.add") return;
      const kind = leg === 0 ? "ASSET" : counterKind(a.transaction.kind);
      const account =
        leg === 1 && kind === "ASSET" && !value.trim()
          ? undefined
          : resolveLedgerAccount(
              snapshot,
              next,
              value,
              kind,
              a.transaction.legs[leg].money.asset,
              leg === 0
                ? "未指定账户"
                : kind === "INCOME"
                  ? "其他收入"
                  : "其他支出",
            );
      a.transaction.legs[leg].accountId = account?.id ?? "";
      const used = new Set(
        next.flatMap((a) =>
          a.type === "ledger.add"
            ? a.transaction.legs.map((l) => l.accountId)
            : [],
        ),
      );
      actions = next.filter(
        (a) => a.type !== "account.add" || used.has(a.account.id),
      );
      update();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  function currency(index: number, value: string) {
    const a = actions[index];
    if (a.type !== "ledger.add") return;
    const name = label(a.transaction.legs[0].accountId);
    for (const l of a.transaction.legs) l.money.asset = value;
    choose(index, 0, name);
  }
  function changeKind(index: number, value: "SPEND" | "INCOME" | "TRANSFER") {
    const a = actions[index];
    if (a.type !== "ledger.add") return;
    a.transaction.kind = value;
    const amount = a.transaction.legs[0].money.amount.replace(/^-/, "");
    simpleAmount(index, amount);
    if (value === "TRANSFER") {
      a.transaction.legs[1].accountId = "";
      update();
    } else choose(index, 1, value === "INCOME" ? "其他收入" : "其他支出");
  }
  function addRow() {
    const next = [...actions];
    const fund = resolveLedgerAccount(
      snapshot,
      next,
      "",
      "ASSET",
      "CNY",
      "未指定账户",
    );
    const category = resolveLedgerAccount(
      snapshot,
      next,
      "",
      "EXPENSE",
      "CNY",
      "其他支出",
    );
    const transaction = makeEntry({
      kind: "SPEND",
      amount: money("1", "CNY"),
      accountId: fund.id,
      counterId: category.id,
      date: dateToday(),
    });
    transaction.legs[0].money.amount = "";
    transaction.legs[1].money.amount = "";
    actions = [...next, { type: "ledger.add", transaction, evidence: rawText }];
    update();
  }
</script>

<div class="finance-preview">
  {#each actions.filter((a) => a.type !== "account.add") as action (action.type === "ledger.add" ? action.transaction.id : action.id)}
    {@const i = actions.indexOf(action)}
    <article>
      {#if action.type === "ledger.reverse"}<strong>冲正</strong><span
          >{snapshot.transactions?.find((t) => t.id === action.transactionId)
            ?.note ?? action.transactionId} · {action.occurredAt}</span
        >
      {:else}
        <header>
          {#if ["SPEND", "INCOME", "TRANSFER"].includes(action.transaction.kind)}<select
              aria-label="类型"
              value={action.transaction.kind}
              disabled={busy}
              on:change={(e) =>
                changeKind(
                  i,
                  e.currentTarget.value as "SPEND" | "INCOME" | "TRANSFER",
                )}
              ><option value="SPEND">支出</option><option value="INCOME"
                >收入</option
              ><option value="TRANSFER">转账</option></select
            >{:else}<strong
              >{{
                SPEND: "支出",
                INCOME: "收入",
                TRANSFER: "转账",
                TRADE: "交易",
                OPENING: "期初余额",
                ADJUST: "调整",
              }[action.transaction.kind]}</strong
            >{/if}<input
            aria-label="日期"
            type="date"
            bind:value={action.transaction.occurredAt}
            disabled={busy}
            on:change={update}
          />
        </header>
        {#if action.transaction.legs.length === 2}
          <div class="row">
            <label
              >金额<input
                aria-label="金额"
                value={action.transaction.legs[0].money.amount.replace(
                  /^-/,
                  "",
                )}
                inputmode="decimal"
                disabled={busy}
                on:input={(e) => simpleAmount(i, e.currentTarget.value)}
              /></label
            >
            <label
              >币种<select
                aria-label="币种"
                value={action.transaction.legs[0].money.asset}
                disabled={busy}
                on:change={(e) => currency(i, e.currentTarget.value)}
                >{#each ASSETS as a}<option value={a.code}>{a.code}</option
                  >{/each}</select
              ></label
            >
          </div>
          <div class="row">
            <label
              >{action.transaction.kind === "INCOME"
                ? "收款账户"
                : "付款账户"}<input
                aria-label="账户"
                list={`fund-${i}`}
                value={label(action.transaction.legs[0].accountId)}
                placeholder="未指定账户"
                maxlength="200"
                disabled={busy}
                on:input={(e) => choose(i, 0, e.currentTarget.value)}
              /></label
            >
            <datalist id={`fund-${i}`}
              >{#each choices(action.transaction.legs[0].money.asset, "ASSET") as a}<option
                  value={a.name}>{a.asset ?? ""}</option
                >{/each}</datalist
            >
            <label
              >{action.transaction.kind === "TRANSFER"
                ? "转入账户"
                : "分类"}<input
                aria-label="分类"
                list={`category-${i}`}
                value={label(action.transaction.legs[1].accountId)}
                maxlength="200"
                disabled={busy}
                on:input={(e) => choose(i, 1, e.currentTarget.value)}
              /></label
            >
            <datalist id={`category-${i}`}
              >{#each choices(action.transaction.legs[0].money.asset, counterKind(action.transaction.kind)) as a}<option
                  value={a.name}
                ></option>{/each}</datalist
            >
          </div>
        {:else}
          {#each action.transaction.legs as leg, j}<label
              >{label(leg.accountId)}<input
                aria-label={`${label(leg.accountId)} 金额`}
                value={leg.money.amount}
                inputmode="decimal"
                disabled={busy}
                on:input={(e) => amount(i, j, e.currentTarget.value)}
              />{leg.money.asset}</label
            >{/each}
        {/if}
        <label
          >备注<input
            aria-label="备注"
            bind:value={action.transaction.note}
            maxlength="5000"
            disabled={busy}
            on:input={update}
          /></label
        >
      {/if}
      <button
        type="button"
        disabled={busy}
        class="text-button remove"
        on:click={() => {
          actions = actions.filter((_, j) => i !== j);
          update();
        }}>移除</button
      >
    </article>
  {/each}
  <button type="button" class="secondary" disabled={busy} on:click={addRow}
    >＋ 一笔</button
  >
  {#if error}<p class="error" role="alert">{error}</p>{:else if invalid}<p
      class="error"
      role="alert"
    >
      请检查金额、日期和所选账户
    </p>{/if}
</div>

<style>
  .finance-preview {
    display: grid;
    gap: 1rem;
  }
  article {
    border-bottom: 1px solid var(--border);
    padding: 1rem 0;
    display: grid;
    gap: 0.75rem;
  }
  header,
  .row {
    display: flex;
    align-items: end;
    gap: 0.75rem;
  }
  header {
    justify-content: space-between;
  }
  header input {
    width: auto;
  }
  label {
    display: grid;
    gap: 0.35rem;
    flex: 1;
    min-width: 0;
    font-size: 0.8rem;
    color: var(--muted);
  }
  input,
  select {
    width: 100%;
    min-width: 0;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .remove {
    justify-self: end;
  }
</style>
