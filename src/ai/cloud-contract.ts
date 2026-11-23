import { z } from "zod";
import { ENTITY_TYPES, STATUSES } from "../domain/proposal";
import { RELATION_TYPES, type VaultSnapshot } from "../lib/types";
const id = z.string().min(1).max(100);
export const cloudInputSchema = z.strictObject({
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{16,100}$/),
  kind: z.enum(["capture", "query", "ledger", "ledger-query"]),
  ledgerAccounts: z
    .array(
      z.strictObject({
        id,
        name: z.string().min(1).max(200),
        kind: z.enum(["ASSET", "LIABILITY", "INCOME", "EXPENSE", "EQUITY"]),
        asset: z.string().max(12).optional(),
      }),
    )
    .max(1000)
    .optional(),
  text: z.string().trim().min(1).max(10000),
  now: z.iso.datetime(),
  entities: z
    .array(
      z.strictObject({
        id,
        name: z.string().min(1).max(500),
        type: z.enum(ENTITY_TYPES),
        status: z.enum(STATUSES),
        fieldKeys: z.array(z.string().min(1).max(100)).max(50).default([]),
      }),
    )
    .max(12),
  relations: z
    .array(
      z.strictObject({ id, from: id, to: id, type: z.enum(RELATION_TYPES) }),
    )
    .max(30),
  events: z
    .array(
      z.strictObject({
        id,
        entityRef: id,
        type: z.enum([
          "EXPIRY",
          "RENEWAL",
          "REVIEW",
          "PAYMENT_DUE",
          "CUSTOM",
          "CANCELLATION",
          "REMINDER",
        ]),
        dueAt: z.string().max(35),
      }),
    )
    .max(20),
});
export type CloudInput = z.infer<typeof cloudInputSchema>;
export function assertNoSecrets(text: string) {
  if (
    /-----BEGIN [\w ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9]{20,}|Bearer\s+\S{16,})|(?:password|passwd|api[_ -]?key|token|cvv|cvc|密码|私钥)\s*[:=：]\s*\S+|\b\d{13,19}\b/i.test(
      text,
    )
  )
    throw new Error(
      "请移除密码、Token、私钥或完整卡号，仅使用密码库引用和卡号后四位。",
    );
}
export function cloudSnapshot(input: CloudInput): VaultSnapshot {
  const ids = new Set(input.entities.map((e) => e.id));
  if (
    ids.size !== input.entities.length ||
    input.relations.some((r) => !ids.has(r.from) || !ids.has(r.to)) ||
    input.events.some((e) => !ids.has(e.entityRef))
  )
    throw new Error("Cloud context has invalid references");
  return {
    revision: 0,
    ledgerAccounts: input.ledgerAccounts?.map((a) => ({
      ...a,
      privacy: "PRIVATE",
    })),
    entities: input.entities.map((e) => ({
      id: e.id,
      name: e.name,
      category: e.type,
      status: e.status,
      privacy: "PRIVATE",
      tags: [],
      createdAt: input.now,
      updatedAt: input.now,
      fields: e.fieldKeys.map((key, i) => ({
        id: `${e.id}-field-${i}`,
        entityId: e.id,
        key,
        value: "",
        valueType: "text",
        privacy: "PRIVATE",
        searchable: false,
      })),
    })),
    relations: input.relations.map((r) => ({
      id: r.id,
      sourceId: r.from,
      targetId: r.to,
      type: r.type,
      privacy: "PRIVATE",
      createdAt: input.now,
    })),
    events: input.events.map((e) => ({
      id: e.id,
      entityId: e.entityRef,
      type: e.type,
      dueAt: e.dueAt,
      status: "UPCOMING",
    })),
  };
}
