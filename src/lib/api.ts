import { invoke, isTauri, isWindows, isMobile } from "./runtime";
import {validateLedger} from '../domain/ledger';
import {applyFinanceActions} from '../domain/finance-capture';
import type {
  CaptureRequest,
  ImportPreview,
  VaultSnapshot,
  VaultStatus,
} from "./types";
import { demoSnapshot } from "./demo";
import { emptySnapshot } from "./types";
import { newId, nowIso } from "./types";
import type { ProviderConfig } from "../ai/provider";
import type { Proposal } from "../domain/proposal";
import {
  applyBrowserProposal,
  validateProposal,
  undoBrowserProposal,
} from "../domain/proposal";

import { isPersistent } from "./runtime";
export { isTauri } from "./runtime";

let browserSnapshot = demoSnapshot();
let browserUnlocked = true;

export async function vaultStatus(): Promise<VaultStatus> {
  if (!isPersistent)
    return {
      exists: true,
      unlocked: browserUnlocked,
      entityCount: browserSnapshot.entities.length,
    };
  return invoke<VaultStatus>("vault_status");
}

export async function initializeVault(
  password: string,
): Promise<VaultSnapshot> {
  if (!isPersistent) {
    browserUnlocked = true;
    browserSnapshot = emptySnapshot();
    return browserSnapshot;
  }
  await invoke("initialize_vault", { password });
  return invoke<VaultSnapshot>("load_snapshot");
}

export async function unlockVault(password: string): Promise<VaultSnapshot> {
  if (!isPersistent) {
    browserUnlocked = true;
    return browserSnapshot;
  }
  await invoke("unlock_vault", { password });
  return invoke<VaultSnapshot>("load_snapshot");
}

export async function loadSnapshot(): Promise<VaultSnapshot> {
  if (!isPersistent) return structuredClone(browserSnapshot);
  return invoke<VaultSnapshot>("load_snapshot");
}

export async function setDeviceUnlock(enabled: boolean): Promise<void> {
  if (!isPersistent) throw new Error("设备解锁仅支持 Windows 桌面版");
  await invoke("set_device_unlock", { enabled });
}
export async function unlockDevice(): Promise<VaultSnapshot> {
  if (!isPersistent) throw new Error("设备解锁仅支持 Windows 桌面版");
  await invoke("unlock_device");
  return loadSnapshot();
}

export async function lockVault(): Promise<void> {
  if (!isPersistent) {
    browserUnlocked = false;
    return;
  }
  await invoke("lock_vault");
}

export async function saveSnapshot(
  snapshot: VaultSnapshot,
  unlinkIds: string[] = [],
): Promise<VaultSnapshot> {
  if (!isPersistent) {
    if(snapshot.revision!==browserSnapshot.revision) throw new Error('数据已更新，请刷新后重试');
    validateLedger(snapshot,browserSnapshot);
    browserSnapshot = structuredClone({
      ...snapshot,
      revision: snapshot.revision + 1,
    });
    return structuredClone(browserSnapshot);
  }
  return invoke<VaultSnapshot>("save_snapshot", { snapshot, unlinkIds });
}

export async function exportBackup(): Promise<string> {
  if (!isPersistent) throw new Error("浏览器预览模式不支持加密备份");
  return invoke<string>("export_backup");
}

export async function importBackup(
  payload: string,
  password: string,
): Promise<VaultSnapshot> {
  if (!isPersistent) throw new Error("浏览器预览模式不支持恢复备份");
  return invoke<VaultSnapshot>("import_backup", { payload, password });
}

