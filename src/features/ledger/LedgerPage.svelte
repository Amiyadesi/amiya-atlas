<script lang="ts">
  import {tick} from "svelte";
  import QuickEntry from "./QuickEntry.svelte";
  import ReviewCharts from "./ReviewCharts.svelte";
  import TransactionDrawer from "./TransactionDrawer.svelte";
  import {frequentEntries,groupLedgerRows,viewportLines,budgetPercent} from "../../domain/ledger-view";
  import {privateEntity} from "../../domain/importers/assets";
  import { confirmDialog } from "../../lib/dialog";
  import type { Entity, VaultSnapshot } from "../../lib/types";
  import { newId, nowIso } from "../../lib/types";
  import { saveSnapshot } from "../../lib/api";
  import {
    ASSETS,
    money,
    formatMoney,
    units,
    negate,
    subtract,
    total,
    type Money,
  } from "../../domain/money";
  import {
    makeEntry,
    dateToday,
    accountBalances,
    reconciliation,
    ledgerCsv,
    preferences,
    validateLedger,
    type LedgerAccount,
    type Transaction,
    type FinanceRecord,
  } from "../../domain/ledger";
  import {
    emptyProposal,
    legacyCosts,
    applyFinanceActions,
    expenseCategory,
    ledgerAccountOptions,
    resolveLedgerAccount,
  } from "../../domain/finance-capture";
  import {
    monthlyCosts,
    periodReport,
    expectedPayments,
    orderReport,
    field,
    isCommercialProject,
  } from "../../domain/reports";
  import type { Proposal } from "../../domain/proposal";
  import InvestmentPanel from "./InvestmentPanel.svelte";
  import MoneyGraph from "./MoneyGraph.svelte";
  import { parseFinanceQuery } from "../../ai/finance";
  import type { ProviderConfig } from "../../ai/provider";
  import {
    queryReport,
    monthEnd,
    type LedgerQuery,
  } from "../../domain/reports";
  export let snapshot: VaultSnapshot;
  export let config: ProviderConfig;
  export let saved: (next: VaultSnapshot) => void;
  export let stage: (raw: string, proposal: Proposal) => Promise<void>;
  export let edit: (entity?: Entity) => void;
  export let quickSave:(next:VaultSnapshot,ids:string[])=>Promise<void>;
  export let openImport:()=>void,subscription:(entity:Entity)=>void,notify:(message:string)=>void;
  let amountInput:HTMLInputElement, investment:InvestmentPanel,scrollList:HTMLDivElement;
  function resetScroll(){scrollTop=0;if(scrollList)scrollList.scrollTop=0;}
  $: presets=frequentEntries(snapshot);
  export let download: (filename: string, payload: string) => Promise<void>;
  let tab = "流水",
    month = dateToday().slice(0, 7),
    search = "",
    accountFilter = "",
    projectFilter = "",
    scrollTop = 0,
    form = "",
    busy = false,
    error = "";
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
  let accountName = "",
    accountKind: LedgerAccount["kind"] = "ASSET",
    linkedEntity = "",
    parentId = "",
    editingAccount = "",
    actual = "",
    reason = "";
  let resource = "",
    effectiveFrom = dateToday(),
    allocationShares: Array<{ projectId: string; weight: number }> = [];
  let budget = "",
    budgetProject = "",
    week = false,
    entryId = "";
  let question = "",
    interpreted: LedgerQuery | undefined;
  $: answer = interpreted ? queryReport(snapshot, interpreted) : undefined;
  let lotMethod: "FIFO" | "LIFO" = "FIFO",
    showEntries = false,
    taxRate = 0,
    reserveAccountId = "";
  $: settings = preferences(snapshot);
  $: if (settings) {
    lotMethod = settings.lotMethod;
    showEntries = settings.showEntries;
    taxRate = settings.taxRate * 100;
    reserveAccountId = settings.reserveAccountId ?? "";
  }
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
  $: balances = accountBalances(snapshot);
  $: from = week && tab==="回顾"
    ? new Date(Date.now() - 6 * 86400000).toLocaleDateString("sv-SE")
    : `${month}-01`;
  $: to = week && tab==="回顾" ? dateToday() : monthEnd(month);
  $: report = periodReport(snapshot, from, to);
  $: monthReport = week ? periodReport(snapshot,month+"-01",monthEnd(month)) : report;
  $: commercialReports = report.projects.filter((p) =>
    snapshot.entities.some((e) => e.id === p.id && isCommercialProject(e)),
  );
  $: costs = monthlyCosts(snapshot, `${month}-01`);
  $: expected = expectedPayments(snapshot, month);
  $: legacy = legacyCosts(snapshot);
  $: accountNames=new Map(accounts.map(a=>[a.id,a.name]));
  $: rows = report.transactions
    .filter(
      (t) =>
        t.privacy !== "SECRET" &&
        (!accountFilter || t.legs.some((l) => l.accountId === accountFilter)) &&
        (!projectFilter || t.legs.some((l) => l.projectId === projectFilter)) &&
        (!search || `${t.note ?? ""} ${t.payee ?? ""} ${t.legs.map((l) => accountNames.get(l.accountId)).join(" ")}`
          .toLowerCase()
          .includes(search.toLowerCase())),
    )
    .sort(
      (a, b) =>
        (b.precision==="month"?b.occurredAt.slice(0,7):b.occurredAt).localeCompare(a.precision==="month"?a.occurredAt.slice(0,7):a.occurredAt) ||
        b.createdAt.localeCompare(a.createdAt),
    );
  $: groups=groupLedgerRows(rows,accounts);
  $: visible=viewportLines(groups.lines,scrollTop);
  $: reversed = new Set(snapshot.transactions?.map((t) => t.reversalOf));
  const list = (values: Money[]) =>
    values.length ? values.map(formatMoney).join(" · ") : "—";
  const accountLabel = (id: string) =>
    accounts.find((a) => a.id === id)?.name ?? id;
  const kindLabel = (value: string) =>
    ({
      SPEND: "支出",
      INCOME: "收入",
      TRANSFER: "转账",
      OPENING: "期初",
      ADJUST: "调整",
      TRADE: "交易",
    })[value] ?? value;
  const accountKinds = {
    ASSET: "资产",
    LIABILITY: "负债",
    INCOME: "收入分类",
    EXPENSE: "支出分类",
    EQUITY: "期初与调整",
  };
  function transactionAmount(t: Transaction) {
    const m=t.legs[0].money;
    return formatMoney(units(m)<0n?negate(m):m);
  }
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await fn();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
  async function persist(next: VaultSnapshot) {
    validateLedger(next, snapshot);
    saved(await saveSnapshot(next));
    form = "";
  }
  async function submit(again:boolean) {
    await run(async () => {
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
        taxRate: kind === "INCOME" ? taxRate / 100 : undefined,
        reserveAccountId,
      });
      if (
        (snapshot.financeRecords ?? []).some(
          (r) =>
            r.type === "reconciliation" &&
            r.accountId === account.id &&
            r.date >= date,
        ) &&
        !await confirmDialog({title: "仍然入账？", description: "这笔记录早于已对账日期。", confirmLabel: "确认入账"})
      )
        return;
      const next = applyFinanceActions(snapshot, [
        ...actions,
        { type: "ledger.add", transaction: t, evidence: note || "手动记账" },
      ]);
      await persist(next);
      form = again?"entry":"";
      accountId=account.id; counterId=counter.id;
      notify("已保存流水");
      amount = "";
      note = "";
      payee = "";
      projectId = "";
      resourceId = "";
      orderId = "";
      fee = "";
      if(again){await tick();amountInput.focus();}
    });
  }
  async function setCommercial(project: Entity, enabled: boolean) {
    await run(async () => {
      const next = structuredClone(snapshot),
        entity = next.entities.find((e) => e.id === project.id)!;
      const existing = entity.fields.find((f) => f.key === "commercial");
      entity.fields = [
        ...entity.fields.filter((f) => f.key !== "commercial"),
        {
          ...existing,
          id: existing?.id ?? newId("field"),
          entityId: entity.id,
          key: "commercial",
          valueType: "boolean",
          value: enabled,
          privacy: "PRIVATE",
          searchable: false,
        },
      ];
      entity.updatedAt = nowIso();
      saved(await saveSnapshot(next));
    });
  }
  async function addAccount() {
    await run(async () => {
      const account: LedgerAccount = {
        id: editingAccount || newId("account"),
        name: accountName.trim(),
        kind: accountKind,
        asset: ["ASSET", "LIABILITY"].includes(accountKind) ? asset : undefined,
        privacy: "PRIVATE",
        entityRef: linkedEntity || undefined,
        parentId: parentId || undefined,
      };
      if (editingAccount) {
        const next = structuredClone(snapshot);
        next.ledgerAccounts = next.ledgerAccounts?.map((a) =>
          a.id === editingAccount ? account : a,
        );
        await persist(next);
      } else {
        const next = structuredClone(snapshot);
        next.ledgerAccounts = [...(next.ledgerAccounts ?? []), account];
        await persist(next);
      }
    });
  }
  async function reverse(t: Transaction) {
    await run(async () => {
      const p = emptyProposal();
      p.financeActions = [
        {
          type: "ledger.reverse",
          transactionId: t.id,
          id: newId("tx"),
          idempotencyKey: newId("reverse"),
          occurredAt: dateToday(),
        },
      ];
      await stage(`冲正 ${t.note ?? t.payee ?? t.id}`, p);
    });
  }
  async function reconcile() {
    await run(async () => {
      const next = structuredClone(snapshot);
      const balance = money(actual, asset);
      const result = reconciliation(
        next,
        accountId,
        accounts.find((a) => a.id === accountId)?.kind === "LIABILITY"
          ? negate(balance)
          : balance,
        date,
        reason,
      );
      if (
        result.transaction &&
        !await confirmDialog({title: "记录对账调整？", description: `差额 ${formatMoney(result.transaction.legs[0].money)}，记为调整？`, confirmLabel: "记为调整"})
      )
        return;
      next.transactions = [
        ...(next.transactions ?? []),
        ...(result.transaction ? [result.transaction] : []),
      ];
      next.financeRecords = [...(next.financeRecords ?? []), result.record];
      await persist(next);
    });
  }
  async function allocate() {
    await run(async () => {
      const next = structuredClone(snapshot);
      const old = next.allocationRules?.find(
        (r) => r.resourceId === resource && !r.effectiveTo,
      );
      if (old) {
        if (effectiveFrom < dateToday())
          throw new Error("新版本不能改写过去的分摊");
        old.effectiveTo = effectiveFrom;
      }
      next.allocationRules = [
        ...(next.allocationRules ?? []),
        {
          id: newId("allocation"),
          resourceId: resource,
          effectiveFrom,
          shares: allocationShares.map((r) => ({
            projectId: r.projectId,
            weight: r.weight / 100,
          })),
        },
      ];
      await persist(next);
    });
  }
  async function saveBudget() {
    await run(async () => {
      const next = structuredClone(snapshot),
        id = `budget:${month}:${asset}:${budgetProject}`;
      next.financeRecords = [
        ...(next.financeRecords?.filter((r) => r.id !== id) ?? []),
        {
          id,
          type: "budget",
          month,
          value: money(budget, asset),
          projectId: budgetProject || undefined,
        },
      ];
      await persist(next);
    });
  }
  async function savePreferences() {
    await run(async () => {
      const next = structuredClone(snapshot);
      next.financeRecords = [
        ...(next.financeRecords?.filter((r) => r.type !== "preferences") ?? []),
        {
          id: settings?.id ?? newId("finance-settings"),
          type: "preferences",
          lotMethod,
          showEntries,
          taxRate: taxRate / 100,
          reserveAccountId: reserveAccountId || undefined,
        },
      ];
      await persist(next);
    });
  }
  export function showTab(value:string){tab=value;week=false;form="";entryId="";}
  async function repeat(t:Transaction) {
    entryId="";date=dateToday();asset=t.legs[0].money.asset;accountId=t.legs[0].accountId;
    if(t.kind==="TRADE"){tab="投资";await tick();investment.repeatTrade(t);return;}
    if(t.kind==="ADJUST"){tab="账户";form="reconcile";actual="";reason=t.note??"";return;}
    kind=t.kind;amount=t.legs[0].money.amount.replace(/^-/,"");counterId=t.legs[1].accountId;
    note=t.note??"";payee=t.payee??"";projectId=t.legs[1].projectId??"";resourceId=t.legs[1].resourceId??"";orderId=t.refs?.orderId??"";
    const charge=t.legs.slice(2).find(l=>accounts.find(a=>a.id===l.accountId)?.kind==="EXPENSE");
    fee=charge?.money.amount??"";feeAccountId=charge?.accountId??"";form="entry";await tick();amountInput.focus();
  }
  function toSubscription(t:Transaction){
    entryId="";subscription(privateEntity("Subscription",t.payee||t.note||accountLabel(t.legs[1].accountId),{fee:money(t.legs[0].money.amount.replace(/^-/,""),t.legs[0].money.asset),billing_period:"monthly"}));
  }
  async function csv() {
    if (!await confirmDialog({title: "导出明文 CSV？", description: "文件未经加密，包含本页流水的金额、账户和备注。", danger: true, confirmLabel: "导出 CSV"}))
      return;
    await run(() =>
      download(`Relakeep-${month}.csv`, ledgerCsv(snapshot, rows)),
    );
  }
  export function showAccount(id: string) {
    tab = "流水"; form = ""; week = false; accountFilter = id; projectFilter = ""; search = ""; scrollTop = 0; entryId = "";
  }
  export function openEntry() {
    form = "entry";
    const last = [...(snapshot.transactions ?? [])]
      .reverse()
      .find((t) => t.kind === kind && !t.reversalOf && t.privacy !== "SECRET");
    if (!funds.some((a) => a.id === accountId))
      accountId = funds.find((a) => a.id === last?.legs[0].accountId)?.id ?? "";
    if (!counters.some((a) => a.id === counterId))
      counterId =
        counters.find((a) => a.id === last?.legs[1].accountId)?.id ?? "";
    feeAccountId = activeAccounts.find((a) => a.name === "手续费")?.id ?? "";
  }
