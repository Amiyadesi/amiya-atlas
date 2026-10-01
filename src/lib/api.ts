import { invoke } from '@tauri-apps/api/core';
import type { CaptureRequest, ImportPreview, VaultSnapshot, VaultStatus } from './types';
import { demoSnapshot } from './demo';
import { emptySnapshot } from './types';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let browserSnapshot = demoSnapshot();
let browserUnlocked = true;

export async function vaultStatus(): Promise<VaultStatus> {
  if (!isTauri) return { exists: true, unlocked: browserUnlocked, entityCount: browserSnapshot.entities.length };
  return invoke<VaultStatus>('vault_status');
}

export async function initializeVault(password: string): Promise<VaultSnapshot> {
  if (!isTauri) { browserUnlocked = true; browserSnapshot = emptySnapshot(); return browserSnapshot; }
  await invoke('initialize_vault', { password });
  return invoke<VaultSnapshot>('load_snapshot');
}

export async function unlockVault(password: string): Promise<VaultSnapshot> {
  if (!isTauri) { browserUnlocked = true; return browserSnapshot; }
  await invoke('unlock_vault', { password });
  return invoke<VaultSnapshot>('load_snapshot');
}

export async function loadSnapshot(): Promise<VaultSnapshot> {
  if (!isTauri) return structuredClone(browserSnapshot);
  return invoke<VaultSnapshot>('load_snapshot');
}

export async function lockVault(): Promise<void> {
  if (!isTauri) { browserUnlocked = false; return; }
  await invoke('lock_vault');
}

export async function saveSnapshot(snapshot: VaultSnapshot, unlinkIds: string[] = []): Promise<VaultSnapshot> {
  if (!isTauri) { browserSnapshot = structuredClone({ ...snapshot, revision: snapshot.revision + 1 }); return structuredClone(browserSnapshot); }
  return invoke<VaultSnapshot>('save_snapshot', { snapshot, unlinkIds });
}

export async function exportBackup(): Promise<string> {
  if (!isTauri) throw new Error('浏览器预览模式不支持加密备份');
  return invoke<string>('export_backup');
}

export async function importBackup(payload: string, password: string): Promise<VaultSnapshot> {
  if (!isTauri) throw new Error('浏览器预览模式不支持恢复备份');
  return invoke<VaultSnapshot>('import_backup', { payload, password });
}

function parseAtlasFile(text: string): VaultSnapshot {
  if (text.length > 32 * 1024 * 1024) throw new Error('导入文件超过 32 MiB');
  let file: unknown;
  try { file = JSON.parse(text); } catch { throw new Error('不是有效 Atlas JSON；请检查文件格式'); }
  if (!file || typeof file !== 'object') throw new Error('不是有效 Atlas JSON；请检查文件格式');
  const value = file as { format?: unknown; version?: unknown; snapshot?: unknown };
  if (value.format !== 'amiya-atlas' || value.version !== 1 || !value.snapshot || typeof value.snapshot !== 'object') throw new Error('不支持的 Atlas 文件版本');
  const snapshot = value.snapshot as Partial<VaultSnapshot>;
  if (!Array.isArray(snapshot.entities) || !Array.isArray(snapshot.relations) || !Array.isArray(snapshot.events)) throw new Error('Atlas JSON 缺少实体、关系或事件列表');
  return { revision: Number(snapshot.revision ?? 0), entities: snapshot.entities, relations: snapshot.relations, events: snapshot.events } as VaultSnapshot;
}

function importSummary(imported: VaultSnapshot, current: VaultSnapshot): ImportPreview {
  const entityIds = new Set(current.entities.map((entity) => entity.id));
  const relationIds = new Set(current.relations.map((relation) => relation.id));
  const eventIds = new Set(current.events.map((event) => event.id));
  const relationKeys = new Set(current.relations.map((relation) => `${relation.sourceId}\u0000${relation.type}\u0000${relation.targetId}`));
  return {
    entityCount: imported.entities.length,
    relationCount: imported.relations.length,
    eventCount: imported.events.length,
    duplicateEntityCount: imported.entities.filter((entity) => entityIds.has(entity.id)).length,
    duplicateRelationCount: imported.relations.filter((relation) => relationIds.has(relation.id) || relationKeys.has(`${relation.sourceId}\u0000${relation.type}\u0000${relation.targetId}`)).length,
    duplicateEventCount: imported.events.filter((event) => eventIds.has(event.id)).length
  };
}

export async function previewAtlasJson(text: string): Promise<ImportPreview> {
  if (!isTauri) return importSummary(parseAtlasFile(text), browserSnapshot);
  return invoke<ImportPreview>('preview_atlas_json', { text });
}

