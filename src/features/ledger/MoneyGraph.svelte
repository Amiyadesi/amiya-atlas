<script lang="ts">
  import type { Entity, VaultSnapshot } from "../../lib/types";
  import {
    isCommercialProject,
    monthlyCosts,
    periodReport,
    queryLedger,
  } from "../../domain/reports";
  import { allocate } from "../../domain/allocation";
  import {
    ASSETS,
    units,
    fromUnits,
    formatMoney,
    total,
    type Money,
  } from "../../domain/money";
  import ExploreCanvas from "../graph/ExploreCanvas.svelte";
  export let snapshot: VaultSnapshot;
  export let month: string;
  export let rootId = "";
  export let mode: "graph" | "flow" = "graph";
  export let onOpen: (id: string) => void;
  export let onConnect: ((entity: Entity) => void) | undefined = undefined;
  export let onFavorite: ((entity: Entity) => void) | undefined = undefined;
  let flowHover = "";
  const flowId = "flow-" + crypto.randomUUID();
  let asset = "CNY",
    selected = rootId;
  $: visible = {
    ...snapshot,
    transactions: queryLedger(snapshot, {
      from: "0000-01-01",
      to: "9999-12-31",
      metric: "all",
      groupBy: "day",
      search: "",
    }),
  };
  $: costs = monthlyCosts(visible, `${month}-01`);
  $: report = periodReport(visible, `${month}-01`, `${month}-31`);
  $: graph = withAllocations(snapshot, costs, asset);
  $: amounts = new Map([
    ...costs.rows
      .filter(
        (r) =>
          !r.usage &&
          r.monthly.asset === asset &&
          !r.entity.fields.some(
            (f) => f.key === "billing_period" && f.privacy === "SECRET",
          ),
      )
      .map((r) => [r.entity.id, r.monthly] as const),
    ...report.projects.map(
      (p) =>
        [
          p.id,
          total([...p.direct, ...p.allocated]).find((m) => m.asset === asset) ??
            fromUnits(0n, asset),
        ] as const,
    ),
  ]);
  const magnitude = (m: Money) => {
    const n = units(m);
    return n < 0n ? -n : n;
  };
  $: max = [...amounts.values()].reduce(
    (max, m) => (magnitude(m) > max ? magnitude(m) : max),
    1n,
  );
  $: decorations = Object.fromEntries(
    [...amounts].map(([id, m]) => [
      id,
      {
        label: formatMoney(m),
        weight: Number((magnitude(m) * 1000n) / max) / 1000,
        idle: costs.rows.find((r) => r.entity.id === id)?.allocation.idle
          .amount,
      },
    ]),
  );
  function color(id: string, label = "") {
    if (id === "p:idle") return "var(--warning)";
    if (id === "p:unassigned") return "var(--muted)";
    if (id.startsWith("e:") && /账单|居住/.test(label)) return "var(--info)";
    return id.startsWith("i:")
      ? "var(--income)"
      : id.startsWith("e:")
        ? "var(--expense)"
        : "var(--accent)";
  }
  $: flows = buildFlows(visible, month, asset);
  $: hoveredNode = flows.nodes.find((n) => n.id === flowHover);
  $: hoveredPath = flows.paths.find((p) => p.key === flowHover);
  $: connected = trace(flows.paths, flowHover);
  function trace(
    paths: { from: string; to: string; key: string }[],
    id: string,
  ) {
    const direct = paths.filter(
      (p) => p.key === id || p.from === id || p.to === id,
    );
    const forward = new Set(direct.map((p) => p.to)),
      backward = new Set(direct.map((p) => p.from));
    return new Set(
      [
        ...direct,
        ...paths.filter((p) => forward.has(p.from) || backward.has(p.to)),
      ].map((p) => p.key),
    );
  }
  $: recent = report.transactions
    .filter(
      (t) =>
        t.privacy !== "SECRET" &&
        t.legs.some(
          (l) => l.projectId === selected || l.resourceId === selected,
        ),
    )
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 8);
  $: project = report.projects.find((p) => p.id === selected);
  function withAllocations(
    snapshot: VaultSnapshot,
    costs: ReturnType<typeof monthlyCosts>,
    asset: string,
  ) {
    const edges = costs.rows.flatMap((row) =>
      row.allocation.shares
        .filter((s) => units(s.amount) !== 0n && s.amount.asset === asset)
        .map((share) => ({
          id: `allocation:${row.allocation.ruleId}:${share.projectId}`,
          sourceId: row.entity.id,
          targetId: share.projectId,
          type: "ALLOCATED_TO",
          note: formatMoney(share.amount),
          privacy: "PRIVATE" as const,
          createdAt: row.entity.createdAt,
        })),
    );
    return { ...snapshot, relations: [...snapshot.relations, ...edges] };
  }
  function buildFlows(s: VaultSnapshot, month: string, asset: string) {
    const accounts = new Map(s.ledgerAccounts?.map((a) => [a.id, a]));
    const names = new Map(
      s.entities
        .filter((e) => e.privacy !== "SECRET")
        .map((e) => [e.id, e.name]),
    );
    const sums = new Map<string, bigint>();
    const labels = new Map<string, string>();
    const put = (from: string, to: string, n: bigint) => {
      const key = `${from}\0${to}`;
      sums.set(key, (sums.get(key) ?? 0n) + n);
    };
    for (const t of s.transactions ?? []) {
      if (!t.occurredAt.startsWith(month) || t.privacy === "SECRET") continue;
      for (const l of t.legs) {
        if (l.money.asset !== asset) continue;
        const a = accounts.get(l.accountId);
        if (!a || a.privacy === "SECRET") continue;
        const accountKey = `${a.kind === "INCOME" ? "i" : "e"}:${a.id}`;
        labels.set(accountKey, a.name);
        const shares = l.projectId
          ? [{ projectId: l.projectId, amount: l.money }]
          : l.resourceId && a.kind === "EXPENSE"
            ? (() => {
                const r = allocate(
                  s,
                  l.resourceId,
                  (t.reversalOf
                    ? s.transactions?.find((old) => old.id === t.reversalOf)
                        ?.occurredAt
                    : undefined) ?? t.occurredAt,
                  l.money,
                );
                return [...r.shares, { projectId: "idle", amount: r.idle }];
              })()
            : [{ projectId: "unassigned", amount: l.money }];
        for (const share of shares) {
          if (
            !["idle", "unassigned"].includes(share.projectId) &&
            !names.has(share.projectId)
          )
            continue;
          const p = `p:${share.projectId}`;
          labels.set(
            p,
            names.get(share.projectId) ??
              (share.projectId === "idle" ? "闲置容量" : "未分配"),
          );
          if (a.kind === "INCOME") put(accountKey, p, -units(share.amount));
          if (a.kind === "EXPENSE") put(p, accountKey, units(share.amount));
        }
      }
    }
    const links = [...sums]
      .filter(([, n]) => n > 0n)
      .map(([key, n]) => {
        const [from, to] = key.split("\0");
        return { from, to, n };
      });
    const ids = [...new Set(links.flatMap((l) => [l.from, l.to]))];
    const nodes = ids.map((id) => ({
      id,
      label: labels.get(id) ?? id,
      x: id.startsWith("i:") ? 60 : id.startsWith("p:") ? 440 : 820,
      y: 0,
      height: 0,
      incoming: 0n,
      outgoing: 0n,
    }));
    let maxTotal = 1n;
    const totals = new Map<string, bigint>();
    for (const node of nodes) {
      const incoming = links
          .filter((l) => l.to === node.id)
          .reduce((n, l) => n + l.n, 0n),
        outgoing = links
          .filter((l) => l.from === node.id)
          .reduce((n, l) => n + l.n, 0n);
      node.incoming = incoming;
      node.outgoing = outgoing;
      totals.set(node.id, incoming > outgoing ? incoming : outgoing);
    }
    for (const x of [60, 440, 820]) {
      const sum = nodes
        .filter((n) => n.x === x)
        .reduce((v, n) => v + (totals.get(n.id) ?? 0n), 0n);
      if (sum > maxTotal) maxTotal = sum;
    }
    const factor = (n: bigint) => Number((n * 30000n) / maxTotal) / 100;
    for (const x of [60, 440, 820]) {
      let y = 40;
      for (const node of nodes.filter((n) => n.x === x)) {
        node.y = y;
        node.height = Math.max(6, factor(totals.get(node.id) ?? 0n));
        y += node.height + 36;
      }
    }
    const offsets = new Map<string, number>();
    const paths = links.flatMap((l) => {
      const a = nodes.find((n) => n.id === l.from),
        b = nodes.find((n) => n.id === l.to);
      if (!a || !b) return [];
      const h = Math.max(1, factor(l.n)),
        ay = a.y + (offsets.get(`${a.id}:out`) ?? 0) + h / 2,
        by = b.y + (offsets.get(`${b.id}:in`) ?? 0) + h / 2;
      offsets.set(`${a.id}:out`, (offsets.get(`${a.id}:out`) ?? 0) + h);
      offsets.set(`${b.id}:in`, (offsets.get(`${b.id}:in`) ?? 0) + h);
      return [
        {
          ...l,
          sourceColor: color(a.id, a.label),
          targetColor: color(b.id, b.label),
          key: l.from + "\\0" + l.to,
          label: a.label + " → " + b.label,
          h,
          d: `M ${a.x + 14} ${ay} C ${a.x + 180} ${ay}, ${b.x - 180} ${by}, ${b.x} ${by}`,
        },
      ];
    });
    return {
      nodes,
      paths,
      height: Math.max(420, ...nodes.map((n) => n.y + n.height + 40)),
    };
  }
