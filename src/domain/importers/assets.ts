import {
  newId,
  nowIso,
  type VaultSnapshot,
  type Entity,
  type Relation,
} from "../../lib/types";
import type { Money } from "../money";
import type { AssetPreview, AssetRow } from "./types";

export function privateEntity(
  category: string,
  name: string,
  fields: Record<string, string | Money> = {},
  tags: string[] = [],
): Entity {
  const id = newId("entity"),
    stamp = nowIso();
  return {
    id,
    category,
    name,
    tags,
    privacy: "PRIVATE",
    status: "ACTIVE",
    createdAt: stamp,
    updatedAt: stamp,
    fields: Object.entries(fields)
      .filter(([, v]) => v !== "")
      .map(([key, value]) => ({
        id: newId("field"),
        entityId: id,
        key,
        value,
        privacy: "PRIVATE",
        searchable: typeof value === "string",
        valueType:
          typeof value !== "string"
            ? "money"
            : key === "origin"
              ? "url"
              : "text",
      })),
  };
}
export const norm = (s: string) => s.normalize("NFKC").trim().toLowerCase();
export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(s);
export const phoneNumber = (s: string) =>
  /^[+\d][\d ().-]*$/.test(s) && /^\d{7,15}$/.test(s.replace(/\D/g, ""))
    ? s.replace(/[^\d+]/g, "")
    : "";
const visible = (e: Entity, ...keys: string[]) =>
  e.fields
    .filter(
      (f) =>
        f.privacy !== "SECRET" &&
        keys.includes(f.key) &&
        typeof f.value === "string",
    )
    .map((f) => String(f.value));
