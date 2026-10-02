import { z } from "zod";
import type { Entity, VaultSnapshot } from "../lib/types";
import { RELATION_TYPES, newId, nowIso } from "../lib/types";

export const ENTITY_TYPES = [
  "Generic",
  "Account",
  "Email",
  "Phone / SIM",
  "Bank Account",
  "Payment Card",
  "Subscription",
  "Domain",
  "Server",
  "Service",
  "Project",
  "Repository",
] as const;
export function attributeLabel(key: string): string {
  const labels: Record<string, string> = {
    region: "地区",
    country: "国家 / 地区",
    provider: "服务商",
    monthly_cost: "月费",
    monthly_cost_approximate: "费用为约数",
    currency: "币种",
    roles: "用途",
    decision: "目前决定",
    account_count: "账号总数",
    email: "邮箱",
    address: "地址",
    url: "网址",
    location: "位置",
    notes: "备注",
    renewal_policy: "续费策略",
  };
  return labels[key] ?? key;
}

export const STATUSES = [
  "ACTIVE",
  "NEEDS_REVIEW",
  "PLANNED",
  "ARCHIVED",
  "INACTIVE",
] as const;
const text = z.string().trim().min(1).max(500);
const attributes = z.record(
  z.string().min(1).max(100),
  z.union([
    z.string().max(5000),
    z.number().finite(),
    z.boolean(),
    z.array(z.string().max(500)).max(20),
  ]),
);
const shape = {
  name: text,
  type: z.enum(ENTITY_TYPES),
  status: z.enum(STATUSES),
  attributes,
  notes: z.string().max(5000),
  evidence: z.string().min(1).max(10000),
};
export const proposalSchema = z.strictObject({
  entitiesToCreate: z.array(z.strictObject({ ref: text, ...shape })).max(20),
  entitiesToUpdate: z
    .array(
      z.strictObject({
        id: text,
        expectedUpdatedAt: z.string().optional(),
        ...shape,
      }),
    )
    .max(20),
  relationsToCreate: z
    .array(
      z.strictObject({
        from: text,
        to: text,
        type: z.enum(RELATION_TYPES),
        note: z.string().max(5000),
        evidence: shape.evidence,
      }),
    )
    .max(50),
  eventsToCreate: z
    .array(
      z.strictObject({
        entityRef: text,
        type: z.enum([
          "EXPIRY",
          "RENEWAL",
          "REVIEW",
          "CANCELLATION",
          "REMINDER",
        ]),
        dueAt: z.string().max(35),
        precision: z.enum(["day", "month", "year", "unknown"]),
        policy: z.enum(["AUTO_RENEW", "MANUAL", "DO_NOT_RENEW", "REVIEW"]),
        note: z.string().max(5000),
        evidence: shape.evidence,
      }),
    )
    .max(30),
  uncertainty: z.array(z.string().max(1000)).max(30),
});
export type Proposal = z.infer<typeof proposalSchema>;
export interface TextCapture {
  id: string;
  rawText: string;
  inputType: "text";
  timestamp: string;
  status: "PENDING" | "CONFIRMED" | "DISMISSED";
}
export interface ProposalRecord {
  id: string;
  captureId: string;
  status: "PENDING" | "CONFIRMED" | "DISMISSED";
  content: Proposal;
  provider: string;
  createdAt: string;
  entityIds: string[];
}

export function parseModelJson(output: string): unknown {
  if (output.length > 100000) throw new Error("模型结果过长，请缩短输入后重试");
  const clean = output
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(clean);
  } catch {
    throw new Error("模型没有返回有效提案。原文已保留，可以重试。");
  }
}

const normalize = (name: string) => name.trim().normalize("NFKC").toLowerCase();
export function entityType(
  entity: Entity,
): Proposal["entitiesToCreate"][number]["type"] {
  if (
    entity.category === "Identity" ||
    entity.category === "Website Account" ||
    entity.category === "AI Provider Account"
  )
    return "Account";
  if (entity.category === "SIM") return "Phone / SIM";
  return ENTITY_TYPES.includes(entity.category as (typeof ENTITY_TYPES)[number])
    ? (entity.category as (typeof ENTITY_TYPES)[number])
    : "Generic";
}

