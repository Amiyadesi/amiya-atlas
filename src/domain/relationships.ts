import type { Entity, Relation, VaultSnapshot } from "../lib/types";
import { newId, nowIso } from "../lib/types";
import type { Proposal } from "./proposal";

export interface ConnectionSlot {
  key: string;
  label: string;
  type: string;
  alternatives?: string[];
  categories: string[];
  createCategory: string;
  fields: string[];
  required?: boolean;
}
const provider = (label = "服务商", fields = ["provider"]): ConnectionSlot => ({
  key: "provider",
  label,
  type: "ISSUED_BY",
  categories: [
    "Provider",
    "Service",
    "Account",
    "Identity",
    "Website Account",
    "AI Provider Account",
  ],
  createCategory: "Provider",
  fields,
  required: true,
});
const login: ConnectionSlot = {
  key: "login",
  label: "注册 / 登录方式",
  type: "REGISTERED_WITH",
  alternatives: ["AUTHENTICATES_WITH", "OWNS_ADDRESS"],
  categories: [
    "Email",
    "SIM",
    "Phone / SIM",
    "Account",
    "Identity",
    "Website Account",
    "AI Provider Account",
  ],
  createCategory: "Email",
  fields: [
    "email",
    "registration_email",
    "registered_with",
    "login_identity",
    "phone",
  ],
  required: true,
};
const hosted: ConnectionSlot = {
  key: "server",
  label: "部署服务器",
  type: "HOSTED_ON",
  alternatives: ["DEPLOYED_ON"],
  categories: ["Server", "Service"],
  createCategory: "Server",
  fields: ["server", "server_id", "hosted_on", "deployed_on"],
};
const domain: ConnectionSlot = {
  key: "domain",
  label: "访问域名",
  type: "EXPOSED_AT",
  categories: ["Domain"],
  createCategory: "Domain",
  fields: ["domain", "fqdn"],
};
const upstream: ConnectionSlot = {
  key: "upstream",
  label: "上游 / 额度来源",
  type: "DEPENDS_ON",
  alternatives: ["USES"],
  categories: [
    "Account",
    "Identity",
    "Website Account",
    "AI Provider Account",
    "Service",
    "Subscription",
    "Server",
  ],
  createCategory: "Account",
  fields: ["upstream", "upstreams", "quota_source", "provider_account"],
};
const payment: ConnectionSlot = {
  key: "payment",
  label: "付款账户",
  type: "PAID_BY",
  categories: ["Payment Card", "Bank Account"],
  createCategory: "Payment Card",
  fields: ["paid_by", "payment_account"],
};

export function connectionSlots(category: string): ConnectionSlot[] {
  switch (category) {
    case "Account":
    case "Identity":
    case "Website Account":
    case "AI Provider Account":
      return [login, { ...provider("所属平台"), required: false }];
    case "SIM":
    case "Phone / SIM":
      return [provider("运营商", ["carrier", "operator", "provider"])];
    case "Payment Card":
    case "Bank Account":
      return [provider("银行 / 发卡方", ["issuer", "bank", "provider"])];
    case "Domain":
      return [
        {
          ...provider("注册商", ["registrar", "provider"]),
          type: "MANAGED_BY",
          alternatives: ["ISSUED_BY"],
        },
      ];
    case "Server":
      return [{ ...provider(), required: false }];
    case "Email":
      return [
        { ...provider("邮箱服务商"), required: false },
        {
          ...login,
          key: "recovery",
          label: "找回方式",
          type: "RECOVERS_WITH",
          alternatives: [],
          fields: ["recovery_email", "recovery_phone"],
          required: false,
        },
      ];
    case "Service":
    case "Project":
      return [
        domain,
        hosted,
        upstream,
        {
          key: "source",
          label: "源码仓库",
          type: "SOURCE_IN",
          categories: ["Repository"],
          createCategory: "Repository",
          fields: ["repository", "source_in"],
        },
      ];
    case "Subscription":
      return [
        {
          ...upstream,
          key: "account",
          label: "订阅账号",
          type: "USES",
          alternatives: [],
          fields: ["account", "account_id"],
        },
        payment,
        { ...provider(), required: false },
      ];
    default:
      return [];
  }
}
export function slotRelations(
  slot: ConnectionSlot,
  id: string,
  relations: Relation[],
): Relation[] {
  const types = [slot.type, ...(slot.alternatives ?? [])];
  return relations.filter(
    (r) =>
      (r.sourceId === id && types.includes(r.type)) ||
      (slot.key === "server" && r.targetId === id && r.type === "HOSTS") ||
      (slot.key === "provider" && r.targetId === id && r.type === "MANAGES"),
  );
}
export function connectionGaps(
  entity: Entity,
  snapshot: Pick<VaultSnapshot, "relations">,
): ConnectionSlot[] {
  if (["ARCHIVED", "INACTIVE", "PLANNED"].includes(entity.status)) return [];
  return connectionSlots(entity.category).filter(
    (slot) =>
      slot.required &&
      !slotRelations(slot, entity.id, snapshot.relations).length,
  );
}
export function connectionHints(
  entity: Entity,
  slot: ConnectionSlot,
): Array<{ name: string; category: string }> {
  return entity.fields
    .filter((f) => f.privacy !== "SECRET" && slot.fields.includes(f.key))
    .flatMap((f) =>
      (Array.isArray(f.value) ? f.value : [f.value])
        .filter((v): v is string => typeof v === "string" && !!v.trim())
        .map((value) => ({
          name: value.trim(),
          category:
            slot.key === "login"
              ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
                ? "Email"
                : /^[+\d][\d ()-]{5,}$/.test(value)
                  ? "Phone / SIM"
                  : "Account"
              : slot.createCategory,
        })),
    );
}

