import type { VaultSnapshot } from "../../lib/types";
import { validateLedger } from "../ledger";
import type {
  AssetPreview,
  BillPreview,
  ImportSelection,
  ImportResult,
} from "./types";

export function assetAdditions(
  snapshot: VaultSnapshot,
  preview: AssetPreview,
  selection: ImportSelection,
) {
  const ids = new Set(snapshot.entities.map((e) => e.id)),
    links = new Set(snapshot.relations.map((r) => r.id));
  const entities: VaultSnapshot["entities"] = [],
    relations: VaultSnapshot["relations"] = [],
    updates = new Map<
      string,
      NonNullable<AssetPreview["rows"][number]["enrichment"]>
    >();
  for (const row of preview.rows)
    if (selection.rows.has(row.id)) {
      for (const entity of [row.entity, row.hub])
        if (entity && !ids.has(entity.id)) {
          entities.push(entity);
          ids.add(entity.id);
        }
      if (row.enrichment && !updates.has(row.entity.id))
        updates.set(row.entity.id, row.enrichment);
      if (row.relation && !links.has(row.relation.id)) {
        relations.push(row.relation);
        links.add(row.relation.id);
      }
    }
  return { entities, relations, updates };
}
function requireRevision(
  snapshot: VaultSnapshot,
  preview: AssetPreview | BillPreview,
) {
  if (snapshot.revision !== preview.revision)
    throw new Error("记忆库已更新，请重新预览文件");
}
export function applyAssetImport(
  snapshot: VaultSnapshot,
  preview: AssetPreview,
  selection: ImportSelection,
): ImportResult {
  requireRevision(snapshot, preview);
  const additions = assetAdditions(snapshot, preview, selection);
  if (
    snapshot.entities.length + additions.entities.length > 20000 ||
    snapshot.relations.length + additions.relations.length > 100000
  )
    throw new Error("所选记录超过记忆库容量");
  const existing = snapshot.entities.map((e) => {
    const update = additions.updates.get(e.id);
    return update
      ? {
          ...e,
          updatedAt: update.updatedAt,
          fields: [
            ...e.fields,
            ...update.fields.filter(
              (f) => !e.fields.some((old) => old.key === f.key),
            ),
          ],
        }
      : e;
  });
  const next = {
    ...snapshot,
    entities: [...existing, ...additions.entities],
    relations: [...snapshot.relations, ...additions.relations],
  };
  validateLedger(next, snapshot);
  return next;
}
export function applyBillImport(
  snapshot: VaultSnapshot,
  preview: BillPreview,
  selection: ImportSelection,
): ImportResult {
  requireRevision(snapshot, preview);
  const seen = new Set(snapshot.transactions?.map((t) => t.idempotencyKey));
  const transactions = preview.rows
    .filter((row) => {
      if (
        !selection.rows.has(row.id) ||
        row.duplicate ||
        seen.has(row.transaction.idempotencyKey)
      )
        return false;
      if (row.needsDestination) throw new Error("请先核对划转的转入账户");
      seen.add(row.transaction.idempotencyKey);
      return true;
    })
    .map((row) => row.transaction);
  const used = new Set(
    transactions.flatMap((t) => t.legs.map((l) => l.accountId)),
  );
  const entities = preview.subscriptions
    .filter(
      (c) =>
        selection.subscriptions?.has(c.entity.id) &&
        !snapshot.entities.some((e) => e.id === c.entity.id),
    )
    .map((c) => c.entity);
  if (!transactions.length && !entities.length) return snapshot;
  const next = {
    ...snapshot,
    entities: [...snapshot.entities, ...entities],
    ledgerAccounts: [
      ...(snapshot.ledgerAccounts ?? []),
      ...preview.accounts.filter(
        (a) =>
          used.has(a.id) &&
          !snapshot.ledgerAccounts?.some((v) => v.id === a.id),
      ),
    ],
    transactions: [...(snapshot.transactions ?? []), ...transactions],
  };
  if (
    next.entities.length > 20000 ||
    next.transactions.length > 100000 ||
    next.ledgerAccounts.length > 10000
  )
    throw new Error("所选记录超过记忆库容量");
  validateLedger(next, snapshot);
  return next;
}
