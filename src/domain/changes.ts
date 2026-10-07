import type { Proposal } from "./proposal";
import type {
  Entity,
  Relation,
  LifecycleEvent,
  VaultSnapshot,
} from "../lib/types";
import { newId } from "../lib/types";

export interface ChangeRecords {
  entities: Entity[];
  relations: Relation[];
  events: LifecycleEvent[];
}
export interface ProposalUndo {
  appliedRevision: number;
  before: ChangeRecords;
  after: ChangeRecords;
}
const deleteWords = /删除|删掉|删去|移除|忘掉|\b(?:delete|remove|forget)\b/i;
const negativeDelete =
  /(?:不要|别|不能|不想|不用|请勿|勿|不|暂不|先不)\s*(?:删除|删掉|删去|删|移除|忘掉|忘)|\b(?:do not|don['’]t|never)\s+(?:delete|remove|forget)\b/i;
export function hasDeleteIntent(text: string): boolean {
  return text
    .split(/[，,。!！?？;；\n]/)
    .some((part) => deleteWords.test(part) && !negativeDelete.test(part));
}
export function hasRemovalIntent(text: string): boolean {
  return (
    hasDeleteIntent(text) ||
    /解绑|解除|去掉|清空|不再绑定|不再关联|取消.*提醒|\b(?:unlink|disconnect)\b/i.test(
      text,
    )
  );
}
function mentions(text: string, entity: Entity): boolean {
  const input = text.toLowerCase().normalize("NFKC");
  const name = entity.name.toLowerCase().normalize("NFKC");
  return (
    input.includes(name) ||
    (name.match(/[a-z][a-z0-9@._+-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? []).some(
      (token) => input.includes(token),
    )
  );
}
function explicitEntityDeletion(
  text: string,
  entity: Entity,
  snapshot: VaultSnapshot,
): boolean {
  return text.split(/[，,。!！?？;；\n]/).some((part) => {
    if (!hasDeleteIntent(part) || !mentions(part, entity)) return false;
    // A request to remove one field/reminder must never erase its owning memory.
    if (
      /属性|字段|月费|费用|备注|提醒|关联|关系|绑定|\b(?:field|attribute|reminder|event|relation|link)\b/i.test(
        part,
      ) &&
      !/整条|整个|连同|及其|和它的|以及它的|\b(?:entire|including)\b/i.test(
        part,
      )
    )
      return false;
    const name = entity.name.toLowerCase();
    if (part.toLowerCase().includes(name))
      return (
        snapshot.entities.filter(
          (e) => e.privacy !== "SECRET" && e.name.toLowerCase() === name,
        ).length === 1
      );
    return (
      name.match(/[a-z][a-z0-9@._+-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? []
    ).some(
      (token) =>
        part.toLowerCase().includes(token) &&
        snapshot.entities.filter(
          (e) => e.privacy !== "SECRET" && e.name.toLowerCase().includes(token),
        ).length === 1,
    );
  });
}
function removalMentions(text: string, entity: Entity): boolean {
  return text
    .split(/[，,。!！?？;；\n]/)
    .some((part) => hasRemovalIntent(part) && mentions(part, entity));
}
export function deletionTargets(proposal: Proposal, snapshot: VaultSnapshot) {
  const entities = new Set((proposal.entitiesToDelete ?? []).map((e) => e.id));
  const relations = new Set([
    ...(proposal.relationsToDelete ?? []).map((r) => r.id),
    ...snapshot.relations
      .filter((r) => entities.has(r.sourceId) || entities.has(r.targetId))
      .map((r) => r.id),
  ]);
  const events = new Set([
    ...(proposal.eventsToDelete ?? []).map((e) => e.id),
    ...snapshot.events.filter((e) => entities.has(e.entityId)).map((e) => e.id),
  ]);
  return { entities, relations, events };
}

/** Destructive intent, known IDs and visible targets are checked before staging and again before commit. */
export function validateRemovals(
  proposal: Proposal,
  snapshot: VaultSnapshot,
  rawText: string,
): void {
  const known = new Map(
    snapshot.entities
      .filter((e) => e.privacy !== "SECRET")
      .map((e) => [e.id, e]),
  );
  const removed = new Set<string>();
  if (proposal.entitiesToDelete?.length && !hasDeleteIntent(rawText))
    throw new Error("停用不等于删除；删除记忆需要原文明说");
  for (const item of proposal.entitiesToDelete ?? []) {
    const entity = known.get(item.id);
    if (!entity || removed.has(item.id))
      throw new Error("无效或重复的删除目标");
    if (!explicitEntityDeletion(rawText, entity, snapshot))
      throw new Error("删除对象不明确，或原文没有同意删除它，请补充完整名称");
    if (entity.fields.some((f) => f.privacy === "SECRET"))
      throw new Error("这项记忆含秘密字段，请手动处理，或选择停用保留");
    if (proposal.entitiesToUpdate.some((e) => e.id === item.id))
      throw new Error("同一记忆不能同时修改和删除");
    removed.add(item.id);
  }
  for (const item of [
    ...proposal.entitiesToCreate,
    ...proposal.entitiesToUpdate,
  ]) {
    const keys = item.attributesToRemove ?? [];
    if (!keys.length) continue;
    if (!("id" in item) || !hasRemovalIntent(rawText))
      throw new Error("只有明确提出的已有属性才能删除");
    const entity = known.get(item.id);
    if (!entity || !removalMentions(rawText, entity))
      throw new Error("待删除属性的对象不明确，请补充名称");
    const seen = new Set<string>();
    for (const key of keys) {
      const field = entity?.fields.find((f) => f.key === key);
      if (
        !field ||
        field.privacy === "SECRET" ||
        seen.has(key) ||
        key in item.attributes ||
        (key === "notes" && item.notes)
      )
        throw new Error("待删除属性不存在、重复或与修改冲突");
      seen.add(key);
    }
  }
  if (
    (proposal.relationsToDelete?.length || proposal.eventsToDelete?.length) &&
    !hasRemovalIntent(rawText)
  )
    throw new Error("解除关联或移除提醒需要原文依据");
  for (const key of ["relationsToDelete", "eventsToDelete"] as const) {
    const ids = new Set<string>();
    for (const item of proposal[key] ?? []) {
      if (ids.has(item.id)) throw new Error("重复删除操作");
      ids.add(item.id);
      if (key === "relationsToDelete") {
        const relation = snapshot.relations.find((r) => r.id === item.id);
        if (
          !relation ||
          relation.privacy === "SECRET" ||
          !known.has(relation.sourceId) ||
          !known.has(relation.targetId)
        )
          throw new Error("待删除关联不存在或不可访问");
        if (
          !removalMentions(rawText, known.get(relation.sourceId)!) ||
          !removalMentions(rawText, known.get(relation.targetId)!)
        )
          throw new Error("解除关联的对象不明确，请补充两端名称");
        if (
          proposal.relationsToCreate.some(
            (r) =>
              r.from === relation.sourceId &&
              r.to === relation.targetId &&
              r.type === relation.type,
          )
        )
          throw new Error("同一关联不能同时新增和删除");
      } else {
        const event = snapshot.events.find((e) => e.id === item.id);
        if (!event || !known.has(event.entityId))
          throw new Error("待删除事件不存在或不可访问");
        if (!removalMentions(rawText, known.get(event.entityId)!))
          throw new Error("待删除提醒的对象不明确，请补充名称");
        if (
          proposal.eventsToCreate.some(
            (e) =>
              e.entityRef === event.entityId &&
              e.type === event.type &&
              e.dueAt === (event.dueAt ?? "") &&
              e.policy === event.policy,
          )
        )
          throw new Error("同一事件不能同时新增和删除");
      }
    }
  }
  const targets = deletionTargets(proposal, snapshot);
  if (
    snapshot.relations.some(
      (r) =>
        targets.relations.has(r.id) &&
        (r.privacy === "SECRET" ||
          !known.has(r.sourceId) ||
          !known.has(r.targetId)),
    )
  )
    throw new Error("此删除会涉及隐藏关联，请先手动处理，或选择停用保留");
}

export function projectEntity(
  existing: Entity,
  item:
    Proposal["entitiesToCreate"][number] | Proposal["entitiesToUpdate"][number],
  timestamp = existing.updatedAt,
): Entity {
  const next = structuredClone(existing);
  next.name = item.name.trim();
  next.status = item.status;
  next.updatedAt = timestamp;
  next.fields = next.fields.filter(
    (f) => !(item.attributesToRemove ?? []).includes(f.key),
  );
  const attrs = { ...item.attributes };
  if (item.notes) {
    const old = String(
      existing.fields.find((f) => f.key === "notes")?.value ?? "",
    );
    attrs.notes =
      old && !old.includes(item.notes)
        ? `${old}\n${item.notes}`
        : old || item.notes;
  }
  for (const [key, value] of Object.entries(attrs)) {
    const valueType =
      typeof value === "number"
        ? "number"
        : typeof value === "boolean"
          ? "boolean"
          : Array.isArray(value)
            ? "json"
            : "text";
    const field = next.fields.find((f) => f.key === key);
    if (field?.privacy === "SECRET") throw new Error("AI 不可覆盖秘密字段");
    if (field) {
      field.value = value;
      field.valueType = valueType;
    } else
      next.fields.push({
        id: newId("field"),
        entityId: next.id,
        key,
        value,
        valueType,
        privacy: "PRIVATE",
        searchable: true,
      });
  }
  return next;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export function createUndo(
  before: VaultSnapshot,
  after: VaultSnapshot,
  appliedRevision: number,
): ProposalUndo {
  const left: ChangeRecords = { entities: [], relations: [], events: [] };
  const right: ChangeRecords = { entities: [], relations: [], events: [] };
  for (const key of ["entities", "relations", "events"] as const) {
    const original = new Map(before[key].map((item) => [item.id, item]));
    const current = new Map(after[key].map((item) => [item.id, item]));
    for (const item of before[key])
      if (!equal(item, current.get(item.id)))
        (left[key] as Array<typeof item>).push(structuredClone(item));
    for (const item of after[key])
      if (!equal(item, original.get(item.id)))
        (right[key] as Array<typeof item>).push(structuredClone(item));
  }
  return { appliedRevision, before: left, after: right };
}
export function undoBrowserProposal(
  current: VaultSnapshot,
  proposalId: string,
): VaultSnapshot {
  const record = current.proposals?.find((p) => p.id === proposalId);
  if (!record || record.status !== "CONFIRMED" || !record.undo)
    throw new Error("这次变更不能撤销");
  if (record.undo.appliedRevision !== current.revision)
    throw new Error("记忆库已有新的操作，不能覆盖后续变更；请用新提案修正");
  const next = structuredClone(current);
  for (const key of ["entities", "relations", "events"] as const) {
    const ids = new Set(
      [...record.undo.before[key], ...record.undo.after[key]].map(
        (item) => item.id,
      ),
    );
    (next[key] as Array<{ id: string }>) = [
      ...next[key].filter((item) => !ids.has(item.id)),
      ...structuredClone(record.undo.before[key]),
    ];
  }
  next.proposals = next.proposals?.map((p) =>
    p.id === proposalId
      ? {
          ...p,
          status: "PENDING",
          entityIds: [],
          undo: undefined,
          baseRevision: current.revision + 1,
        }
      : p,
  );
  next.captures = next.captures?.map((c) =>
    c.id === record.captureId ? { ...c, status: "PENDING" } : c,
  );
  next.revision += 1;
  return next;
}

export type ChangeKind = "add" | "update" | "remove";
export interface DiffRow {
  key: string;
  before?: string;
  after?: string;
}
export interface ProposalChange {
  id: string;
  kind: ChangeKind;
  label: string;
  category: string;
  rows: DiffRow[];
  automatic?: boolean;
}
export const statusLabel = (status: string) =>
  ({
    ACTIVE: "使用中",
    INACTIVE: "已停用",
    ARCHIVED: "已归档",
    PLANNED: "计划中",
    NEEDS_REVIEW: "待检查",
  })[status] ?? status;
const display = (value: unknown) =>
  Array.isArray(value)
    ? value.join("、")
    : typeof value === "boolean"
      ? value
        ? "是"
        : "否"
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
const values = (entity: Entity) =>
  new Map([
    ["name", entity.name],
    ["type", entity.category],
    ["status", statusLabel(entity.status)],
    ...entity.fields
      .filter((f) => f.privacy !== "SECRET")
      .map((f) => [`attribute:${f.key}`, display(f.value)] as [string, string]),
  ]);
function rows(before?: Entity, after?: Entity): DiffRow[] {
  const old = before ? values(before) : new Map<string, string>();
  const next = after ? values(after) : new Map<string, string>();
  return [...new Set([...old.keys(), ...next.keys()])]
    .filter((key) => old.get(key) !== next.get(key))
    .map((key) => ({ key, before: old.get(key), after: next.get(key) }));
}
/** Preview derives values and cascades from stored facts, using the same patch rules as browser commit. */
export function proposalDiff(
  proposal: Proposal,
  snapshot: VaultSnapshot,
): ProposalChange[] {
  const changes: ProposalChange[] = [];
  const names = new Map([
    ...snapshot.entities
      .filter((e) => e.privacy !== "SECRET")
      .map((e) => [e.id, e.name] as const),
    ...proposal.entitiesToCreate.map((e) => [e.ref, e.name] as const),
  ]);
  for (const item of proposal.entitiesToCreate) {
    const empty: Entity = {
      id: item.ref,
      name: "",
      category: item.type,
      status: "",
      privacy: "PRIVATE",
      fields: [],
      tags: [],
      createdAt: "",
      updatedAt: "",
    };
    changes.push({
      id: item.ref,
      kind: "add",
      label: item.name,
      category: "记忆",
      rows: rows(undefined, projectEntity(empty, item)),
    });
  }
  for (const item of proposal.entitiesToUpdate) {
    const old = snapshot.entities.find(
      (e) => e.id === item.id && e.privacy !== "SECRET",
    );
    if (!old) continue;
    const diff = rows(old, projectEntity(old, item));
    if (diff.length)
      changes.push({
        id: item.id,
        kind: "update",
        label: old.name,
        category: "记忆",
        rows: diff,
      });
  }
  const targets = deletionTargets(proposal, snapshot);
  for (const entity of snapshot.entities.filter(
    (e) => targets.entities.has(e.id) && e.privacy !== "SECRET",
  ))
    changes.push({
      id: entity.id,
      kind: "remove",
      label: entity.name,
      category: "记忆",
      rows: rows(entity),
    });
  for (const item of proposal.relationsToCreate) {
    if (
      snapshot.relations.some(
        (r) =>
          r.sourceId === item.from &&
          r.targetId === item.to &&
          r.type === item.type,
      )
    )
      continue;
    changes.push({
      id: `${item.from}:${item.type}:${item.to}`,
      kind: "add",
      label: `${names.get(item.from) ?? item.from} → ${names.get(item.to) ?? item.to}`,
      category: "关联",
      rows: [
        { key: "relation", after: item.type },
        ...(item.note ? [{ key: "notes", after: item.note }] : []),
      ],
    });
  }
  for (const relation of snapshot.relations.filter(
    (r) =>
      targets.relations.has(r.id) &&
      r.privacy !== "SECRET" &&
      names.has(r.sourceId) &&
      names.has(r.targetId),
  ))
    changes.push({
      id: relation.id,
      kind: "remove",
      label: `${names.get(relation.sourceId)} → ${names.get(relation.targetId)}`,
      category: "关联",
      automatic:
        targets.entities.has(relation.sourceId) ||
        targets.entities.has(relation.targetId),
      rows: [
        { key: "relation", before: relation.type },
        ...(relation.note ? [{ key: "notes", before: relation.note }] : []),
      ],
    });
  for (const item of proposal.eventsToCreate) {
    if (
      snapshot.events.some(
        (e) =>
          e.entityId === item.entityRef &&
          e.type === item.type &&
          (e.dueAt ?? "") === item.dueAt &&
          e.policy === item.policy,
      )
    )
      continue;
    changes.push({
      id: `${item.entityRef}:${item.type}:${item.dueAt}`,
      kind: "add",
      label: names.get(item.entityRef) ?? item.entityRef,
      category: "生命周期",
      rows: [
        { key: "event", after: item.type },
        { key: "dueAt", after: item.dueAt || "日期待定" },
        { key: "policy", after: item.policy },
        ...(item.note ? [{ key: "notes", after: item.note }] : []),
      ],
    });
  }
  for (const event of snapshot.events.filter(
    (e) => targets.events.has(e.id) && names.has(e.entityId),
  ))
    changes.push({
      id: event.id,
      kind: "remove",
      label: names.get(event.entityId)!,
      category: "生命周期",
      automatic: targets.entities.has(event.entityId),
      rows: [
        { key: "event", before: event.type },
        { key: "dueAt", before: event.dueAt ?? "日期待定" },
        ...(event.policy ? [{ key: "policy", before: event.policy }] : []),
        ...(event.recurrence
          ? [{ key: "recurrence", before: event.recurrence }]
          : []),
        ...(event.note ? [{ key: "notes", before: event.note }] : []),
      ],
    });
  return changes;
}