</script>

<div class="money-toolbar">
  <label
    >币种<select bind:value={asset}
      >{#each ASSETS as a}<option value={a.code}>{a.code}</option
        >{/each}</select
    ></label
  >{#if mode === "graph"}<label
      >聚焦资产<select bind:value={rootId}
        ><option value="">全部资产</option
        >{#each snapshot.entities.filter((e) => e.privacy !== "SECRET") as e}<option
            value={e.id}>{e.name}</option
          >{/each}</select
      ></label
    >{/if}
</div>
{#if mode === "graph"}
  <ExploreCanvas
    snapshot={graph}
    {rootId}
    moneyData={decorations}
    {onConnect}
    {onFavorite}
    {onOpen}
    onPick={(id) => {
      selected = id;
      rootId = id;
    }}
  />
  {#if selected}<aside class="money-detail">
      <div class="section-heading">
        <h3>{snapshot.entities.find((e) => e.id === selected)?.name}</h3>
        <button class="secondary" on:click={() => onOpen(selected)}
          >编辑资产</button
        >
      </div>
      {#if project}<p>
          {#if snapshot.entities.some((e) => e.id === project.id && isCommercialProject(e))}收入
            {project.income
              .filter((m) => m.asset === asset)
              .map(formatMoney)
              .join(" · ") || "—"} /
          {/if}成本 {total([...project.direct, ...project.allocated])
            .filter((m) => m.asset === asset)
            .map(formatMoney)
            .join(" · ") ||
            "—"}{#if snapshot.entities.some((e) => e.id === project.id && isCommercialProject(e))}
            / 利润 {project.profit
              .filter((m) => m.asset === asset)
              .map(formatMoney)
              .join(" · ") || "—"}{/if}
        </p>{/if}{#each recent as t}<div class="money-row">
          <span>{t.occurredAt} · {t.note || t.payee || t.kind}</span><strong
            >{total(
              t.legs
                .filter((l) => l.money.asset === asset && units(l.money) > 0n)
                .map((l) => l.money),
            )
              .map(formatMoney)
              .join(" · ")}</strong
          >
        </div>{:else}<p class="muted">本月没有关联流水</p>{/each}
    </aside>{/if}
{:else}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable region needs keyboard focus.) -->
  <div
    class="flow"
    role="region"
    aria-label={`${month} ${asset} 钱流图`}
    tabindex="0"
  >
    <svg
      viewBox={`0 0 1040 ${flows.height}`}
      role="group"
      aria-label="收入、项目与成本流向"
    >
      <text class="column" x="60" y="20">收入</text><text
        class="column"
        x="440"
        y="20">项目 / 分配</text
      ><text class="column" x="820" y="20">支出</text>
      <defs
        >{#each flows.paths as p, i}<linearGradient
            id={flowId + "-" + i}
            gradientUnits="userSpaceOnUse"
            x1={p.from.startsWith("i:") ? 72 : 452}
            x2={p.from.startsWith("i:") ? 440 : 820}
            ><stop stop-color={p.sourceColor} /><stop
              offset="1"
              stop-color={p.targetColor}
            /></linearGradient
          >{/each}</defs
      >
      {#each flows.paths as p, i}<path
          role="img"
          aria-label={p.label + "：" + formatMoney(fromUnits(p.n, asset))}
          d={p.d}
          fill="none"
          stroke={`url(#${flowId}-${i})`}
          opacity={flowHover ? (connected.has(p.key) ? 0.76 : 0.07) : 0.32}
          stroke-width={p.h}
          on:pointerenter={() => (flowHover = p.key)}
          on:pointerleave={() => (flowHover = "")}
        >
          <title>{p.label}：{formatMoney(fromUnits(p.n, asset))}</title></path
        >{/each}
      {#each flows.nodes as n}
        {@const label =
          n.incoming && n.outgoing
            ? `入 ${formatMoney(fromUnits(n.incoming, asset))} / 出 ${formatMoney(fromUnits(n.outgoing, asset))}`
            : formatMoney(fromUnits(n.incoming || n.outgoing, asset))}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard focus reveals the same paths as pointer hover.) -->
        <g
          role="group"
          tabindex="0"
          aria-label={n.label + "：" + label}
          on:pointerenter={() => (flowHover = n.id)}
          on:pointerleave={() => (flowHover = "")}
          on:focus={() => (flowHover = n.id)}
          on:blur={() => (flowHover = "")}
        >
          <title>{n.label}：{label}</title>
          <rect
            x={n.x}
            y={n.y}
            width="12"
            height={n.height}
            rx="3"
            fill={color(n.id, n.label)}
          />
          <text x={n.x + 19} y={n.y + 11}>{n.label}</text>
          <text class="flow-amount" x={n.x + 19} y={n.y + 27}>{label}</text>
        </g>
      {/each}
    </svg>
  </div>
  {#if flows.nodes.length}<p class="flow-readout" role="status">
      {#if hoveredPath}{hoveredPath.label} · {formatMoney(
          fromUnits(hoveredPath.n, asset),
        )}
      {:else if hoveredNode}{hoveredNode.label} · 流入 {formatMoney(
          fromUnits(hoveredNode.incoming, asset),
        )} / 流出 {formatMoney(fromUnits(hoveredNode.outgoing, asset))}
      {:else}{month} · {asset} · {flows.paths.length} 条资金流向{/if}
    </p>{/if}
  {#if !flows.nodes.length}<p class="muted">本月没有 {asset} 收支流水</p>{/if}
{/if}

<style>
  .money-toolbar {
    display: flex;
    gap: 1rem;
    margin: 1rem 0;
  }
  .money-detail {
    padding: 1rem 0;
  }
  .money-row {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    border-bottom: 1px solid var(--border);
    padding: 0.8rem 0;
  }
  .flow {
    width: 100%;
    overflow: auto;
    margin: 1rem 0 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    padding-top: 14px;
  }
  .flow-readout {
    font-size: 12px;
    color: var(--muted);
    margin-top: 8px;
  }
  .flow g {
    cursor: crosshair;
  }
  .flow text {
    paint-order: stroke;
    stroke: var(--surface);
    stroke-width: 3px;
    stroke-linejoin: round;
  }
  .flow .column {
    font-weight: 650;
  }
  .flow .flow-amount {
    fill: var(--muted);
    font-size: 11px;
  }
  .flow svg {
    width: 100%;
    min-width: 700px;
  }
  text {
    font-size: 12px;
    fill: var(--text);
  }
</style>
