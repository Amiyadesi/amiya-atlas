<script lang="ts">
  import type { VaultSnapshot } from "../../lib/types";
  import { ASSETS, formatMoney, units } from "../../domain/money";
  import { reviewSpending } from "../../domain/ledger-view";
  export let snapshot: VaultSnapshot, month: string;
  let asset = "CNY",
    active = -1;
  $: data = reviewSpending(snapshot, month, asset);
  $: readout = data.days[active];
</script>

<section class="charts">
  <header>
    <h3>月度支出</h3>
    <label
      >{month}
      <select aria-label="图表币种" bind:value={asset}
        >{#each ASSETS as a}<option>{a.code}</option>{/each}</select
      ></label
    >
  </header>
  <h4>每日支出趋势</h4>
  <div class="readout">
    {readout
      ? readout.date + " · " + formatMoney(readout.value)
      : "移至柱条或用方向键查看金额"}
  </div>
  <div class="bars" role="group" aria-label="每日支出趋势柱状图">
    {#each data.days as d, i}<button
        aria-label={d.date + " " + formatMoney(d.value)}
        title={d.date + " · " + formatMoney(d.value)}
        class:active={active === i}
        on:pointerenter={() => (active = i)}
        on:focus={() => (active = i)}
        on:click={() => (active = i)}
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
        <span class:negative={units(d.value) < 0n} style:height={d.height + "%"}
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
      <div class="track"><i style:width={c.percent + "%"}></i></div>
      <b>{c.percent}%</b><strong>{formatMoney(c.value)}</strong>
    </div>{:else}<p class="muted">本月暂无此币种的支出。</p>{/each}
</section>

<style>
  .charts {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px 22px;
    margin: 18px 0;
    background: var(--surface);
  }
  header,
  .axis,
  .rank {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  header label {
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
  }
  .bars button.active {
    background: var(--accent-soft);
  }
  .bars span {
    background: var(--accent);
    min-height: 1px;
    width: 100%;
    border-radius: 3px 3px 0 0;
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
    height: 100%;
    background: var(--accent);
  }
</style>
