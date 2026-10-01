<script lang="ts">
  import { onMount } from 'svelte';
  import { isTauri, vaultStatus, initializeVault, unlockVault, loadSnapshot, lockVault, saveSnapshot, exportBackup, importBackup, previewAtlasJson, importAtlasJson, exportRedacted as exportRedactedJson, openVaultwarden } from './lib/api';
  import { demoSnapshot } from './lib/demo';
  import { emptySnapshot, newId, nowIso, RELATION_TYPES, TEMPLATES } from './lib/types';
  import type { Entity, Field, ImportPreview, LifecycleEvent, Privacy, Relation, ValueType, VaultSnapshot } from './lib/types';

  type Mode = 'loading' | 'create' | 'unlock' | 'ready';
  let mode: Mode = 'loading';
  let snapshot: VaultSnapshot = emptySnapshot();
  let password = '';
  let passwordConfirm = '';
  let query = '';
  let activeNav = 'all';
  let selectedId = '';
  let error = '';
  let notice = '';
  let showAdd = false;
  let showRelation = false;
  let showEvent = false;
  let showField = false;
  let pendingImport: { text: string; preview: ImportPreview } | null = null;
  let saving = false;
  let editing = false;
  let addMode: 'quick' | 'template' = 'quick';
  let addName = '';
  let addTemplate = 'project';
  let addTags = '';
  let addValue = '';
  let relationType = 'RELATED_TO';
  let relationTarget = '';
  let relationNote = '';
  let eventType = 'REVIEW';
  let eventDueAt = '';
  let eventPolicy = 'REVIEW';
  let eventNote = '';
  let editName = '';
  let editStatus = '';
  let editTags = '';
  let editingFieldId = '';
  let fieldKey = '';
  let fieldValueType: ValueType = 'text';
  let fieldValue = '';
  let fieldPrivacy: Privacy = 'PRIVATE';
  let fieldSearchable = true;
  let fieldSourceProvider = '';
  let fieldSourceReference = '';
  let importInput: HTMLInputElement;
  let backupInput: HTMLInputElement;

  $: selected = snapshot.entities.find((item) => item.id === selectedId) ?? snapshot.entities[0];
  $: if (selected && !editing) { editName = selected.name; editStatus = selected.status; editTags = selected.tags.join(', '); }
  $: inbound = selected ? snapshot.relations.filter((item) => item.targetId === selected.id) : [];
  $: outbound = selected ? snapshot.relations.filter((item) => item.sourceId === selected.id) : [];
  $: relatedIds = new Set([...inbound.map((item) => item.sourceId), ...outbound.map((item) => item.targetId)]);
  $: searchText = query.trim().toLowerCase();
  $: visibleEntities = snapshot.entities.filter((item) => {
    const matchesNav = activeNav === 'all' || activeNav === 'inbox' && item.status === 'NEEDS_REVIEW' || activeNav === 'expiring' && snapshot.events.some((event) => event.entityId === item.id && event.status === 'UPCOMING' && event.dueAt && new Date(event.dueAt).getTime() < Date.now() + 90 * 86_400_000) || activeNav === item.category;
    const searchable = [item.name, item.category, item.status, ...item.tags, ...item.fields.filter((field) => field.searchable && field.privacy !== 'SECRET').map((field) => `${field.key} ${String(field.value)}`)].join(' ').toLowerCase();
    const relatedMatch = snapshot.relations.some((rel) => (rel.sourceId === item.id || rel.targetId === item.id) && snapshot.entities.find((e) => e.id === (rel.sourceId === item.id ? rel.targetId : rel.sourceId))?.name.toLowerCase().includes(searchText));
    return matchesNav && (!searchText || searchable.includes(searchText) || relatedMatch);
  });
  $: categories = ['Identity', 'Email', 'Website Account', 'Domain', 'Server', 'Project', 'Subscription', 'SIM', 'Repository', 'AI Provider Account', 'Payment Card'];
  $: expiringCount = snapshot.events.filter((event) => event.status === 'UPCOMING' && event.dueAt && new Date(event.dueAt).getTime() < Date.now() + 90 * 86_400_000).length;

  onMount(() => {
    let timer: number | undefined;
    const openQuickAdd = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (mode === 'ready') { showAdd = true; addMode = 'quick'; }
      }
    };
    const sync = () => { if (document.visibilityState === 'visible') void syncFromBackend(true); };
    window.addEventListener('keydown', openQuickAdd);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    if (isTauri) timer = window.setInterval(() => void syncFromBackend(), 30_000);
    void initialize();
    return () => {
      window.removeEventListener('keydown', openQuickAdd);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
      if (timer !== undefined) window.clearInterval(timer);
    };

    async function initialize() {
      try {
        const status = await vaultStatus();
        if (!isTauri) { snapshot = demoSnapshot(); selectedId = snapshot.entities[0]?.id ?? ''; mode = 'ready'; return; }
        mode = status.exists ? status.unlocked ? 'ready' : 'unlock' : 'create';
        if (status.unlocked) { snapshot = await loadSnapshot(); selectedId = snapshot.entities[0]?.id ?? ''; }
      } catch (e) { error = readableError(e); mode = 'create'; }
    }
  });

  function readableError(e: unknown): string { return e instanceof Error ? e.message : typeof e === 'string' ? e : '操作失败'; }
  function selectEntity(id: string) { selectedId = id; editing = false; }
  function navMatches(entity: Entity, label: string): boolean {
    return label === 'all' || label === 'inbox' && entity.status === 'NEEDS_REVIEW' || label === 'expiring' && snapshot.events.some((event) => event.entityId === entity.id && event.status === 'UPCOMING' && event.dueAt && new Date(event.dueAt).getTime() < Date.now() + 90 * 86_400_000) || label === entity.category;
  }
  function nav(label: string) { activeNav = label; selectedId = snapshot.entities.find((entity) => navMatches(entity, label))?.id ?? ''; }
  function templateLabel(category: string) { return TEMPLATES.find((template) => template.category === category)?.label ?? category; }
  function getField(entity: Entity | undefined, key: string): string { return String(entity?.fields.find((field) => field.key === key)?.value ?? ''); }
  function fieldDisplay(field: Field): string { return field.valueType === 'json' ? JSON.stringify(field.value) : String(field.value ?? ''); }
  function entityName(id: string): string { return snapshot.entities.find((item) => item.id === id)?.name ?? '未知实体'; }
  function entityCategory(id: string): string { return snapshot.entities.find((item) => item.id === id)?.category ?? ''; }
  function formatDate(value?: string): string { if (!value) return '未设置'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
  function daysUntil(value?: string): string { if (!value) return ''; const days = Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000); return days < 0 ? '已过期' : `${days} 天后`; }

  function clearLockedState() {
    snapshot = emptySnapshot(); selectedId = ''; query = ''; editing = false; showAdd = false; showRelation = false; showEvent = false; showField = false; pendingImport = null; password = ''; passwordConfirm = '';
  }

  async function syncFromBackend(force = false) {
    if (!isTauri || mode !== 'ready' || saving) return;
    try {
      const status = await vaultStatus();
      if (!status.unlocked) { mode = 'unlock'; clearLockedState(); return; }
      const fresh = await loadSnapshot();
      if (force || fresh.revision !== snapshot.revision) {
        const currentId = selectedId;
        snapshot = fresh;
        selectedId = snapshot.entities.some((entity) => entity.id === currentId) ? currentId : snapshot.entities[0]?.id ?? '';
      }
    } catch (e) {
      if (mode === 'ready') error = readableError(e);
    }
  }

  async function createVault() {
    error = '';
    if (password.length < 12 || password !== passwordConfirm) { error = password.length < 12 ? '主密码至少 12 个字符' : '两次主密码不一致'; return; }
    try { snapshot = await initializeVault(password); mode = 'ready'; password = ''; passwordConfirm = ''; notice = 'Vault 已创建'; }
    catch (e) { error = readableError(e); }
  }
  async function unlock() {
    error = '';
    try { snapshot = await unlockVault(password); mode = 'ready'; password = ''; selectedId = snapshot.entities[0]?.id ?? ''; notice = 'Vault 已解锁'; }
    catch (e) { error = readableError(e); }
  }
  async function commit(next: VaultSnapshot, unlinkIds: string[] = [], selectedAfter = selectedId): Promise<boolean> {
    if (saving) return false;
    const previous = snapshot;
    const previousSelected = selectedId;
    snapshot = next;
    selectedId = selectedAfter;
    saving = true;
    try {
      snapshot = await saveSnapshot(next, unlinkIds);
      notice = '已保存'; setTimeout(() => notice = '', 1800);
      saving = false;
      return true;
    } catch (e) {
      saving = false;
      snapshot = previous;
      selectedId = previousSelected;
      error = readableError(e);
      await syncFromBackend(true);
      return false;
    }
  }
  async function doLock() {
    try { await lockVault(); } catch (e) { error = readableError(e); return; }
    if (isTauri) { mode = 'unlock'; clearLockedState(); } else notice = '预览模式无法锁定';
  }

  async function addEntity() {
    if (!addName.trim()) return;
    const template = TEMPLATES.find((item) => item.id === addTemplate) ?? TEMPLATES[0];
    const id = newId('entity'); const timestamp = nowIso();
    const valueKey = template.fields[0]?.key ?? 'purpose';
    const next: Entity = { id, name: addName.trim(), templateId: template.id, category: template.category, status: 'NEEDS_REVIEW', privacy: 'PRIVATE', tags: addTags.split(',').map((tag) => tag.trim()).filter(Boolean), fields: [{ id: newId('field'), entityId: id, key: valueKey, valueType: template.fields[0]?.valueType ?? 'text', value: addValue, privacy: template.fields[0]?.privacy ?? 'PRIVATE', searchable: true }], createdAt: timestamp, updatedAt: timestamp };
    if (await commit({ ...snapshot, entities: [next, ...snapshot.entities] }, [], id)) { showAdd = false; addName = ''; addTags = ''; addValue = ''; }
  }

  async function updateEntity() {
    if (!selected) return;
    const next = { ...snapshot, entities: snapshot.entities.map((item) => item.id === selected.id ? { ...item, name: editName.trim() || item.name, status: editStatus, tags: editTags.split(',').map((tag) => tag.trim()).filter(Boolean), updatedAt: nowIso() } : item) };
    if (await commit(next)) editing = false;
  }

  async function deleteSelected() {
    if (!selected) return;
    const hasRelations = snapshot.relations.some((item) => item.sourceId === selected.id || item.targetId === selected.id);
    if (hasRelations && !confirm('该实体仍有关系。确认解除关系并删除？')) return;
    if (!hasRelations && !confirm('确认删除该实体？')) return;
    const next = { ...snapshot, entities: snapshot.entities.filter((item) => item.id !== selected.id), relations: snapshot.relations.filter((item) => item.sourceId !== selected.id && item.targetId !== selected.id), events: snapshot.events.filter((item) => item.entityId !== selected.id) };
    await commit(next, hasRelations ? [selected.id] : [], next.entities[0]?.id ?? '');
  }
  async function addRelation() {
    if (!selected || !relationTarget || relationTarget === selected.id) return;
    if (snapshot.relations.some((item) => item.sourceId === selected.id && item.targetId === relationTarget && item.type === relationType)) { error = '关系已存在'; return; }
    const relation: Relation = { id: newId('relation'), sourceId: selected.id, type: relationType, targetId: relationTarget, note: relationNote.trim() || undefined, privacy: 'PRIVATE', createdAt: nowIso() };
    if (await commit({ ...snapshot, relations: [...snapshot.relations, relation] })) { showRelation = false; relationTarget = ''; relationNote = ''; }
  }
  async function removeRelation(id: string) { await commit({ ...snapshot, relations: snapshot.relations.filter((item) => item.id !== id) }); }
  async function addEvent() {
    if (!selected || !eventDueAt) return;
    const event: LifecycleEvent = { id: newId('event'), entityId: selected.id, type: eventType as LifecycleEvent['type'], dueAt: new Date(`${eventDueAt}T12:00:00`).toISOString(), policy: eventPolicy as LifecycleEvent['policy'], status: 'UPCOMING', note: eventNote.trim() || undefined };
    if (await commit({ ...snapshot, events: [...snapshot.events, event] })) { showEvent = false; eventDueAt = ''; eventNote = ''; }
  }

  function resetFieldForm(field?: Field) {
    editingFieldId = field?.id ?? '';
    fieldKey = field?.key ?? '';
    fieldValueType = field?.valueType ?? 'text';
    fieldValue = field ? fieldDisplay(field) : '';
    fieldPrivacy = field?.privacy ?? 'PRIVATE';
    fieldSearchable = field?.searchable ?? true;
    fieldSourceProvider = field?.sourceOfTruth?.provider ?? '';
    fieldSourceReference = field?.sourceOfTruth?.reference ?? '';
  }
  function openFieldForm(field?: Field) { resetFieldForm(field); showField = true; }
  function parseFieldValue(value: string, type: ValueType): unknown {
    if (type === 'number') { const parsed = Number(value); if (!Number.isFinite(parsed)) throw new Error('数字字段必须是有效数字'); return parsed; }
    if (type === 'boolean') return value === 'true';
    if (type === 'json') { try { return JSON.parse(value); } catch { throw new Error('JSON 字段格式无效'); } }
    return value;
  }
  async function saveField() {
    if (!selected || !fieldKey.trim()) { error = '字段名称不能为空'; return; }
    let value: unknown;
    try { value = parseFieldValue(fieldValue, fieldValueType); } catch (e) { error = readableError(e); return; }
    const sourceOfTruth = fieldSourceProvider.trim() || fieldSourceReference.trim() ? { kind: 'EXTERNAL' as const, provider: fieldSourceProvider.trim() || 'Vaultwarden', reference: fieldSourceReference.trim() || undefined } : undefined;
    const timestamp = nowIso();
    const field: Field = { id: editingFieldId || newId('field'), entityId: selected.id, key: fieldKey.trim(), valueType: fieldValueType, value, privacy: fieldPrivacy, searchable: fieldSearchable, sourceOfTruth };
    const nextEntity = { ...selected, fields: [...selected.fields.filter((item) => item.id !== field.id), field], updatedAt: timestamp };
    const next = { ...snapshot, entities: snapshot.entities.map((item) => item.id === selected.id ? nextEntity : item) };
    if (await commit(next)) { showField = false; resetFieldForm(); }
  }
  async function removeField(field: Field) {
    if (!selected || !confirm(`确认删除字段“${field.key}”？`)) return;
    const next = { ...snapshot, entities: snapshot.entities.map((item) => item.id === selected.id ? { ...item, fields: item.fields.filter((candidate) => candidate.id !== field.id), updatedAt: nowIso() } : item) };
    await commit(next);
  }
  async function openSource(reference?: string) {
    if (!reference) return;
    try { await openVaultwarden(reference); } catch (e) { error = readableError(e); }
  }
  async function downloadRedacted() {
    try { const payload = await exportRedactedJson(true); download('atlas-redacted.json', payload, 'application/json'); notice = '已导出脱敏 JSON'; }
    catch (e) { error = readableError(e); }
  }
  async function exportEncryptedBackup() {
    try { const payload = await exportBackup(); download('atlas-backup.atlas', payload, 'text/plain'); notice = '已导出加密备份'; }
    catch (e) { error = readableError(e); }
  }
  async function importEncryptedBackup(event: Event) { const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return; try { const backupPassword = prompt('请输入该备份的 Vault 主密码'); if (!backupPassword) throw new Error('已取消恢复'); await importBackup(await file.text(), backupPassword); mode = 'unlock'; notice = '备份已恢复，请解锁 Atlas'; } catch (e) { error = readableError(e); } (event.target as HTMLInputElement).value = ''; }
  async function importJson(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0]; if (!file) return;
    try { const text = await file.text(); pendingImport = { text, preview: await previewAtlasJson(text) }; }
    catch (e) { error = readableError(e); }
    input.value = '';
  }
  async function confirmImport() {
    if (!pendingImport) return;
    try {
      const before = snapshot.entities.length;
      snapshot = await importAtlasJson(pendingImport.text);
      selectedId = snapshot.entities[0]?.id ?? '';
      notice = `已导入 ${Math.max(0, snapshot.entities.length - before)} 个新实体`;
      pendingImport = null;
    } catch (e) { error = readableError(e); }
  }
  function download(name: string, content: string, type: string) { const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(new Blob([content], { type })); anchor.download = name; anchor.click(); URL.revokeObjectURL(anchor.href); }