export function proposedConnectionGaps(
  proposal: Proposal,
  snapshot: VaultSnapshot,
) {
  const removed = new Set((proposal.relationsToDelete ?? []).map((r) => r.id));
  const relations = [
    ...snapshot.relations.filter((r) => !removed.has(r.id)),
    ...proposal.relationsToCreate.map((r, i) => ({
      id: `proposed-${i}`,
      sourceId: r.from,
      targetId: r.to,
      type: r.type,
      privacy: "PRIVATE" as const,
      createdAt: "",
    })),
  ];
  return proposal.entitiesToCreate.flatMap((item) => {
    const entity: Entity = {
      id: item.ref,
      name: item.name,
      category: item.type,
      status: item.status,
      privacy: "PRIVATE",
      tags: [],
      fields: [],
      createdAt: "",
      updatedAt: "",
    };
    const gaps = connectionGaps(entity, { relations });
    return gaps.length
      ? [
          {
            ref: item.ref,
            name: item.name,
            status: item.status,
            labels: gaps.map((g) => g.label),
          },
        ]
      : [];
  });
}

export function fieldConnections(snapshot: VaultSnapshot) {
  const created: Entity[] = [],
    relations: Relation[] = [],
    ambiguous: string[] = [];
  const all = snapshot.entities.filter((e) => e.privacy !== "SECRET");
  const normalize = (value: string) => value.trim().toLocaleLowerCase();
  for (const entity of all)
    for (const slot of connectionSlots(entity.category)) {
      for (const hint of connectionHints(entity, slot).filter(
        (h) =>
          h.name.length <= 500 &&
          !/^(unknown|needs_review|待确认|未知|未填写|无|n\/a)$/i.test(h.name),
      )) {
        const candidates = [...all, ...created].filter(
          (e) =>
            e.id !== entity.id &&
            slot.categories.includes(e.category) &&
            (e.id === hint.name ||
              normalize(e.name) === normalize(hint.name) ||
              e.fields.some(
                (f) =>
                  f.privacy !== "SECRET" &&
                  ["address", "email", "phone", "number", "fqdn"].includes(
                    f.key,
                  ) &&
                  typeof f.value === "string" &&
                  normalize(f.value) === normalize(hint.name),
              )),
        );
        if (candidates.length > 1) {
          ambiguous.push(entity.id);
          continue;
        }
        let target = candidates[0];
        if (!target) {
          target = {
            id: newId("entity"),
            name: hint.name,
            category: hint.category,
            status: connectionSlots(hint.category).some((s) => s.required)
              ? "NEEDS_REVIEW"
              : "ACTIVE",
            privacy: entity.privacy,
            tags: [],
            fields: [],
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          created.push(target);
        }
        if (
          slotRelations(slot, entity.id, [
            ...snapshot.relations,
            ...relations,
          ]).some((r) => r.sourceId === target.id || r.targetId === target.id)
        )
          continue;
        const type =
          slot.key === "login" &&
          !["Email", "SIM", "Phone / SIM"].includes(target.category)
            ? "AUTHENTICATES_WITH"
            : slot.type;
        relations.push({
          id: newId("relation"),
          sourceId: entity.id,
          targetId: target.id,
          type,
          privacy: entity.privacy,
          createdAt: nowIso(),
        });
      }
    }
  return { entities: created, relations, ambiguous: [...new Set(ambiguous)] };
}