/** Exact matches can be updates; fuzzy matches remain visible suggestions. Never silently merge identities. */
export function matchEntities(
  input: Proposal,
  snapshot: VaultSnapshot,
  rawText: string,
): Proposal {
  const proposal = structuredClone(proposalSchema.parse(input));
  const remap = new Map<string, string>();
  const remaining: Proposal["entitiesToCreate"] = [];
  for (const candidate of proposal.entitiesToCreate) {
    const matches = snapshot.entities.filter(
      (e) =>
        e.privacy !== "SECRET" &&
        normalize(e.name) === normalize(candidate.name) &&
        entityType(e) === candidate.type,
    );
    if (matches.length === 1) {
      const { ref, ...patch } = candidate;
      if (
        proposal.entitiesToUpdate.some((update) => update.id === matches[0].id)
      )
        throw new Error("模型对同一实体提出了重复修改，请重试");
      remap.set(ref, matches[0].id);
      proposal.entitiesToUpdate.push({
        ...patch,
        id: matches[0].id,
        expectedUpdatedAt: matches[0].updatedAt,
      });
    } else {
      remaining.push(candidate);
      if (matches.length > 1)
        proposal.uncertainty.push(
          `“${candidate.name}”匹配多个现有记忆，请修改名称或重新说明。`,
        );
    }
  }
  proposal.entitiesToCreate = remaining;
  for (const update of proposal.entitiesToUpdate) {
    const entity = snapshot.entities.find(
      (e) => e.id === update.id && e.privacy !== "SECRET",
    );
    if (!entity) throw new Error("模型引用了不存在或不可访问的实体，请重试");
    update.expectedUpdatedAt = entity.updatedAt;
  }
  proposal.relationsToCreate.forEach((r) => {
    r.from = remap.get(r.from) ?? r.from;
    r.to = remap.get(r.to) ?? r.to;
  });
  proposal.eventsToCreate.forEach((e) => {
    e.entityRef = remap.get(e.entityRef) ?? e.entityRef;
  });
  validateProposal(proposal, snapshot, rawText);
  return proposal;
}

export function validateProposal(
  proposal: Proposal,
  snapshot: VaultSnapshot,
  rawText: string,
): void {
  proposalSchema.parse(proposal);
  if (
    !proposal.entitiesToCreate.length &&
    !proposal.entitiesToUpdate.length &&
    !proposal.relationsToCreate.length &&
    !proposal.eventsToCreate.length
  )
    throw new Error("没有识别出可保存的记忆，请补充名称或信息");
  const known = new Set(
    snapshot.entities.filter((e) => e.privacy !== "SECRET").map((e) => e.id),
  );
  const refs = new Set<string>();
  const updates = new Set<string>();
  for (const entity of proposal.entitiesToCreate) {
    if (known.has(entity.ref) || refs.has(entity.ref))
      throw new Error("提案含重复实体引用");
    refs.add(entity.ref);
  }
  for (const update of proposal.entitiesToUpdate) {
    if (!known.has(update.id) || updates.has(update.id))
      throw new Error("提案含无效或重复更新");
    updates.add(update.id);
  }
  const exists = (id: string) => known.has(id) || refs.has(id);
  const edges = new Set<string>();
  for (const relation of proposal.relationsToCreate) {
    if (
      !exists(relation.from) ||
      !exists(relation.to) ||
      relation.from === relation.to
    )
      throw new Error("关系必须连接两个已知实体");
    const key = `${relation.from}\0${relation.type}\0${relation.to}`;
    if (edges.has(key)) throw new Error("提案含重复关系");
    edges.add(key);
  }
  for (const event of proposal.eventsToCreate) {
    if (!exists(event.entityRef)) throw new Error("事件引用了不存在的实体");
    const pattern = {
      day: /^\d{4}-\d{2}-\d{2}$/,
      month: /^\d{4}-\d{2}$/,
      year: /^\d{4}$/,
      unknown: /^$/,
    }[event.precision];
    if (!pattern.test(event.dueAt))
      throw new Error("日期必须保留原文精度，不能猜测具体日期");
    if (event.precision !== "unknown") {
      const date =
        event.precision === "month"
          ? `${event.dueAt}-01`
          : event.precision === "year"
            ? `${event.dueAt}-01-01`
            : event.dueAt;
      const parsed = new Date(`${date}T12:00:00Z`);
      if (
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== date
      )
        throw new Error("事件日期无效");
    }
  }
  const changes = [
    ...proposal.entitiesToCreate,
    ...proposal.entitiesToUpdate,
    ...proposal.relationsToCreate,
    ...proposal.eventsToCreate,
  ];
  if (changes.some((c) => !rawText.includes(c.evidence)))
    throw new Error("提案缺少原文依据，请重试");
}

