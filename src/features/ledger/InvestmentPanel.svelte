<script lang="ts">
  import { confirmDialog } from "../../lib/dialog";
  import { onMount } from "svelte";
  import type { VaultSnapshot } from "../../lib/types";
  import { newId } from "../../lib/types";
  import {
    dateToday,
    type Transaction,
    type TradePlan,
    type FinanceRecord,
  } from "../../domain/ledger";
  import {
    ASSETS,
    money,
    formatMoney,
    fromUnits,
    units,
    scale,
    precision,
    total,
    subtract,
    type Money,
  } from "../../domain/money";
  import {
    tradeTransaction,
    positions,
    rewardRisk,
    checkStops,
    stopPlan,
  } from "../../domain/positions";
  import { accountBalances } from "../../domain/ledger";
  import { emptyProposal } from "../../domain/finance-capture";
  import type { Proposal } from "../../domain/proposal";
  import {
    convertAtMarket,
    fetchMarketRates,
    marketPrice,
    type MarketRates,
  } from "../../lib/market";
  export let snapshot: VaultSnapshot;
  export let stage: (raw: string, proposal: Proposal) => Promise<void>;
  export let saved: (next: VaultSnapshot) => Promise<void>;
  let form = "",
    side: "BUY" | "SELL" = "BUY",
    asset = "BTC",
    quote = "USD",
    quantity = "",
    gross = "",
    fee = "0",
    holdingId = "",
    cashId = "",
    clearingId = "",
    feeAccountId = "",
    date = dateToday(),
    error = "",
    busy = false;
  let value = "",
    priceType: "price" | "rate" = "price",
    entry = "",
    target = "",
    stop = "",
    cooldownDays = 3,
    review = "",
    editingPlan = "",
    planStatus: TradePlan["status"] = "PLANNED",
    netCurrency = "USD";
  let market: MarketRates | undefined,
    marketError = "",
    loadingMarket = false;
  onMount(() => {
    void refreshMarket();
    const timer = setInterval(() => {
      if (!document.hidden) void refreshMarket();
    }, 60_000);
    return () => clearInterval(timer);
  });
  async function refreshMarket() {
    if (loadingMarket) return;
    loadingMarket = true;
    marketError = "";
    try {
      market = await fetchMarketRates();
    } catch (e) {
      marketError = e instanceof Error ? e.message : String(e);
    } finally {
      loadingMarket = false;
    }
  }
  $: selectedPrice =
    market?.rates[asset] && market.rates[quote]
      ? marketPrice(asset, quote, market)
      : "";
  $: accounts = (snapshot.ledgerAccounts ?? []).filter(
    (a) => !a.archived && a.privacy !== "SECRET",
  );
  $: plans = (snapshot.financeRecords ?? []).filter(
    (r): r is TradePlan => r.type === "plan",
  );
  $: positionResult = readPositions(snapshot, market);
  $: balances = accountBalances(snapshot);
  $: net = total(
    (snapshot.ledgerAccounts ?? [])
      .filter((a) => ["ASSET", "LIABILITY"].includes(a.kind))
      .flatMap((a) => balances.get(a.id) ?? []),
  );
  $: converted = net.map((m) => {
    if (m.asset === netCurrency) return { money: m, date: "" };
    if (market?.rates[m.asset] && market.rates[netCurrency])
      return {
        money: convertAtMarket(m, netCurrency, market),
        date: new Date(market.fetchedAt).toLocaleString(),
      };
    const rate = snapshot.financeRecords
      ?.filter(
        (r) =>
          r.type === "rate" &&
          r.asset === m.asset &&
          r.value.asset === netCurrency &&
          r.date <= dateToday(),
      )
      .sort((a, b) =>
        ("date" in b ? b.date : "").localeCompare("date" in a ? a.date : ""),
      )[0];
    return rate?.type === "rate"
      ? {
          money: scale(rate.value, units(m), 10n ** BigInt(precision(m.asset))),
          date: rate.date,
        }
      : undefined;
  });
  $: netTotal = converted.every(Boolean)
    ? total(converted.flatMap((r) => (r ? [r.money] : [])))
    : [];
  function readPositions(s: VaultSnapshot, prices: MarketRates | undefined) {
    try {
      return {
        values: positions(s).map((p) => {
          if (!prices?.rates[p.asset] || !prices.rates[p.quote]) return p;
          const value = convertAtMarket(p.quantityMoney, p.quote, prices);
          return {
            ...p,
            value,
            unrealized: subtract(value, p.costMoney),
            priceDate: new Date(prices.fetchedAt).toLocaleString(),
          };
        }),
        error: "",
      };
    } catch (e) {
      return { values: [], error: String(e) };
    }
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
  export function repeatTrade(t:Transaction) {
    const [holding,clearing,cash]=t.legs;
    side=units(holding.money)>0n?"BUY":"SELL";
    asset=holding.money.asset;quote=cash.money.asset;quantity=holding.money.amount.replace(/^-/,"");gross=cash.money.amount.replace(/^-/,"");
    holdingId=holding.accountId;clearingId=clearing.accountId;cashId=cash.accountId;
    fee=t.legs[5]?.money.amount??"0";feeAccountId=t.legs[5]?.accountId??"";date=dateToday();form="trade";
  }
  async function trade() {
    await run(async () => {
      const t = tradeTransaction(snapshot, {
        side,
        quantity: money(quantity, asset),
        gross: money(gross, quote),
        fee: money(fee || "0", quote),
        holdingId,
        cashId,
        clearingId,
        feeAccountId,
        date,
      });
      if (
        side === "BUY" &&
        plans.some(
          (p) => p.asset === asset && p.cooldownUntil && date < p.cooldownUntil,
        ) &&
        !await confirmDialog({title: "记录已发生的买入？", description: "这项资产仍在冷静期。", confirmLabel: "继续记录"})
      )
        return;
      const p = emptyProposal();
      const raw = `${date} ${side === "BUY" ? "买入" : "卖出"} ${quantity} ${asset}，成交 ${gross} ${quote}，手续费 ${fee || "0"} ${quote}`;
      p.financeActions = [
        { type: "ledger.add", transaction: t, evidence: raw },
      ];
      await stage(raw, p);
      form = "";
    });
  }
  async function savePrice() {
    await run(async () => {
      const next = structuredClone(snapshot),
        id = `${priceType}:${asset}:${quote}:${date}`;
      next.financeRecords = [
        ...(next.financeRecords?.filter((r) => r.id !== id) ?? []),
        { id, type: priceType, asset, value: money(value, quote), date },
      ];
      await saved(checkStops(next, dateToday()));
      form = "";
    });
  }
  async function savePlan() {
    await run(async () => {
      const prior = plans.find((p) => p.id === editingPlan);
      let plan: TradePlan = {
        id: editingPlan || newId("plan"),
        type: "plan",
        asset,
        quantity: money(quantity, asset),
        entry: money(entry, quote),
        target: money(target, quote),
        stop: money(stop, quote),
        status: planStatus,
        cooldownDays,
        review,
        date,
        cooldownUntil: prior?.cooldownUntil,
        reviewDue: review.trim() ? undefined : prior?.reviewDue,
      };
      if (plan.status === "STOPPED" && prior?.status !== "STOPPED")
        plan = stopPlan(plan, dateToday());
      const next = structuredClone(snapshot);
      next.financeRecords = [
        ...(next.financeRecords?.filter((r) => r.id !== plan.id) ?? []),
        plan,
      ];
      await saved(checkStops(next, dateToday()));
      form = "";
    });
  }
  function openPlan(p?: TradePlan) {
    form = "plan";
    editingPlan = p?.id ?? "";
    asset = p?.asset ?? "BTC";
    quote = p?.entry.asset ?? "USD";
    quantity = p?.quantity.amount ?? "";
    entry = p?.entry.amount ?? "";
    target = p?.target.amount ?? "";
    stop = p?.stop.amount ?? "";
    cooldownDays = p?.cooldownDays ?? 3;
    review = p?.review ?? "";
    date = p?.date ?? dateToday();
    planStatus = p?.status ?? "PLANNED";
  }
</script>

<div class="section-heading">
  <h2>持仓</h2>
  <div class="button-row">
    <button class="primary" on:click={() => (form = "trade")}>记录交易</button
    ><button class="secondary" disabled={loadingMarket} on:click={refreshMarket}
      >{loadingMarket ? "更新中…" : "刷新行情"}</button
    ><button class="secondary" on:click={() => openPlan()}>交易计划</button>
  </div>
</div>
{#if form !== "trade" && form !== "plan"}<div class="market-quote">
    <label
      ><span class="sr-only">资产</span><select
        aria-label="行情资产"
        bind:value={asset}
        >{#each ASSETS as a}<option value={a.code}>{a.code}</option
          >{/each}</select
      ></label
    >
    <span>/</span><label
      ><span class="sr-only">计价币种</span><select
        aria-label="行情计价币种"
        bind:value={quote}
        >{#each ASSETS.filter((a) => a.code !== asset) as a}<option
            value={a.code}>{a.code}</option
          >{/each}</select
      ></label
    >
    <strong
      >{selectedPrice
        ? Number(selectedPrice).toLocaleString(undefined, {
            maximumFractionDigits: Number(selectedPrice) >= 1 ? 2 : 8,
          })
        : loadingMarket
          ? "加载中…"
          : "暂无行情"}</strong
    >
    {#if market}<small
        >{market.source} · {new Date(
          market.fetchedAt,
        ).toLocaleTimeString()}</small
      >{/if}
    <button
      class="text-button"
      on:click={() => {
        form = "price";
        priceType = "price";
      }}>手动录入</button
    >
  </div>{/if}
{#if marketError}<p class="error" role="alert">
    {marketError}<button class="text-button" on:click={refreshMarket}
      >重试</button
    >
  </p>{/if}
{#if error}<p class="error" role="alert">{error}</p>{/if}
{#if positionResult.error}<p class="error">{positionResult.error}</p>{/if}
{#if form === "trade"}<form on:submit|preventDefault={trade}>
    <div class="grid">
      <label
        >买卖<select bind:value={side}
          ><option value="BUY">买入</option><option value="SELL">卖出</option
          ></select
        ></label
      ><label
        >资产<select bind:value={asset}
          >{#each ASSETS as a}<option value={a.code}>{a.code}</option
            >{/each}</select
        ></label
      ><label
        >数量<input bind:value={quantity} required inputmode="decimal" /></label
      ><label
        >成交币种<select bind:value={quote}
          >{#each ASSETS.filter((a) => a.code !== asset) as a}<option
              value={a.code}>{a.code}</option
            >{/each}</select
        ></label
      ><label
        >成交总额<input
          bind:value={gross}
          required
          inputmode="decimal"
        /></label
      ><label
        >手续费<input bind:value={fee} required inputmode="decimal" /></label
      ><label
        >持仓账户<select bind:value={holdingId} required
          ><option value="">选择</option
          >{#each accounts.filter((a) => a.kind === "ASSET" && a.asset === asset) as a}<option
              value={a.id}>{a.name}</option
            >{/each}</select
        ></label
      ><label
        >资金账户<select bind:value={cashId} required
          ><option value="">选择</option
          >{#each accounts.filter((a) => a.kind === "ASSET" && a.asset === quote) as a}<option
              value={a.id}>{a.name}</option
            >{/each}</select
        ></label
      ><label
        >清算账户<select bind:value={clearingId} required
          ><option value="">选择</option
          >{#each accounts.filter((a) => a.kind === "EQUITY" && !a.asset) as a}<option
              value={a.id}>{a.name}</option
            >{/each}</select
        ></label
      ><label
        >手续费分类<select bind:value={feeAccountId} required
          ><option value="">选择</option
          >{#each accounts.filter((a) => a.kind === "EXPENSE") as a}<option
              value={a.id}>{a.name}</option
            >{/each}</select
        ></label
      ><label>成交日期<input type="date" bind:value={date} required /></label>
    </div>
    <button class="primary" disabled={busy}>预览交易</button><button
      type="button"
      class="text-button"
      on:click={() => (form = "")}>取消</button
    >
  </form>{/if}
{#if form === "price"}<form on:submit|preventDefault={savePrice}>
    <div class="grid">
      <label
        >记录<select bind:value={priceType}
          ><option value="price">市场价格</option><option value="rate"
            >换算汇率</option
          ></select
        ></label
      ><label
        >1 单位<select bind:value={asset}
          >{#each ASSETS as a}<option value={a.code}>{a.code}</option
            >{/each}</select
        ></label
      ><label>等于<input bind:value required inputmode="decimal" /></label
      ><label
        >计价币种<select bind:value={quote}
          >{#each ASSETS.filter((a) => a.code !== asset) as a}<option
              value={a.code}>{a.code}</option
            >{/each}</select
        ></label
      ><label>截至日期<input type="date" bind:value={date} required /></label>
    </div>
    <button class="primary" disabled={busy}>保存</button><button
      type="button"
      class="text-button"
      on:click={() => (form = "")}>取消</button
    >
  </form>{/if}
{#each positionResult.values as p}<article class="position">
    <header>
      <h3>
        {p.asset}
        <small>{accounts.find((a) => a.id === p.accountId)?.name}</small>
      </h3>
      <strong>{formatMoney(p.quantityMoney)}</strong>
    </header>
    <div class="grid metrics">
      <div><small>持仓成本</small>{formatMoney(p.costMoney)}</div>
      <div class:profit={units(p.realizedMoney)>0n} class:loss={units(p.realizedMoney)<0n}><small>已实现盈亏</small>{formatMoney(p.realizedMoney)}</div>
      <div class:profit={p.unrealized && units(p.unrealized)>0n} class:loss={p.unrealized && units(p.unrealized)<0n}>
        <small>未实现盈亏</small>{p.unrealized
          ? formatMoney(p.unrealized)
          : loadingMarket
            ? "加载行情…"
            : "行情不可用"}
      </div>
      <div>
        <small>市值</small>{p.value ? formatMoney(p.value) : "—"}<small
          >{p.priceDate ?? ""}</small
        >
      </div>
    </div>
    <details>
      <summary>成本批次 · {p.lots.length}</summary>{#each p.lots as lot}<p>
          {lot.date} · {formatMoney(fromUnits(lot.quantity, p.asset))} · 成本 {formatMoney(
            fromUnits(lot.cost, p.quote),
          )}
        </p>{/each}
    </details>
  </article>{:else}<p class="muted">记录第一笔买入后查看持仓。</p>{/each}
<h3>净资产</h3>
<div class="net">
  {#each net as m}<strong>{formatMoney(m)}</strong>{/each}<label
    >折算<select bind:value={netCurrency}
      >{#each ASSETS.filter((a) => a.kind === "FIAT") as a}<option
          value={a.code}>{a.code}</option
        >{/each}</select
    ></label
  >{#if netTotal.length}<strong>{netTotal.map(formatMoney).join(" · ")}</strong
    ><small
      >汇率截至 {converted
        .flatMap((r) => (r?.date ? [r.date] : []))
        .sort()[0] ?? dateToday()}</small
    >{:else if net.length}<button
      class="text-button"
      on:click={() => {
        void refreshMarket();
      }}>更新汇率</button
    >{/if}
</div>
<h3>交易计划</h3>
{#if form === "plan"}<form on:submit|preventDefault={savePlan}>
    <div class="grid">
      <label
        >资产<select bind:value={asset}
          >{#each ASSETS as a}<option value={a.code}>{a.code}</option
            >{/each}</select
        ></label
      ><label
        >数量<input bind:value={quantity} inputmode="decimal" required /></label
      ><label
        >计价<select bind:value={quote}
          >{#each ASSETS.filter((a) => a.code !== asset) as a}<option
              value={a.code}>{a.code}</option
            >{/each}</select
        ></label
      ><label
        >入场价<input bind:value={entry} inputmode="decimal" required /></label
      ><label
        >目标价<input bind:value={target} inputmode="decimal" required /></label
      ><label
        >止损价<input bind:value={stop} inputmode="decimal" required /></label
      ><label
        >冷静期 / 天<input
          type="number"
          bind:value={cooldownDays}
          min="0"
          max="365"
          required
        /></label
      ><label
        >状态<select bind:value={planStatus}
          ><option value="PLANNED">计划中</option><option value="OPEN"
            >持有中</option
          ><option value="CLOSED">已结束</option><option value="STOPPED"
            >已触及止损</option
          ></select
        ></label
      ><label>日期<input type="date" bind:value={date} required /></label>
    </div>
    <label>复盘<textarea bind:value={review} maxlength="5000"></textarea></label
    ><button class="primary" disabled={busy}>保存计划</button><button
      type="button"
      class="text-button"
      on:click={() => (form = "")}>取消</button
    >
  </form>{/if}
{#each plans as p}<article class="position">
    <header>
      <h3>{p.asset}</h3>
      <span
        >{{
          PLANNED: "计划中",
          OPEN: "持有中",
          CLOSED: "已结束",
          STOPPED: "已触及止损",
        }[p.status]}</span
      ><button class="secondary" on:click={() => openPlan(p)}
        >{p.reviewDue ? "去复盘" : "编辑"}</button
      >
    </header>
    <div class="grid metrics">
      <div><small>入场</small>{formatMoney(p.entry)}</div>
      <div><small>目标</small>{formatMoney(p.target)}</div>
      <div><small>止损</small>{formatMoney(p.stop)}</div>
      <div><small>盈亏比</small>{rewardRisk(p)} : 1</div>
    </div>
    {#if p.cooldownUntil}<p>冷静期至 {p.cooldownUntil}</p>{/if}{#if p.review}<p>
        {p.review}
      </p>{/if}
  </article>{/each}

<style>
  .market-quote {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    flex-wrap: wrap;
    margin: 1rem 0;
    padding:12px 16px;background:var(--surface-raised);border-radius:20px;font-variant-numeric:tabular-nums;
  }
  .market-quote label {
    width: auto;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
  }
  form {
    border: 1px solid var(--border);
    padding: 1.5rem;
    margin: 1rem 0;
  }
  form > .primary {
    margin-top: 1rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 1rem;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  header h3 {
    margin: 0;
  }
  .position {
    padding: 1.2rem 1.4rem;
    border:0;border-radius:16px;background:var(--surface);box-shadow:var(--shadow-sm);margin:12px 0;
  }
  small {
    display: block;
    color: var(--muted);
    font-size: 0.75rem;
  }
  .metrics .profit{color:var(--income)}.metrics .loss{color:var(--expense)}.metrics small{margin-bottom:4px}.position header{padding-bottom:8px;border-bottom:1px solid var(--border)}
  .metrics {
    margin: 1rem 0;
    font-variant-numeric: tabular-nums;
  }
  .net {
    display: flex;
    gap: 1.5rem;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 2rem;
  }
  textarea {
    min-height: 100px;
  }
  .section-heading {
    flex-wrap: wrap;
  }
</style>
