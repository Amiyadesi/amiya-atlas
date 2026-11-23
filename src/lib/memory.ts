import type { Entity, VaultSnapshot } from "./types";
import { formatMoney, moneySchema, units } from "../domain/money";
import { recurringCost } from "../domain/reports";
import { isFavorite } from "./record-tags";

export const sortNames = {
  updated: "最近更新",
  relations: "关联最多",
  favorite: "收藏优先",
  cost: "月度费用",
} as const;
export type MemorySort = keyof typeof sortNames;

export function keyFields(entity: Entity) {
  return entity.fields
    .filter(
      (f) =>
        f.privacy !== "SECRET" &&
        f.value !== "" &&
        [
          "region",
          "country",
          "provider",
          "carrier",
          "registrar",
          "issuer",
          "account",
          "address",
          "username",
          "url",
          "origin",
          "fqdn",
          "fee",
          "monthly_cost",
        ].includes(f.key),
    )
    .flatMap((f) => {
      const m = f.valueType === "money" ? moneySchema.safeParse(f.value) : null;
      const text = m?.success
        ? formatMoney(m.data)
        : ["string", "number"].includes(typeof f.value)
          ? String(f.value)
          : "";
      return text ? [{ key: f.key, text }] : [];
    });
}
export function monthlyFee(entity: Entity) {
  if (
    entity.fields.some(
      (f) => f.key === "billing_period" && f.privacy === "SECRET",
    )
  )
    return;
  const row = recurringCost(entity);
  if (row) return row.usage ? undefined : row.monthly;
  const value = entity.fields.find(
    (f) => f.key === "monthly_cost" && f.privacy !== "SECRET",
  )?.value;
  const asset = entity.fields.find(
    (f) => f.key === "currency" && f.privacy !== "SECRET",
  )?.value;
  const legacy = moneySchema.safeParse({ amount: String(value), asset });
  return legacy.success ? legacy.data : undefined;
}
export function memoryIndex(snapshot: VaultSnapshot) {
  const index = new Map(
    snapshot.entities
      .filter((e) => e.privacy !== "SECRET")
      .map((e) => [
        e.id,
        {
          count: 0,
          favorite: e.tags.some(isFavorite),
          cost: monthlyFee(e),
          summary: keyFields(e)
            .filter((f) => !["fee", "monthly_cost"].includes(f.key))
            .slice(0, 2)
            .map((f) => f.text)
            .join(" · "),
        },
      ]),
  );
  for (const r of snapshot.relations) {
    const a = index.get(r.sourceId),
      b = index.get(r.targetId);
    if (r.privacy !== "SECRET" && a && b) {
      a.count++;
      if (a !== b) b.count++;
    }
  }
  return index;
}
export function sortMemory(
  entities: Entity[],
  sort: MemorySort,
  index: ReturnType<typeof memoryIndex>,
) {
  return [...entities].sort((a, b) => {
    const x = index.get(a.id)!,
      y = index.get(b.id)!;
    let order = 0;
    if (sort === "relations") order = y.count - x.count;
    if (sort === "favorite") order = Number(y.favorite) - Number(x.favorite);
    if (sort === "cost") {
      if (x.cost && y.cost)
        order =
          x.cost.asset.localeCompare(y.cost.asset) ||
          Number(units(y.cost) - units(x.cost));
      else order = Number(!!y.cost) - Number(!!x.cost);
    }
    return (
      order ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.name.localeCompare(b.name)
    );
  });
}