const regionAliases: Record<string, string[]> = {
  US: ["美国", "美國", "usa", "united states"],
  JP: ["日本", "japan"],
  CN: ["中国", "中國", "china"],
  HK: ["香港", "hong kong"],
  TW: ["台湾", "台灣", "taiwan"],
};
export function searchEntities(
  snapshot: VaultSnapshot,
  query: string,
  region = "",
): Entity[] {
  const q = normalize(query);
  const candidates = snapshot.entities.filter(
    (e) =>
      e.privacy !== "SECRET" &&
      (!region ||
        e.fields.some(
          (f) =>
            f.privacy !== "SECRET" &&
            f.searchable &&
            ["region", "country"].includes(f.key) &&
            [region.toLowerCase(), ...(regionAliases[region] ?? [])].includes(
              normalize(String(f.value)),
            ),
        )),
  );
  if (!q) return candidates;
  const aliases = new Set([q]);
  for (const [code, names] of Object.entries(regionAliases))
    if ([code.toLowerCase(), ...names].includes(q))
      [code.toLowerCase(), ...names].forEach((name) => aliases.add(name));
  return candidates.filter(
    (e) =>
      e.privacy !== "SECRET" &&
      [
        e.name,
        e.category,
        ...e.tags,
        ...e.fields
          .filter((f) => f.searchable && f.privacy !== "SECRET")
          .map((f) =>
            typeof f.value === "object"
              ? JSON.stringify(f.value)
              : String(f.value),
          ),
      ].some((value) =>
        [...aliases].some((alias) => normalize(value).includes(alias)),
      ),
  );
}

export function oneHop(
  snapshot: VaultSnapshot,
  rootIds: string[],
  types: string[] = [],
) {
  const roots = new Set(rootIds);
  const visible = new Set(
    snapshot.entities.filter((e) => e.privacy !== "SECRET").map((e) => e.id),
  );
  const relations = snapshot.relations.filter(
    (r) =>
      r.privacy !== "SECRET" &&
      visible.has(r.sourceId) &&
      visible.has(r.targetId) &&
      (roots.has(r.sourceId) || roots.has(r.targetId)) &&
      (!types.length || types.includes(r.type)),
  );
  const ids = new Set([
    ...rootIds.filter((id) => visible.has(id)),
    ...relations.flatMap((r) => [r.sourceId, r.targetId]),
  ]);
  return {
    entities: snapshot.entities.filter((e) => ids.has(e.id)),
    relations,
  };
}

