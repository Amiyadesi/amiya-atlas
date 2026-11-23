<script lang="ts">
  import ImportCenter from "./features/import/ImportCenter.svelte";
  import StarterCard from "./features/onboarding/StarterCard.svelte";
  import QuickSheet from "./features/capture/QuickSheet.svelte";
  import EntryForm from "./features/ledger/EntryForm.svelte";
  import type {Transaction} from "./domain/ledger";
  import type {IconName} from "./lib/Icon.svelte";
  import MonthSwitcher from "./lib/MonthSwitcher.svelte";
  import QuickEntry from "./features/ledger/QuickEntry.svelte";
  import type {ImportTab} from "./domain/importers/types";
  import {reverseTransaction,validateLedger} from "./domain/ledger";
  import { cancelDialogs, confirmDialog, promptDialog } from "./lib/dialog";
  import DialogHost from "./lib/DialogHost.svelte";
  import CommandPalette from "./features/command/CommandPalette.svelte";
  import UpdateSettings from "./features/update/UpdateSettings.svelte";
  import { APP_VERSION, getUpdatePrefs, saveUpdatePrefs, checkForUpdate, openUpdateDownload, type UpdatePrefs, type UpdateCheckResult } from "./lib/updater";
  import type { Command } from "./features/command/search";
  import { initTheme, themePreference, resolvedTheme, themeNames, setTheme, type Preference } from "./lib/theme";
  import { categoryColors } from "./features/graph/layout";
  import { memoryIndex, sortMemory, sortNames, type MemorySort } from "./lib/memory";
  import LedgerPage from './features/ledger/LedgerPage.svelte';
  import MoneyGraph from './features/ledger/MoneyGraph.svelte';
  import {localLedgerProposal} from './domain/finance-capture';
  import {dateToday} from './domain/ledger';
  import {formatMoney,moneySchema} from './domain/money';
  import Icon from "./lib/Icon.svelte";
  import { onMount, tick } from "svelte";
  import { invoke, isPersistent, isHttpHost, isWindows, isMobile, isSelfhost, hasWebAccess, setWebAccess } from "./lib/runtime";
  import SyncSettings from "./features/sync/SyncSettings.svelte";
  import ServerAuth from "./features/sync/ServerAuth.svelte";
  import ServerSecurity from "./features/sync/ServerSecurity.svelte";
  import { emptySync, type SyncStatus } from "./lib/sync";
  import { selfRequest } from "./lib/selfhost-auth";
  import CloudSettings from './features/cloud/CloudSettings.svelte';
  import ManualEditor from './features/capture/ManualEditor.svelte';
  import ConnectionReview from './features/capture/ConnectionReview.svelte';
  import { categoryGroup, categoryLabel, eventLabel, RECORD_GROUPS, relationLabel, statusLabel } from './lib/record-labels';
  import { isFavorite } from './lib/record-tags';
  import { connectionGaps, connectionHints, connectionSlots, slotRelations } from './domain/relationships';
  import { clearCloudRetries } from './ai/cloud-client';
  import { listen } from "@tauri-apps/api/event";
  import {
    isTauri,
    vaultStatus,
    initializeVault,
    unlockVault,
    unlockDevice,
    setDeviceUnlock,
    loadSnapshot,
    saveSnapshot,
    lockVault,
    beginTextCapture,
    stageProposal,
    confirmProposal,
    undoProposal,
    reviseProposal,
    dismissCapture,
    saveAiConfig,
    prepareLocalModel,
    readCaptureClipboard,
    warmLocalModel,
    exportBackup,
    importBackup,
    exportRedacted,
    previewAtlasJson,
    importAtlasJson,
  } from "./lib/api";
  import { emptySnapshot } from "./lib/types";
  import type { Entity, VaultSnapshot } from "./lib/types";
  import {
    DEFAULT_PROVIDER,
    LOCAL_MODELS,
    createProvider,
  } from "./ai/provider";
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
  import CaptureComposer from "./features/capture/CaptureComposer.svelte";
  import { PcmRecorder } from "./features/voice/recorder";
  import {
    voiceStatus,
    prepareVoice,
    transcribeVoice,
    cancelVoice,
  } from "./features/voice/api";

  type Page = "Ledger" | "Home" | "Memory" | "Explore" | "Inbox" | "Settings";
  const pages: Page[] = ["Home", "Memory", "Ledger", "Settings"];
  const labels: Record<Page, string> = {
    Ledger: "洞察",
    Home: "今日",
    Memory: "资产",
    Explore: "关系图",
    Inbox: "待确认",
    Settings: "我的",
  };
  let mode: "loading" | "access" | "create" | "unlock" | "ready" = "loading";
  let access = "";
  let syncStatus: SyncStatus = { ...emptySync };
  let syncBusy = false;
  let syncError = "";
  let snapshot: VaultSnapshot = emptySnapshot();
  let page: Page = "Home";
  let mePage="", insight="回顾", filtersOpen=false, previewing=false;
  let original:Transaction|undefined, order:Entity|undefined;
  let menuOpen=false;
  $: activePage=page==="Explore"?"Memory":page==="Inbox"?"Home":page;
  $: ledgerTab=page==="Home"?"流水":page==="Settings"?"账户":insight;
  function openSettings(title:string){navigate("Settings");mePage=title;}
  async function routeSpecial(t:Transaction){
    if(t.kind==="TRADE"){navigate("Ledger");insight="投资";}
    else openSettings("资金账户与对账");
    await tick();await ledgerPage.repeatSpecial(t);
  }
  let updatePrefs = getUpdatePrefs(), updateInfo: UpdateCheckResult | null = null;
  let checkingUpdate = false, updateError = "", updateRequest = 0, showUpdateErrors = false;
  let startupChecked = false;
  $: if (mode === "ready" && !startupChecked) {
    startupChecked = true;
    const age = Date.now() - updatePrefs.lastCheckedAt;
    if (updatePrefs.autoCheck && (age > 6 * 60 * 60 * 1000 || age < 0)) void checkUpdate(true);
  }
  function changeUpdatePrefs(change: Partial<UpdatePrefs>) {
    if ((change.source !== undefined && change.source !== updatePrefs.source) ||
        (change.customMirror !== undefined && change.customMirror !== updatePrefs.customMirror)) {
      updateRequest++;
      updateInfo = null; updateError = ""; checkingUpdate = false;
    }
    updatePrefs = {...updatePrefs, ...change};
    try { saveUpdatePrefs(updatePrefs); }
    catch { if (!("lastCheckedAt" in change)) flash("偏好仅在本次使用中生效"); }
  }
  async function checkUpdate(silent = false) {
    if (!silent) showUpdateErrors = true;
    if (checkingUpdate) return;
    const request = ++updateRequest;
    checkingUpdate = true; showUpdateErrors = !silent; updateError = ""; updateInfo = null;
    try {
      const info = await checkForUpdate(updatePrefs);
      if (request === updateRequest) updateInfo = info;
    } catch (e) {
      if (request === updateRequest && showUpdateErrors) updateError = readable(e);
    } finally {
      if (request === updateRequest) {
        checkingUpdate = false;
        changeUpdatePrefs({lastCheckedAt: Date.now()});
      }
    }
  }
  async function updateDetails(check = false) {
    openSettings("应用更新");
    await tick();
    const panel = document.getElementById("app-update");
    panel?.focus({preventScroll: true}); panel?.scrollIntoView({block: "start"});
    if (check) void checkUpdate();
  }
  function openUpdate(url: string) {
    void openUpdateDownload(url, updatePrefs.customMirror).catch(e => error = readable(e));
  }
  let paletteOpen = false, relationEditor = false;
  let ledgerPage: LedgerPage;
  let importTab:ImportTab|null=null, captureMode:"asset"|"bill"="asset", draftEntity:Entity|undefined;
  let quickUndo:{revision:number;ids:string[]}|null=null;
  async function saveLocal(next:VaultSnapshot,message:string) {
    if(busy || mode!=="ready") throw new Error("请等待当前操作完成");
    const token=epoch;busy=true;
    try {const value=await saveSnapshot(next);
      if(token!==epoch) return;
      snapshot=value;flash(message);
    } finally {if(token===epoch)busy=false;}
  }
  async function saveQuick(next:VaultSnapshot,ids:string[]) {
    const token=epoch;
    await saveLocal(next,"已入账 "+ids.length+" 笔");
    if(epoch===token)quickUndo={revision:snapshot.revision,ids};
  }
  async function undoQuick() {
    if(!quickUndo || quickUndo.revision!==snapshot.revision || busy)return;
    try {
      const ids=new Set(quickUndo.ids),txs=snapshot.transactions??[];
      const next={...snapshot,transactions:[...txs,...txs.filter(t=>ids.has(t.id)).map(t=>reverseTransaction(t,t.occurredAt))]};
      validateLedger(next,snapshot);await saveLocal(next,"已撤销，原流水与冲正分录均已保留");quickUndo=null;
    }catch(e){error=readable(e);}
  }
  function canSwitchCapture() {
    if (!recording && !voiceBusy) return true;
    flash("请先完成或取消录音");
    return false;
  }
  function startExpense(tx?:Transaction,source?:Entity){
    if(busy || !canSwitchCapture())return;
    original=tx;order=source;previewing=false;captureMode="bill";quickOpen=true;error="";
  }
  let memoryView: "list" | "card" = "list", memorySort: MemorySort = "updated";
  function openPalette() {
    if (mode === "ready" && !busy && !recording && !voiceBusy && !document.querySelector("dialog[open]")) paletteOpen = true;
  }
  async function ledgerCommand(id?: string) {
    if (!id){startExpense();return;}
    navigate("Home");await tick();ledgerPage.showAccount(id);
  }
  function showImport(tab:ImportTab) { if (canSwitchCapture()) {quickOpen=false;importTab=tab;} }
  function openImport() { showImport("assets"); }
  $: commands = [
    {label:"新建记录", run:()=>editRecord()},
    {label:"记一笔", run:()=>ledgerCommand()},
    {label:"导入数据", detail:"账号、密码管理器与账单", run:openImport},
    {label:"切换浅/暗色模式", detail:themeNames[$resolvedTheme], run:()=>setTheme($resolvedTheme === "dark" ? "light" : "dark")},
    {label:"导出加密备份", detail:isPersistent ? undefined : "需要持久记忆库", disabled:!isPersistent, run:backup},
    {label:"锁定记忆库", run:lock},
  ].map(c=>({...c, group:"操作"})) as Command[];
  const palettePages = [...pages,"Inbox" as const,"Explore" as const].map(p=>({label:labels[p], group:"页面", keywords:p, run:()=>navigate(p)}));
  let graphMode="relation";
  let currentMonth=dateToday().slice(0,7);
  let password = "";
  let passwordConfirm = "";
  let rememberDevice = isWindows;
  let deviceUnlockEnabled = false;
  let accountCode = "";
  let accountMessage = "";
  let accountTimer: ReturnType<typeof setTimeout> | undefined;
  let idleMinutes = 0;
  let recordGroup = "";
  let connectionsOnly = false, detailFromGraph = false;
  let editorOpen = false;
  let connectionsOpen = false;
  let editedEntity: Entity | undefined;
  let text = "";
  let query = "";
  let interpretedQuery: { search: string; region: string } | null = null;
  let busy = false;
  let modelBusy = false;
  let parsingId = "";
  let error = "";
  let notice = "";
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let selectedId = "";
  let rootId = "";
  let previewId = "";
  let config: ProviderConfig = { ...DEFAULT_PROVIDER };
  let settingsConfig: ProviderConfig = { ...DEFAULT_PROVIDER };
  let connection = "";
  let progress = { stage: "", completed: 0, total: 0 };
  let quickInput: HTMLTextAreaElement;
  let quickOpen = false;
  let inputType: TextCapture["inputType"] = "text";
  let recording = false;
  let voiceBusy = false;
  let voiceInstalling = false;
  let voiceLabel = "正在本机转写…";
  let voiceSeconds = 0;
  let voiceLevel = 0;
  let voiceLanguage = "auto";
  let voiceInfo = {
    supported: isWindows,
    ready: false,
    model: "Whisper Small Q5_1",
    prerequisite: null as string | null,
  };
  let voiceProgress = { stage: "", completed: 0, total: 0 };
  let quickStatus = {
    enabled: true,
    shortcuts: [] as Array<{
      action: string;
      key: string;
      registered: boolean;
    }>,
  };
  let recorder: PcmRecorder | undefined;
  let voiceTimer: number | undefined;
  let voiceEpoch = 0;
  let epoch = 0;
  let nextServerDiscovery = 0;
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
  $: lastUndo = snapshot.proposals?.find(
    (p) =>
      p.status === "CONFIRMED" && p.undo?.appliedRevision === snapshot.revision,
  );
  $: recent = snapshot.entities
    .filter((e) => e.privacy !== "SECRET")
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);
  $: connectionNeeds = new Set(snapshot.entities.filter(e=>e.privacy!=="SECRET" && (connectionGaps(e,snapshot).length || connectionSlots(e.category).some(slot=>!slotRelations(slot,e.id,snapshot.relations).length && connectionHints(e,slot).length))).map(e=>e.id));
  $: memoryColors = categoryColors($resolvedTheme);
  $: memoryMeta = memoryIndex(snapshot);
  $: results = sortMemory(searchEntities(
    snapshot,
    interpretedQuery?.search ?? query,
    interpretedQuery?.region ?? "",
  ).filter(entity => (!recordGroup || categoryGroup(entity.category) === recordGroup) && (!connectionsOnly || connectionNeeds.has(entity.id))), memorySort, memoryMeta);
  $: selected = snapshot.entities.find(
    (e) => e.id === selectedId && e.privacy !== "SECRET",
  );
  $: upcoming = snapshot.events
    .filter((e) => (e.status === "UPCOMING" || e.status === "UNKNOWN") && snapshot.entities.some(a=>a.id===e.entityId && a.privacy !== "SECRET"))
    .slice()
    .sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"));
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
  type SettingRow={title:string;icon:IconName;tint:string;value?:string};
  let settingsGroups:{title:string;rows:SettingRow[]}[];
  $: settingsGroups=[
    {title:"数据与账本",rows:[
      {title:"数据导入中心",icon:"Upload",tint:"var(--info)",value:"Bitwarden / 账单"},
      {title:"资金账户与对账",icon:"Wallet",tint:"var(--income)",value:(snapshot.ledgerAccounts??[]).filter(a=>a.privacy!=="SECRET").length+" 个账户"},
      {title:"备份与导出",icon:"Download",tint:"var(--info)",value:"加密备份"}]},
    {title:"智能与同步",rows:[
      {title:"AI 模型",icon:"Action",tint:"var(--accent)",value:config.kind==="cloud"?"官网云服务":config.kind==="openai-compatible"?"自带 API":"本地模型"},
      {title:"多端同步",icon:"Sync",tint:"var(--income)",value:syncStatus.configured?(syncStatus.automatic?"已开启":"手动同步"):"未配置"},
      ...(!isMobile && !/Android|iPhone|iPad/i.test(navigator.userAgent)?[{title:"快捷与语音",icon:"Voice" as const,tint:"var(--warning)"}]:[])]},
    {title:"外观与安全",rows:[
      {title:"外观主题",icon:"Theme",tint:"var(--accent)"},
      {title:"安全与锁屏",icon:"Shield",tint:"var(--info)",value:"锁定"},
      {title:"应用更新",icon:"Download",tint:"var(--accent)",value:updateInfo?.hasUpdate?"● 有新版本":"v"+APP_VERSION}]}];
  const readable = (e: unknown) => (e instanceof Error ? e.message : String(e));
  function flash(message: string) {
    if (noticeTimer) clearTimeout(noticeTimer);
    notice = message;
    noticeTimer = setTimeout(() => notice = "", 5000);
  }
  function name(id: string) {
    return snapshot.entities.find((e) => e.id === id)?.name ?? "未知记忆";
  }
  function display(value: unknown) {
    const amount=moneySchema.safeParse(value);
    if(amount.success)return formatMoney(amount.data);
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
    if (recording || voiceBusy) stopVoice();
    if (next === "Explore") rootId = "";
    page = next;mePage="";filtersOpen=false;menuOpen=false;
    window.scrollTo(0,0);
    detailFromGraph = false;
    selectedId = "";
    previewId = "";
    error = "";
  }
  function openEntity(id: string) {
    if (page === "Explore") { detailFromGraph=true;rootId=id; }
    selectedId = id;
    page = "Memory";
    previewId = "";
    error = "";
  }
  function closeDetail() {
    if (detailFromGraph) page="Explore";
    selectedId="";
  }
  async function favorite(entity: Entity) {
    if (busy) return;
    busy=true;
    const token = epoch;
    try {
      const next=structuredClone(snapshot), item=next.entities.find(e=>e.id===entity.id)!;
      item.tags=item.tags.some(isFavorite)?item.tags.filter(t=>!isFavorite(t)):[...item.tags,"⭐ 收藏"];
      item.updatedAt=new Date().toISOString();
      const updated = await saveSnapshot(next);
      if (token === epoch) snapshot = updated;
    } catch(value) {if (token === epoch) error=readable(value);}
    finally {if (token === epoch) busy=false;}
  }
  function editRecord(entity?: Entity, relations = false) {
    quickOpen=false;
    relationEditor = relations;
    draftEntity = undefined;
    editedEntity = entity;
    editorOpen = true;
  }
  function recordSaved(value: VaultSnapshot, id: string) {
    if (mode !== "ready") return;
    snapshot = value;
    editorOpen = false;
    editedEntity = undefined;
    openEntity(id);
    flash(id ? "已保存" : "已删除");
  }
  async function saveLockPolicy() {
    try { await invoke("set_idle_minutes", { minutes: Number(idleMinutes) }); flash("已保存"); }
    catch (value) { error = readable(value); }
  }
  function explore(id: string) {
    graphMode = "relation";
    selectedId = "";
    rootId = id;
    page = "Explore";
  }
  function configure(kind: ProviderConfig["kind"]) {
    if(kind==='cloud') {
      settingsConfig={kind:'cloud',baseUrl:'https://atlas.sayori.org',model:'qwen3.7-flash-2026-07-15',apiKey:'',responseFormat:'json_schema'};
      connection='';return;
    }
    settingsConfig =
      kind === "local"
        ? { ...DEFAULT_PROVIDER }
        : {
            kind,
            baseUrl:
              kind === "ollama"
                ? "http://localhost:11434"
                : "https://api.example.com/v1",
            model: kind === "ollama" ? DEFAULT_PROVIDER.model : "",
            apiKey: "",
            responseFormat: "json_object",
          };
    connection = "";
  }
  function clearPrivateState() {
    paletteOpen = connectionsOpen = false;
    importTab=null; quickUndo=null; draftEntity=undefined; captureMode="asset";
    page="Home";mePage="";original=order=undefined;filtersOpen=false;recordGroup="";connectionsOnly=false;currentMonth=dateToday().slice(0,7);
    cancelDialogs();
    editorOpen = false;
    editedEntity = undefined;
    clearCloudRetries();
    stopVoice();
    quickOpen = false;
    epoch++;
    snapshot = emptySnapshot();
    text = "";
    inputType = "text";
    query = "";
    selectedId = "";
    rootId = "";
    previewId = "";
    password = "";
    passwordConfirm = "";
    config = { ...DEFAULT_PROVIDER };
    settingsConfig = { ...DEFAULT_PROVIDER };
    syncStatus = { ...emptySync };
    nextServerDiscovery = 0;
    syncError = "";
    busy = false;
    parsingId = "";
    notice = "";
    error = "";
    pendingImport = null;
    interpretedQuery = null;
    connection = "";
  }
  async function sync() {
    if (!isPersistent || mode !== "ready" || busy || syncBusy || document.hidden) return;
    syncBusy = true;
    const token = epoch;
    const revision = snapshot.revision;
    try {
      const status = await vaultStatus();
      if (token !== epoch || mode !== "ready") return;
      deviceUnlockEnabled = Boolean(status.deviceUnlockEnabled);
      idleMinutes = status.idleMinutes ?? 0;
      if (!status.unlocked) {
        clearPrivateState();
        mode = "unlock";
        return;
      }
      let settings = await invoke<SyncStatus>("sync_status");
      if (token !== epoch || mode !== "ready") return;
      if (!isSelfhost && !settings.configured && Date.now() >= nextServerDiscovery) {
        nextServerDiscovery = Date.now() + 300000;
        const cloud = await invoke<{connected:boolean}>("cloud_status");
        if(cloud.connected){
          const directory=await invoke<{servers:Array<{id:string}>}>("cloud_request",{path:"/api/account/servers"});
          if(token!==epoch||mode!=="ready")return;
          if(directory.servers.length===1)settings=await invoke<SyncStatus>("sync_cloud_connect",{id:directory.servers[0].id});
        }
      }
      syncStatus = settings;
      if (settings.automatic && !syncStatus.conflicts.length) {
        try {
          const result = await invoke<SyncStatus>("sync_run");
          if (token !== epoch || mode !== "ready") return;
          syncStatus = result;
          syncError = "";
        } catch (e) {
          if (token === epoch) syncError = readable(e) === "REMOTE_VAULT_DIFFERENT" ? "远端是另一份记忆库，请在同步设置中导入" : readable(e);
        }
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
      if(token===epoch)error = readable(e);
    } finally {
      syncBusy = false;
    }
  }
  async function boot() {
    try {
      if (isHttpHost && !(await hasWebAccess())) { mode = "access"; return; }
      const deviceCode = isSelfhost ? new URLSearchParams(location.search).get("user_code") : null;
      if (deviceCode && await confirmDialog({ title: "允许设备同步？", description: `设备代码：${deviceCode}`, confirmLabel: "允许同步" })) { await selfRequest("/api/auth/device?user_code=" + encodeURIComponent(deviceCode)); await selfRequest("/api/auth/device/approve", { userCode: deviceCode }); history.replaceState(null, "", location.pathname); flash("设备已连接"); }
      const status = await vaultStatus();
      deviceUnlockEnabled = isWindows && Boolean(status.deviceUnlockEnabled);
      rememberDevice = isWindows;
      idleMinutes = status.idleMinutes ?? 0;
      mode = !status.exists ? "create" : status.unlocked ? "ready" : "unlock";
      if (!status.unlocked && status.exists && deviceUnlockEnabled) { await enterDevice(); return; }
      if (status.unlocked) { await refreshSnapshot(); void refreshTools(); void sync(); }
    } catch (e) { error = readable(e); mode = isHttpHost ? "access" : "unlock"; }
  }
  async function refreshSnapshot() {
    const token = epoch;
    const fresh = await loadSnapshot();
    if (token !== epoch) return;
    snapshot = fresh;
    config = { ...(snapshot.aiConfig ?? (isWindows ? DEFAULT_PROVIDER : { ...DEFAULT_PROVIDER, kind: "ollama", baseUrl: "http://localhost:11434" })) };
    settingsConfig = { ...config };
    if (isPersistent) syncStatus = await invoke<SyncStatus>("sync_status");
  }
  async function enterAccess() {
    error = ""; setWebAccess(access); access = ""; await boot();
  }
  onMount(() => {
    const stopTheme = initTheme();
    const unlisteners: Array<() => void> = [];
    let alive = true;
    if (isTauri)
      void listen<typeof progress>("atlas-model-progress", (event) => {
        if (alive) progress = event.payload;
      }).then((fn) => {
        if (alive) unlisteners.push(fn);
        else fn();
      });
    if (isTauri) {
      void listen<typeof voiceProgress>("atlas-voice-progress", (event) => {
        if (alive) voiceProgress = event.payload;
      }).then((fn) => {
        if (alive) unlisteners.push(fn);
        else fn();
      });
      void listen<string>("atlas-quick-capture", (event) => {
        if (alive) void openQuickCapture(event.payload);
      }).then((fn) => {
        if (alive) unlisteners.push(fn);
        else fn();
      });
    }
    const keydown = (e: KeyboardEvent) => {
      if (!e.repeat && !e.isComposing && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        if (mode === "ready") void lock();
        else if (mode === "unlock" && deviceUnlockEnabled) void enterDevice();
      }
      if (
        mode === "ready" &&
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        openPalette();
      }
      if (e.key === "Escape" && (recording || voiceBusy)) {
        e.preventDefault();
        stopVoice();
      }
      if (
        !isTauri &&
        !e.repeat &&
        !e.isComposing &&
        (e.ctrlKey || e.metaKey) &&
        ((e.shiftKey && e.code === "Space") ||
          (e.altKey && ["KeyV", "KeyR"].includes(e.code)))
      ) {
        e.preventDefault();
        void openQuickCapture(
          e.code === "KeyV"
            ? "clipboard"
            : e.code === "KeyR"
              ? "voice"
              : "text",
        );
      }
    };
    const focus = () => void sync();
    window.addEventListener("keydown", keydown);
    window.addEventListener("focus", focus);
    window.addEventListener("online", focus);
    document.addEventListener("visibilitychange", focus);
    const timer = window.setInterval(() => void sync(), 30000);
    void boot();
    return () => {
      stopTheme();
      alive = false;
      epoch++;
      stopVoice();
      unlisteners.forEach((fn) => fn());
      window.clearInterval(timer);
      if (noticeTimer) clearTimeout(noticeTimer);
      if (accountTimer) clearTimeout(accountTimer);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("focus", focus);
      window.removeEventListener("online", focus);
      document.removeEventListener("visibilitychange", focus);
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
      if (isWindows && rememberDevice !== deviceUnlockEnabled) {
        await setDeviceUnlock(rememberDevice);
        deviceUnlockEnabled = rememberDevice;
      }
      void refreshTools();
      await refreshSnapshot();
    } catch (e) {
      error = readable(e);
    } finally {
      busy = false;
    }
  }
  async function signInAccount() {
    if (busy || accountCode) return;
    busy = true; error = ""; accountMessage = "";
    try {
      const result = await invoke<{ userCode: string }>("cloud_device_start");
      accountCode = result.userCode;
      accountTimer = setTimeout(() => void pollAccount(), 5000);
    } catch (value) { error = readable(value); }
    finally { busy = false; }
  }
  async function pollAccount() {
    try {
      const result = await invoke<{ pending?: boolean }>("cloud_device_poll");
      if (result.pending) { accountTimer = setTimeout(() => void pollAccount(), 5000); return; }
      accountCode = "";
      await boot();
      accountMessage = mode === "ready" ? "" : "官网账号已登录。首次打开需解锁本机记忆库。";
    } catch (value) { accountCode = ""; error = readable(value); }
  }
  async function enterDevice() {
    if (busy) return;
    busy = true;
    error = "";
    try {
      snapshot = await unlockDevice();
      mode = "ready";
      password = "";
      passwordConfirm = "";
      config = { ...(snapshot.aiConfig ?? DEFAULT_PROVIDER) };
      settingsConfig = { ...config };
      if (rememberDevice !== deviceUnlockEnabled) {
        await setDeviceUnlock(rememberDevice);
        deviceUnlockEnabled = rememberDevice;
      }
      void refreshTools();
    } catch (e) {
      if (mode !== "ready") mode = "unlock";
      error = readable(e);
    } finally { busy = false; }
  }
  async function toggleDeviceUnlock() {
    if (busy) return;
    if (!deviceUnlockEnabled && !await confirmDialog({ title: "开启自动解锁？", description: "使用当前 Windows 账户的人都能打开记忆库。", confirmLabel: "开启" })) return;
    busy = true;
    error = "";
    try {
      await setDeviceUnlock(!deviceUnlockEnabled);
      deviceUnlockEnabled = !deviceUnlockEnabled;
      rememberDevice = deviceUnlockEnabled;
      flash(deviceUnlockEnabled ? "已开启自动解锁" : "已关闭自动解锁");
    } catch (e) { error = readable(e); }
    finally { busy = false; }
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
      const current = await loadSnapshot();
      if (token !== epoch || mode !== "ready") return;
      snapshot = current;
      const content = localLedgerProposal(capture.rawText,snapshot) ?? await createProvider(config).parseCapture(
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
  async function stageFinance(raw: string, proposal: Proposal) {
    if (busy) return;
    const token = epoch;
    busy = true;
    try {
      const before = new Set(snapshot.captures?.map(c => c.id));
      const captured = await beginTextCapture(raw, "text");
      if (token !== epoch) return;
      snapshot = captured;
      const capture = captured.captures?.find(c => !before.has(c.id));
      if (!capture) throw new Error("原文未保存");
      const staged = await stageProposal(capture.id, proposal, "本地账本");
      if (token !== epoch) return;
      snapshot = staged;quickOpen=false;
      previewId = staged.proposals?.find(p => p.captureId === capture.id && p.status === "PENDING")?.id ?? "";
      page = "Inbox";
    } finally {
      if (token === epoch) busy = false;
    }
  }
  async function capture(parseNow: boolean) {
    if (!text.trim() || busy || recording || voiceBusy) return;
    busy = true;
    error = "";
    const token = epoch;
    try {
      const before = new Set((snapshot.captures ?? []).map((c) => c.id));
      const next = await beginTextCapture(text, inputType);
      if (token !== epoch) return;
      snapshot = next;
      text = "";
      inputType = "text";
      quickOpen = false;
      const input = snapshot.captures?.find((c) => !before.has(c.id));
      if (!input) throw new Error("原文保存失败");
      navigate("Inbox");
      notice = "";
      if (parseNow) await parseCapture(input, true);
      else flash("已存入待确认");
    } catch (e) {
      if (token === epoch) {
        error = readable(e);
      }
    } finally {
      if (token === epoch) busy = false;
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
      notice = "";
      const rememberedId = record?.entityIds.find((id) =>
        snapshot.entities.some((e) => e.id === id && e.privacy !== "SECRET"),
      );
      if (rememberedId) openEntity(rememberedId);
      else navigate(content.financeActions?.length?"Home":"Memory");
    } catch (failure) {
      // Refresh after a rejected commit so the stale preview offers a real retry.
      if (token === epoch) snapshot = await loadSnapshot();
      throw failure;
    } finally {
      if (token === epoch) busy = false;
    }
  }
  async function undoLastConfirmation() {
    if (!lastUndo || busy || recording || voiceBusy) return;
    const id = lastUndo.id;
    const token = epoch;
    busy = true;
    error = "";
    try {
      const next = await undoProposal(id);
      if (token !== epoch) return;
      snapshot = next;
      selectedId = "";
      const financial=next.proposals?.find(p=>p.id===id)?.status==='DISMISSED';
      previewId = financial?'':id;
      page = financial?'Home':'Inbox';
      flash(financial?'已撤销，账本已生成抵消记录':'已撤销，提案已回到待确认');
    } catch (e) {
      if (token === epoch) error = readable(e);
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
      flash("提案已保存");
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
      flash("已移出待确认");
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
      const savedConfig = { ...settingsConfig };
      const next = await saveAiConfig(savedConfig);
      if (token !== epoch) return;
      snapshot = next;
      config = savedConfig;
      void warmLocalModel(config).catch(() => {});
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
    const preparedConfig = { ...settingsConfig };
    try {
      await prepareLocalModel(preparedConfig.model);
      if (token !== epoch) return;
      const next = await saveAiConfig(preparedConfig);
      if (token !== epoch) return;
      snapshot = next;
      config = preparedConfig;
      settingsConfig = { ...config };
      connection = "模型已就绪";
      flash("本地模型已就绪");
      void warmLocalModel(config).catch(() => {});
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
    const question = query.trim();
    try {
      const parsed = await createProvider(config).parseQuery(question);
      if (token !== epoch || query.trim() !== question) return;
      interpretedQuery = { search: parsed.search, region: parsed.region };
    } catch (e) {
      if (token === epoch && query.trim() === question) error = readable(e);
    } finally {
      if (token === epoch) busy = false;
    }
  }
  async function refreshTools() {
    const token = epoch;
    const results = await Promise.allSettled([
      voiceStatus(),
      isTauri
        ? invoke<typeof quickStatus>("quick_capture_status")
        : Promise.resolve(quickStatus),
    ]);
    if (token !== epoch || mode !== "ready") return;
    if (results[0].status === "fulfilled") voiceInfo = results[0].value;
    if (results[1].status === "fulfilled") quickStatus = results[1].value;
    void warmLocalModel(config).catch(() => {});
  }
  async function openQuickCapture(action = "text") {
    if (mode !== "ready") {
      error = "先解锁记忆库，再使用快捷键记录。";
      return;
    }
    if (busy || recording || voiceBusy) {
      flash("正在处理当前记录，请稍等。");
      return;
    }
    if (document.querySelector("dialog[open]") && !quickOpen) return;
    if(!quickOpen){original=undefined;order=undefined;previewing=false;}
    captureMode="asset";quickOpen = true;
    await tick();
    if (!quickOpen || mode !== "ready") return;
    quickInput?.focus();
    if (action === "clipboard") await pasteCapture();
    else if (action === "voice") await microphone();
  }
  function closeQuickCapture() {
    stopVoice();
    quickOpen = false;
  }
  async function pasteCapture() {
    if (busy || recording || voiceBusy) return;
    const token = epoch;
    try {
      const clipboard = await readCaptureClipboard();
      if (token !== epoch || mode !== "ready") return;
      if (text.length + clipboard.length + (text.trim() ? 1 : 0) > 10000)
        throw new Error("草稿加上剪贴板超过 10000 字，请先整理当前记录");
      inputType = text.trim() ? "text" : "clipboard";
      text = text.trim() ? `${text}\n${clipboard}` : clipboard;
      await tick();
      quickInput?.focus();
    } catch (e) {
      if (token === epoch) error = readable(e);
    }
  }
  function stopVoice() {
    voiceEpoch++;
    recorder?.cancel();
    recorder = undefined;
    if (voiceTimer !== undefined) window.clearInterval(voiceTimer);
    voiceTimer = undefined;
    recording = false;
    voiceBusy = false;
    voiceSeconds = 0;
    voiceLevel = 0;
    void cancelVoice().catch(() => {});
  }
  async function microphone() {
    if (recording) {
      await finishRecording();
      return;
    }
    if (busy || voiceBusy) return;
    if (!voiceInfo.supported) {error="当前设备不支持本地语音输入";return;}
    if (!voiceInfo.ready) {
      closeQuickCapture();
      openSettings("快捷与语音");
      flash(
        "先在「语音输入」中准备本地语音模型，再打开快速记录。Windows 的 Win H 也能直接听写到输入框。",
      );
      return;
    }
    error = "";
    voiceBusy = true;
    voiceLabel = "请允许使用麦克风…";
    const token = ++voiceEpoch;
    const session = new PcmRecorder(
      (level) => {
        if (token === voiceEpoch) voiceLevel = level;
      },
      () => {
        if (token === voiceEpoch) void finishRecording();
      },
    );
    recorder = session;
    try {
      await session.start();
      if (token !== voiceEpoch || mode !== "ready") {
        session.cancel();
        return;
      }
      recording = true;
      voiceBusy = false;
      voiceSeconds = 0;
      const start = performance.now();
      voiceTimer = window.setInterval(() => {
        voiceSeconds = Math.floor((performance.now() - start) / 1000);
        if (voiceSeconds >= 60) void finishRecording();
      }, 250);
    } catch (e) {
      if (token === voiceEpoch) {
        stopVoice();
        error =
          e instanceof DOMException && e.name === "NotAllowedError"
            ? "麦克风未获授权。请允许络笺使用麦克风，或在输入框使用 Win H。"
            : `无法开始录音：${readable(e)}`;
      }
    }
  }
  async function finishRecording() {
    if (!recording || !recorder) return;
    const session = recorder;
    const token = voiceEpoch;
    const privateToken = epoch;
    recording = false;
    voiceBusy = true;
    voiceLabel = "正在本机转写…";
    if (voiceTimer !== undefined) window.clearInterval(voiceTimer);
    voiceTimer = undefined;
    try {
      const wav = await session.stop();
      if (token !== voiceEpoch || privateToken !== epoch) {
        wav.fill(0);
        return;
      }
      const transcript = await transcribeVoice(wav, voiceLanguage);
      if (token !== voiceEpoch || privateToken !== epoch || mode !== "ready")
        return;
      if (text.length + transcript.length + (text.trim() ? 1 : 0) > 10000)
        throw new Error("转写加上草稿超过 10000 字，请分段记录");
      inputType = text.trim() ? "text" : "voice";
      text = text.trim() ? `${text}\n${transcript}` : transcript;
      flash("已转成文字。核对名称和数字后，按 Ctrl Enter 整理。");
      await tick();
      quickInput?.focus();
    } catch (e) {
      if (token === voiceEpoch && privateToken === epoch) {
        error = readable(e);
        if (error.includes("运行库"))
          voiceInfo = {
            ...voiceInfo,
            ready: false,
            prerequisite: "Microsoft Visual C++ v14 x64 运行库",
          };
      }
    } finally {
      if (token === voiceEpoch) {
        voiceBusy = false;
        recorder = undefined;
        voiceLevel = 0;
      }
    }
  }
  async function installVoice() {
    if (voiceInstalling) return;
    voiceInstalling = true;
    error = "";
    const token = epoch;
    try {
      await prepareVoice();
      if (token === epoch) {
        voiceInfo = await voiceStatus();
        flash("语音已就绪");
      }
    } catch (e) {
      if (token === epoch) error = readable(e);
    } finally {
      voiceInstalling = false;
    }
  }
  async function toggleQuickCapture() {
    try {
      quickStatus = await invoke("set_quick_capture_enabled", {
        enabled: !quickStatus.enabled,
      });
    } catch (e) {
      error = readable(e);
    }
  }
  async function download(filename: string, payload: string) {
    if (isTauri) { await invoke("save_export_file", { filename, payload }); return; }
    const url = URL.createObjectURL(
      new Blob([payload], { type: filename.endsWith('.csv')?'text/csv;charset=utf-8':"application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function backup() {
    try {
      await download("relakeep-encrypted-backup.json", await exportBackup());
    } catch (e) {
      error = readable(e);
    }
  }
  async function redacted() {
    try {
      await download("relakeep-redacted.json", await exportRedacted(true));
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
      if (item.size > 128 * 1024 * 1024) throw new Error("文件超过 128 MiB");
      await applyFile(await item.text(), kind);
    } catch (e) { error = readable(e); }
    finally { input.value = ""; }
  }
  async function pickFile(kind: "import" | "restore") {
    try { const payload = await invoke<string | null>("read_import_file"); if (payload) await applyFile(payload, kind); }
    catch (e) { error = readable(e); }
  }
  async function restoreServer() {
    try { const response = await fetch("/api/sync"); if (!response.ok) throw new Error(response.status === 404 ? "服务器尚无同步副本" : "读取同步副本失败"); await applyFile(await response.text(), "restore"); }
    catch (e) { error = readable(e); }
  }
  async function applyFile(payload: string, kind: "import" | "restore") {
    error = "";
    if (busy) return;
    busy = true;
    epoch++;
    try {
      if (kind === "restore") {
        const secret = await promptDialog({ title: "恢复加密备份？", description: "恢复将替换当前记忆库。", input: {label: "备份主密码", type: "password"}, danger: true, confirmLabel: "恢复备份" });
        if (!secret) return;
        snapshot = await importBackup(payload, secret);
        const warning = (snapshot as VaultSnapshot & {restoreWarning?:string}).restoreWarning;
        deviceUnlockEnabled = false;
        rememberDevice = false;
        mode = "ready";
        await refreshSnapshot();
        selectedId = "";rootId = "";previewId = "";pendingImport=null;syncError="";
        config = { ...(snapshot.aiConfig ?? DEFAULT_PROVIDER) };
        settingsConfig = { ...config };
        flash("加密备份已恢复");
        if(warning) error=warning;
      } else {
        const summary = await previewAtlasJson(payload);
        pendingImport = {
          text: payload,
          summary: `${summary.entityCount} 个实体 · ${summary.relationCount} 条关系 · ${summary.eventCount} 个事件${summary.transactionCount?` · ${summary.transactionCount} 笔流水`:''}`,
        };
      }
    } catch (e) {
      error = readable(e);
    } finally {busy = false;}
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

<svelte:window on:pointerdown={e=>{if(menuOpen && !(e.target as Element).closest(".more-actions"))menuOpen=false;}} on:keydown={e=>{if(menuOpen && e.key==="Escape"){menuOpen=false;document.getElementById("today-more")?.focus();}}}/>
<DialogHost />
{#if mode !== "ready"}
  <main class="lock-screen">
    <section class="lock-card">
      <img class="brand-mark" src="/mark.svg" alt="" width="44" height="44" />
      <p class="lock-brand">络笺 <span>Relakeep</span></p>
      <h1>
        {mode === "loading"
          ? "正在打开…"
          : mode === "access" ? "登录"
          : mode === "create"
            ? "创建记忆库"
            : "解锁记忆库"}
      </h1>
      {#if mode === "unlock" && deviceUnlockEnabled}
        <button class="primary device-unlock-button" disabled={busy} on:click={enterDevice}>使用这台电脑解锁 <kbd>Ctrl Shift L</kbd></button>
        <p class="lock-divider">或使用主密码</p>
      {/if}
      {#if mode === "access"}
        {#if isSelfhost}<ServerAuth authenticated={boot} />{:else}<form on:submit|preventDefault={enterAccess}><label>访问口令<input type="password" bind:value={access} required autocomplete="off" /></label><button class="primary">进入</button></form>{/if}
      {:else if mode !== "loading"}<form on:submit|preventDefault={enter}>
          <label
            >主密码<input
              type="password"
              bind:value={password}
              required
              minlength={mode === "create" ? 12 : undefined}
              autocomplete={mode === "create"
                ? "new-password"
                : "current-password"}
            /></label
          >{#if mode === "create"}<label
              >再输入一次<input
                type="password"
                bind:value={passwordConfirm}
                required
                autocomplete="new-password"
              /></label
            >
            {/if}
          {#if isWindows}<label class="check-label"><input type="checkbox" bind:checked={rememberDevice} />记住这台电脑</label>{/if}
          <button class="primary" disabled={busy}
            >{busy
              ? "正在打开…"
              : mode === "create"
                ? "创建"
                : "解锁"}</button
          >
        </form>{/if}{#if error}<div class="error" role="alert">
          {error}
        </div>{/if}
      {#if isTauri && mode !== "loading"}<button class="secondary lock-cloud-link" disabled={busy || !!accountCode} on:click={signInAccount}>登录官网账户</button>{#if accountCode}<p class="device-code" role="status">{accountCode}</p>{/if}{#if accountMessage}<p role="status">{accountMessage}</p>{/if}{/if}
      {#if isPersistent && (mode === "create" || mode === "unlock")}
        {#if isSelfhost}<button class="secondary" on:click={restoreServer}>导入服务器同步副本</button>{/if}
        {#if isTauri}<button class="text-button lock-cloud-link" on:click={() => pickFile("restore")}>导入加密备份</button>{:else}<label class="file-button secondary">导入加密备份<input type="file" accept=".json" on:change={(e) => file(e, "restore")} /></label>{/if}
      {/if}
    </section>
  </main>
{:else}
  <div class="app-shell">
    {#if paletteOpen}<CommandPalette {snapshot} {commands} pages={palettePages} {openEntity} {explore} account={ledgerCommand}
      preview={stageFinance} checkUpdate={() => updateDetails(true)} close={() => paletteOpen = false} failed={e => error = readable(e)}/>{/if}
    <aside class="sidebar">
      <a
        class="brand"
        href="#home"
        on:click|preventDefault={() => navigate("Home")}
        ><img class="brand-mark" src="/mark.svg" alt="" width="32" height="32" /><span
          >络笺<small>Relakeep</small></span
        ></a
      >

      <button class="sidebar-add primary" disabled={busy} aria-label="快速记录" on:click={()=>startExpense()}><Icon name="Plus"/><span>记录</span></button>
      <nav aria-label="主导航">
        {#each pages as item}<button
            class:active={activePage === item}
            aria-current={activePage === item
              ? "page"
              : undefined}
            aria-label={labels[item]}
            on:click={() => navigate(item)}
            ><span class="nav-symbol"><Icon name={item} /></span><span
              >{labels[item]}</span
            ></button
          >{/each}
      </nav>
      <div class="sidebar-bottom">
        <button class="side-utility" on:click={openPalette}><Icon name="Search"/>搜索<kbd>Ctrl K</kbd></button>
        <button class="side-utility" aria-label="锁定记忆库" on:click={lock}><Icon name="Lock"/>锁定记忆库</button>
      </div>
    </aside>
    <main class="main-area">
      <div class="page-content">
        {#if updateInfo?.hasUpdate && updatePrefs.dismissedVersion !== updateInfo.latestVersion}
          <aside class="update-banner" aria-label="新版本提示">
            <strong>v{updateInfo.latestVersion} {updateInfo.filename ? "可更新" : "已发布"}</strong>
            {#if updateInfo.mirrorUrl}<button on:click={() => openUpdate(updateInfo!.mirrorUrl!)}>国内镜像下载</button>{/if}
            {#if updateInfo.githubUrl}<button on:click={() => openUpdate(updateInfo!.githubUrl!)}>GitHub 下载</button>{/if}
            <button on:click={() => updateDetails()}>查看详情</button>
            <button class="dismiss" on:click={() => changeUpdatePrefs({dismissedVersion: updateInfo!.latestVersion})}>忽略此版本</button>
          </aside>
        {/if}
        {#if quickUndo?.revision===snapshot.revision && !error}<div class="commit-feedback" role="status"><span>{notice||"已入账"}</span><button class="secondary" disabled={busy} on:click={undoQuick}>撤销入账</button></div>{/if}
        {#if lastUndo && !error && !notice}<div class="commit-feedback" role="status">
            <span>已保存</span><button
              class="secondary"
              disabled={busy || recording || voiceBusy}
              on:click={undoLastConfirmation}>撤销这次变更</button
            >
          </div>{/if}
        {#if error}<div class="error" role="alert">
            {error}<button class="text-button" aria-label="关闭错误提示" on:click={() => error = ""}>×</button>
          </div>{:else if notice && quickUndo?.revision!==snapshot.revision}<div class="notice" role="status">
            {notice}<button aria-label="关闭提示" on:click={() => (notice = "")}
              >×</button
            >
          </div>{/if}
        {#if page==="Home" || page==="Ledger"}
          <header class="destination-header"><h1>{labels[page]}</h1><MonthSwitcher bind:month={currentMonth}/>
            {#if page==="Home"}<div class="header-actions">
              <button class="icon-button" aria-label="打开命令面板" on:click={openPalette}><Icon name="Search"/></button>
              <div class="more-actions"><button class="icon-button" id="today-more" aria-label="更多操作" aria-expanded={menuOpen} on:click={()=>menuOpen=!menuOpen}><Icon name="More"/></button>
              {#if menuOpen}<div class="action-menu">
                <button on:click={()=>{menuOpen=false;showImport("bills");}}>导入账单</button>
                <button on:click={()=>{menuOpen=false;void ledgerPage.csv();}}>导出 CSV</button>
                <button on:click={()=>{menuOpen=false;filtersOpen=!filtersOpen;}}>筛选流水</button>
              </div>{/if}</div>
            </div>{/if}
          </header>
        {:else if (page==="Memory" && !selected) || page==="Explore"}
          <header class="destination-header"><h1>资产</h1>
            <div class="segmented" role="group" aria-label="资产视图">
              <button aria-pressed={page==="Memory"} on:click={()=>navigate("Memory")}>列表</button>
              <button aria-pressed={page==="Explore"} on:click={()=>navigate("Explore")}>图谱</button>
            </div><div class="header-actions">
              <button class="icon-button" aria-label="导入数据" on:click={openImport}><Icon name="Upload"/></button>
              <button class="icon-button" aria-label="新建记录" on:click={()=>editRecord()}><Icon name="Plus"/></button>
            </div>
          </header>
        {/if}
        {#if page === "Inbox"}
          <button class="back-link" on:click={()=>navigate("Home")}><Icon name="Back"/>返回今日</button>
          {#if preview && previewCapture}<ProposalPreview
              record={preview}
              capture={previewCapture}
              entities={snapshot.entities}
              {snapshot}
              {busy}
              onConfirm={confirm}
              onLater={later}
              onRetry={() => parseCapture(previewCapture!)}
            />{:else}<div class="page-heading">
              <h1>待确认</h1>
            </div>
            {#if upcoming.length}<section class="upcoming-list"><h2>即将处理</h2>{#each upcoming as event}<button
                    class="event-row"
                    on:click={() => openEntity(event.entityId)}
                    ><span>{name(event.entityId)}</span><span
                      >{date(event.dueAt)} · {event.policy === "DO_NOT_RENEW"
                        ? "不续费"
                        : event.type === "EXPIRY"
                          ? "到期"
                          : "待处理"}</span
                    ></button
                  >{/each}</section>{/if}
            {#if pending.length}<div class="inbox-list">
                {#each pending as input}{@const proposal =
                    snapshot.proposals?.find(
                      (p) => p.captureId === input.id && p.status === "PENDING",
                    )}
                  <article class="panel inbox-item">
                    <div class="section-heading">
                      <span class="pill" role="status"
                        >{parsingId === input.id
                          ? "正在整理…"
                          : proposal
                            ? "等待确认"
                            : "待整理"}</span
                      ><span class="muted"
                        >{input.inputType === "voice"
                          ? "语音转写 · "
                          : input.inputType === "clipboard"
                            ? "剪贴板 · "
                            : ""}{date(input.timestamp)}</span
                      >
                    </div>
                    <p>{input.rawText}</p>
                    <div class="button-row">
                      <button
                        class="text-button danger"
                        disabled={busy}
                        on:click={() => dismiss(input.id)}>移出待确认</button
                      ><button
                        class="secondary"
                        disabled={busy}
                        on:click={() => parseCapture(input)}
                        >{parsingId === input.id
                          ? "正在理解…"
                          : proposal
                            ? "重新理解"
                            : "开始整理"}</button
                      >{#if proposal}<button
                          class="primary"
                          disabled={busy}
                          on:click={() => (previewId = proposal.id)}
                          >检查并确认</button
                        >{/if}
                    </div>
                  </article>{/each}
              </div>{:else if !upcoming.length}<div class="empty-state">
                <span class="empty-spark">✦</span>
                <h2>没有待确认的内容</h2>
                <button class="primary" on:click={() => openQuickCapture()}
                  >开始记录</button
                >
              </div>{/if}{/if}
        {:else if page === "Memory"}
          {#if selected}<div class="detail-header">
              <button class="text-button" on:click={closeDetail}
                >← {detailFromGraph?"返回关系图":"返回资产列表"}</button
              ><div class="button-row"><button class="secondary" aria-pressed={selected.tags.some(isFavorite)} disabled={busy} on:click={()=>favorite(selected)}>{selected.tags.some(isFavorite)?"★ 已收藏":"☆ 收藏"}</button><button class="secondary" on:click={() => editRecord(selected)}>编辑</button><button class="primary" on:click={() => explore(selected.id)}>关系图</button></div>
            </div>
            <article class="detail-card">
              <span class="pill">{categoryLabel(selected.category)}</span>
              <h1>{selected.name}</h1>
              {#if selected.tags.length}<div class="tag-options">{#each selected.tags as tag}<span class="pill">{tag}</span>{/each}</div>{/if}
              <p class="muted">
                {statusLabel(selected.status)} · 最近更新 {date(selected.updatedAt)}
              </p>
              <dl class="detail-fields">
                {#each selected.fields.filter((f) => f.privacy !== "SECRET") as field}<div
                  >
                    <dt>{attributeLabel(field.key)}</dt>
                    <dd>{display(field.value)}</dd>
                  </div>{/each}
              </dl>
              <h2>关联</h2>
              {#if connectionNeeds.has(selected.id)}<button class="secondary" on:click={()=>editRecord(selected)}>补全关联{connectionGaps(selected,snapshot).length?`：${connectionGaps(selected,snapshot).map(s=>s.label).join("、")}`:""}</button>{/if}
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
                      {relationLabel(relation.type)}</span
                    ><strong
                      >{name(
                        relation.sourceId === selected.id
                          ? relation.targetId
                          : relation.sourceId,
                      )}</strong
                    ></button
                  >{/each}{:else}<p class="muted">
                  暂无关联
                </p>{/if}{#if snapshot.events.some((e) => e.entityId === selected.id)}<h2
                >
                  生命周期
                </h2>
                {#each snapshot.events.filter((e) => e.entityId === selected.id) as event}<div
                    class="event-detail"
                  >
                    <strong>{date(event.dueAt)} · {eventLabel(event.type)}</strong><span
                      >{event.policy === "DO_NOT_RENEW"
                        ? "不续费"
                        : event.policy}</span
                    >
                    <p class="muted">{event.note ?? ""}</p>
                  </div>{/each}{/if}{#if sources.length}<h2>当时你说的是</h2>
                {#each sources as source}<blockquote class="original">
                    {source.rawText}
                    <footer>
                      {source.inputType === "voice"
                        ? "语音转写文字 · "
                        : source.inputType === "clipboard"
                          ? "剪贴板文字 · "
                          : ""}{date(source.timestamp)}
                    </footer>
                  </blockquote>{/each}{/if}
            </article>{:else}
            <div class="record-filters" aria-label="记录分类"><button class:chosen={!recordGroup && !connectionsOnly} on:click={() => {recordGroup = "";connectionsOnly=false;}}>全部</button>{#each RECORD_GROUPS as group}<button class:chosen={recordGroup === group.label} on:click={() => recordGroup = group.label}>{group.label}</button>{/each}{#if connectionNeeds.size}<button class:chosen={connectionsOnly} on:click={()=>connectionsOnly=!connectionsOnly}>待补关联 {connectionNeeds.size}</button>{/if}</div>
            <div class="search-box" role="search" aria-label="查找已确认的记忆">
              <Icon name="Search"/><input
                bind:value={query}
                placeholder="搜索名称、地区或备注"
                aria-label="搜索资产"
                on:input={() => {
                  interpretedQuery = null;
                  error = "";
                }}
              />{#if query}<button
                  class="text-button"
                  aria-label="清除搜索"
                  on:click={() => {
                    query = "";
                    interpretedQuery = null;
                    error = "";
                  }}>×</button
                ><button
                class="secondary"
                disabled={busy || !query.trim()}
                on:click={ask}>{busy ? "正在理解…" : "理解问题"}</button>{/if}
            </div>
            {#if interpretedQuery}<p
                class="search-interpretation"
                role="status"
              >
                筛选：{interpretedQuery.search ||
                  "全部名称"}{interpretedQuery.region
                  ? ` · 地区 ${interpretedQuery.region}`
                  : ""}
              </p>{/if}
            <div class="list-heading">
              <span>{results.length} 项资产</span>
              {#if connectionNeeds.size}<button class="text-button" on:click={()=>connectionsOpen=true}>从字段补全关联</button>{/if}
              <div class="memory-controls"><select aria-label="记忆排序" bind:value={memorySort}>{#each Object.entries(sortNames) as [key,title]}<option value={key}>{title}</option>{/each}</select>
                <div class="segmented" role="group" aria-label="记忆视图">
                  <button aria-pressed={memoryView === "list"} on:click={()=>memoryView="list"}><Icon name="List"/><span class="sr-only">行视图</span></button>
                  <button aria-pressed={memoryView === "card"} on:click={()=>memoryView="card"}><Icon name="Grid"/><span class="sr-only">卡片</span></button>
                </div>
              </div>
            </div>
            {#if memorySort === "cost"}<p class="muted">按币种分组，同币种按月费从高到低排列。</p>{/if}
            {#if results.length}<div class="entity-list" class:cards={memoryView === "card"}>
                {#each results as entity (entity.id)}{@const meta = memoryMeta.get(entity.id)!}
                  <button class="entity-list-item" on:click={() => openEntity(entity.id)}>
                    <span class="entity-icon" style={`--category:${memoryColors[categoryGroup(entity.category)]}`}>{entity.name.slice(0, 1).toUpperCase()}</span>
                    <div class="memory-identity"><strong>{entity.name}</strong>{#if meta.favorite}<span class="favorite-star" aria-label="已收藏">★</span>{/if}
                      <small><i class="category-dot" style:background={memoryColors[categoryGroup(entity.category)]}></i>{categoryLabel(entity.category)} · {meta.cost ? formatMoney(meta.cost)+" / 月" : meta.summary || statusLabel(entity.status)}{connectionNeeds.has(entity.id) ? " · 待补关联" : ""}</small>
                    </div>
                    <span class="relation-count" aria-label={meta.count + " 条关联"}><Icon name="Link"/>{meta.count}</span><span class="row-chevron"><Icon name="Chevron"/></span>
                  </button>
                {/each}
              </div>{:else}<div class="empty-state">
                没有找到相关资产。试试名称、地区或备注中的关键词。
              </div>{/if}{/if}
        {:else if page === "Ledger"}
          <div class="segmented insight-tabs" role="group" aria-label="洞察视图">{#each ["回顾","资源成本","投资","项目"] as tab}<button aria-pressed={insight===tab} on:click={()=>insight=tab}>{tab==="资源成本"?"订阅":tab}</button>{/each}</div>
        {:else if page === "Explore"}
          {#snippet graphSwitcher()}<div class="segmented graph-modes" role="group" aria-label="图谱视图"><button aria-pressed={graphMode==="relation"} on:click={()=>graphMode="relation"}>关系</button><button aria-pressed={graphMode==="money"} on:click={()=>graphMode="money"}>金钱</button></div>{/snippet}
          <div class="graph-workspace">
          {#if graphMode==="money"}<MoneyGraph {snapshot} {rootId} month={currentMonth} onFavorite={favorite} onConnect={e => editRecord(e,true)} onOpen={openEntity} {graphSwitcher}/>{:else}<ExploreCanvas
              {snapshot}
              {rootId}
              onOpen={openEntity} onFavorite={favorite} onConnect={e => editRecord(e,true)}
            >{@render graphSwitcher()}</ExploreCanvas>{/if}</div>
        {:else if page === "Settings"}
          {#if mePage}<button class="back-link" on:click={()=>openSettings("")}><Icon name="Back"/>返回</button>{/if}
          <header class="destination-header"><h1>{mePage || "我的"}</h1></header>
          {#if !mePage || mePage==="官网账户"}<CloudSettings summary={!mePage} open={()=>openSettings("官网账户")} changed={async()=>{await refreshSnapshot();nextServerDiscovery=0;void sync();}}/>{/if}
          {#if !mePage}
            {#each settingsGroups as group}
              <section class="setting-group"><h2>{group.title}</h2><div class="setting-rows">
                {#each group.rows as row}
                  {#if row.title==="外观主题"}<div class="setting-row"><span class="setting-symbol" style:color={row.tint}><Icon name={row.icon}/></span><strong>{row.title}</strong><div class="segmented" role="group" aria-label="外观主题">
                    {#each Object.entries(themeNames) as [key,label]}<button aria-pressed={$themePreference===key} on:click={()=>setTheme(key as Preference)}>{key==="system"?"自动":label}</button>{/each}</div></div>
                  {:else}<button class="setting-row" on:click={()=>row.title==="数据导入中心"?openImport():openSettings(row.title)}><span class="setting-symbol" style:color={row.tint}><Icon name={row.icon}/></span>
                    <strong>{row.title}</strong><small>{row.value}</small><Icon name="Chevron"/></button>{/if}
                {/each}
              </div></section>
            {/each}
            {#if !isPersistent}<p class="preview-note">浏览器预览 · 刷新会清空数据</p>{/if}
          {:else if mePage==="安全与锁屏"}
          <section class="panel settings-panel">
            {#if isWindows}<div class="section-heading"><h2>打开与锁定</h2></div>
            <div class="preference-row"><strong>记住这台电脑</strong><button class="preference-switch" class:enabled={deviceUnlockEnabled} role="switch" aria-checked={deviceUnlockEnabled} aria-label="记住这台电脑" on:click={toggleDeviceUnlock} disabled={busy || !isTauri}><span></span></button></div>
            <div class="preference-row"><strong>锁定 / 解锁</strong><kbd>Ctrl Shift L</kbd></div>{/if}
            <button class="secondary" on:click={lock}>立即锁定</button>
          </section>
          {#if isPersistent}<section class="panel settings-panel"><label class="preference-row"><strong>自动锁定</strong><select bind:value={idleMinutes} on:change={saveLockPolicy}><option value={0}>不自动锁定</option><option value={5}>5 分钟</option><option value={15}>15 分钟</option><option value={30}>30 分钟</option><option value={60}>1 小时</option></select></label></section>{/if}
          {:else if mePage==="应用更新"}
          <UpdateSettings prefs={updatePrefs} info={updateInfo} checking={checkingUpdate} error={updateError} check={()=>checkUpdate()} change={changeUpdatePrefs} open={openUpdate}/>
          {:else if mePage==="多端同步"}
          {#if !isPersistent}<p class="muted">在应用或自托管版中连接同步服务器。</p>{/if}
          {#if isPersistent}<SyncSettings bind:status={syncStatus} changed={refreshSnapshot} />{/if}
          {#if syncError}<p class="error" role="alert">{syncError}</p>{/if}
          {#if isSelfhost}<ServerSecurity />{/if}
          {:else if mePage==="AI 模型"}
          <section class="panel settings-panel">
            <div class="provider-options">
              {#each [["local", "本地模型"], ["ollama", "Ollama"], ["openai-compatible", "自带 API Key"], ["cloud", "官网云服务"]].filter(([kind]) => (kind !== "local" || isWindows) && (kind !== "cloud" || isPersistent)) as [kind, title]}<button
                  class:chosen={settingsConfig.kind === kind}
                  disabled={modelBusy}
                  on:click={() => configure(kind as ProviderConfig["kind"])}
                  ><strong>{title}</strong></button
                >{/each}
            </div>
            {#if settingsConfig.kind === "local" && isWindows}
              <div class="model-options" aria-label="本地模型选择">
                {#each LOCAL_MODELS as model}<button
                    class:chosen={settingsConfig.model === model.model}
                    disabled={modelBusy}
                    on:click={() => {
                      settingsConfig = {
                        ...settingsConfig,
                        model: model.model,
                        responseFormat: "json_object",
                      };
                      connection = "";
                    }}
                  >
                    <strong>{model.label}</strong><span
                      >{model.name} · {model.size}</span
                    ><small>{model.description}</small>
                  </button>{/each}
              </div>
              <div class="button-row">
                <button
                  class="primary"
                  disabled={modelBusy || !isTauri}
                  on:click={prepareModel}
                  >{modelBusy
                    ? "正在准备本地模型…"
                    : "下载并使用所选模型"}</button
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
                  ></progress>{/if}{/if}{:else if settingsConfig.kind !== "cloud"}<div class="provider-form">
                <label
                  >接口地址<input
                    bind:value={settingsConfig.baseUrl}
                    placeholder={settingsConfig.kind === "ollama"
                      ? "http://localhost:11434"
                      : "https://your-provider.example/v1"}
                  /></label
                ><label
                  >模型名称<input
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
                        value="prompt">文本</option
                      ></select
                    ></label
                  >
                  {/if}
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
          {:else if mePage==="快捷与语音"}
          {#if isWindows}<section class="panel settings-panel" id="voice-settings">
            <h2>语音输入</h2>
            <div class="button-row">
              <button
                class="primary"
                disabled={!voiceInfo.supported || voiceInstalling}
                on:click={installVoice}
              >
                {!voiceInfo.supported ? "当前设备不支持语音" : voiceInstalling
                  ? "正在准备语音…"
                  : voiceInfo.ready
                    ? "语音已就绪"
                    : "下载语音模型（约 199 MB）"}</button
              >
              <label class="voice-language"
                >转写语言<select bind:value={voiceLanguage}
                  ><option value="auto">自动识别</option><option value="zh"
                    >中文</option
                  ><option value="en">English</option><option value="ja"
                    >日本語</option
                  ></select
                ></label
              >
            </div>
            {#if voiceInfo.prerequisite}<p class="muted">
                需要先安装 {voiceInfo.prerequisite}。
              </p>
              <div class="button-row">
                <button
                  class="secondary"
                  on:click={() =>
                    invoke("open_voice_prerequisite").catch(
                      (e) => (error = readable(e)),
                    )}>打开 Microsoft 官方下载</button
                ><button class="secondary" on:click={refreshTools}
                  >已安装，重新检查</button
                >
              </div>{/if}
            {#if voiceInstalling}<p class="muted" role="status">
                {voiceProgress.stage}{voiceProgress.total
                  ? ` · ${Math.round((voiceProgress.completed / voiceProgress.total) * 100)}%`
                  : ""}
              </p>
              {#if voiceProgress.total}<progress
                  value={voiceProgress.completed}
                  max={voiceProgress.total}
                ></progress>{/if}{/if}
          </section>{/if}
          {#if !isMobile}<section class="panel settings-panel">
            <h2>快捷记录</h2>
            <div class="shortcut-list"><div><kbd>Ctrl / ⌘ K</kbd><span>打开命令面板</span></div>
              <div>
                <kbd>Ctrl / ⌘ Shift Space</kbd><span>唤起快速输入</span>
              </div>
              <div>
                <kbd>Ctrl / ⌘ Alt V</kbd><span>唤起并读取剪贴板文字</span>
              </div>
              <div><kbd>Ctrl / ⌘ Alt R</kbd><span>唤起并开始语音</span></div>
              <div><kbd>Ctrl / ⌘ Enter</kbd><span>整理当前输入</span></div>
              <div><kbd>Esc</kbd><span>取消录音或关闭快速输入</span></div>
            </div>
            {#if isTauri}<button class="secondary" on:click={toggleQuickCapture}
                >{quickStatus.enabled
                  ? "关闭全局快捷键"
                  : "启用全局快捷键"}</button
              >
              {#each quickStatus.shortcuts.filter((shortcut) => quickStatus.enabled && !shortcut.registered) as shortcut}<p
                  class="muted"
                >
                  {shortcut.key} 未能注册，可能被其他应用占用。仍可点击 ＋ 记录。
                </p>{/each}
            {/if}
          </section>{/if}
          {:else if mePage==="备份与导出"}
          <section class="panel settings-panel">
            <h2 id="backup-settings">记忆与备份</h2>
            <div class="button-row">
              <button class="secondary" on:click={backup} disabled={!isPersistent}
                >导出加密备份</button
              >{#if isTauri}<button class="secondary" on:click={() => pickFile("restore")}>恢复加密备份</button>{:else}<label class="file-button secondary"
                >恢复加密备份<input
                  type="file"
                  accept=".json"
                  on:change={(e) => file(e, "restore")}
                  disabled={!isPersistent}
                /></label
              >{/if}<button class="secondary" on:click={redacted}
                >导出脱敏清单</button
              >{#if isTauri}<button class="secondary" on:click={() => pickFile("import")}>导入 Atlas JSON</button>{:else}<label class="file-button secondary"
                >导入旧 Atlas JSON<input
                  type="file"
                  accept=".json"
                  on:change={(e) => file(e, "import")}
                /></label
              >{/if}
            </div>
            <div class="github-backup-entry"><button class="secondary" on:click={() => isTauri ? invoke('cloud_open', {path:'/guide'}).catch(e => error = readable(e)) : window.open('https://atlas.sayori.org/guide#github-backup', '_blank', 'noopener')}>GitHub 备份教程</button></div>
            {#if pendingImport}<div class="import-preview">
                <p>{pendingImport.summary}</p>
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
        {/if}
        {#if page==="Home" || page==="Ledger" || (page==="Settings" && mePage==="资金账户与对账")}
          {#key ledgerTab}<LedgerPage bind:this={ledgerPage} tab={ledgerTab} month={currentMonth} bind:filtersOpen {snapshot} {config} {download}
            saved={next=>snapshot=next} stage={stageFinance} edit={entity=>editRecord(entity)} entry={startExpense} {routeSpecial}
            openImport={()=>showImport("bills")} subscription={e=>{editRecord();draftEntity=e;}} showReview={()=>{navigate("Ledger");insight="回顾";}}>
          {#if pending.length || upcoming.length}<button class="pending-pill" on:click={()=>navigate("Inbox")}><Icon name="Inbox"/>{pending.length?pending.length+" 条待确认":"即将处理"}<Icon name="Chevron"/></button>{/if}
          <StarterCard {snapshot} open={showImport} save={saveLocal}/>
          <svelte:fragment slot="recent">
        {#if recent.length}
          <section class="recent-section">
            <div class="section-heading">
              <div>
                <h2>最近记录的资产</h2>
              </div>
              <button class="text-button" on:click={() => navigate("Memory")}
                >查看全部</button
              >
            </div>
            <div class="recent-list">
                {#each recent as entity}<button
                    class="recent-row"
                    on:click={() => openEntity(entity.id)}
                    ><span class="entity-icon"
                        >{entity.name.slice(0, 1).toUpperCase()}</span
                      ><span class="recent-name"><strong>{entity.name}</strong><small>{categoryLabel(entity.category)}</small></span>
                    <span class="recent-meta">
                      {entity.fields.find(
                        (f) =>
                          ["region", "country", "provider"].includes(f.key) &&
                          f.privacy !== "SECRET",
                      )?.value ?? ""}
                    </span><span class="recent-date">{date(entity.updatedAt)}</span></button
                  >{/each}
              </div>
          </section>
        {/if}
          </svelte:fragment>
          </LedgerPage>{/key}
        {/if}
      </div>
    </main>
    {#if ["Home","Memory","Explore","Ledger"].includes(page)}<button class="floating-add" disabled={busy} aria-label="快速记录" on:click={()=>startExpense()}><Icon name="Plus"/></button>{/if}
  </div>
  {#if quickOpen}
    <QuickSheet bind:mode={captureMode} close={closeQuickCapture} recording={recording||voiceBusy} {busy}>
      {#if error}<div class="error" role="alert">{error}</div>{/if}
      {#if notice}<p class="muted" role="status">{notice}</p>{/if}
      <div hidden={captureMode!=="bill"}>
        <QuickEntry {snapshot} {config} stage={stageFinance} bind:previewing save={async(next,ids)=>{await saveQuick(next,ids);quickOpen=false;}}/>
        <div hidden={previewing}><EntryForm {snapshot} {original} {order} save={saveQuick} close={closeQuickCapture}/></div>
      </div><div hidden={captureMode!=="asset"}>
      <CaptureComposer voiceSupported={voiceInfo.supported}
        id="quick-capture"
        compact
        bind:text
        bind:input={quickInput}
        {busy}
        {recording}
        {voiceBusy}
        {voiceLabel}
        voiceReady={voiceInfo.ready}
        seconds={voiceSeconds}
        level={voiceLevel}
        submit={() => capture(true)}
        save={() => capture(false)}
        paste={pasteCapture}
        {microphone}
        cancelRecording={stopVoice}
      />
        <div class="sheet-links"><button class="text-button" disabled={busy||recording||voiceBusy} on:click={()=>editRecord()}>手动填表单</button><button class="text-button" disabled={busy||recording||voiceBusy} on:click={openImport}>批量导入</button>
          <details><summary>示例</summary>{#each samples as sample}<button on:click={()=>{text=sample;inputType="text";quickInput.focus();}} disabled={busy||recording||voiceBusy}>{sample}</button>{/each}</details>
        </div>
      </div>
      {#if !isPersistent}<p class="preview-note">浏览器预览 · 刷新会清空记录</p>{/if}
    </QuickSheet>
  {/if}
{/if}
{#if mode === "ready" && importTab}<ImportCenter {snapshot} tab={importTab} close={()=>importTab=null} save={saveLocal}/>{/if}
{#if mode === "ready" && editorOpen}<ManualEditor {snapshot} initial={draftEntity} showRelations={relationEditor} entity={editedEntity} saved={recordSaved} close={() => editorOpen = false} />{/if}
{#if mode === "ready" && connectionsOpen}<ConnectionReview {snapshot} saved={value=>{snapshot=value;connectionsOpen=false;flash("已补全关联");}} close={()=>connectionsOpen=false}/>{/if}

<style>
  .update-banner { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; margin-bottom: 16px; padding: 9px 14px; border-radius: 8px; background: var(--accent-soft); color: var(--accent); font-size: 13px; }
  .update-banner button { background: transparent; color: inherit; padding: 4px 0; font-size: inherit; }
  .update-banner button:hover { text-decoration: underline; }
  .update-banner .dismiss { margin-left: auto; color: var(--muted); }
</style>
