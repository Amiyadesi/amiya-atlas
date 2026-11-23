import type { VaultSnapshot } from "../lib/types";
import { type Transaction, type LedgerAccount } from "./ledger";
import { fromUnits, units, total, negate, type Money } from "./money";
import { monthEnd } from "./reports";

export function frequentEntries(snapshot: VaultSnapshot) {
  const accounts = new Map(
    snapshot.ledgerAccounts
      ?.filter((a) => !a.archived && a.privacy !== "SECRET")
      .map((a) => [a.id, a]),
  );
  const pairs = new Map<
    string,
    {
      kind: "SPEND" | "INCOME" | "TRANSFER";
      account: LedgerAccount;
      counter: LedgerAccount;
      asset: string;
      count: number;
    }
  >();
  const reversed = new Set(snapshot.transactions?.map((t) => t.reversalOf));
  for (const t of snapshot.transactions ?? []) {
    if (
      t.privacy === "SECRET" ||
      t.reversalOf ||
      reversed.has(t.id) ||
      (t.kind !== "INCOME" && t.kind !== "SPEND" && t.kind !== "TRANSFER")
    )
      continue;
    const account = accounts.get(t.legs[0].accountId),
      counter = accounts.get(t.legs[1].accountId),
      asset = t.legs[0].money.asset;
    if (!account || !counter) continue;
    const key = JSON.stringify([t.kind, account.id, counter.id, asset]),
      pair = pairs.get(key);
    if (pair) pair.count++;
    else pairs.set(key, { kind: t.kind, account, counter, asset, count: 1 });
  }
  return [...pairs.values()].sort((a, b) => b.count - a.count).slice(0, 6);
}
export function budgetPercent(spent: Money, limit: Money) {
  if (spent.asset !== limit.asset) throw new Error("预算币种不一致");
  const max = units(limit),
    n = units(spent);
  return max === 0n
    ? n > 0n
      ? Infinity
      : 0
    : Number((n * 10000n) / max) / 100;
}
export function reviewSpending(
  snapshot: VaultSnapshot,
  month: string,
  asset: string,
) {
  const accounts = new Map(
    snapshot.ledgerAccounts
      ?.filter((a) => a.privacy !== "SECRET" && a.kind === "EXPENSE")
      .map((a) => [a.id, a.name]),
  );
  const days = Array<bigint>(Number(monthEnd(month).slice(-2))).fill(0n),
    categories = new Map<string, bigint>();
  let monthOnly = 0n;
  for (const t of snapshot.transactions ?? [])
    if (t.privacy !== "SECRET" && t.occurredAt.slice(0, 7) === month)
      for (const leg of t.legs) {
        const category = accounts.get(leg.accountId);
        if (!category || leg.money.asset !== asset) continue;
        const n = units(leg.money);
        if (t.precision === "month") monthOnly += n;
        else days[Number(t.occurredAt.slice(-2)) - 1] += n;
        categories.set(category, (categories.get(category) ?? 0n) + n);
      }
  const sorted = [...categories]
      .filter(([, n]) => n > 0n)
      .sort(([, a], [, b]) => (a > b ? -1 : a === b ? 0 : 1)),
    sum = sorted.reduce((acc, [, n]) => acc + n, 0n);
  const max = days.reduce(
    (a, b) => (a > (b < 0n ? -b : b) ? a : b < 0n ? -b : b),
    1n,
  );
  return {
    days: days.map((n, i) => ({
      date: month + "-" + String(i + 1).padStart(2, "0"),
      value: fromUnits(n, asset),
      height: Number(((n < 0n ? -n : n) * 1000n) / max) / 10,
    })),
    monthOnly: fromUnits(monthOnly, asset),
    categories: sorted.map(([name, n]) => ({
      name,
      value: fromUnits(n, asset),
      percent: Number((n * 1000n) / sum) / 10,
    })),
  };
}

export type LedgerLine =
  | { type: "day"; day: string; expense: Money[]; income: Money[]; top: number }
  | { type: "tx"; tx: Transaction; top: number };
export function groupLedgerRows(
  rows: Transaction[],
  accounts: LedgerAccount[],
) {
  const byId = new Map(accounts.map((a) => [a.id, a.kind])),
    lines: LedgerLine[] = [];
  let top = 0,
    header: Extract<LedgerLine, { type: "day" }> | undefined;
  for (const tx of rows) {
    const day =
      tx.precision === "month"
        ? tx.occurredAt.slice(0, 7) + "（按月）"
        : tx.occurredAt;
    if (header?.day !== day) {
      header = { type: "day", day, expense: [], income: [], top };
      lines.push(header);
      top += 38;
    }
    for (const leg of tx.legs) {
      const kind = byId.get(leg.accountId);
      if (kind === "EXPENSE")
        header.expense = total([...header.expense, leg.money]);
      if (kind === "INCOME")
        header.income = total([...header.income, negate(leg.money)]);
    }
    lines.push({ type: "tx", tx, top });
    top += 64;
  }
  return { lines, height: top };
}
export function viewportLines(lines: LedgerLine[], scroll: number) {
  let lo = 0,
    hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid].top < scroll) lo = mid + 1;
    else hi = mid;
  }
  return lines.slice(Math.max(0, lo - 3), lo + 17);
}
