import { it, expect } from "vitest";
import { emptySnapshot } from "../src/lib/types";
import { parseBills } from "../src/domain/importers/bills";
import { applyBillImport } from "../src/domain/importers/apply";
import { reverseTransaction, validateLedger } from "../src/domain/ledger";
import {
  frequentEntries,
  groupLedgerRows,
  viewportLines,
  reviewSpending,
  budgetPercent,
} from "../src/domain/ledger-view";
import { createStarterHubs } from "../src/features/onboarding/starter";
import { money } from "../src/domain/money";

it("creates any subset of starter hubs and reuses their wallet account", () => {
  const before = emptySnapshot(),
    first = createStarterHubs(before, " Me@Test.org ", "", "", false);
  expect(first.entities.map((e) => e.name)).toEqual(["me@test.org"]);
  expect(first.ledgerAccounts).toBeUndefined();
  const next = createStarterHubs(
    first,
    "ME@test.org",
    "+1 (415) 555-0101",
    "零钱",
    true,
  );
  expect(next.entities).toHaveLength(3);
  expect(next.ledgerAccounts?.[0].entityRef).toBe(next.entities[2].id);
  expect(createStarterHubs(next, "", "+14155550101", "零钱", true)).toEqual(
    next,
  );
  expect(before.entities).toEqual([]);
  expect(() => createStarterHubs(before, "oops", "", "钱包", true)).toThrow(
    /邮箱/,
  );
  expect(
    createStarterHubs(before, "", "", "现金", false).ledgerAccounts,
  ).toBeUndefined();
});
it("keeps currencies and month-only values separate; reversal offsets spending, not frequency", () => {
  const s = emptySnapshot(),
    p = parseBills(
      "date,amount,account,category,currency\n2026-02-01,-5,Cash,Books,USD\n2026-02-01,-10,Cash,Books,USD\n2026-02-02,-25,Cash,Food,CNY\n2026-02-03,-10,Cash,Books,USD",
      s,
    );
  const next = applyBillImport(s, p, {
    rows: new Set(p.rows.map((r) => r.id)),
  });
  const [first, , , last] = next.transactions!;
  last.precision = "month";
  next.transactions!.push(reverseTransaction(first, "2026-02-01"));
  validateLedger(next);
  const report = reviewSpending(next, "2026-02", "USD");
  expect(report.days).toHaveLength(28);
  expect(report.days[0].value.amount).toBe("10.00");
  expect(report.monthOnly.amount).toBe("10.00");
  expect(report.categories).toEqual([
    { name: "Books", value: money("20", "USD"), percent: 100 },
  ]);
  expect(frequentEntries(next)[0]).toMatchObject({
    kind: "SPEND",
    asset: "USD",
    count: 2,
  });
  const g = groupLedgerRows(
    next.transactions!.filter((t) => t.occurredAt === "2026-02-01"),
    next.ledgerAccounts!,
  );
  expect(g.lines[0]).toMatchObject({
    type: "day",
    expense: [money("10", "USD")],
  });
  expect(g.height).toBe(38 + 64 * 3);
  expect(viewportLines(g.lines, 0)).toEqual(g.lines);
  expect(budgetPercent(money("8", "USD"), money("10", "USD"))).toBe(80);
  expect(budgetPercent(money("0.01", "USD"), money("0", "USD"))).toBe(Infinity);
});