function parseAtlasFile(text: string): VaultSnapshot {
  if (text.length > 32 * 1024 * 1024) throw new Error("导入文件超过 32 MiB");
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error("不是有效 Atlas JSON；请检查文件格式");
  }
  if (!file || typeof file !== "object")
    throw new Error("不是有效 Atlas JSON；请检查文件格式");
  const value = file as {
    format?: unknown;
    version?: unknown;
    snapshot?: unknown;
  };
  if (
    value.format !== "amiya-atlas" ||
    value.version !== 1 ||
    !value.snapshot ||
    typeof value.snapshot !== "object"
  )
    throw new Error("不支持的 Atlas 文件版本");
  const snapshot = value.snapshot as Partial<VaultSnapshot>;
  if (
    !Array.isArray(snapshot.entities) ||
    !Array.isArray(snapshot.relations) ||
    !Array.isArray(snapshot.events)
  )
    throw new Error("Atlas JSON 缺少实体、关系或事件列表");
  const result = {
    ...snapshot,
    revision: Number(snapshot.revision ?? 0),
    entities: snapshot.entities,
    relations: snapshot.relations,
    events: snapshot.events,
  } as VaultSnapshot;
  validateLedger(result);
  return result;
}

function importSummary(
  imported: VaultSnapshot,
  current: VaultSnapshot,
): ImportPreview {
  const entityIds = new Set(current.entities.map((entity) => entity.id));
  const relationIds = new Set(current.relations.map((relation) => relation.id));
  const eventIds = new Set(current.events.map((event) => event.id));
  const relationKeys = new Set(
    current.relations.map(
      (relation) =>
        `${relation.sourceId}\u0000${relation.type}\u0000${relation.targetId}`,
    ),
  );
  return {
    entityCount: imported.entities.length,
    transactionCount: imported.transactions?.length??0,
    relationCount: imported.relations.length,
    eventCount: imported.events.length,
    duplicateEntityCount: imported.entities.filter((entity) =>
      entityIds.has(entity.id),
    ).length,
    duplicateRelationCount: imported.relations.filter(
      (relation) =>
        relationIds.has(relation.id) ||
        relationKeys.has(
          `${relation.sourceId}\u0000${relation.type}\u0000${relation.targetId}`,
        ),
    ).length,
    duplicateEventCount: imported.events.filter((event) =>
      eventIds.has(event.id),
    ).length,
  };
}

export async function previewAtlasJson(text: string): Promise<ImportPreview> {
  if (!isPersistent) return importSummary(parseAtlasFile(text), browserSnapshot);
  return invoke<ImportPreview>("preview_atlas_json", { text });
}