/** Browser preview only. The desktop commits through independently validated Rust transactions. */
export function applyBrowserProposal(
  current: VaultSnapshot,
  proposalId: string,
  content: Proposal,
): VaultSnapshot {
  const record = current.proposals?.find((p) => p.id === proposalId);
  if (!record) throw new Error("提案不存在");
  if (record.status === "CONFIRMED") return structuredClone(current);
  if (record.status !== "PENDING") throw new Error("提案已撤回");
  const input = current.captures?.find(
    (c) => c.id === record.captureId && c.status === "PENDING",
  );
  if (!input) throw new Error("原文已处理");
  validateProposal(content, current, input.rawText);
  const next = structuredClone(current);
  const refs = new Map(next.entities.map((e) => [e.id, e.id]));
  const changed = new Set<string>();
  const timestamp = nowIso();
  const patch = (
    entity: Entity,
    item:
      | Proposal["entitiesToCreate"][number]
      | Proposal["entitiesToUpdate"][number],
  ) => {
    entity.name = item.name;
    entity.status = item.status;
    entity.updatedAt = timestamp;
    const attrs = { ...item.attributes };
    if (item.notes) {
      const old = String(
        entity.fields.find((f) => f.key === "notes")?.value ?? "",
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
      const field = entity.fields.find((f) => f.key === key);
      if (field?.privacy === "SECRET") throw new Error("AI 不可覆盖秘密字段");
      if (field) {
        field.value = value;
        field.valueType = valueType;
      } else
        entity.fields.push({
          id: newId("field"),
          entityId: entity.id,
          key,
          value,
          valueType,
          privacy: "PRIVATE",
          searchable: true,
        });
    }
  };
  for (const item of content.entitiesToCreate) {
    if (
      next.entities.some(
        (e) =>
          normalize(e.name) === normalize(item.name) &&
          entityType(e) === item.type,
      )
    )
      throw new Error("同名实体已存在，请重新解析");
    const entity: Entity = {
      id: newId("entity"),
      name: item.name,
      category: item.type,
      status: item.status,
      privacy: "PRIVATE",
      tags: [],
      fields: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    patch(entity, item);
    refs.set(item.ref, entity.id);
    changed.add(entity.id);
    next.entities.push(entity);
  }
  for (const item of content.entitiesToUpdate) {
    const existing = next.entities.find((e) => e.id === item.id);
    const staged = record.content.entitiesToUpdate.find(
      (e) => e.id === item.id,
    );
    if (
      !existing ||
      existing.updatedAt !== item.expectedUpdatedAt ||
      staged?.expectedUpdatedAt !== item.expectedUpdatedAt
    )
      throw new Error("记忆已变化，请重新解析");
    patch(existing, item);
    changed.add(existing.id);
  }
  for (const item of content.relationsToCreate) {
    const sourceId = refs.get(item.from)!;
    const targetId = refs.get(item.to)!;
    if (
      !next.relations.some(
        (r) =>
          r.sourceId === sourceId &&
          r.targetId === targetId &&
          r.type === item.type,
      )
    )
      next.relations.push({
        id: newId("relation"),
        sourceId,
        targetId,
        type: item.type,
        note: item.note,
        privacy: "PRIVATE",
        createdAt: timestamp,
      });
    changed.add(sourceId);
    changed.add(targetId);
  }
  for (const item of content.eventsToCreate) {
    const entityId = refs.get(item.entityRef)!;
    if (
      !next.events.some(
        (e) =>
          e.entityId === entityId &&
          e.type === item.type &&
          (e.dueAt ?? "") === item.dueAt &&
          e.policy === item.policy,
      )
    )
      next.events.push({
        id: newId("event"),
        entityId,
        type: item.type,
        dueAt: item.dueAt || undefined,
        duePrecision: item.precision === "unknown" ? undefined : item.precision,
        policy: item.policy,
        status: item.precision === "unknown" ? "UNKNOWN" : "UPCOMING",
        note: item.note,
      });
    changed.add(entityId);
  }
  next.captures = next.captures?.map((c) =>
    c.id === input.id ? { ...c, status: "CONFIRMED" } : c,
  );
  next.proposals = next.proposals?.map((p) =>
    p.id === record.id
      ? {
          ...p,
          status: "CONFIRMED",
          content: structuredClone(content),
          entityIds: [...changed],
        }
      : p,
  );
  next.revision += 1;
  return next;
}