</script>

{#if mode === 'loading'}
  <div class="splash"><div class="brand-mark">A</div><strong>Amiya Atlas</strong><span>正在打开本地 Vault…</span></div>
{:else if mode === 'create' || mode === 'unlock'}
  <main class="auth-screen">
    <section class="auth-card">
      <div class="brand-lockup"><div class="brand-mark">A</div><div><h1>Amiya Atlas</h1><p>本地优先的个人数字基础设施图谱</p></div></div>
      <div class="auth-copy"><span class="eyebrow">LOCAL VAULT</span><h2>{mode === 'create' ? '建立你的本地 Vault' : '解锁你的 Vault'}</h2><p>{mode === 'create' ? 'Atlas 只保存关系、上下文和生命周期。密码、Token、私钥继续留在 Vaultwarden。' : '数据库和关系拓扑均已加密。错误密码不会打开任何记录。'}</p></div>
      <form on:submit|preventDefault={mode === 'create' ? createVault : unlock}>
        <label>主密码<input bind:value={password} type="password" minlength="12" autocomplete={mode === 'create' ? 'new-password' : 'current-password'} placeholder="至少 12 个字符" /></label>
        {#if mode === 'create'}<label>再次输入<input bind:value={passwordConfirm} type="password" minlength="12" autocomplete="new-password" /></label>{/if}
        {#if error}<p class="form-error">{error}</p>{/if}
        <button class="primary wide" type="submit">{mode === 'create' ? '创建并解锁' : '解锁 Atlas'}</button>
      </form>
      <div class="auth-foot"><span>Argon2id · XChaCha20-Poly1305 · 无遥测</span>{#if !isTauri}<span>浏览器预览数据为虚构样例</span>{/if}</div>
    </section>
  </main>
{:else}
  <div class="app-shell">
    <header class="topbar">
      <div class="brand-lockup compact"><div class="brand-mark">A</div><div><strong>Amiya Atlas</strong><span>本地优先的个人数字基础设施图谱</span></div></div>
      <label class="global-search"><span>⌕</span><input bind:value={query} placeholder="搜索实体、域名、标签… 或输入命令" on:click|stopPropagation /><kbd>Ctrl K</kbd></label>
      <div class="top-actions"><button class="primary" on:click|stopPropagation={() => { showAdd = true; addMode = 'quick'; }}>＋ 快速添加</button><button class="icon-button" title="导入 JSON" on:click|stopPropagation={() => importInput.click()}>↥</button><button class="icon-button" title="导出脱敏 JSON" on:click|stopPropagation={downloadRedacted}>⇩</button><button class="icon-button" title="锁定" on:click|stopPropagation={doLock}>⌑</button></div>
    </header>
    <div class="workspace">
      <aside class="sidebar">
        <nav>
          <button class:active={activeNav === 'all'} on:click={() => nav('all')}><span>▣</span><b>全部</b><em>{snapshot.entities.length}</em></button>
          <button class:active={activeNav === 'inbox'} on:click={() => nav('inbox')}><span>▱</span><b>收件箱</b><em>{snapshot.entities.filter((item) => item.status === 'NEEDS_REVIEW').length}</em></button>
          <button class:active={activeNav === 'expiring'} on:click={() => nav('expiring')}><span>◷</span><b>即将过期</b><em>{expiringCount}</em></button>
        </nav>
        <div class="nav-section"><span class="nav-title">资产</span>{#each categories as category}<button class:active={activeNav === category} on:click={() => nav(category)}><span>{category === 'Identity' ? '♙' : category === 'Domain' ? '◎' : category === 'Server' ? '▤' : category === 'Project' ? '□' : '◌'}</span><b>{templateLabel(category)}</b><em>{snapshot.entities.filter((item) => item.category === category).length}</em></button>{/each}</div>
        <div class="nav-bottom"><span class="nav-title">工具</span><button on:click|stopPropagation={exportEncryptedBackup}><span>⇩</span><b>加密备份</b></button><button on:click|stopPropagation={() => backupInput.click()}><span>↥</span><b>恢复备份</b></button><button on:click|stopPropagation={() => { showAdd = true; addMode = 'template'; }}><span>＋</span><b>新建实体</b></button></div>
      </aside>
      <section class="entity-pane">
        <div class="pane-heading"><div><span class="eyebrow">{activeNav === 'all' ? 'INVENTORY' : 'FILTER'}</span><h2>{activeNav === 'all' ? '全部实体' : activeNav === 'expiring' ? '即将过期' : activeNav === 'inbox' ? '待整理' : templateLabel(activeNav)} <small>({visibleEntities.length})</small></h2></div><button class="icon-button muted">≡</button></div>
        <div class="list-tools"><label class="local-search"><span>⌕</span><input bind:value={query} placeholder="搜索名称、域名、标签…" /></label><button class="filter-button">☷ 筛选</button></div>
        <div class="list-header"><span>名称</span><span>类型</span><span>状态</span><span>更新</span></div>
        <div class="entity-list">
          {#each visibleEntities as entity (entity.id)}
            <button class:selected={entity.id === selectedId} class="entity-row" on:click={() => selectEntity(entity.id)}><span class="entity-icon">{entity.category === 'Domain' ? '◎' : entity.category === 'Server' ? '▤' : entity.category === 'Identity' ? '♙' : entity.category === 'Project' ? '□' : '◌'}</span><span class="entity-name"><strong>{entity.name}</strong><small>{entity.category}</small></span><span class="status-chip" class:review={entity.status === 'NEEDS_REVIEW'} class:planned={entity.status === 'PLANNED'}>{entity.status === 'ACTIVE' ? '正常' : entity.status === 'NEEDS_REVIEW' ? '待整理' : entity.status === 'PLANNED' ? '计划中' : entity.status}</span><time>{formatDate(entity.updatedAt)}</time></button>
          {:else}<div class="empty-list"><span>⌁</span><p>没有匹配实体</p><button class="secondary" on:click={() => { query = ''; activeNav = 'all'; }}>清除筛选</button></div>{/each}
        </div>
      </section>
      <section class="detail-pane">
        {#if selected}
          <div class="detail-head"><div class="detail-title"><div class="large-icon">{selected.category === 'Domain' ? '◎' : selected.category === 'Server' ? '▤' : selected.category === 'Identity' ? '♙' : selected.category === 'Project' ? '□' : '◌'}</div><div><h1>{selected.name}</h1><div class="title-meta"><span>{selected.category}</span><span class="status-chip" class:review={selected.status === 'NEEDS_REVIEW'}>{selected.status === 'ACTIVE' ? '正常' : selected.status}</span><span class="privacy-mark">PRIVATE</span></div></div></div><div class="detail-actions">{#if editing}<button class="primary" on:click={updateEntity}>保存</button><button class="secondary" on:click={() => editing = false}>取消</button>{:else}<button class="secondary" on:click={() => editing = true}>✎ 编辑</button>{/if}<button class="icon-button" on:click={deleteSelected}>⋯</button></div></div>
          <div class="tabs"><button class="active">概览</button><button>关系 <span>({inbound.length + outbound.length})</span></button><button>事件 <span>({snapshot.events.filter((event) => event.entityId === selected.id).length})</span></button><button>凭据 <span>({selected.fields.some((field) => field.sourceOfTruth?.provider === 'Vaultwarden') ? 1 : 0})</span></button></div>
          <div class="detail-scroll">
            <section class="detail-card basic-card"><div class="card-heading"><h3>基本信息</h3>{#if !editing}<span class="updated">更新于 {formatDate(selected.updatedAt)}</span>{/if}</div>{#if editing}<div class="edit-grid"><label>名称<input bind:value={editName} /></label><label>状态<select bind:value={editStatus}><option>ACTIVE</option><option>NEEDS_REVIEW</option><option>PLANNED</option><option>ARCHIVED</option></select></label><label class="full">标签<input bind:value={editTags} placeholder="用逗号分隔" /></label></div>{:else}<div class="field-grid"><div><span>名称</span><strong>{selected.name}</strong></div><div><span>创建时间</span><strong>{formatDate(selected.createdAt)}</strong></div><div><span>类型</span><strong>{selected.category}</strong></div><div><span>更新日期</span><strong>{formatDate(selected.updatedAt)}</strong></div><div><span>状态</span><strong>{selected.status}</strong></div><div><span>数据范围</span><strong>本地加密</strong></div></div><div class="tag-list">{#each selected.tags as tag}<span>{tag}</span>{/each}<button on:click={() => editing = true}>＋</button></div>{/if}<div class="field-list"><div class="card-heading field-heading"><h3>字段</h3><button class="secondary small" on:click={() => openFieldForm()}>＋ 添加字段</button></div>{#each selected.fields as field}<div class="field-line"><span>{field.key}</span><strong>{field.privacy === 'SECRET' ? '••••••••' : fieldDisplay(field)}</strong>{#if field.sourceOfTruth}<small>{field.sourceOfTruth.provider ?? '外部来源'} 引用</small>{/if}<span class="field-actions"><button title="编辑字段" on:click={() => openFieldForm(field)}>✎</button><button title="删除字段" on:click={() => removeField(field)}>×</button></span></div>{:else}<p class="muted-copy">暂无字段。把公开上下文或 Vaultwarden 引用加到这里。</p>{/each}</div></section>
            <section class="detail-card relations-card"><div class="card-heading"><h3>关系</h3><button class="secondary small" on:click={() => showRelation = true}>＋ 添加关系</button></div><div class="relation-columns"><div><h4>传入关系 <span>({inbound.length})</span></h4>{#each inbound as relation}<div class="relation-row"><span class="relation-icon">{entityCategory(relation.sourceId) === 'Domain' ? '◎' : '◌'}</span><div><strong>{entityName(relation.sourceId)}</strong><small>{entityCategory(relation.sourceId)}</small></div><code>{relation.type}</code><button on:click={() => removeRelation(relation.id)}>×</button></div>{:else}<p class="muted-copy">暂无传入关系</p>{/each}</div><div><h4>传出关系 <span>({outbound.length})</span></h4>{#each outbound as relation}<div class="relation-row"><span class="relation-icon">{entityCategory(relation.targetId) === 'Server' ? '▤' : '◌'}</span><div><strong>{entityName(relation.targetId)}</strong><small>{entityCategory(relation.targetId)}</small></div><code>{relation.type}</code><button on:click={() => removeRelation(relation.id)}>×</button></div>{:else}<p class="muted-copy">暂无传出关系</p>{/each}</div></div></section>
            <section class="detail-card events-card"><div class="card-heading"><h3>生命周期事件</h3><button class="secondary small" on:click={() => showEvent = true}>＋ 添加事件</button></div>{#each snapshot.events.filter((event) => event.entityId === selected.id) as event}<div class="event-row"><span class="event-dot"></span><div><strong>{event.type === 'RENEWAL' ? '续费提醒' : event.type === 'EXPIRY' ? '到期提醒' : '复核提醒'}</strong><small>{formatDate(event.dueAt)} · {daysUntil(event.dueAt)}</small></div><span class="event-policy">{event.policy ?? 'REVIEW'}</span></div>{:else}<p class="muted-copy">没有安排事件。把续费、到期和复核日期放在这里。</p>{/each}</section>
            <section class="detail-card source-card"><div class="card-heading"><h3>权威来源</h3></div><div class="source-row"><span class="vault-icon">⌑</span><div><strong>密码和 Token 不进入 Atlas</strong><small>{#if selected.fields.some((field) => field.sourceOfTruth?.reference)}已保存外部引用；需要凭据时只打开对应 Vaultwarden 条目。{:else}编辑字段可以保存 Vaultwarden 条目 URL 引用。{/if}</small></div>{#if selected.fields.some((field) => field.sourceOfTruth?.reference)}<button class="secondary small" on:click={() => openSource(selected.fields.find((field) => field.sourceOfTruth?.reference)?.sourceOfTruth?.reference)}>打开引用 ↗</button>{/if}</div></section>
          </div>
        {:else}<div class="detail-empty"><span>＋</span><h2>从左侧选择一个实体</h2><p>或者按 Ctrl K 快速添加第一条记录。</p></div>{/if}
      </section>
    </div>
    {#if notice}<div class="toast success">{notice}</div>{/if}{#if error}<div class="toast error">{error}</div>{/if}
  </div>
{/if}

{#if showAdd}<div class="modal-backdrop" role="presentation" on:click={() => showAdd = false}><section class="modal" role="dialog" aria-modal="true" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation><div class="modal-head"><div><span class="eyebrow">QUICK ADD</span><h2>{addMode === 'quick' ? '捕获一条新资产' : '新建实体'}</h2></div><button class="icon-button" on:click={() => showAdd = false}>×</button></div><form on:submit|preventDefault={addEntity}><label>名称<input bind:value={addName} placeholder="例如：Cloudflare Main" /></label><div class="form-grid"><label>模板<select bind:value={addTemplate}>{#each TEMPLATES as template}<option value={template.id}>{template.label}</option>{/each}</select></label><label>标签<input bind:value={addTags} placeholder="core, review" /></label></div><label>{TEMPLATES.find((item) => item.id === addTemplate)?.fields[0]?.key ?? '备注'}<input bind:value={addValue} placeholder="可稍后补充" /></label><p class="helper">名称是唯一必填项。保存后可在详情中继续补全字段、关系和生命周期。</p><div class="modal-actions"><button class="secondary" type="button" on:click={() => showAdd = false}>取消</button><button class="primary" type="submit">保存到收件箱</button></div></form></section></div>{/if}
{#if showRelation && selected}<div class="modal-backdrop" role="presentation" on:click={() => showRelation = false}><section class="modal" role="dialog" aria-modal="true" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation><div class="modal-head"><div><span class="eyebrow">RELATION</span><h2>添加关系</h2></div><button class="icon-button" on:click={() => showRelation = false}>×</button></div><form on:submit|preventDefault={addRelation}><label>关系类型<select bind:value={relationType}>{#each RELATION_TYPES as type}<option>{type}</option>{/each}</select></label><label>目标实体<select bind:value={relationTarget}><option value="">选择实体</option>{#each snapshot.entities.filter((item) => item.id !== selected.id) as entity}<option value={entity.id}>{entity.name} · {entity.category}</option>{/each}</select></label><label>备注<input bind:value={relationNote} placeholder="可选" /></label><div class="modal-actions"><button class="secondary" type="button" on:click={() => showRelation = false}>取消</button><button class="primary" type="submit">建立关系</button></div></form></section></div>{/if}
{#if showEvent && selected}<div class="modal-backdrop" role="presentation" on:click={() => showEvent = false}><section class="modal" role="dialog" aria-modal="true" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation><div class="modal-head"><div><span class="eyebrow">LIFECYCLE</span><h2>添加生命周期事件</h2></div><button class="icon-button" on:click={() => showEvent = false}>×</button></div><form on:submit|preventDefault={addEvent}><div class="form-grid"><label>类型<select bind:value={eventType}><option value="REVIEW">复核</option><option value="RENEWAL">续费</option><option value="EXPIRY">到期</option><option value="PAYMENT_DUE">付款</option></select></label><label>日期<input bind:value={eventDueAt} type="date" required /></label></div><label>策略<select bind:value={eventPolicy}><option value="REVIEW">需要复核</option><option value="MANUAL">手动续费</option><option value="DO_NOT_RENEW">不续费</option><option value="AUTO_RENEW">自动续费</option></select></label><label>备注<input bind:value={eventNote} placeholder="可选" /></label><div class="modal-actions"><button class="secondary" type="button" on:click={() => showEvent = false}>取消</button><button class="primary" type="submit">加入时间线</button></div></form></section></div>{/if}
{#if showField && selected}<div class="modal-backdrop" role="presentation" on:click={() => showField = false}><section class="modal" role="dialog" aria-modal="true" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation><div class="modal-head"><div><span class="eyebrow">FIELD</span><h2>{editingFieldId ? '编辑字段' : '添加字段'}</h2></div><button class="icon-button" on:click={() => showField = false}>×</button></div><form on:submit|preventDefault={saveField}><div class="form-grid"><label>字段名<input bind:value={fieldKey} placeholder="例如：provider" required /></label><label>值类型<select bind:value={fieldValueType}><option value="text">文本</option><option value="url">URL</option><option value="date">日期</option><option value="number">数字</option><option value="boolean">布尔</option><option value="json">JSON</option></select></label></div>{#if fieldValueType === 'boolean'}<label>值<select bind:value={fieldValue}><option value="false">否</option><option value="true">是</option></select></label>{:else if fieldValueType === 'json'}<label>值<textarea bind:value={fieldValue} rows="4" placeholder="有效 JSON"></textarea></label>{:else}<label>值<input bind:value={fieldValue} type={fieldValueType === 'date' ? 'date' : 'text'} /></label>{/if}<div class="form-grid"><label>隐私级别<select bind:value={fieldPrivacy}><option value="PUBLIC">PUBLIC · 可公开</option><option value="PRIVATE">PRIVATE · 本地私有</option><option value="SECRET">SECRET · 不导出</option></select></label><label class="check-label"><input bind:checked={fieldSearchable} type="checkbox" />允许搜索</label></div><div class="form-grid"><label>来源提供方<input bind:value={fieldSourceProvider} placeholder="Vaultwarden" /></label><label>来源引用 URL<input bind:value={fieldSourceReference} placeholder="https://vaultwarden.example/item/..." /></label></div><p class="helper">密码、Token、SSH 私钥和 CVV 不允许写入字段；这里只保存外部来源引用。</p><div class="modal-actions"><button class="secondary" type="button" on:click={() => showField = false}>取消</button><button class="primary" type="submit">保存字段</button></div></form></section></div>{/if}
{#if pendingImport}<div class="modal-backdrop" role="presentation" on:click={() => pendingImport = null}><section class="modal" role="dialog" aria-modal="true" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation><div class="modal-head"><div><span class="eyebrow">IMPORT REVIEW</span><h2>确认导入 Atlas JSON</h2></div><button class="icon-button" on:click={() => pendingImport = null}>×</button></div><p class="helper">文件已通过格式和字段校验。重复项会复用现有记录，冲突内容将在写入时拒绝。</p><div class="import-summary"><div><strong>{pendingImport.preview.entityCount}</strong><span>实体</span></div><div><strong>{pendingImport.preview.relationCount}</strong><span>关系</span></div><div><strong>{pendingImport.preview.eventCount}</strong><span>事件</span></div></div><p class="helper">可复用：实体 {pendingImport.preview.duplicateEntityCount}、关系 {pendingImport.preview.duplicateRelationCount}、事件 {pendingImport.preview.duplicateEventCount}。</p><div class="modal-actions"><button class="secondary" type="button" on:click={() => pendingImport = null}>取消</button><button class="primary" type="button" on:click={confirmImport}>确认导入</button></div></section></div>{/if}
<input class="hidden-input" bind:this={importInput} type="file" accept="application/json,.json" on:change={importJson} /><input class="hidden-input" bind:this={backupInput} type="file" accept=".atlas,text/plain" on:change={importEncryptedBackup} />
