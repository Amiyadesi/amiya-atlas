<script lang="ts">
  import { oneHop } from "../../domain/proposal";
  import type { VaultSnapshot } from "../../lib/types";
  import { categoryLabel, relationLabel } from "../../lib/record-labels";
  export let snapshot: VaultSnapshot;
  export let rootId: string;
  export let onOpen: (id: string) => void;
  export let moneyData: Record<string,{label:string;weight:number;idle?:string}> = {};
  export let onPick: (id:string)=>void = ()=>{};
  let roots: string[] = [];
  let loadedRoot = "";
  let picked = "";
  let filter = "";
  let zoom = 1;
  let pan = { x: 0, y: 0 };
  let dragging: {
    x: number;
    y: number;
    startX: number;
    startY: number;
    pointer: number;
  } | null = null;
  const filters: Record<string, string[]> = {
    登录: ["AUTHENTICATES_WITH", "REGISTERED_WITH"],
    找回: ["RECOVERS_WITH"],
    归属: ["OWNS", "OWNS_ADDRESS", "MANAGES", "MANAGED_BY", "ISSUED_BY"],
    付款: ["PAID_BY", "BILLED_FOR", "INVOICED_TO", "ALLOCATED_TO"],
    托管: ["HOSTED_ON", "HOSTS", "EXPOSED_AT"],
    依赖: ["DEPENDS_ON", "USES", "CONNECTED_VIA"],
    部署: ["SOURCE_IN", "DEPLOYED_ON"],
  };
  $: if (rootId !== loadedRoot) {
    roots = [rootId];
    loadedRoot = rootId;
    picked = rootId;
    zoom = 1;
    pan = { x: 0, y: 0 };
  }
  $: graph = oneHop(snapshot, roots, filters[filter] ?? []);
  $: visible = [
    ...graph.entities.filter((e) => e.id === rootId),
    ...graph.entities.filter((e) => e.id !== rootId),
  ].slice(0, 80);
  $: positions = new Map(
    visible.map((entity, index) => {
      const center = entity.id === rootId;
      const i = visible
        .filter((e) => e.id !== rootId)
        .findIndex((e) => e.id === entity.id);
      const ring = Math.floor(Math.max(0, i) / 10);
      const angle =
        (Math.PI * 2 * (i % 10)) /
        Math.min(10, Math.max(1, visible.length - 1));
      return [
        entity.id,
        {
          x: center ? 500 : 500 + (260 + ring * 180) * Math.cos(angle),
          y: center ? 340 : 340 + (210 + ring * 140) * Math.sin(angle),
          index,
        },
      ];
    }),
  );
  $: pickedName = snapshot.entities.find((e) => e.id === picked)?.name ?? "";
  function down(event: PointerEvent) {
    if (event.target instanceof Element && event.target.closest("button"))
      return;
    dragging = {
      x: event.clientX,
      y: event.clientY,
      startX: pan.x,
      startY: pan.y,
      pointer: event.pointerId,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent) {
    if (dragging)
      pan = {
        x: dragging.startX + event.clientX - dragging.x,
        y: dragging.startY + event.clientY - dragging.y,
      };
  }
  function up() {
    dragging = null;
  }
</script>

<div class="graph-toolbar">
  <label
    >关系筛选<select bind:value={filter}
      ><option value="">全部关系</option
      >{#each Object.keys(filters) as type}<option>{type}</option
        >{/each}</select
    ></label
  >
  <div class="button-row">
    <button
      class="secondary"
      on:click={() => (zoom = Math.max(0.3, zoom - 0.15))}
      aria-label="缩小">−</button
    ><button
      class="secondary"
      on:click={() => {
        zoom = 1;
        pan = { x: 0, y: 0 };
      }}
      aria-label="重置画布">重置</button
    ><button
      class="secondary"
      on:click={() => (zoom = Math.min(2, zoom + 0.15))}
      aria-label="放大">＋</button
    >
  </div>
</div>
<div
  class="graph-canvas"
  role="region"
  aria-label="关系探索画布，可以拖动画布或点击节点"
  on:pointerdown={down}
  on:pointermove={move}
  on:pointerup={up}
  on:pointercancel={up}
>
  <div
    class="graph-world"
    style={`transform: translate(${pan.x}px, ${pan.y}px) scale(${zoom});`}
  >
    <svg width="1800" height="1400" aria-hidden="true"
      ><defs
        ><marker
          id="atlas-arrow"
          markerWidth="10"
          markerHeight="10"
          refX="20"
          refY="4"
          orient="auto"><path d="M0,0 L0,8 L9,4 z" fill="#8998bc" /></marker
        ></defs
      >{#each graph.relations as relation}{@const from = positions.get(
          relation.sourceId,
        )}{@const to = positions.get(relation.targetId)}{#if from && to}<line
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="#657391"
            stroke-width="1.5"
            marker-end="url(#atlas-arrow)"
          /><text
            x={(from.x + to.x) / 2}
            y={(from.y + to.y) / 2 - 12}
            text-anchor="middle"
            fill="#a6b1c8"
            font-size="10">{relation.type==='ALLOCATED_TO' ? relation.note : relationLabel(relation.type)}</text
          >{/if}{/each}</svg
    >
    {#each visible as entity}{@const p = positions.get(entity.id)!}<button
        class:root={entity.id === rootId}
        class:picked={entity.id === picked}
        class="graph-node"
        style={`left: ${p.x}px; top: ${p.y}px;${moneyData[entity.id]?`min-width:${150+60*moneyData[entity.id].weight}px;background:color-mix(in srgb,var(--accent) ${Math.round(8+moneyData[entity.id].weight*35)}%,var(--surface));`:''}`}
        on:click={() => {picked = entity.id;onPick(picked);}}
        ><span>{categoryLabel(entity.category)}</span><strong>{entity.name}</strong>{#if moneyData[entity.id]}<small>{moneyData[entity.id].label} / 月</small>{#if moneyData[entity.id].idle&&!/^0(?:\.0+)?$/.test(moneyData[entity.id].idle!)}<small style="border-top:1px dashed #aaa;color:var(--muted)">闲置 {moneyData[entity.id].idle}</small>{/if}{/if}</button
      >{/each}
  </div>
  {#if graph.entities.length > 80}<div class="graph-hint">
      显示 {visible.length} / {graph.entities.length} 个节点
    </div>{:else}<div class="graph-hint">
      {graph.entities.length} 个相关记忆
    </div>{/if}
</div>
<div class="graph-footer">
  <span>{pickedName || "选择一个记忆"}</span>
  <div class="button-row">
    <button
      class="secondary"
      disabled={!picked}
      on:click={() => {
        if (!roots.includes(picked)) roots = [...roots, picked];
      }}>展开关联</button
    ><button class="primary" disabled={!picked} on:click={() => onOpen(picked)}
      >打开详情</button
    >
  </div>
</div>