</script>

<section class="ledger-page">
  <header class="ledger-heading">
    <div>
      <h1>账本</h1>
    </div>
    <div class="button-row">
      <label class="month-picker"
        ><span class="sr-only">月份</span><input
          type="month"
          bind:value={month}
          on:change={resetScroll}
        /></label
      ><button class="secondary" on:click={openImport}>导入账单</button><button class="primary" on:click={openEntry}>记一笔</button>
    </div>
  </header>
  <nav class="ledger-tabs" aria-label="账本视图">
    {#each ["流水", "资源成本", "项目", "回顾", "投资", "账户"] as item}<button
        class:active={tab === item}
        on:click={() => {
          tab = item;
          form = "";
        }}>{item}</button
      >{/each}
  </nav>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if tab === "流水"}<QuickEntry {snapshot} {config} {stage} save={quickSave}/>{/if}
  {#if form === "entry"}<form
      class="ledger-form"
      on:submit|preventDefault={e=>submit(e.submitter?.getAttribute("value")==="again")}
    >
      <div class="section-heading">
        <h2>记一笔</h2>
        <button type="button" class="text-button" on:click={() => (form = "")}
          >关闭</button
        >
      </div>
      {#if presets.length}<div class="entry-presets" aria-label="常用组合">{#each presets as p}<button type="button" class="secondary" on:click={()=>{kind=p.kind;asset=p.asset;accountId=p.account.id;counterId=p.counter.id;fee="";orderId="";}}>{p.counter.name} · {p.account.name} · {kindLabel(p.kind)}</button>{/each}</div>{/if}
      <div class="entry-kinds">
        {#each [["SPEND", "支出"], ["INCOME", "收入"], ["TRANSFER", "转账"], ["OPENING", "期初余额"]] as [value, label]}<button
            type="button"
            class:active={kind === value}
            on:click={() => {
              kind = value as Transaction["kind"];
              counterId = "";
              fee = "";
              orderId = "";
            }}>{label}</button
          >{/each}
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
      {#if kind !== "TRANSFER"}<div class="entry-categories" aria-label="分类">
          {#each counters as category}<button
              type="button"
              class:active={counterId === category.id ||
                counterId === category.name}
              on:click={() => (counterId = category.id)}>{category.name}</button
            >{/each}
        </div>{/if}
      <div class="form-grid">
        <label
          >{kind === "INCOME" || kind === "OPENING"
            ? "收款账户"
            : "付款账户"}<input
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
          >{:else}<label
            >分类<input
              aria-label="分类"
              value={counters.find((a) => a.id === counterId)?.name ??
                counterId}
              on:input={(e) => (counterId = e.currentTarget.value)}
              list="entry-categories"
              placeholder={kind === "INCOME"
                ? "其他收入"
                : kind === "OPENING"
                  ? "期初与调整"
                  : "其他支出"}
              maxlength="200"
            /><datalist id="entry-categories"
              >{#each counters as a}<option value={a.name}
                ></option>{/each}</datalist
            ></label
          >{/if}<label
          >日期<input type="date" bind:value={date} required /></label
        ><label>备注<input bind:value={note} maxlength="5000" /></label>
      </div>
      <details class="entry-more">
        <summary>更多</summary>
        <div class="form-grid">
          <label
            >项目<select bind:value={projectId}
              ><option value="">无</option>{#each projects as p}<option
                  value={p.id}>{p.name}</option
                >{/each}</select
            ></label
          ><label
            >资源<select bind:value={resourceId}
              ><option value="">无</option>{#each resources as r}<option
                  value={r.id}>{r.name}</option
                >{/each}</select
            ></label
          >
          {#if kind === "INCOME"}<label
              >订单<select bind:value={orderId}
                ><option value="">无</option>{#each orders as o}<option
                    value={o.id}>{o.name}</option
                  >{/each}</select
              ></label
            ><label
              >平台手续费<input bind:value={fee} inputmode="decimal" /></label
            >{#if fee}<label
                >手续费分类<select bind:value={feeAccountId} required
                  ><option value="">选择</option
                  >{#each activeAccounts.filter((a) => a.kind === "EXPENSE") as a}<option
                      value={a.id}>{a.name}</option
                    >{/each}</select
                ></label
              >{/if}{/if}
          <label>对方<input bind:value={payee} maxlength="500" /></label>
        </div>
      </details>
      <button class="primary" disabled={busy}
        >{busy ? "保存中…" : "保存"}</button>
      <button type="submit" value="again" class="secondary" disabled={busy}>保存并再记一笔</button>
    </form>{/if}
  {#if form === "account"}<form
      class="ledger-form"
      on:submit|preventDefault={addAccount}
    >
      <div class="section-heading">
        <h2>{editingAccount ? "编辑账户" : "添加账户"}</h2>
        <button type="button" class="text-button" on:click={() => (form = "")}
          >关闭</button
        >
      </div>
      <div class="form-grid">
        <label>名称<input bind:value={accountName} required /></label><label
          >类型<select bind:value={accountKind} disabled={!!editingAccount}
            >{#each Object.entries(accountKinds) as [value, label]}<option
                {value}>{label}</option
              >{/each}</select
          ></label
        >{#if ["ASSET", "LIABILITY"].includes(accountKind)}<label
            >币种<select bind:value={asset} disabled={!!editingAccount}
              >{#each ASSETS as a}<option value={a.code}>{a.code}</option
                >{/each}</select
            ></label
          >{/if}<label
          >关联资产<select bind:value={linkedEntity}
            ><option value="">无</option
            >{#each snapshot.entities.filter((e) => e.privacy !== "SECRET") as e}<option
                value={e.id}>{e.name}</option
              >{/each}</select
          ></label
        ><label
          >上级分类<select bind:value={parentId}
            ><option value="">无</option
            >{#each activeAccounts.filter((a) => a.id !== editingAccount) as a}<option
                value={a.id}>{a.name}</option
              >{/each}</select
          ></label
        >
      </div>
      <button class="primary" disabled={busy}>保存</button>
    </form>{/if}
  {#if form === "reconcile"}<form
      class="ledger-form"
      on:submit|preventDefault={reconcile}
    >
      <h2>对账 · {accountLabel(accountId)}</h2>
      <div class="form-grid">
        <label
          >{accounts.find((a) => a.id === accountId)?.kind === "LIABILITY"
            ? "实际欠款"
            : "实际余额"} · {asset}<input
            bind:value={actual}
            required
            inputmode="decimal"
          /></label
        ><label>截至日期<input type="date" bind:value={date} required /></label
        ><label>差额原因<input bind:value={reason} /></label>
      </div>
      <button class="primary" disabled={busy}>核对并保存</button><button
        type="button"
        class="text-button"
        on:click={() => (form = "")}>取消</button
      >
    </form>{/if}

  {#if tab === "流水"}
    <div class="ledger-totals">
      <div><span>本月支出</span><strong>{list(report.expense)}</strong></div>
      <div><span>本月收入</span><strong>{list(report.income)}</strong></div>
      <div><span>固定月成本</span><strong>{list(costs.totals)}</strong></div>
    </div>

    <div class="ledger-filters">
      <input
        type="search"
        aria-label="搜索流水"
        bind:value={search}
        placeholder="搜索流水"
        on:input={resetScroll}
      /><select
        bind:value={accountFilter}
        aria-label="账户筛选"
        on:change={resetScroll}
        ><option value="">全部账户</option>{#each accounts as a}<option
            value={a.id}>{a.name}</option
          >{/each}</select
      ><select
        bind:value={projectFilter}
        aria-label="项目筛选"
        on:change={resetScroll}
        ><option value="">全部项目</option>{#each projects as p}<option
            value={p.id}>{p.name}</option
          >{/each}</select
      ><button class="text-button" on:click={csv}>导出 CSV</button>
    </div>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable region needs keyboard focus.) -->
    <div
      class="ledger-scroll" bind:this={scrollList}
      on:scroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
      role="region"
      aria-label="流水列表"
      tabindex="0"
    >
      <div style:height={groups.height+"px"} style:position="relative">
        {#each visible as line (line.type==="day"?"day:"+line.day:line.tx.id)}
          {#if line.type==="day"}<div class="day-header" style:top={line.top+"px"}><strong>{line.day}</strong><span class="expense">支 {list(line.expense)}</span><span class="income">收 {list(line.income)}</span></div>
          {:else}{@const t=line.tx}{@const inflow=units(t.legs[0].money)>0n}
            <button class="transaction-row" style:top={line.top+"px"} on:click={()=>entryId=t.id}>
              <span class="transaction-title"><strong>{t.note||t.payee||kindLabel(t.kind)}</strong><small>{t.reversalOf?"冲正 · ":""}{kindLabel(t.kind)} · {accountLabel(t.legs[0].accountId)}{#if snapshot.financeRecords?.some(r=>r.type==="reconciliation"&&r.accountId===t.legs[0].accountId&&r.date>=t.occurredAt&&r.createdAt<t.createdAt)} · 回溯{/if}</small></span>
              <span class="category">{accountLabel(t.legs[1].accountId)}</span>
              <strong class="numeric" class:income={t.kind==="INCOME"} class:expense={t.kind==="SPEND"} class:transfer={t.kind==="TRANSFER"}>{t.kind==="TRANSFER"?"↔ ":inflow?"+":"−"}{transactionAmount(t)}</strong>
            </button>
          {/if}
        {/each}
      </div>
      {#if !rows.length}<div class="empty-state">这个月还没有流水</div>{/if}
    </div>
    {#if entryId}{@const entry=rows.find(t=>t.id===entryId)}{#if entry}<TransactionDrawer {entry} {accountLabel} {kindLabel} amount={transactionAmount(entry)} {showEntries} reversed={reversed.has(entry.id)} {busy} close={()=>entryId=""} repeat={()=>repeat(entry)} subscribe={()=>toSubscription(entry)} reverse={()=>reverse(entry)}/>{/if}{/if}
  {:else if tab === "资源成本"}
    <div class="section-heading">
      <h2>{list(costs.totals)}<small> / 月</small></h2>
      <button class="secondary" on:click={() => edit()}>添加资源</button>
    </div>
    {#each costs.rows as row}<button
        class="cost-row"
        on:click={() => edit(row.entity)}
        ><span
          ><strong>{row.entity.name}</strong><small
            >{row.usage
              ? "按量"
              : String(field(row.entity, "billing_period") ?? "monthly") ===
                  "yearly"
                ? "年付"
                : "周期费用"}</small
          ></span
        ><span class="numeric"
          >{formatMoney(row.usage ? row.fee : row.monthly)}{row.usage
            ? ""
            : " / 月"}</span
        ></button
      >{/each}
    <h3>固定月成本归属</h3>
    {#each projects as project}{@const allocated = total(
        costs.rows
          .filter((r) => !r.usage)
          .flatMap((r) =>
            r.allocation.shares
              .filter((a) => a.projectId === project.id)
              .map((a) => a.amount),
          ),
      )}{#if allocated.length}<div class="report-row">
          <span>{project.name}</span><strong>{list(allocated)}</strong>
        </div>{/if}{/each}
    <div class="report-row">
      <span>闲置容量</span><strong>{list(costs.idle)}</strong>
    </div>
    {#if legacy.length}<h3>旧费用待整理</h3>
      {#each legacy as item}<div class="report-row">
          <span
            >{snapshot.entities.find((e) => e.id === item.entityId)?.name} · {item.text}</span
          ><button
            class="secondary"
            disabled={busy}
            on:click={() => run(() => stage(item.text, item.proposal))}
            >预览转换</button
          >
        </div>{/each}{/if}
    <h3>预期扣费</h3>
    {#each expected as row}<div class="report-row">
        <span>{row.due} · {row.entity.name}</span><strong
          >{formatMoney(row.expected)}</strong
        ><span
          >{row.actual
            ? row.difference && units(row.difference) !== 0n
              ? `差额 ${formatMoney(row.difference)}`
              : "已匹配"
            : "待扣费"}</span
        >
      </div>{:else}<p class="muted">本月没有扣费提醒</p>{/each}
  {:else if tab === "项目"}
    <div class="section-heading">
      <h2>项目损益</h2>
      <div class="button-row">
        <button
          class="secondary"
          on:click={() => (form = form === "business" ? "" : "business")}
          >经营项目</button
        >
        <button
          class="secondary"
          on:click={() => {
            form = "allocation";
            effectiveFrom = dateToday();
          }}>分摊成本</button
        ><button class="secondary" on:click={() => edit()}>客户 / 订单</button>
      </div>
    </div>
    {#if form === "business"}<div class="ledger-form" aria-label="经营项目">
        {#each projects as project}<label class="business-project"
            ><input
              type="checkbox"
              checked={isCommercialProject(project)}
              disabled={busy}
              on:change={(e) => setCommercial(project, e.currentTarget.checked)}
            />{project.name}</label
          >{:else}<p class="muted">还没有项目</p>{/each}
      </div>{/if}
    {#if form === "allocation"}<form
        class="ledger-form"
        on:submit|preventDefault={allocate}
      >
        <div class="form-grid">
          <label
            >资源<select bind:value={resource} required
              ><option value="">选择</option>{#each resources as r}<option
                  value={r.id}>{r.name}</option
                >{/each}</select
            ></label
          ><label
            >生效日期<input
              type="date"
              bind:value={effectiveFrom}
              required
            /></label
          >
        </div>
        {#each allocationShares as share, i}<div class="ledger-filters">
            <select aria-label="分摊项目" bind:value={share.projectId} required
              ><option value="">选择项目</option>{#each projects as p}<option
                  value={p.id}>{p.name}</option
                >{/each}</select
            ><label
              >占比 %<input
                type="number"
                bind:value={share.weight}
                min="0"
                max="100"
                step="0.0001"
                required
              /></label
            ><button
              type="button"
              class="text-button"
              on:click={() =>
                (allocationShares = allocationShares.filter((_, j) => j !== i))}
              >移除</button
            >
          </div>{/each}<button
          type="button"
          class="secondary"
          on:click={() =>
            (allocationShares = [
              ...allocationShares,
              { projectId: "", weight: 0 },
            ])}>＋ 项目</button
        ><button class="primary" disabled={busy}>保存分摊</button>
      </form>{/if}
    {#each commercialReports as p}<article class="project-report">
        <header>
          <button
            class="text-button"
            on:click={() => edit(snapshot.entities.find((e) => e.id === p.id))}
            >{p.name}</button
          ><strong>{list(p.profit)}</strong>
        </header>
        <div class="ledger-totals">
          <div><span>收入</span>{list(p.income)}</div>
          <div><span>直接成本</span>{list(p.direct)}</div>
          <div><span>分摊成本</span>{list(p.allocated)}</div>
          <div><span>停用后可省 / 月</span>{list(p.avoidable)}</div>
        </div>
        {#if p.ruleIds.length}<details>
            <summary>所用分摊</summary>{#each p.ruleIds as id}{@const rule =
                snapshot.allocationRules?.find((r) => r.id === id)}
              <p>
                {snapshot.entities.find((e) => e.id === rule?.resourceId)?.name} ·
                {rule?.effectiveFrom} 起
              </p>{/each}
          </details>{/if}
      </article>{:else}<p class="muted">选择经营项目后查看损益。</p>{/each}
    {#if commercialReports.length && report.idle.length}<div class="report-row">
        <span>闲置容量</span><strong>{list(report.idle)}</strong>
      </div>{/if}
    {#if orders.length}<h3>订单与应收</h3>
      {#each orders as order}{@const r = orderReport(snapshot, order)}
        <div class="report-row">
          <button class="text-button" on:click={() => edit(order)}
            >{order.name}</button
          ><span
            >{r
              ? `报价 ${formatMoney(r.quote)} · 已收 ${formatMoney(r.paid)}`
              : "报价待填写"}</span
          ><strong>{r ? `应收 ${formatMoney(r.due)}` : "—"}</strong><button
            class="secondary"
            on:click={() => {
              kind = "INCOME";
              orderId = order.id;
              asset = r?.quote.asset ?? "CNY";
              amount = r?.due.amount ?? "";
              projectId = String(field(order, "project") ?? "");
              openEntry();
            }}>收款</button
          >
        </div>{/each}{/if}
  {:else if tab === "回顾"}
    <form
      class="sentence-entry"
      on:submit|preventDefault={() =>
        run(async () => {
          interpreted = await parseFinanceQuery(config, question, snapshot);
        })}
    >
      <input
        bind:value={question}
        placeholder="这个月某个项目赚了多少"
        aria-label="查询账本"
        required
      /><button class="secondary" disabled={busy}>查询</button>
    </form>
    {#if answer && interpreted}<div class="ledger-form">
        <div class="section-heading">
          <span>{interpreted.from} — {interpreted.to}</span><button
            class="text-button"
            on:click={() => (interpreted = undefined)}>收起</button
          >
        </div>
        <div class="ledger-totals">
          {#if ["income", "all"].includes(interpreted.metric)}<div>
              <span>收入</span><strong>{list(answer.income)}</strong>
            </div>{/if}{#if ["expense", "all"].includes(interpreted.metric)}<div
            >
              <span>支出</span><strong>{list(answer.expense)}</strong>
            </div>{/if}{#if ["profit", "all"].includes(interpreted.metric)}<div>
              <span>净收支</span><strong>{list(answer.profit)}</strong>
            </div>{/if}
        </div>
        {#each answer.groups as group}<div class="report-row">
            <span>{group.label}</span><strong
              >{interpreted.metric === "all"
                ? "收入 " +
                  list(group.income) +
                  " · 支出 " +
                  list(group.expense)
                : list(group[interpreted.metric])}</strong
            >
          </div>{/each}
      </div>{/if}
    <div class="section-heading">
      <h2>{week ? "最近七天" : month}</h2>
      <div class="button-row">
        <button class="secondary" on:click={() => (week = !week)}
          >{week ? "按月" : "最近七天"}</button
        ><button class="secondary" on:click={() => (form = "budget")}
          >设置预算</button
        >
      </div>
    </div>
    <div class="ledger-totals">
      <div><span>收入</span><strong>{list(report.income)}</strong></div>
      <div><span>支出</span><strong>{list(report.expense)}</strong></div>
      <div>
        <span>净收支</span><strong
          >{list(
            total([...report.income, ...report.expense.map(negate)]),
          )}</strong
        >
      </div>
    </div>
    {#if month}<ReviewCharts {snapshot} {month}/>{/if}
    {#if form === "budget"}<form
        class="ledger-form"
        on:submit|preventDefault={saveBudget}
      >
        <div class="form-grid">
          <label
            >预算<input
              bind:value={budget}
              required
              inputmode="decimal"
            /></label
          ><label
            >币种<select bind:value={asset}
              >{#each ASSETS as a}<option value={a.code}>{a.code}</option
                >{/each}</select
            ></label
          ><label
            >项目<select bind:value={budgetProject}
              ><option value="">全部</option>{#each projects as p}<option
                  value={p.id}>{p.name}</option
                >{/each}</select
            ></label
          >
        </div>
        <button class="primary" disabled={busy}>保存</button>
      </form>{/if}
    {#each snapshot.financeRecords?.filter((r) => r.type === "budget" && r.month === month) ?? [] as b}{#if b.type === "budget"}{@const p =
          monthReport.projects.find((p) => p.id === b.projectId)}{@const spent =
          total(
            b.projectId
              ? [...(p?.direct ?? []), ...(p?.allocated ?? [])]
              : monthReport.expense,
          ).find((m) => m.asset === b.value.asset) ?? money("0", b.value.asset)}
        {@const percent=budgetPercent(spent,b.value)}
        <div class="budget-row" class:over={units(spent)>units(b.value)} class:warn={percent>=80 && percent<=100}>
          <div><strong>{projects.find(p=>p.id===b.projectId)?.name??"全部"}预算</strong><span>{formatMoney(spent)} / {formatMoney(b.value)}</span></div>
          <div class="budget-track"><i style:width={Math.min(100,Math.max(0,percent))+"%"}></i></div>
          <div><b>{Number.isFinite(percent)?percent+"%":"超出零预算"}</b><small>{units(spent)>units(b.value)?"超出":"剩余"} {formatMoney(units(spent)>units(b.value)?subtract(spent,b.value):subtract(b.value,spent))}</small></div>
        </div>{/if}{/each}
    <MoneyGraph
      {snapshot}
      {month}
      mode="flow"
      onOpen={(id) => edit(snapshot.entities.find((e) => e.id === id))}
    />
    <h3>续费与差额</h3>
    {#each expected as row}<div class="report-row">
        <span>{row.due} · {row.entity.name}</span><span
          >{row.actual
            ? `实际 ${formatMoney(row.actual)}`
            : `预计 ${formatMoney(row.expected)}`}</span
        >{#if row.difference && units(row.difference) !== 0n}<strong
            >差额 {formatMoney(row.difference)}</strong
          >{/if}
      </div>{/each}
  {:else if tab === "投资"}<InvestmentPanel bind:this={investment}
      {snapshot}
      {stage}
      saved={async (next) => {
        await persist(next);
      }}
    />
  {:else if tab === "账户"}
    <div class="section-heading">
      <h2>账户</h2>
      <button
        class="secondary"
        on:click={() => {
          form = "account";
          editingAccount = "";
          accountName = "";
          parentId = "";
          linkedEntity = "";
        }}>＋ 账户</button
      >
    </div>
    {#each accounts as a}<div class="account-row">
        <button
          class="text-button"
          on:click={() => {
            form = "account";
            editingAccount = a.id;
            accountName = a.name;
            accountKind = a.kind;
            asset = a.asset ?? "CNY";
            linkedEntity = a.entityRef ?? "";
            parentId = a.parentId ?? "";
          }}
          ><strong>{a.name}</strong><small
            >{accountKinds[a.kind]}{a.archived ? " · 已归档" : ""}</small
          ></button
        ><strong
          >{list(
            (balances.get(a.id) ?? []).map((m) =>
              a.kind === "LIABILITY" ? negate(m) : m,
            ),
          )}</strong
        >
        <div class="button-row">
          {#if a.asset}<button
              class="secondary"
              on:click={() => {
                form = "reconcile";
                accountId = a.id;
                asset = a.asset!;
                actual = "";
                reason = "";
                date = dateToday();
              }}>对账</button
            >{/if}<button
            class="text-button"
            disabled={busy}
            on:click={() =>
              run(async () => {
                const next = structuredClone(snapshot);
                next.ledgerAccounts = next.ledgerAccounts?.map((item) =>
                  item.id === a.id ? { ...item, archived: !a.archived } : item,
                );
                await persist(next);
              })}>{a.archived ? "启用" : "归档"}</button
          >
        </div>
      </div>{/each}
    <form class="ledger-form" on:submit|preventDefault={savePreferences}>
      <h3>账本设置</h3>
      <div class="form-grid">
        <label
          >成本批次<select bind:value={lotMethod}
            ><option value="FIFO">先进先出</option><option value="LIFO"
              >后进先出</option
            ></select
          ></label
        ><label
          >收入预留 %<input
            type="number"
            min="0"
            max="100"
            step="0.01"
            bind:value={taxRate}
          /></label
        ><label
          >预留账户<select bind:value={reserveAccountId}
            ><option value="">不预留</option
            >{#each activeAccounts.filter((a) => a.kind === "ASSET") as a}<option
                value={a.id}>{a.name}</option
              >{/each}</select
          ></label
        ><label class="check"
          ><input type="checkbox" bind:checked={showEntries} />显示分录</label
        >
      </div>
      <button class="primary" disabled={busy}>保存</button>
    </form>
  {/if}
</section>

<style>
  .ledger-page {
    max-width: 1280px;
    margin: auto;
  }
  .ledger-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 1rem 0 2rem;
    gap: 1rem;
  }
  .ledger-heading h1 {
    margin: 0.25rem 0;
    font-size: 2.6rem;
  }
  .entry-kinds {
    display: flex;
    gap: 6px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .entry-kinds button,
  .entry-categories button {
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    border-radius: 6px;
    padding: 8px 14px;
  }
  .entry-kinds button.active,
  .entry-categories button.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }
  .entry-amount {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 6px 0 20px;
  }
  .entry-amount label:first-child {
    flex: 1;
    min-width: 0;
  }
  .entry-amount input {
    font-size: 36px;
    font-variant-numeric: tabular-nums;
    border: 0;
    background: transparent;
    padding: 0;
    max-width: 100%;
    width: 100%;
  }
  .entry-amount select {
    width: 90px;
  }
  .entry-categories {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 22px;
  }
  .entry-more {
    margin: 14px 0 24px;
  }
  .entry-more summary {
    cursor: pointer;
    font-size: 13px;
    color: var(--muted);
    padding: 10px 0;
  }
  .entry-more[open] summary {
    margin-bottom: 12px;
  }
  .entry-presets{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.entry-presets button{font-size:12px}
  .day-header,.transaction-row{position:absolute;left:0;right:0;width:100%;box-sizing:border-box}
  .day-header{height:38px;display:flex;align-items:center;gap:12px;background:var(--surface-raised);border-bottom:1px solid var(--border);padding:0 10px;font-size:12px;font-variant-numeric:tabular-nums}.day-header strong{margin-right:auto}
  .income{color:var(--income)}.expense{color:var(--expense)}.transfer{color:var(--info)}
  .category{background:var(--accent-soft);color:var(--accent);font-size:12px;padding:2px 7px;border-radius:5px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .budget-row{--bar:var(--accent);margin:15px 0;padding:16px;background:var(--surface);border:1px solid var(--border);border-radius:10px;font-variant-numeric:tabular-nums}.budget-row.warn{--bar:var(--warning)}.budget-row.over{--bar:var(--expense)}.budget-row>div{display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap}.budget-track{height:7px;background:var(--surface-raised);margin:10px 0;border-radius:8px;overflow:hidden}.budget-track i{background:var(--bar);height:100%}.budget-row small{background:var(--surface-raised);color:var(--bar);border-radius:5px;padding:0 6px}.budget-row b{color:var(--bar)}

  .ledger-tabs {
    display: flex;
    gap: 1.6rem;
    border-bottom: 1px solid var(--border);
    margin-bottom: 1.5rem;
    overflow: auto;
  }
  .ledger-tabs button {
    background: transparent;
    padding: 1rem 0;
    color: var(--muted);
    white-space: nowrap;
    border-bottom: 2px solid transparent;
  }
  .ledger-tabs .active {
    color: var(--text);
    border-color: var(--text);
  }
  .ledger-totals {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 1.5rem;
    margin: 1.5rem 0 2rem;
  }
  .ledger-totals div {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .ledger-totals span {
    font-size: 0.8rem;
    color: var(--muted);
  }
  .ledger-totals strong {
    font-size: 1.3rem;
    font-variant-numeric: tabular-nums;
    font-weight: 550;
  }
  .ledger-form {
    padding: 1.5rem;
    border: 1px solid var(--border);
    margin: 1rem 0 2rem;
    background: var(--surface);
  }
  .form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 1rem;
    margin-bottom: 1rem;
  }
  .sentence-entry {
    display: flex;
    gap: 0.7rem;
    margin-bottom: 1.5rem;
  }
  .sentence-entry input {
    flex: 1;
  }
  .ledger-filters {
    display: flex;
    gap: 0.7rem;
    align-items: center;
    margin: 1rem 0;
    flex-wrap: wrap;
  }
  .ledger-filters input {
    flex: 1;
    min-width: 150px;
  }
  .ledger-scroll {
    height: 456px;
    overflow: auto;
    border-block: 1px solid var(--border);
  }
  .transaction-row {
    height: 64px;
    display: grid;
    text-align:left;background:var(--surface);padding:0 10px;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 1rem;
    align-items: center;
    border-bottom: 1px solid var(--border);
  }
  .transaction-row:hover { background:var(--surface-raised); }
  .transaction-title {
    min-width: 0;
    text-align: left;
    background: transparent;
    padding: 0;
  }
  .transaction-title strong {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 550;
  }
  small {
    font-size: 0.75rem;
    color: var(--muted);
    display: block;
  }
  .numeric {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .report-row,
  .cost-row,
  .account-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1.1rem 0;
    border-bottom: 1px solid var(--border);
    width: 100%;
    text-align: left;
    background: transparent;
  }
  .project-report {
    border-bottom: 1px solid var(--border);
    padding: 1rem 0;
  }
  .project-report header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .business-project {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.4rem 0;
  }
  .business-project input {
    width: auto;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
  }
  @media (max-width: 650px) {
    .ledger-heading {
      align-items: flex-start;
    }
    .ledger-heading .button-row {
      flex-direction: column;
    }
    .ledger-totals {
      gap: 1rem;
    }
    .ledger-totals strong {
      font-size: 1.05rem;
    }
    .transaction-row {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 0.5rem;
    }
    .transaction-row > .category {
      display: none;
    }
    .report-row,
    .account-row {
      flex-wrap: wrap;
    }
    .ledger-tabs {
      gap: 1.2rem;
    }
    .ledger-form {
      padding: 1rem;
    }
    .ledger-heading h1 {
      font-size: 2rem;
    }
  }
</style>