function origin(raw: string) {
  if (!raw.trim()) return "";
  try {
    const u = new URL(/^[a-z][\w+.-]*:/i.test(raw) ? raw : "https://" + raw);
    return ["https:", "http:"].includes(u.protocol) ? u.origin : "";
  } catch {
    return "";
  }
}
export interface LoginItem {
  name: string;
  url?: string;
  username?: string;
  folder?: string;
  favorite?: boolean;
  card?: { brand: string; last4: string };
}
export function assetPreview(
  snapshot: VaultSnapshot,
  items: LoginItem[],
  format: string,
  stripped: number,
  warnings: string[],
): AssetPreview {
  const rows: AssetRow[] = [],
    existing = new Set(snapshot.entities.map((e) => e.id)),
    index = new Map<string, Entity[]>();
  const keys = (e: Entity) => {
    if (["Email", "SIM", "Phone / SIM"].includes(e.category)) {
      const email = e.category === "Email";
      return [
        e.name,
        ...visible(
          e,
          ...(email
            ? ["address", "email"]
            : ["number", "phone", "phone_number"]),
        ),
      ]
        .map((v) => (email ? norm(v) : phoneNumber(v)))
        .filter(Boolean)
        .map((v) => (email ? "mail:" : "tel:") + v);
    }
    if (
      ["Account", "Website Account", "AI Provider Account"].includes(e.category)
    )
      return [
        "name:" + norm(e.name),
        ...visible(e, "origin", "url", "domain", "website")
          .map((v) => origin(v))
          .filter(Boolean)
          .map((v) => "site:" + new URL(v).hostname),
      ];
    return [e.category + ":" + norm(e.name)];
  };
  const indexEntity = (e: Entity) => {
    for (const k of new Set(keys(e)))
      index.set(k, [...(index.get(k) ?? []), e]);
  };
  snapshot.entities
    .filter((e) => e.privacy !== "SECRET")
    .forEach((e) =>
      indexEntity({
        ...e,
        fields: e.fields.filter(
          (f) =>
            f.privacy !== "SECRET" &&
            [
              "username",
              "brand",
              "last4",
              "address",
              "email",
              "phone",
              "number",
              "phone_number",
              "origin",
              "url",
              "domain",
              "website",
            ].includes(f.key),
        ),
      }),
    );
  const claims = new Map<string, string>(),
    loginKey = (v: string) => phoneNumber(v) || norm(v);
  const originals = new Map(snapshot.entities.map((e) => [e.id, e]));
  function match(e: Entity) {
    const username = visible(e, "username")[0],
      last4 = visible(e, "last4")[0];
    const sites = keys(e).filter((k) => k.startsWith("site:"));
    for (const k of keys(e)) {
      const options = (index.get(k) ?? []).filter((c) => {
        const other = visible(c, "username")[0] || claims.get(c.id),
          digits = visible(c, "last4")[0];
        const otherSites = keys(c).filter((v) => v.startsWith("site:"));
        if (
          sites.length &&
          otherSites.length &&
          !sites.some((v) => otherSites.includes(v))
        )
          return false;
        return (
          (!username || !other || loginKey(username) === loginKey(other)) &&
          (!last4 || !digits || digits === last4)
        );
      });
      const exact = options.filter(
        (c) =>
          username &&
          loginKey(visible(c, "username")[0] || claims.get(c.id) || "") ===
            loginKey(username),
      );
      if (exact.length === 1) return exact[0];
      if (options.length === 1) return options[0];
    }
    indexEntity(e);
    return e;
  }
  const relations = new Map<string, Relation>();
  for (const r of snapshot.relations)
    if (r.type === "REGISTERED_WITH")
      relations.set(r.sourceId + "|" + r.targetId, r);
  const savedLinks = new Set(snapshot.relations.map((r) => r.id)),
    seenRows = new Set<string>();
  for (const item of items) {
    const url = origin(item.url ?? ""),
      login = item.username?.trim() ?? "",
      title = item.name.trim();
    const name =
      (/^https?:\/\//i.test(title) ? origin(title) : title) ||
      (url && new URL(url).hostname);
    if (!name) {
      warnings.push("跳过缺少名称和网站的记录");
      continue;
    }
    const tags = [
      ...new Set(
        [item.folder?.trim(), item.favorite ? "⭐ 收藏" : ""].filter(
          (t): t is string => !!t,
        ),
      ),
    ];
    if (
      name.length > 500 ||
      tags.some((t) => t.length > 100) ||
      login.length > 5000 ||
      [name, url, login, ...tags, item.card?.brand ?? ""].some((v) =>
        /PRIVATE KEY-----|otpauth:\/\/|sk-proj-|ghp_|github_pat_/i.test(v),
      )
    ) {
      warnings.push("已跳过包含凭据标记或字段过长的项目");
      continue;
    }
    const proposed = item.card
      ? privateEntity("Payment Card", name, { ...item.card }, tags)
      : privateEntity(
          "Website Account",
          name,
          { origin: url, username: login },
          tags,
        );
    const entity = match(proposed);
    if (login) claims.set(entity.id, login);
    const row: AssetRow = {
      id: newId("row"),
      entity,
      existing: existing.has(entity.id),
      duplicate: false,
      login,
      folder: item.folder ?? "",
      favorite: !!item.favorite,
    };
    const original = originals.get(entity.id);
    if (original && !item.card) {
      const fields = proposed.fields
        .filter((f) => !original.fields.some((old) => old.key === f.key))
        .map((f) => ({ ...f, entityId: entity.id }));
      if (fields.length)
        row.enrichment = { fields, updatedAt: proposed.createdAt };
    }
    if (!item.card && (isEmail(login) || phoneNumber(login))) {
      row.hub = match(
        isEmail(login)
          ? privateEntity("Email", norm(login), { address: norm(login) })
          : privateEntity("Phone / SIM", phoneNumber(login), {
              number: phoneNumber(login),
            }),
      );
      const key = entity.id + "|" + row.hub.id;
      if (!relations.has(key))
        relations.set(key, {
          id: newId("rel"),
          sourceId: entity.id,
          targetId: row.hub.id,
          type: "REGISTERED_WITH",
          privacy: "PRIVATE",
          createdAt: nowIso(),
        });
      const relation = relations.get(key)!;
      if (!savedLinks.has(relation.id)) row.relation = relation;
    }
    const rowKey = entity.id + "|" + (row.hub?.id ?? "");
    row.duplicate =
      (row.existing && !row.relation && !row.enrichment) ||
      seenRows.has(rowKey);
    seenRows.add(rowKey);
    rows.push(row);
  }
  return {
    kind: "assets",
    format,
    rows,
    stripped,
    warnings,
    revision: snapshot.revision,
  };
}
