<script lang="ts">
  import type { VaultSnapshot } from "../../lib/types";
  import { formatMoney, units } from "../../domain/money";
  import { reviewSpending } from "../../domain/ledger-view";
  export let snapshot: VaultSnapshot, month: string;
  let asset = "CNY",
    hovered = -1,
    pinned = -1;
  $: expenseIds = new Set(
    (snapshot.ledgerAccounts ?? [])
      .filter((a) => a.privacy !== "SECRET" && a.kind === "EXPENSE")
      .map((a) => a.id),
  );
  $: monthAssets = [
    ...new Set(
      (snapshot.transactions ?? [])
        .filter(
          (t) =>
            t.privacy !== "SECRET" &&
            t.occurredAt.startsWith(month) &&
            t.legs.some(
              (l) => expenseIds.has(l.accountId) && units(l.money) !== 0n,
            ),
        )
        .flatMap((t) =>
          t.legs
            .filter((l) => expenseIds.has(l.accountId) && units(l.money) !== 0n)
            .map((l) => l.money.asset),
        ),
    ),
  ];
  $: if (monthAssets.length && !monthAssets.includes(asset)) {
    asset = monthAssets[0];
  }
  $: active = hovered >= 0 ? hovered : pinned;
  $: data = reviewSpending(snapshot, month, asset);
  $: readout = data.days[active];
</script>

<section class="charts">
  <header>
    <h3>月度支出</h3>
    {#if monthAssets.length > 1}
      <label
        >{month}
        <select aria-label="图表币种" bind:value={asset}
          >{#each monthAssets as code}<option>{code}</option>{/each}</select
        ></label
      >
    {:else}
      <span class="period-meta">{month} · {asset}</span>
    {/if}
  </header>
  <h4>每日支出趋势</h4>
  <div class="readout">
    {readout
      ? readout.date + " · " + formatMoney(readout.value)
      : "点选或移至柱条查看当日金额"}
  </div>
  <div
    class="bars"
    role="group"
    aria-label="每日支出趋势柱状图"
    on:pointerleave={() => (hovered = -1)}
  >
    {#each data.days as d, i}<button
        type="button"
        aria-label={d.date + " " + formatMoney(d.value)}
        aria-pressed={pinned === i}
        title={d.date + " · " + formatMoney(d.value)}
        class:active={active === i}
        on:pointerenter={(e) => {
          if (e.pointerType !== "touch") hovered = i;
        }}
        on:focus={() => (pinned = i)}
        on:click={() => {
          pinned = pinned === i ? -1 : i;
          hovered = -1;
        }}
        on:keydown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const buttons =
              e.currentTarget.parentElement!.querySelectorAll("button");
            buttons[
              (i + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) %
                buttons.length
            ].focus();
          }
        }}
      >
        <span
          class:negative={units(d.value) < 0n}
          style:transform={`scaleY(${Math.max(d.height / 100, units(d.value) === 0n ? 0.01 : 0.03)})`}
        ></span></button
      >{/each}
  </div>
  <div class="axis"><span>1 日</span><span>{data.days.length} 日</span></div>
  {#if units(data.monthOnly) !== 0n}<small
      >仅有月份的流水：{formatMoney(data.monthOnly)}，未分配到具体日期。</small
    >{/if}
  <h4>支出分类占比</h4>
  {#each data.categories as c}<div class="rank">
      <span>{c.name}</span>
      <div class="track">
        <i style:transform={`scaleX(${Math.min(1, Math.max(0, c.percent / 100))})`}></i>
      </div>
      <b>{c.percent}%</b><strong>{formatMoney(c.value)}</strong>
    </div>{:else}<p class="muted">本月暂无此币种的支出。</p>{/each}
</section>

<style>
  .charts {
    border: 0;
    border-radius: 16px;
    padding: 18px 22px;
    margin: 18px 0;
    background: var(--surface);
    box-shadow: var(--shadow-sm);
  }
  header,
  .axis,
  .rank {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  header label,
  .period-meta {
    display: flex;
    align-items: center;
    gap: 9px;
    color: var(--muted);
    font-size: 13px;
  }
  header h3,
  h4 {
    margin: 0;
  }
  h4 {
    margin-top: 17px;
    font-size: 14px;
  }
  .readout,
  .axis,
  small {
    font-size: 12px;
    color: var(--muted);
  }
  .readout {
    text-align: right;
    min-height: 20px;
    font-variant-numeric: tabular-nums;
  }
  .bars {
    height: 108px;
    display: flex;
    border-bottom: 1px solid var(--border);
    gap: 2px;
    background: repeating-linear-gradient(
      to top,
      transparent 0 35px,
      var(--border) 35px 36px
    );
  }
  .bars button {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
    align-items: end;
    padding: 0;
    background: transparent;
    border-radius: 4px 4px 0 0;
  }
  .bars button.active {
    background: var(--accent-soft);
  }
  .bars span {
    background: var(--accent);
    height: 100%;
    width: 100%;
    transform-origin: bottom center;
    border-radius: 3px 3px 0 0;
    transition:
      transform var(--dur-chart, 340ms) var(--ease-out, ease-out),
      background-color var(--dur-micro, 150ms) var(--ease-out, ease-out);
  }
  .bars .negative {
    background: var(--income);
  }
  .rank {
    font-size: 13px;
    margin: 9px 0;
    font-variant-numeric: tabular-nums;
  }
  .rank span {
    min-width: 60px;
  }
  .rank b {
    font-weight: 400;
    color: var(--muted);
    width: 48px;
    text-align: right;
  }
  .track {
    height: 7px;
    flex: 1;
    border-radius: 8px;
    background: var(--surface-raised);
    overflow: hidden;
  }
  .track i {
    display: block;
    width: 100%;
    height: 100%;
    transform-origin: left center;
    background: var(--accent);
    border-radius: 8px;
    transition: transform var(--dur-chart, 340ms) var(--ease-out, ease-out);
  }
</style>