export async function importAtlasJson(text: string): Promise<VaultSnapshot> {
  if (!isPersistent) {
    const imported = parseAtlasFile(text);
    const entityIds = new Set(
      browserSnapshot.entities.map((entity) => entity.id),
    );
    const relationIds = new Set(
      browserSnapshot.relations.map((relation) => relation.id),
    );
    const eventIds = new Set(browserSnapshot.events.map((event) => event.id));
    const relationKeys = new Set(
      browserSnapshot.relations.map(
        (relation) =>
          `${relation.sourceId}\u0000${relation.type}\u0000${relation.targetId}`,
      ),
    );
    if (
      imported.entities.some(
        (entity) =>
          entityIds.has(entity.id) &&
          JSON.stringify(entity) !==
            JSON.stringify(
              browserSnapshot.entities.find(
                (existing) => existing.id === entity.id,
              ),
            ),
      )
    )
      throw new Error("导入 ID 与现有数据冲突");
    if (
      imported.relations.some(
        (relation) =>
          relationIds.has(relation.id) &&
          JSON.stringify(relation) !==
            JSON.stringify(
              browserSnapshot.relations.find(
                (existing) => existing.id === relation.id,
              ),
            ),
      )
    )
      throw new Error("导入关系 ID 冲突");
    if (
      imported.events.some(
        (event) =>
          eventIds.has(event.id) &&
          JSON.stringify(event) !==
            JSON.stringify(
              browserSnapshot.events.find(
                (existing) => existing.id === event.id,
              ),
            ),
      )
    )
      throw new Error("导入事件 ID 冲突");
    const next:VaultSnapshot = {
      ...browserSnapshot,
      entities: [
        ...browserSnapshot.entities,
        ...imported.entities.filter((entity) => !entityIds.has(entity.id)),
      ],
      relations: [
        ...browserSnapshot.relations,
        ...imported.relations.filter(
          (relation) =>
            !relationIds.has(relation.id) &&
            !relationKeys.has(
              `${relation.sourceId}\u0000${relation.type}\u0000${relation.targetId}`,
            ),
        ),
      ],
      events: [
        ...browserSnapshot.events,
        ...imported.events.filter((event) => !eventIds.has(event.id)),
      ],
      revision: browserSnapshot.revision + 1,
    };
    for(const key of ['ledgerAccounts','transactions','allocationRules','financeRecords','opaqueRecords'] as const){
      const identity=(item:any)=>key==='opaqueRecords'?`${item.kind}:${item.data.id}`:item.id;
      const items=new Map((browserSnapshot[key]??[]).map(item=>[identity(item),item]));
      for(const item of imported[key]??[]){const previous=items.get(identity(item));if(previous&&JSON.stringify(previous)!==JSON.stringify(item))throw new Error('导入财务 ID 冲突');items.set(identity(item),item);}
      (next as any)[key]=[...items.values()];
    }
    const keys=new Map<string,NonNullable<VaultSnapshot['transactions']>[number]>(),remap=new Map<string,string>();
    for(const t of next.transactions??[]){const previous=keys.get(t.idempotencyKey);if(previous){if(JSON.stringify({...t,id:previous.id,createdAt:previous.createdAt})!==JSON.stringify(previous))throw new Error('同一幂等键包含不同流水');remap.set(t.id,previous.id);}else keys.set(t.idempotencyKey,t);}
    next.transactions=[...keys.values()].map(t=>t.reversalOf&&remap.has(t.reversalOf)?{...t,reversalOf:remap.get(t.reversalOf)}:t);
    validateLedger(next,browserSnapshot);
    browserSnapshot=next;
    return structuredClone(browserSnapshot);
  }
  return invoke<VaultSnapshot>("import_atlas_json", { text });
}

export async function exportRedacted(maskPrivate = true): Promise<string> {
  if (!isPersistent) {
    const redacted = structuredClone(browserSnapshot);
    delete redacted.aiConfig;
    delete redacted.captures;
    delete redacted.proposals;
    delete redacted.transactions;delete redacted.ledgerAccounts;delete redacted.allocationRules;delete redacted.financeRecords;delete redacted.opaqueRecords;
    const secretIds = new Set(
      redacted.entities
        .filter((entity) => entity.privacy === "SECRET")
        .map((entity) => entity.id),
    );
    redacted.entities = redacted.entities.filter(
      (entity) => !secretIds.has(entity.id),
    );
    for (const entity of redacted.entities) {
      entity.fields = entity.fields.filter(
        (field) => field.privacy !== "SECRET" && field.valueType!=='money' && !['note','notes','description','cost','monthly_cost','fee','quote','price','amount','balance','currency','avoidable_project','project'].includes(field.key.toLowerCase()),
      );
      for (const field of entity.fields) {
        if (maskPrivate && field.privacy === "PRIVATE") {
          field.value = "";
          field.searchable = false;
        }
        field.sourceOfTruth = undefined;
      }
    }
    redacted.relations = redacted.relations.filter(
      (relation) =>
        relation.privacy !== "SECRET" &&
        !secretIds.has(relation.sourceId) &&
        !secretIds.has(relation.targetId),
    );
    redacted.events = redacted.events.filter(
      (event) => !secretIds.has(event.entityId),
    );
    for(const relation of redacted.relations)delete relation.note;
    for(const event of redacted.events)delete event.note;
    if (maskPrivate) redacted.events = [];
    return JSON.stringify(
      { format: "amiya-atlas", version: 1, snapshot: redacted },
      null,
      2,
    );
  }
  return invoke<string>("export_redacted", { maskPrivate });
}