export async function importAtlasJson(text: string): Promise<VaultSnapshot> {
  if (!isTauri) {
    const imported = parseAtlasFile(text);
    const entityIds = new Set(browserSnapshot.entities.map((entity) => entity.id));
    const relationIds = new Set(browserSnapshot.relations.map((relation) => relation.id));
    const eventIds = new Set(browserSnapshot.events.map((event) => event.id));
    const relationKeys = new Set(browserSnapshot.relations.map((relation) => `${relation.sourceId}\u0000${relation.type}\u0000${relation.targetId}`));
    if (imported.entities.some((entity) => entityIds.has(entity.id) && JSON.stringify(entity) !== JSON.stringify(browserSnapshot.entities.find((existing) => existing.id === entity.id)))) throw new Error('导入 ID 与现有数据冲突');
    if (imported.relations.some((relation) => relationIds.has(relation.id) && JSON.stringify(relation) !== JSON.stringify(browserSnapshot.relations.find((existing) => existing.id === relation.id)))) throw new Error('导入关系 ID 冲突');
    if (imported.events.some((event) => eventIds.has(event.id) && JSON.stringify(event) !== JSON.stringify(browserSnapshot.events.find((existing) => existing.id === event.id)))) throw new Error('导入事件 ID 冲突');
    browserSnapshot = {
      ...browserSnapshot,
      entities: [...browserSnapshot.entities, ...imported.entities.filter((entity) => !entityIds.has(entity.id))],
      relations: [...browserSnapshot.relations, ...imported.relations.filter((relation) => !relationIds.has(relation.id) && !relationKeys.has(`${relation.sourceId}\u0000${relation.type}\u0000${relation.targetId}`))],
      events: [...browserSnapshot.events, ...imported.events.filter((event) => !eventIds.has(event.id))],
      revision: browserSnapshot.revision + 1
    };
    return structuredClone(browserSnapshot);
  }
  return invoke<VaultSnapshot>('import_atlas_json', { text });
}

export async function exportRedacted(maskPrivate = true): Promise<string> {
  if (!isTauri) {
    const redacted = structuredClone(browserSnapshot);
    const secretIds = new Set(redacted.entities.filter((entity) => entity.privacy === 'SECRET').map((entity) => entity.id));
    redacted.entities = redacted.entities.filter((entity) => !secretIds.has(entity.id));
    for (const entity of redacted.entities) {
      entity.fields = entity.fields.filter((field) => field.privacy !== 'SECRET');
      for (const field of entity.fields) {
        if (maskPrivate && field.privacy === 'PRIVATE') { field.value = ''; field.searchable = false; }
        field.sourceOfTruth = undefined;
      }
    }
    redacted.relations = redacted.relations.filter((relation) => relation.privacy !== 'SECRET' && !secretIds.has(relation.sourceId) && !secretIds.has(relation.targetId));
    redacted.events = redacted.events.filter((event) => !secretIds.has(event.entityId));
    if (maskPrivate) redacted.events = [];
    return JSON.stringify({ format: 'amiya-atlas', version: 1, snapshot: redacted }, null, 2);
  }
  return invoke<string>('export_redacted', { maskPrivate });
}

export async function handleCapture(request: CaptureRequest): Promise<VaultSnapshot> {
  if (!isTauri) {
    let page: URL;
    try { page = new URL(request.url); } catch { throw new Error('网页 URL 无效'); }
    if (!['http:', 'https:'].includes(page.protocol) || page.username || page.password) throw new Error('仅接受不含凭据的 http/https 网页');
    const origin = page.origin;
    const identity = browserSnapshot.entities.find((item) => item.id === request.identityId && ['Identity', 'Email'].includes(item.category) && item.status === 'ACTIVE');
    if (!identity) throw new Error('选择的身份不存在或未启用');
    const relationType = identity.category === 'Email' ? 'REGISTERED_WITH' : 'AUTHENTICATES_WITH';
    const existing = browserSnapshot.entities.find((item) => item.category === 'Website Account' && item.fields.some((field) => field.key === 'origin' && field.value === origin) && browserSnapshot.relations.some((relation) => relation.sourceId === item.id && relation.targetId === request.identityId && relation.type === relationType));
    if (!existing) {
      const entityId = `website-${crypto.randomUUID()}`;
      browserSnapshot.entities.push({ id: entityId, name: request.title || page.hostname, templateId: 'website-account', category: 'Website Account', status: 'ACTIVE', privacy: 'PRIVATE', tags: ['captured'], fields: [{ id: `${entityId}-origin`, entityId, key: 'origin', valueType: 'url', value: origin, privacy: 'PRIVATE', searchable: true }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      browserSnapshot.relations.push({ id: `rel-${crypto.randomUUID()}`, sourceId: entityId, type: relationType, targetId: request.identityId, privacy: 'PRIVATE', createdAt: new Date().toISOString() });
    }
    return structuredClone(browserSnapshot);
  }
  return invoke<VaultSnapshot>('capture_website_account', { request });
}

export async function openVaultwarden(reference: string): Promise<void> {
  if (!/^https?:\/\//i.test(reference)) throw new Error('权威来源必须是 http/https URL');
  if (!isTauri) { window.open(reference, '_blank', 'noopener,noreferrer'); return; }
  await invoke('open_vaultwarden', { reference });
}
