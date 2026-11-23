<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { ForceGraph3DInstance } from "3d-force-graph";
  import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
  import { searchEntities } from "../../domain/proposal";
  import type { VaultSnapshot } from "../../lib/types";
  import {
    categoryLabel,
    categoryGroup,
    relationLabel,
  } from "../../lib/record-labels";
  import {
    graphData,
    graphColors,
    relatedIds,
    endpointId,
    nodeVolume,
    type GraphNode,
    type GraphLink,
  } from "./layout";
  export let snapshot: VaultSnapshot;
  export let rootId = "";
  export let onOpen: (id: string) => void;
  export let moneyData: Record<
    string,
    { label: string; weight: number; idle?: string }
  > = {};
  export let onPick: (id: string) => void = () => {};
  let focus = rootId,
    loadedRoot = rootId,
    search = "",
    searchOpen = false,
    suggestion = 0,
    filter = "";
  let container: HTMLElement, viewport: HTMLDivElement;
  let fullscreen = false,
    error = "",
    ready = false,
    hovered = "";
  let graph: ForceGraph3DInstance<GraphNode, GraphLink> | undefined;
  let labels: Array<{
    id: string;
    name: string;
    x: number;
    y: number;
    selected: boolean;
    color: string;
  }> = [];
  let labelFrame = 0,
    labelTime = 0,
    fitTimer: ReturnType<typeof setTimeout>;
  let home = new Map<string, { x: number; y: number; z: number }>();
  const marker = "graph-" + crypto.randomUUID();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const filters: Record<string, string[]> = {
    登录: ["AUTHENTICATES_WITH", "REGISTERED_WITH"],
    找回: ["RECOVERS_WITH"],
    归属: ["OWNS", "OWNS_ADDRESS", "MANAGES", "MANAGED_BY", "ISSUED_BY"],
    付款: ["PAID_BY", "BILLED_FOR", "INVOICED_TO", "ALLOCATED_TO"],
    托管: ["HOSTED_ON", "HOSTS", "EXPOSED_AT"],
    依赖: ["DEPENDS_ON", "USES", "CONNECTED_VIA"],
    部署: ["SOURCE_IN", "DEPLOYED_ON"],
  };
  $: data = graphData(snapshot, filter ? filters[filter] : undefined);
  $: entities = data.nodes.map((n) => n.entity);
  $: entityById = new Map(entities.map((e) => [e.id, e]));
  $: related = relatedIds(data.links, focus);
  $: selected = entityById.get(focus);
  $: selectedRelations = data.links
    .filter(
      (l) => l.relation.sourceId === focus || l.relation.targetId === focus,
    )
    .map((l) => l.relation);
  $: matches = (search.trim() ? searchEntities(snapshot, search) : entities)
    .filter((e) => entityById.has(e.id))
    .slice(0, 8);
  $: groups = [...new Set(entities.map((e) => categoryGroup(e.category)))];
  $: if (ready) load(data);
  $: if (rootId !== loadedRoot) {
    loadedRoot = rootId;
    void pick(rootId);
  }
  const activeLink = (l: GraphLink) =>
    !focus || endpointId(l.source) === focus || endpointId(l.target) === focus;
  function tooltip(text: string) {
    const el = document.createElement("span");
    el.textContent = text;
    return el;
  }
  function labelsSoon() {
    if (labelFrame) return;
    labelFrame = requestAnimationFrame(() => {
      labelFrame = 0;
      projectLabels();
    });
  }
  function projectLabels() {
    if (!graph) return;
    const camera = graph.camera(),
      center = graph.cameraPosition();
    const { width, height } = viewport.getBoundingClientRect();
    const candidates = data.nodes
      .filter((n) => !focus || related.has(n.id) || n.id === hovered)
      .map((n) => {
        const distance = Math.hypot(
          n.x - center.x,
          n.y - center.y,
          n.z - center.z,
        );
        const p = graph!.graph2ScreenCoords(n.x, n.y, n.z);
        return {
          n,
          p,
          distance,
          priority:
            (n.id === focus || n.id === hovered ? 1e6 : 0) +
            n.degree * 3 -
            distance / 100,
        };
      })
      .sort((a, b) => b.priority - a.priority);
    const taken: Array<{ x: number; y: number }> = [];
    labels = candidates.flatMap(({ n, p, distance }) => {
      const forward = camera.matrixWorld.elements;
      const behind =
        (n.x - center.x) * forward[8] +
          (n.y - center.y) * forward[9] +
          (n.z - center.z) * forward[10] >
        0;
      if (
        behind ||
        p.x < 28 ||
        p.y < 20 ||
        p.x > width - 28 ||
        p.y > height - 32
      )
        return [];
      if (
        n.id !== focus &&
        n.id !== hovered &&
        (taken.length >= 28 ||
          distance > 1900 ||
          taken.some(
            (q) => Math.abs(q.x - p.x) < 105 && Math.abs(q.y - p.y) < 28,
          ))
      )
        return [];
      taken.push(p);
      return [
        {
          id: n.id,
          name: n.entity.name,
          x: p.x,
          y: p.y + 13,
          selected: n.id === focus,
          color: n.color,
        },
      ];
    });
  }
  function fit() {
    if (!graph || !data.nodes.length) return;
    graph.zoomToFit(
      reduced ? 0 : 650,
      Math.min(65, viewport.clientWidth / 8),
      (n) => !focus || related.has(n.id),
    );
    labelsSoon();
  }
  function load(next: typeof data) {
    if (!graph) return;
    home.clear();
    graph
      .nodeRelSize(next.nodes.length > 500 ? 5 : 8)
      .nodeResolution(next.nodes.length > 500 ? 12 : 20)
      .graphData(next)
      .cooldownTicks(100)
      .cooldownTime(2500);
    graph.d3Force("charge")?.strength(-55).distanceMax(250);
    graph.d3Force("link")?.distance(70);
    graph.d3Force("bounds", (alpha) => {
      if (focus) return;
      for (const n of next.nodes) {
        n.vx = (n.vx ?? 0) - n.x * alpha * 0.003;
        n.vy = (n.vy ?? 0) - n.y * alpha * 0.003;
        n.vz = (n.vz ?? 0) - n.z * alpha * 0.003;
      }
    });
    graph.d3Force("focus", null);
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => (focus ? arrangeFocus() : fit()), 350);
  }
  function styleFocus() {
    graph
      ?.nodeColor((n) =>
        focus && !related.has(n.id)
          ? "#344153"
          : n.id === focus
            ? "#ffffff"
            : n.color,
      )
      .linkColor((l) =>
        activeLink(l) ? (focus ? "#a7c8e9" : "#7189a7") : "#273345",
      )
      .linkDirectionalArrowLength((l) => (activeLink(l) ? (focus ? 5 : 3) : 0));
  }
  function arrangeFocus() {
    if (!graph) return;
    styleFocus();
    if (!home.size)
      for (const n of data.nodes) home.set(n.id, { x: n.x, y: n.y, z: n.z });
    const root = home.get(focus),
      targets = new Map(home);
    if (root) {
      const neighbors = data.nodes.filter(
        (n) => n.id !== focus && related.has(n.id),
      );
      const radius = Math.max(90, Math.cbrt(neighbors.length) * 40);
      neighbors.forEach((n, i) => {
        const y = 1 - (2 * (i + 0.5)) / neighbors.length,
          r = Math.sqrt(1 - y * y),
          a = i * 2.399963;
        targets.set(n.id, {
          x: root.x + radius * r * Math.cos(a),
          y: root.y + radius * y,
          z: root.z + radius * r * Math.sin(a),
        });
      });
      for (const n of data.nodes)
        if (!related.has(n.id)) {
          const p = home.get(n.id)!,
            dx = p.x - root.x,
            dy = p.y - root.y,
            dz = p.z - root.z;
          const length = Math.hypot(dx, dy, dz) || 1,
            distance = Math.max(radius * 3, length + 160);
          targets.set(n.id, {
            x: root.x + (dx / length) * distance,
            y: root.y + (dy / length) * distance,
            z: root.z + (dz / length) * distance,
          });
        }
      const camera = graph.cameraPosition(),
        dx = camera.x - root.x,
        dy = camera.y - root.y,
        dz = camera.z - root.z;
      const distance = Math.hypot(dx, dy, dz) || 1,
        zoom = Math.max(300, radius * 3.8);
      graph.cameraPosition(
        {
          x: root.x + (dx / distance) * zoom,
          y: root.y + (dy / distance) * zoom,
          z: root.z + (dz / distance) * zoom,
        },
        root,
        reduced ? 0 : 750,
      );
    } else {
      fitTimer = setTimeout(fit, 500);
    }
    graph.d3Force("link")?.strength(focus ? 0 : 0.7);
    graph.d3Force("center")?.strength(focus ? 0 : 1);
    graph.d3Force("charge")?.strength(focus ? -4 : -55);
    graph
      .d3Force("focus", (alpha) => {
        for (const n of data.nodes) {
          const p = targets.get(n.id)!;
          n.vx = (n.vx ?? 0) + (p.x - n.x) * alpha * 0.25;
          n.vy = (n.vy ?? 0) + (p.y - n.y) * alpha * 0.25;
          n.vz = (n.vz ?? 0) + (p.z - n.z) * alpha * 0.25;
        }
      })
      .d3ReheatSimulation();
  }
  async function pick(id: string) {
    focus = id;
    search = "";
    searchOpen = false;
    suggestion = 0;
    onPick(id);
    await tick();
    arrangeFocus();
  }
  async function openDetail(id: string) {
    if (document.fullscreenElement === container)
      await document.exitFullscreen();
    onOpen(id);
  }
  function key(event: KeyboardEvent) {
    if (event.key === "Escape") {
      searchOpen = false;
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      searchOpen = true;
      suggestion = Math.max(
        0,
        Math.min(
          matches.length - 1,
          suggestion + (event.key === "ArrowDown" ? 1 : -1),
        ),
      );
    }
    if (event.key === "Enter" && matches.length) {
      event.preventDefault();
      void pick(matches[suggestion]?.id ?? matches[0].id);
    }
  }
  async function toggleFullscreen() {
    if (fullscreen && document.fullscreenElement !== container) {
      fullscreen = false;
      return;
    }
    try {
      if (document.fullscreenElement === container)
        await document.exitFullscreen();
      else if (container.requestFullscreen) await container.requestFullscreen();
      else fullscreen = !fullscreen;
    } catch {
      fullscreen = true;
    }
  }
  function zoom(factor: number) {
    if (!graph) return;
    const camera = graph.cameraPosition(),
      target = (graph.controls() as OrbitControls).target;
    graph.cameraPosition(
      {
        x: target.x + (camera.x - target.x) * factor,
        y: target.y + (camera.y - target.y) * factor,
        z: target.z + (camera.z - target.z) * factor,
      },
      target,
      reduced ? 0 : 250,
    );
  }
  onMount(() => {
    let disposed = false;
    const resize = new ResizeObserver(() => {
      graph?.width(viewport.clientWidth).height(viewport.clientHeight);
      labelsSoon();
    });
    const full = () => {
      fullscreen = document.fullscreenElement === container;
    };
    const visibility = () =>
      document.hidden ? graph?.pauseAnimation() : graph?.resumeAnimation();
    void (async () => {
      const [
        { default: ForceGraph3D },
        {
          AmbientLight,
          DirectionalLight,
          CanvasTexture,
          Sprite,
          SpriteMaterial,
        },
      ] = await Promise.all([import("3d-force-graph"), import("three")]);
      if (disposed) return;
      graph = new ForceGraph3D(viewport, {
        controlType: "orbit",
        rendererConfig: { antialias: true, alpha: false },
      }) as unknown as ForceGraph3DInstance<GraphNode, GraphLink>;
      graph
        .width(viewport.clientWidth)
        .height(viewport.clientHeight)
        .backgroundColor("#142033")
        .showNavInfo(false)
        .nodeOpacity(1)
        .nodeVal(
          (n) => nodeVolume(n.degree) * (1 + (moneyData[n.id]?.weight ?? 0)),
        )
        .nodeThreeObjectExtend((n) => !!n.icon)
        .nodeThreeObject((n) => {
          if (!n.icon) return undefined as unknown as import("three").Object3D;
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 64;
          const ctx = canvas.getContext("2d")!;
          ctx.font = '46px "Segoe UI Emoji","Apple Color Emoji",sans-serif';
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(n.icon, 32, 34);
          const sprite = new Sprite(
            new SpriteMaterial({
              map: new CanvasTexture(canvas),
              transparent: true,
            }),
          );
          const diameter =
            (data.nodes.length > 500 ? 5 : 8) *
            Math.cbrt(
              nodeVolume(n.degree) * (1 + (moneyData[n.id]?.weight ?? 0)),
            ) *
            1.25;
          sprite.scale.set(diameter, diameter, 1);
          return sprite;
        })
        .nodePositionUpdate((icon, coords, n) => {
          if (n.icon) {
            const camera = graph!.camera().position;
            const radius =
              (data.nodes.length > 500 ? 5 : 8) *
              Math.cbrt(
                nodeVolume(n.degree) * (1 + (moneyData[n.id]?.weight ?? 0)),
              );
            icon.position
              .set(
                camera.x - coords.x,
                camera.y - coords.y,
                camera.z - coords.z,
              )
              .normalize()
              .multiplyScalar(radius * 1.06);
          }
          return false;
        })
        .nodeColor((n) => n.color)
        .nodeLabel((n) => tooltip(n.entity.name))
        .linkOpacity(0.45)
        .linkWidth(0)
        .linkColor("#7189a7")
        .linkDirectionalArrowResolution(5)
        .linkDirectionalArrowLength(3)
        .linkDirectionalArrowRelPos(1)
        .linkCurvature((l) =>
          endpointId(l.source) === endpointId(l.target) ? 0.4 : 0,
        )
        .linkLabel((l) => tooltip(relationLabel(l.relation.type)))
        .enableNodeDrag(false)
        .onNodeClick((n) => void pick(n.id))
        .onNodeHover((n) => {
          hovered = n?.id ?? "";
          viewport.style.cursor = n ? "pointer" : "grab";
          labelsSoon();
        })
        .onBackgroundClick(() => {
          if (focus) void pick("");
          searchOpen = false;
        })
        .onEngineTick(() => {
          if (performance.now() - labelTime > 90) {
            labelTime = performance.now();
            labelsSoon();
          }
        })
        .onEngineStop(() => {
          if (!focus) fit();
          labelsSoon();
        });
      graph.renderer().setPixelRatio(Math.min(devicePixelRatio, 1.6));
      const key = new DirectionalLight(0xffffff, 2.5);
      key.position.set(-100, 180, 240);
      const fill = new DirectionalLight(0x82b6ef, 1);
      fill.position.set(200, -80, -140);
      graph.lights([new AmbientLight(0xffffff, 0.85), key, fill]);
      const controls = graph.controls() as OrbitControls;
      controls.enableDamping = !reduced;
      controls.dampingFactor = 0.12;
      controls.minDistance = 35;
      controls.maxDistance = 9000;
      controls.addEventListener("change", labelsSoon);
      resize.observe(viewport);
      document.addEventListener("fullscreenchange", full);
      document.addEventListener("visibilitychange", visibility);
      ready = true;
    })().catch((e) => {
      error =
        e instanceof Error
          ? `无法显示三维图：${e.message}`
          : "无法显示三维图，请启用硬件加速";
    });
    return () => {
      disposed = true;
      ready = false;
      resize.disconnect();
      clearTimeout(fitTimer);
      cancelAnimationFrame(labelFrame);
      document.removeEventListener("fullscreenchange", full);
      document.removeEventListener("visibilitychange", visibility);
      graph?._destructor();
      graph = undefined;
    };
  });