export async function beginTextCapture(
  text: string,
  inputType: "text" | "clipboard" | "voice" = "text",
): Promise<VaultSnapshot> {
  if (isPersistent)
    return invoke<VaultSnapshot>("begin_text_capture", { text, inputType });
  if (!text.trim() || text.length > 10000)
    throw new Error("请输入 1–10000 字的记忆");
  browserSnapshot = {
    ...browserSnapshot,
    captures: [
      ...(browserSnapshot.captures ?? []),
      {
        id: newId("capture"),
        rawText: text.trim(),
        inputType,
        timestamp: nowIso(),
        status: "PENDING",
      },
    ],
    revision: browserSnapshot.revision + 1,
  };
  return structuredClone(browserSnapshot);
}
export async function stageProposal(
  captureId: string,
  content: Proposal,
  provider: string,
): Promise<VaultSnapshot> {
  if (isPersistent)
    return invoke<VaultSnapshot>("stage_proposal", {
      captureId,
      content,
      provider,
    });
  const input = browserSnapshot.captures?.find(
    (c) => c.id === captureId && c.status === "PENDING",
  );
  if (!input) throw new Error("原文不存在或已处理");
  content = structuredClone(content);
  content.numbersReviewed=false;
  applyFinanceActions(browserSnapshot,content.financeActions??[],input);
  for (const item of [
    ...content.entitiesToUpdate,
    ...(content.entitiesToDelete ?? []),
  ]) {
    const entity = browserSnapshot.entities.find(
      (e) => e.id === item.id && e.privacy !== "SECRET",
    );
    if (
      !entity ||
      (item.expectedUpdatedAt && item.expectedUpdatedAt !== entity.updatedAt)
    )
      throw new Error("记忆已变化，请重新解析");
    item.expectedUpdatedAt = entity.updatedAt;
  }
  validateProposal(content, browserSnapshot, input.rawText);
  browserSnapshot = {
    ...browserSnapshot,
    proposals: [
      ...(browserSnapshot.proposals ?? []).map((p) =>
        p.captureId === captureId && p.status === "PENDING"
          ? { ...p, status: "DISMISSED" as const }
          : p,
      ),
      {
        id: newId("proposal"),
        captureId,
        content: structuredClone(content),
        provider,
        status: "PENDING",
        createdAt: nowIso(),
        entityIds: [],
        baseRevision: browserSnapshot.revision + 1,
      },
    ],
    revision: browserSnapshot.revision + 1,
  };
  return structuredClone(browserSnapshot);
}
export async function reviseProposal(
  proposalId: string,
  content: Proposal,
): Promise<VaultSnapshot> {
  if (isPersistent)
    return invoke<VaultSnapshot>("revise_proposal", { proposalId, content });
  applyBrowserProposal(browserSnapshot, proposalId, content);
  browserSnapshot = {
    ...browserSnapshot,
    proposals: browserSnapshot.proposals?.map((p) =>
      p.id === proposalId && p.status === "PENDING"
        ? {
            ...p,
            content: structuredClone(content),
            baseRevision: browserSnapshot.revision + 1,
          }
        : p,
    ),
    revision: browserSnapshot.revision + 1,
  };
  return structuredClone(browserSnapshot);
}

