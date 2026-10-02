<script lang="ts">
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import {
    isTauri,
    vaultStatus,
    initializeVault,
    unlockVault,
    loadSnapshot,
    lockVault,
    beginTextCapture,
    stageProposal,
    confirmProposal,
    reviseProposal,
    dismissCapture,
    saveAiConfig,
    prepareLocalModel,
    exportBackup,
    importBackup,
    exportRedacted,
    previewAtlasJson,
    importAtlasJson,
  } from "./lib/api";
  import { emptySnapshot } from "./lib/types";
  import type { Entity, VaultSnapshot } from "./lib/types";
  import { DEFAULT_PROVIDER, createProvider } from "./ai/provider";
  import type { ProviderConfig } from "./ai/provider";
  import {
    matchEntities,
    searchEntities,
    validateProposal,
    attributeLabel,
  } from "./domain/proposal";
  import type { Proposal, TextCapture } from "./domain/proposal";
  import ProposalPreview from "./features/capture/ProposalPreview.svelte";
  import ExploreCanvas from "./features/graph/ExploreCanvas.svelte";

  type Page = "Home" | "Search" | "Memory" | "Explore" | "Inbox" | "Settings";
  const pages: Page[] = [
    "Home",
    "Search",
    "Memory",
    "Explore",
    "Inbox",
    "Settings",
  ];
  const labels: Record<Page, string> = {
    Home: "首页",
    Search: "搜索",
    Memory: "记忆",
    Explore: "探索",
    Inbox: "待确认",
    Settings: "设置",
  };
  const symbols: Record<Page, string> = {
    Home: "⌂",
    Search: "⌕",
    Memory: "▤",
    Explore: "◇",
    Inbox: "▱",
    Settings: "⚙",
  };
  let mode: "loading" | "create" | "unlock" | "ready" = "loading";
  let snapshot: VaultSnapshot = emptySnapshot();
  let page: Page = "Home";
  let password = "";
  let passwordConfirm = "";
  let text = "";
  let query = "";
  let queryAnswer = "";
  let queryRegion = "";
  let busy = false;
  let modelBusy = false;
  let parsingId = "";
  let error = "";
  let notice = "";
  let selectedId = "";
  let rootId = "";
  let previewId = "";
  let config: ProviderConfig = { ...DEFAULT_PROVIDER };
  let settingsConfig: ProviderConfig = { ...DEFAULT_PROVIDER };
  let connection = "";
  let progress = { stage: "", completed: 0, total: 0 };
  let captureInput: HTMLTextAreaElement;
  let epoch = 0;
  let pendingImport: { text: string; summary: string } | null = null;
  const samples = [
    "Saily 是我唯一一个美国 +1 号码，一个月六块多，主要备用和收藏，目前先保留。",
    "SuperGrok 已经付到 2026 年 12 月，以后不续。",
    "我刚注册了一个日本网站，用日本 Google 大号登录。",
  ];
  $: pending = (snapshot.captures ?? [])
    .filter((c) => c.status === "PENDING")
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  $: preview = snapshot.proposals?.find(
    (p) => p.id === previewId && p.status === "PENDING",
  );
  $: previewCapture = snapshot.captures?.find(
    (c) => c.id === preview?.captureId,
  );
  $: recent = snapshot.entities
    .filter((e) => e.privacy !== "SECRET")
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);
  $: results = searchEntities(snapshot, query, queryRegion);
  $: selected = snapshot.entities.find(
    (e) => e.id === selectedId && e.privacy !== "SECRET",
  );
  $: upcoming = snapshot.events
    .filter((e) => e.status === "UPCOMING" || e.status === "UNKNOWN")
    .slice()
    .sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"))
    .slice(0, 4);
  $: selectedRelations = selected
    ? snapshot.relations.filter(
        (r) =>
          r.privacy !== "SECRET" &&
          (r.sourceId === selected.id || r.targetId === selected.id) &&
          snapshot.entities.find((e) => e.id === r.sourceId)?.privacy !==
            "SECRET" &&
          snapshot.entities.find((e) => e.id === r.targetId)?.privacy !==
            "SECRET",
      )
    : [];
  $: sources = selected
    ? (snapshot.proposals ?? [])
        .filter(
          (p) => p.status === "CONFIRMED" && p.entityIds.includes(selected.id),
        )
        .map((p) => snapshot.captures?.find((c) => c.id === p.captureId))
        .filter((c): c is TextCapture => !!c)
    : [];

  const readable = (e: unknown) => (e instanceof Error ? e.message : String(e));
  function flash(message: string) {
    notice = message;
  }
  function name(id: string) {
    return snapshot.entities.find((e) => e.id === id)?.name ?? "未知记忆";
  }
  function display(value: unknown) {
    return Array.isArray(value)
      ? value.join(" · ")
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value ?? "");
  }
  function date(value?: string) {
    if (!value) return "日期待定";
    if (/^\d{4}(-\d{2})?$/.test(value)) return value;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString("zh-CN");
  }
  function navigate(next: Page) {
    page = next;
    selectedId = "";
    previewId = "";
    error = "";
    queryAnswer = "";
    queryRegion = "";
    if (next === "Explore" && !rootId) rootId = recent[0]?.id ?? "";
  }
  function openEntity(id: string) {
    selectedId = id;
    page = "Memory";
    previewId = "";
    error = "";
  }
  function explore(id: string) {
    selectedId = "";
    rootId = id;
    page = "Explore";
  }
  function configure(kind: ProviderConfig["kind"]) {
    settingsConfig =
      kind === "local"
        ? { ...DEFAULT_PROVIDER }
        : {
            kind,
            baseUrl:
              kind === "ollama"
                ? "http://localhost:11434"
                : "https://api.example.com/v1",
            model: kind === "ollama" ? "qwen3.5:2b-q4_K_M" : "",
            apiKey: "",
            responseFormat: kind === "ollama" ? "json_schema" : "json_object",
          };
    connection = "";
  }
  function clearPrivateState() {
    epoch++;
    snapshot = emptySnapshot();
    text = "";
    query = "";
    selectedId = "";
    rootId = "";
    previewId = "";
    password = "";
    passwordConfirm = "";
    config = { ...DEFAULT_PROVIDER };
    settingsConfig = { ...DEFAULT_PROVIDER };
    busy = false;
    parsingId = "";
    notice = "";
    error = "";
    pendingImport = null;
    queryAnswer = "";
    queryRegion = "";
    connection = "";
  }
  async function sync() {
    if (!isTauri || mode !== "ready" || busy) return;
    const token = epoch;
    const revision = snapshot.revision;
    try {
      const status = await vaultStatus();
      if (token !== epoch || mode !== "ready") return;
      if (!status.unlocked) {
        clearPrivateState();
        mode = "unlock";
        return;
      }
      const fresh = await loadSnapshot();
      if (
        token === epoch &&
        mode === "ready" &&
        !busy &&
        revision === snapshot.revision &&
        fresh.revision !== snapshot.revision
      )
        snapshot = fresh;
    } catch (e) {
      error = readable(e);
    }
  }
  onMount(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    if (isTauri)
      void listen<typeof progress>("atlas-model-progress", (event) => {
        if (alive) progress = event.payload;
      }).then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      });
    const keydown = (e: KeyboardEvent) => {
      if (
        mode === "ready" &&
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        navigate("Home");
        queueMicrotask(() => captureInput?.focus());
      }
    };
    const focus = () => void sync();
    window.addEventListener("keydown", keydown);
    window.addEventListener("focus", focus);
    const timer = window.setInterval(() => void sync(), 30000);
    void (async () => {
      try {
        const status = await vaultStatus();
        mode = !status.exists ? "create" : status.unlocked ? "ready" : "unlock";
        if (status.unlocked) {
          snapshot = await loadSnapshot();
          config = { ...(snapshot.aiConfig ?? DEFAULT_PROVIDER) };
          settingsConfig = { ...config };
        }
      } catch (e) {
        error = readable(e);
        mode = "unlock";
      }
    })();
    return () => {
      alive = false;
      epoch++;
      unlisten?.();
      window.clearInterval(timer);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("focus", focus);
    };
  });
  async function enter() {
    if (busy) return;
    busy = true;
    error = "";
    try {
      if (
        mode === "create" &&
        (password.length < 12 || password !== passwordConfirm)
      )
        throw new Error(
          password.length < 12 ? "主密码至少 12 个字符" : "两次密码不一致",
        );
      snapshot =
        mode === "create"
          ? await initializeVault(password)
          : await unlockVault(password);
      mode = "ready";
      password = "";
      passwordConfirm = "";
      config = { ...(snapshot.aiConfig ?? DEFAULT_PROVIDER) };
      settingsConfig = { ...config };
    } catch (e) {
      error = readable(e);
    } finally {
      busy = false;
    }
  }
  async function lock() {
    try {
      await lockVault();
      clearPrivateState();
      mode = "unlock";
    } catch (e) {
      error = readable(e);
    }
  }
  async function parseCapture(capture: TextCapture, ownsBusy = false) {
    const token = epoch;
    parsingId = capture.id;
    if (!ownsBusy) busy = true;
    error = "";
    notice = "";
    try {
      const content = await createProvider(config).parseCapture(
        capture.rawText,
        { snapshot, now: new Date().toISOString() },
      );
      if (token !== epoch || mode !== "ready") return;
      // Matching uses fresh metadata after the model response; the native commit guards any subsequent edits.
      const fresh = await loadSnapshot();
      const matched = matchEntities(content, fresh, capture.rawText);
      const next = await stageProposal(capture.id, matched, config.model);
      if (token !== epoch) return;
      snapshot = next;
      previewId =
        snapshot.proposals?.find(
          (p) => p.captureId === capture.id && p.status === "PENDING",
        )?.id ?? "";
      page = "Inbox";
    } catch (e) {
      if (token === epoch) {
        error = `${readable(e)} 原文已保留在待确认区。`;
        page = "Inbox";
      }
    } finally {
      if (token === epoch) {
        busy = false;
        parsingId = "";
      }
    }
  }
  async function capture() {
    if (!text.trim() || busy) return;
    busy = true;
    error = "";
    const token = epoch;
    try {
      const before = new Set((snapshot.captures ?? []).map((c) => c.id));
      const next = await beginTextCapture(text);
      if (token !== epoch) return;
      snapshot = next;
      text = "";
      const input = snapshot.captures?.find((c) => !before.has(c.id));
      if (!input) throw new Error("原文保存失败");
      await parseCapture(input, true);
    } catch (e) {
      if (token === epoch) {
        error = readable(e);
        busy = false;
      }
    }
  }
  async function confirm(content: Proposal) {
    if (!preview || !previewCapture || busy) return;
    validateProposal(content, snapshot, previewCapture.rawText);
    const id = preview.id;
    const token = epoch;
    busy = true;
    try {
      const next = await confirmProposal(id, content);
      if (token !== epoch) return;
      snapshot = next;
      const record = snapshot.proposals?.find((p) => p.id === id);
      previewId = "";
      flash("已记住。原文也一起保留了。");
      if (record?.entityIds[0]) openEntity(record.entityIds[0]);
    } finally {
      if (token === epoch) busy = false;
    }
  }
  async function later(content: Proposal) {
    if (!preview || busy) return;
    const token = epoch;
    busy = true;
    try {
      const next = await reviseProposal(preview.id, content);
      if (token !== epoch) return;
      snapshot = next;
      previewId = "";
      flash("修改已保留，提案仍在待确认区。");
    } finally {
      if (token === epoch) busy = false;
    }
  }
  async function dismiss(captureId: string) {
    if (busy) return;
    const token = epoch;
    busy = true;
    try {
      const next = await dismissCapture(captureId);
      if (token !== epoch) return;
      snapshot = next;
      previewId = "";
      flash("已移出待确认区，原文仍保留。");
    } catch (e) {
      if (token === epoch) error = readable(e);
    } finally {
      if (token === epoch) busy = false;
    }
  }
  async function saveSettings() {
    if (busy) return;
    const token = epoch;
    busy = true;
    error = "";
    try {
      const next = await saveAiConfig(settingsConfig);
      if (token !== epoch) return;
      snapshot = next;
      config = { ...settingsConfig };
      flash("模型设置已保存");
    } catch (e) {
      if (token === epoch) error = readable(e);
    } finally {
      if (token === epoch) busy = false;
    }
  }
  async function testConnection() {
    const token = epoch;
    connection = "正在检查…";
    try {
      const healthy = await createProvider(settingsConfig).healthCheck();
      if (token !== epoch) return;
      connection = healthy
        ? "模型可用"
        : "没有连接到这个模型，请检查服务和模型名称";
    } catch (e) {
      if (token === epoch) connection = readable(e);
    }
  }
  async function prepareModel() {
    if (modelBusy) return;
    modelBusy = true;
    progress = { stage: "正在准备…", completed: 0, total: 0 };
    error = "";
    const token = epoch;
    try {
      await prepareLocalModel();
      if (token !== epoch) return;
      const next = await saveAiConfig({ ...DEFAULT_PROVIDER });
      if (token !== epoch) return;
      snapshot = next;
      config = { ...DEFAULT_PROVIDER };
      settingsConfig = { ...config };
      connection = "模型已就绪";
      flash("本地模型已准备好，可以回首页记第一条了。");
    } catch (e) {
      if (token === epoch) error = readable(e);
    } finally {
      modelBusy = false;
    }
  }
  async function ask() {
    if (!query.trim() || busy) return;
    busy = true;
    error = "";
    const token = epoch;
    try {
      const parsed = await createProvider(config).parseQuery(query);
      if (token !== epoch) return;
      query = parsed.search;
      queryRegion = parsed.region;
      queryAnswer = `按${parsed.region ? `地区 ${parsed.region}` : "名称"}检索已确认的记忆`;
    } catch (e) {
      if (token === epoch) error = readable(e);
    } finally {
      if (token === epoch) busy = false;
    }
  }
  function download(filename: string, payload: string) {
    const url = URL.createObjectURL(
      new Blob([payload], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function backup() {
    try {
      download("atlas-encrypted-backup.json", await exportBackup());
    } catch (e) {
      error = readable(e);
    }
  }
  async function redacted() {
    try {
      download("atlas-redacted.json", await exportRedacted(true));
    } catch (e) {
      error = readable(e);
    }
  }
  async function file(event: Event, kind: "import" | "restore") {
    const input = event.currentTarget as HTMLInputElement;
    const item = input.files?.[0];
    if (!item) return;
    error = "";
    try {
      if (item.size > 32 * 1024 * 1024) throw new Error("文件超过 32 MiB");
      const payload = await item.text();
      if (kind === "restore") {
        const secret = prompt("输入这份加密备份的主密码");
        if (!secret) return;
        snapshot = await importBackup(payload, secret);
        config = { ...(snapshot.aiConfig ?? DEFAULT_PROVIDER) };
        settingsConfig = { ...config };
        flash("加密备份已恢复");
      } else {
        const summary = await previewAtlasJson(payload);
        pendingImport = {
          text: payload,
          summary: `${summary.entityCount} 个实体 · ${summary.relationCount} 条关系 · ${summary.eventCount} 个事件`,
        };
      }
    } catch (e) {
      error = readable(e);
    } finally {
      input.value = "";
    }
  }
  async function commitImport() {
    if (!pendingImport) return;
    busy = true;
    try {
      snapshot = await importAtlasJson(pendingImport.text);
      pendingImport = null;
      flash("旧记忆已导入");
    } catch (e) {
      error = readable(e);
    } finally {
      busy = false;
    }
  }
</script>

{#if mode !== "ready"}
  <main class="lock-screen">
    <section class="lock-card">
      <div class="brand-mark">✦</div>
      <p class="eyebrow">AMIYA ATLAS</p>
      <h1>
        {mode === "loading"
          ? "正在打开你的 Atlas…"
          : mode === "create"
            ? "给记忆一个安全的家。"
            : "欢迎回来。"}
      </h1>
      <p class="muted">你只管说，Atlas 替你记住。</p>
      {#if mode !== "loading"}<form on:submit|preventDefault={enter}>
          <label
            >主密码<input
              type="password"
              bind:value={password}
              autocomplete={mode === "create"
                ? "new-password"
                : "current-password"}
            /></label
          >{#if mode === "create"}<label
              >再输入一次<input
                type="password"
                bind:value={passwordConfirm}
                autocomplete="new-password"
              /></label
            >
            <p class="muted">
              至少 12 个字符。你的记忆保存在本机的加密数据库中。
            </p>{/if}<button class="primary" disabled={busy}
            >{busy
              ? "正在打开…"
              : mode === "create"
                ? "创建我的 Atlas"
                : "解锁"}</button
          >
        </form>{/if}{#if error}<div class="error" role="alert">
          {error}
        </div>{/if}
    </section>
  </main>
{:else}
  <div class="app-shell">
    <aside class="sidebar">
      <a
        class="brand"
        href="#home"
        on:click|preventDefault={() => navigate("Home")}
        ><span class="brand-mark">✦</span><span
          >Atlas<small>by Amiya</small></span
        ></a
      >
      <p class="sidebar-label">你的数字世界</p>
      <nav aria-label="主导航">
        {#each pages as item}<button
            class:active={page === item}
            on:click={() => navigate(item)}
            ><span class="nav-symbol">{symbols[item]}</span><span
              >{labels[item]}<small>{item}</small></span
            >{#if item === "Inbox" && pending.length}<span class="count"
                >{pending.length}</span
              >{/if}</button
          >{/each}
      </nav>
      <div class="sidebar-bottom">
        <div class="local-label">
          <span></span>{config.kind === "openai-compatible"
            ? "使用你选择的远程模型"
            : "本地模型 · 本机保存"}
        </div>
        <button class="text-button" on:click={lock}>锁定记忆库 ↗</button>
      </div>
    </aside>
    <main class="main-area">
      <header class="topbar">
        <span>我的 Atlas <span class="slash">/</span> {labels[page]}</span><span
          class="pill"
          >{isTauri
            ? "PRIVATE BY DEFAULT"
            : "临时浏览器预览 · 刷新后重置"}</span
        >
      </header>
      <div class="page-content">
        {#if error}<div class="error" role="alert">
            {error}
          </div>{/if}{#if notice}<div class="notice" role="status">
            {notice}<button aria-label="关闭提示" on:click={() => (notice = "")}
              >×</button
            >
          </div>{/if}
        {#if page === "Home"}
          <section class="home-intro">
            <p class="eyebrow">LESS TO REMEMBER. MORE TO CREATE.</p>
            <h1>今天要告诉 Atlas 什么？</h1>
            <p>账号、项目、一次决定。说出来，让它们有迹可循。</p>
          </section>
          <form class="capture-card" on:submit|preventDefault={capture}>
            <label class="sr-only" for="capture">告诉 Atlas 一件事</label
            ><textarea
              id="capture"
              bind:this={captureInput}
              bind:value={text}
              maxlength="10000"
              placeholder="比如：Saily 是我的美国备用号码，每个月六块多，暂时保留。"
              rows="4"
              disabled={busy}></textarea>
            <div class="capture-footer">
              <span
                ><span class="tiny-spark">✦</span> 自动整理，等你确认
                <kbd>Ctrl K</kbd></span
              ><button
                class="primary"
                disabled={busy || !text.trim()}
                type="submit"
                >{busy ? "正在理解…" : "帮我记住"} <span>↗</span></button
              >
            </div>
          </form>
          <div class="example-row">
            <span>试着告诉它</span
            >{#each ["一个号码", "一项订阅", "一次注册"] as label, i}<button
                class="example-chip"
                disabled={busy}
                on:click={() => {
                  text = samples[i];
                  captureInput?.focus();
                }}>{label} ＋</button
              >{/each}
          </div>
          <section class="recent-section">
            <div class="section-heading">
              <div>
                <p class="eyebrow">YOUR MEMORY, AT A GLANCE</p>
                <h2>最近记住</h2>
              </div>
              <button class="text-button" on:click={() => navigate("Memory")}
                >全部记忆 ↗</button
              >
            </div>
            {#if recent.length}<div class="memory-grid">
                {#each recent.slice(0, 3) as entity}<button
                    class="memory-card"
                    on:click={() => openEntity(entity.id)}
                    ><div class="memory-card-top">
                      <span class="entity-icon"
                        >{entity.name.slice(0, 1).toUpperCase()}</span
                      ><span class="muted">↗</span>
                    </div>
                    <strong>{entity.name}</strong><span>{entity.category}</span>
                    <div class="memory-card-meta">
                      {entity.fields.find(
                        (f) =>
                          ["region", "country", "provider"].includes(f.key) &&
                          f.privacy !== "SECRET",
                      )?.value ?? "已确认的记忆"}
                    </div></button
                  >{/each}
              </div>{:else}<div class="empty-state">
                从第一句话开始。记忆会慢慢连成你的数字世界。
              </div>{/if}
          </section>
          <div class="home-bottom">
            <section class="panel">
              <div class="section-heading">
                <h2>待确认 <span class="count">{pending.length}</span></h2>
                <button class="text-button" on:click={() => navigate("Inbox")}
                  >查看 ↗</button
                >
              </div>
              {#if pending.length}<p class="muted">
                  {pending[0].rawText.slice(0, 100)}
                </p>{:else}<p class="muted">
                  都整理好了。没有待确认的内容。
                </p>{/if}
            </section>
            <section class="panel">
              <div class="section-heading">
                <h2>即将处理</h2>
                <span class="muted">LIFECYCLE</span>
              </div>
              {#if upcoming.length}{#each upcoming.slice(0, 2) as event}<button
                    class="event-row"
                    on:click={() => openEntity(event.entityId)}
                    ><span>{name(event.entityId)}</span><span
                      >{date(event.dueAt)} · {event.policy === "DO_NOT_RENEW"
                        ? "不续费"
                        : event.type === "EXPIRY"
                          ? "到期"
                          : "待处理"}</span
                    ></button
                  >{/each}{:else}<p class="muted">
                  有时间安排时，Atlas 会记在这里。
                </p>{/if}
            </section>
          </div>
        {:else if page === "Inbox"}
          {#if preview && previewCapture}<ProposalPreview
              record={preview}
              capture={previewCapture}
              entities={snapshot.entities}
              {busy}
              onConfirm={confirm}
              onLater={later}
            />{:else}<div class="page-heading">
              <p class="eyebrow">YOUR WORDS, WAITING TO BECOME MEMORY</p>
              <h1>待确认</h1>
              <p>原话已经保留。看看 Atlas 理解得对不对。</p>
            </div>
            {#if pending.length}<div class="inbox-list">
                {#each pending as input}{@const proposal =
                    snapshot.proposals?.find(
                      (p) => p.captureId === input.id && p.status === "PENDING",
                    )}
                  <article class="panel inbox-item">
                    <div class="section-heading">
                      <span class="pill"
                        >{proposal ? "提案已准备好" : "等待解析"}</span
                      ><span class="muted">{date(input.timestamp)}</span>
                    </div>
                    <p>{input.rawText}</p>
                    <div class="button-row">
                      <button
                        class="text-button danger"
                        disabled={busy}
                        on:click={() => dismiss(input.id)}>暂不整理</button
                      ><button
                        class="secondary"
                        disabled={busy}
                        on:click={() => parseCapture(input)}
                        >{parsingId === input.id
                          ? "正在理解…"
                          : proposal
                            ? "重新解析"
                            : "重新尝试"}</button
                      >{#if proposal}<button
                          class="primary"
                          disabled={busy}
                          on:click={() => (previewId = proposal.id)}
                          >检查并确认</button
                        >{/if}
                    </div>
                  </article>{/each}
              </div>{:else}<div class="empty-state">
                <span class="empty-spark">✦</span>
                <h2>没有待确认的内容</h2>
                <p>回首页说一件想记住的事。</p>
                <button class="primary" on:click={() => navigate("Home")}
                  >记第一句话</button
                >
              </div>{/if}{/if}
        {:else if page === "Search" || page === "Memory"}
          {#if selected}<div class="detail-header">
              <button class="text-button" on:click={() => (selectedId = "")}
                >← 全部记忆</button
              ><button class="primary" on:click={() => explore(selected.id)}
                >探索关联 ◇</button
              >
            </div>
            <article class="detail-card">
              <span class="pill">{selected.category}</span>
              <h1>{selected.name}</h1>
              <p class="muted">
                {selected.status} · 最近更新 {date(selected.updatedAt)}
              </p>
              <dl class="detail-fields">
                {#each selected.fields.filter((f) => f.privacy !== "SECRET") as field}<div
                  >
                    <dt>{attributeLabel(field.key)}</dt>
                    <dd>{display(field.value)}</dd>
                  </div>{/each}
              </dl>
              {#if !selected.fields.length}<p class="muted">
                  这条记忆还没有更多属性。
                </p>{/if}
              <h2>关联</h2>
              {#if selectedRelations.length}{#each selectedRelations as relation}<button
                    class="relation-row"
                    on:click={() =>
                      openEntity(
                        relation.sourceId === selected.id
                          ? relation.targetId
                          : relation.sourceId,
                      )}
                    ><span
                      >{relation.sourceId === selected.id ? "→" : "←"}
                      {relation.type}</span
                    ><strong
                      >{name(
                        relation.sourceId === selected.id
                          ? relation.targetId
                          : relation.sourceId,
                      )}</strong
                    ></button
                  >{/each}{:else}<p class="muted">
                  还没有已确认的关联。
                </p>{/if}{#if snapshot.events.some((e) => e.entityId === selected.id)}<h2
                >
                  生命周期
                </h2>
                {#each snapshot.events.filter((e) => e.entityId === selected.id) as event}<div
                    class="event-detail"
                  >
                    <strong>{date(event.dueAt)} · {event.type}</strong><span
                      >{event.policy === "DO_NOT_RENEW"
                        ? "不续费"
                        : event.policy}</span
                    >
                    <p class="muted">{event.note ?? ""}</p>
                  </div>{/each}{/if}{#if sources.length}<h2>当时你说的是</h2>
                {#each sources as source}<blockquote class="original">
                    {source.rawText}
                    <footer>{date(source.timestamp)}</footer>
                  </blockquote>{/each}{/if}
            </article>{:else}<div class="page-heading">
              <p class="eyebrow">
                {page === "Search"
                  ? "FIND WHAT YOUR MIND LEFT BEHIND"
                  : "A WORLD YOU CAN COME BACK TO"}
              </p>
              <h1>{page === "Search" ? "想找什么？" : "你的记忆"}</h1>
              <p>
                {page === "Search"
                  ? "搜索名称、地区或备注，也可以让 Atlas 理解你的问题。"
                  : "每一条都来自你确认过的信息。"}
              </p>
            </div>
            <form class="search-box" on:submit|preventDefault={ask}>
              <span>⌕</span><input
                bind:value={query}
                placeholder={page === "Search"
                  ? "美国，或者「我有哪些日本的东西？」"
                  : "搜索名称、地区、备注…"}
                aria-label="搜索记忆"
                on:input={() => {
                  queryAnswer = "";
                  queryRegion = "";
                }}
              />{#if page === "Search"}<button
                  class="secondary"
                  disabled={busy || !query.trim()}
                  type="submit">{busy ? "正在理解…" : "理解问题"}</button
                >{/if}
            </form>
            {#if queryAnswer}<p class="muted">
                {queryAnswer}。结果来自数据库。
              </p>{/if}
            <div class="list-heading">
              <span>{results.length} 条记忆</span><span>仅显示已确认的内容</span
              >
            </div>
            {#if results.length}<div class="entity-list">
                {#each results as entity}<button
                    class="entity-list-item"
                    on:click={() => openEntity(entity.id)}
                    ><span class="entity-icon"
                      >{entity.name.slice(0, 1).toUpperCase()}</span
                    >
                    <div>
                      <strong>{entity.name}</strong><small
                        >{entity.category} · {entity.status}</small
                      >
                    </div>
                    <span>↗</span></button
                  >{/each}
              </div>{:else}<div class="empty-state">
                没有找到相关记忆。试试名称、地区或备注中的关键词。
              </div>{/if}{/if}
        {:else if page === "Explore"}
          <div class="page-heading">
            <p class="eyebrow">FOLLOW THE CONNECTIONS</p>
            <h1>探索你的数字世界</h1>
            <p>从一个记忆开始，按需展开它的关联。</p>
          </div>
          <label class="root-picker"
            >从这里开始<select bind:value={rootId}
              ><option value="">选择一个记忆</option
              >{#each snapshot.entities.filter((e) => e.privacy !== "SECRET") as entity}<option
                  value={entity.id}>{entity.name}</option
                >{/each}</select
            ></label
          >{#if rootId}<ExploreCanvas
              {snapshot}
              {rootId}
              onOpen={openEntity}
            />{:else}<div class="empty-state">
              先选择一个记忆，画布只会显示与它相关的节点。
            </div>{/if}
        {:else if page === "Settings"}
          <div class="page-heading">
            <p class="eyebrow">MAKE ATLAS FEEL LIKE YOURS</p>
            <h1>设置</h1>
            <p>默认留在本机。也可以连接你选择的模型。</p>
          </div>
          <section class="panel settings-panel">
            <h2>理解你的模型</h2>
            <div class="provider-options">
              {#each [["local", "Atlas Local", "默认 · 本机私密"], ["ollama", "Ollama", "使用已有本地服务"], ["openai-compatible", "OpenAI Compatible", "自定义 URL / Key / Model"]] as [kind, title, subtitle]}<button
                  class:chosen={settingsConfig.kind === kind}
                  on:click={() => configure(kind as ProviderConfig["kind"])}
                  ><strong>{title}</strong><small>{subtitle}</small></button
                >{/each}
            </div>
            {#if settingsConfig.kind === "local"}<div class="local-model">
                <span class="model-monogram">Q</span>
                <div>
                  <h3>Qwen3.5 2B · Lite</h3>
                  <p>
                    模型约 1.9 GB。首次使用另需下载运行时约 1.5
                    GB，解压后需要更多空间。
                  </p>
                  <p class="muted">
                    自动配置，关闭思考模式。输入在本机解析，下载完成后可离线使用。
                  </p>
                </div>
              </div>
              <div class="button-row">
                <button
                  class="primary"
                  disabled={modelBusy || !isTauri}
                  on:click={prepareModel}
                  >{modelBusy
                    ? "正在准备本地模型…"
                    : "下载并准备默认模型"}</button
                ><button class="secondary" on:click={testConnection}
                  >检查模型</button
                >
              </div>
              {#if modelBusy}<p class="muted" role="status">
                  {progress.stage}{progress.total
                    ? ` · ${Math.round((progress.completed / progress.total) * 100)}%`
                    : ""}
                </p>
                {#if progress.total}<progress
                    value={progress.completed}
                    max={progress.total}
                  ></progress>{/if}{/if}{#if !isTauri}<p class="muted">
                  一键准备在 Windows x64 桌面版中使用。浏览器预览可连接已有
                  Ollama 服务。
                </p>{/if}{:else}<div class="provider-form">
                <label
                  >Base URL<input
                    bind:value={settingsConfig.baseUrl}
                    placeholder={settingsConfig.kind === "ollama"
                      ? "http://localhost:11434"
                      : "https://your-provider.example/v1"}
                  /></label
                ><label
                  >Model<input
                    bind:value={settingsConfig.model}
                    placeholder="模型名称"
                  /></label
                >{#if settingsConfig.kind === "openai-compatible"}<label
                    >API Key<input
                      type="password"
                      bind:value={settingsConfig.apiKey}
                      autocomplete="off"
                    /></label
                  ><label
                    >兼容格式<select bind:value={settingsConfig.responseFormat}
                      ><option value="json_object">JSON Object（通用）</option
                      ><option value="json_schema">JSON Schema</option><option
                        value="prompt">仅提示词约束</option
                      ></select
                    ></label
                  >
                  <p class="muted">
                    选择远程模型后，输入原文及最多 12
                    个相关实体的名称、类型会发送到这个地址。API Key
                    在桌面版的加密数据库中保存。
                  </p>{/if}
              </div>
              <button class="secondary" on:click={testConnection}
                >检查连接</button
              >{/if}{#if connection}<p class="connection-status" role="status">
                {connection}
              </p>{/if}
            <div class="settings-footer">
              <button
                class="primary"
                disabled={busy || modelBusy}
                on:click={saveSettings}>保存模型设置</button
              >
            </div>
          </section>
          <section class="panel settings-panel">
            <h2>记忆与备份</h2>
            <p class="muted">
              桌面版使用原有加密 SQLite。旧实体和关系仍能打开。
            </p>
            <div class="button-row">
              <button class="secondary" on:click={backup} disabled={!isTauri}
                >导出加密备份</button
              ><label class="file-button secondary"
                >恢复加密备份<input
                  type="file"
                  accept=".json"
                  on:change={(e) => file(e, "restore")}
                  disabled={!isTauri}
                /></label
              ><button class="secondary" on:click={redacted}
                >导出脱敏清单</button
              ><label class="file-button secondary"
                >导入旧 Atlas JSON<input
                  type="file"
                  accept=".json"
                  on:change={(e) => file(e, "import")}
                /></label
              >
            </div>
            {#if pendingImport}<div class="import-preview">
                <p>{pendingImport.summary}</p>
                <p class="muted">确认后合并到已有记忆。</p>
                <div class="button-row">
                  <button
                    class="secondary"
                    on:click={() => (pendingImport = null)}>取消</button
                  ><button
                    class="primary"
                    disabled={busy}
                    on:click={commitImport}>确认导入</button
                  >
                </div>
              </div>{/if}
          </section>
        {/if}
        <footer class="page-footer">
          <span>Tell Atlas. It remembers.</span><span
            >你确认的，才是记忆。 ✦</span
          >
        </footer>
      </div>
    </main>
  </div>
{/if}