</script>

<svelte:window
  on:keydown={(e) => {
    if (e.key === "Escape" && !document.fullscreenElement) fullscreen = false;
  }}
/>
<section
  class="atlas-graph"
  class:expanded={fullscreen}
  bind:this={container}
  aria-label="三维资产关系图"
>
  <div class="canvas-toolbar">
    <div class="graph-search">
      <input
        type="search"
        role="combobox"
        aria-label="搜索资产"
        aria-autocomplete="list"
        aria-expanded={searchOpen && matches.length > 0}
        aria-controls={marker + "-results"}
        aria-activedescendant={searchOpen && matches.length
          ? `${marker}-result-${suggestion}`
          : undefined}
        bind:value={search}
        on:focus={() => (searchOpen = true)}
        on:input={() => {
          searchOpen = true;
          suggestion = 0;
        }}
        on:keydown={key}
        placeholder="搜索资产、标签…"
      />
      {#if searchOpen}<div
          class="graph-suggestions"
          id={marker + "-results"}
          role="listbox"
          aria-label="匹配资产"
        >
          {#each matches as entity, i}<button
              type="button"
              role="option"
              id={`${marker}-result-${i}`}
              aria-selected={i === suggestion}
              class:active={i === suggestion}
              on:click={() => pick(entity.id)}
              ><strong>{entity.name}</strong><small
                >{categoryLabel(entity.category)}</small
              ></button
            >{:else}<span>没有匹配的资产</span>{/each}
        </div>{/if}
    </div>
    <select bind:value={filter} aria-label="关系筛选"
      ><option value="">全部关系</option
      >{#each Object.keys(filters) as type}<option>{type}</option
        >{/each}</select
    >
    <button class="secondary" on:click={() => pick("")}>全部资产</button><button
      class="secondary"
      on:click={toggleFullscreen}>{fullscreen ? "退出全屏" : "全屏"}</button
    >
  </div>
  <div class="asset-canvas" class:with-selection={!!selected}>
    <div
      class="graph-scene"
      bind:this={viewport}
      aria-label="拖动旋转，滚轮缩放；搜索选择资产"
      role="img"
    ></div>
    <div class="node-labels" aria-hidden="true">
      {#each labels as label (label.id)}<span
          class:chosen={label.selected}
          style={`left:${label.x}px;top:${label.y}px;--node-color:${label.color}`}
          >{label.name}</span
        >{/each}
    </div>
    <div class="canvas-count">
      {focus ? `${related.size} 个相关 / ` : ""}{entities.length} 个资产 · {data
        .links.length} 条关系
    </div>
    <div class="canvas-legend">
      {#each groups as group}<span
          ><i style={`background:${graphColors[group]}`}></i>{group}</span
        >{/each}
    </div>
    <div class="canvas-zoom">
      <button aria-label="缩小" on:click={() => zoom(1.3)}>−</button><button
        aria-label="适应画布"
        on:click={fit}>居中</button
      ><button aria-label="放大" on:click={() => zoom(0.75)}>＋</button>
    </div>
    {#if !ready && !error}<div class="graph-empty" role="status">
        正在打开三维图…
      </div>{:else if !entities.length}<div class="graph-empty">
        添加资产后，在这里查看关联
      </div>{/if}
    {#if selected}<aside class="selection-detail">
        <div class="selection-title">
          <div>
            <small>{categoryLabel(selected.category)}</small>
            <h2>{selected.name}</h2>
          </div>
          <button aria-label="取消选择" on:click={() => pick("")}>×</button>
        </div>
        {#if selected.tags.length}<div class="selection-tags">
            {selected.tags.join(" / ")}
          </div>{/if}
        {#if moneyData[selected.id]}<p>
            {moneyData[selected.id].label} / 月
          </p>{/if}
        <button class="open-detail" on:click={() => openDetail(selected.id)}
          >查看详情</button
        >
        <div class="selection-relations">
          {#each selectedRelations as relation}{@const outgoing =
              relation.sourceId === focus}{@const other = entityById.get(
              outgoing ? relation.targetId : relation.sourceId,
            )!}<button on:click={() => pick(other.id)}
              ><small
                >{outgoing ? "→" : "←"} {relationLabel(relation.type)}</small
              ><strong>{other.name}</strong></button
            >{:else}<span>暂无关联</span>{/each}
        </div>
      </aside>{/if}
  </div>
  {#if error}<p class="graph-error" role="alert">{error}</p>{/if}
</section>

<style>
  .atlas-graph {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .atlas-graph.expanded {
    position: fixed;
    inset: 0;
    z-index: 1000;
    border-radius: 0;
  }
  .atlas-graph:fullscreen {
    width: 100vw;
    height: 100dvh;
    border-radius: 0;
  }
  .canvas-toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    padding: 12px;
    z-index: 3;
    background: var(--surface);
  }
  .graph-search {
    position: relative;
    flex: 1;
    min-width: 170px;
  }
  .graph-search input {
    width: 100%;
    padding: 10px 12px;
  }
  .canvas-toolbar select {
    width: auto;
    min-width: 100px;
    padding: 9px;
  }
  .canvas-toolbar button {
    white-space: nowrap;
  }
  .graph-suggestions {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    right: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 7px;
    box-shadow: 0 8px 24px #101a3033;
    max-height: 330px;
    overflow: auto;
  }
  .graph-suggestions button {
    width: 100%;
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 12px;
    border: 0;
    background: none;
    text-align: left;
    color: var(--text);
    cursor: pointer;
  }
  .graph-suggestions button.active,
  .graph-suggestions button:hover {
    background: var(--accent-soft);
  }
  .graph-suggestions small {
    color: var(--muted);
  }
  .graph-suggestions > span {
    display: block;
    padding: 12px;
    font-size: 13px;
  }
  .asset-canvas {
    position: relative;
    min-height: 500px;
    height: calc(100dvh - 240px);
    max-height: 920px;
    overflow: hidden;
    background: #142033;
  }
  .expanded .asset-canvas,
  :fullscreen .asset-canvas {
    flex: 1;
    max-height: none;
    height: auto;
  }
  .graph-scene {
    position: absolute;
    inset: 0;
    touch-action: none;
    cursor: grab;
  }
  .with-selection .graph-scene {
    right: 280px;
  }
  .node-labels {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
  }
  .with-selection .node-labels {
    right: 280px;
  }
  .node-labels span {
    position: absolute;
    transform: translateX(-50%);
    font-size: 11px;
    white-space: nowrap;
    max-width: 190px;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #e3ebf9;
    text-shadow:
      0 1px 4px #142033,
      1px 0 3px #142033,
      -1px 0 3px #142033;
    border-bottom: 1px solid var(--node-color);
    padding: 1px 2px;
  }
  .node-labels span.chosen {
    font-weight: 700;
    color: #fff;
    font-size: 13px;
  }
  .canvas-count {
    position: absolute;
    bottom: 17px;
    left: 18px;
    color: #c1cfe2;
    font-size: 12px;
    pointer-events: none;
  }
  .canvas-legend {
    position: absolute;
    top: 16px;
    left: 18px;
    display: flex;
    gap: 15px;
    flex-wrap: wrap;
    color: #aabbd3;
    pointer-events: none;
    max-width: calc(100% - 30px);
    font-size: 11px;
  }
  .with-selection .canvas-legend {
    max-width: calc(100% - 310px);
  }
  .canvas-legend span {
    display: flex;
    gap: 5px;
    align-items: center;
  }
  .canvas-legend i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .canvas-zoom {
    position: absolute;
    bottom: 11px;
    right: 12px;
    display: flex;
    gap: 1px;
  }
  .with-selection .canvas-zoom {
    right: 292px;
  }
  .canvas-zoom button {
    background: #24334a;
    color: #d5e4f9;
    border: 1px solid #40516a;
    padding: 7px 11px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  .canvas-zoom button:hover {
    background: #364a68;
  }
  .graph-empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: #c1cfe2;
    pointer-events: none;
    font-size: 13px;
  }
  .selection-detail {
    position: absolute;
    inset: 0 0 0 auto;
    width: 280px;
    background: #1b2b42;
    color: #e3ebf9;
    border-left: 1px solid #354860;
    padding: 20px;
    overflow: auto;
    box-sizing: border-box;
  }
  .selection-title {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    justify-content: space-between;
  }
  .selection-title h2 {
    font-size: 19px;
    line-height: 1.45;
    overflow-wrap: anywhere;
    margin: 8px 0 15px;
  }
  .selection-title small,
  .selection-tags,
  .selection-relations small {
    color: #a8bdd8;
    font-size: 11px;
  }
  .selection-title button {
    border: 0;
    background: none;
    color: #c2d0e4;
    font-size: 22px;
    padding: 0;
    cursor: pointer;
  }
  .selection-tags {
    margin-bottom: 16px;
  }
  .open-detail {
    border: 1px solid #6888b5;
    background: #293f60;
    color: #f1f6ff;
    padding: 8px 14px;
    border-radius: 6px;
    cursor: pointer;
    width: 100%;
    margin-bottom: 20px;
  }
  .selection-relations {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .selection-relations button {
    border: 0;
    border-bottom: 1px solid #354860;
    padding: 12px 0;
    text-align: left;
    background: none;
    display: flex;
    flex-direction: column;
    gap: 5px;
    color: #e3ebf9;
    cursor: pointer;
  }
  .selection-relations strong {
    font-size: 13px;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .selection-relations > span {
    font-size: 12px;
    color: #a8bdd8;
  }
  .graph-error {
    padding: 12px;
    color: var(--danger);
    margin: 0;
  }
  @media (max-width: 700px) {
    .asset-canvas {
      min-height: 560px;
    }
    .canvas-toolbar {
      gap: 6px;
      padding: 8px;
    }
    .canvas-toolbar select {
      min-width: 80px;
    }
    .canvas-toolbar button {
      padding: 8px;
      font-size: 11px;
    }
    .with-selection .graph-scene {
      right: 0;
      bottom: 205px;
    }
    .with-selection .node-labels {
      right: 0;
      bottom: 205px;
    }
    .selection-detail {
      inset: auto 0 0;
      width: 100%;
      height: 205px;
      border-left: 0;
      border-top: 1px solid #354860;
      padding: 14px 18px;
    }
    .selection-title h2 {
      font-size: 16px;
      margin: 4px 0 10px;
    }
    .selection-title small {
      display: none;
    }
    .selection-tags {
      display: none;
    }
    .open-detail {
      width: auto;
      position: absolute;
      right: 50px;
      top: 12px;
      margin: 0;
      font-size: 11px;
    }
    .selection-relations {
      display: grid;
      grid-template-columns: 1fr 1fr;
      column-gap: 18px;
    }
    .with-selection .canvas-count {
      bottom: 220px;
    }
    .with-selection .canvas-zoom {
      right: 12px;
      bottom: 214px;
    }
    .with-selection .canvas-legend {
      max-width: calc(100% - 30px);
    }
    .canvas-legend {
      gap: 10px;
    }
    .canvas-count {
      font-size: 10px;
    }
    .canvas-zoom button {
      padding: 6px 9px;
    }
  }
</style>