export async function confirmProposal(
  proposalId: string,
  content: Proposal,
): Promise<VaultSnapshot> {
  if (isPersistent)
    return invoke<VaultSnapshot>("confirm_proposal", { proposalId, content });
  browserSnapshot = applyBrowserProposal(browserSnapshot, proposalId, content);
  return structuredClone(browserSnapshot);
}
export async function undoProposal(proposalId: string): Promise<VaultSnapshot> {
  if (isPersistent) return invoke<VaultSnapshot>("undo_proposal", { proposalId });
  browserSnapshot = undoBrowserProposal(browserSnapshot, proposalId);
  return structuredClone(browserSnapshot);
}
export async function dismissCapture(
  captureId: string,
): Promise<VaultSnapshot> {
  if (isPersistent) return invoke<VaultSnapshot>("dismiss_capture", { captureId });
  browserSnapshot = {
    ...browserSnapshot,
    captures: browserSnapshot.captures?.map((c) =>
      c.id === captureId ? { ...c, status: "DISMISSED" } : c,
    ),
    proposals: browserSnapshot.proposals?.map((p) =>
      p.captureId === captureId && p.status === "PENDING"
        ? { ...p, status: "DISMISSED" }
        : p,
    ),
    revision: browserSnapshot.revision + 1,
  };
  return structuredClone(browserSnapshot);
}
export async function saveAiConfig(
  config: ProviderConfig,
): Promise<VaultSnapshot> {
  if (isPersistent) return invoke<VaultSnapshot>("save_ai_config", { config });
  browserSnapshot = {
    ...browserSnapshot,
    aiConfig: structuredClone(config),
    revision: browserSnapshot.revision + 1,
  };
  return structuredClone(browserSnapshot);
}
export async function prepareLocalModel(model: string): Promise<void> {
  if (!isPersistent) throw new Error("请在桌面版下载本地模型；浏览器仅提供临时预览");
  return invoke("prepare_local_model", { model });
}

export async function readCaptureClipboard(): Promise<string> {
  const text = isTauri && !isMobile
    ? await invoke<string>("read_capture_clipboard")
    : await navigator.clipboard.readText();
  if (!text.trim()) throw new Error("剪贴板里没有文字");
  if (text.length > 10000)
    throw new Error("剪贴板超过 10000 字，请选取需要的内容");
  return text.trim();
}

export async function warmLocalModel(config: ProviderConfig): Promise<void> {
  if (isWindows && config.kind === "local")
    await invoke("warm_local_model", { config });
}

export async function handleCapture(
  request: CaptureRequest,
): Promise<VaultSnapshot> {
  if (!isPersistent) {
    let page: URL;
    try {
      page = new URL(request.url);
    } catch {
      throw new Error("网页 URL 无效");
    }
    if (
      !["http:", "https:"].includes(page.protocol) ||
      page.username ||
      page.password
    )
      throw new Error("仅接受不含凭据的 http/https 网页");
    const origin = page.origin;
    const identity = browserSnapshot.entities.find(
      (item) =>
        item.id === request.identityId &&
        ["Identity", "Email"].includes(item.category) &&
        item.status === "ACTIVE",
    );
    if (!identity) throw new Error("选择的身份不存在或未启用");
    const relationType =
      identity.category === "Email" ? "REGISTERED_WITH" : "AUTHENTICATES_WITH";
    const existing = browserSnapshot.entities.find(
      (item) =>
        item.category === "Website Account" &&
        item.fields.some(
          (field) => field.key === "origin" && field.value === origin,
        ) &&
        browserSnapshot.relations.some(
          (relation) =>
            relation.sourceId === item.id &&
            relation.targetId === request.identityId &&
            relation.type === relationType,
        ),
    );
    if (!existing) {
      const entityId = `website-${crypto.randomUUID()}`;
      browserSnapshot.entities.push({
        id: entityId,
        name: request.title || page.hostname,
        templateId: "website-account",
        category: "Website Account",
        status: "ACTIVE",
        privacy: "PRIVATE",
        tags: ["captured"],
        fields: [
          {
            id: `${entityId}-origin`,
            entityId,
            key: "origin",
            valueType: "url",
            value: origin,
            privacy: "PRIVATE",
            searchable: true,
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      browserSnapshot.relations.push({
        id: `rel-${crypto.randomUUID()}`,
        sourceId: entityId,
        type: relationType,
        targetId: request.identityId,
        privacy: "PRIVATE",
        createdAt: new Date().toISOString(),
      });
    }
    return structuredClone(browserSnapshot);
  }
  return invoke<VaultSnapshot>("capture_website_account", { request });
}

export async function openVaultwarden(reference: string): Promise<void> {
  if (!/^https?:\/\//i.test(reference))
    throw new Error("权威来源必须是 http/https URL");
  if (!isPersistent) {
    window.open(reference, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("open_vaultwarden", { reference });
}
