import { describe, it, expect } from "vitest";
import {
  money,
  add,
  scale,
  units,
  formatMoney,
  fromUnits,
} from "../src/domain/money";
import {
  makeEntry,
  reverseTransaction,
  validateLedger,
  accountBalances,
  reconciliation,
  type LedgerAccount,
} from "../src/domain/ledger";
import {
  emptySnapshot,
  type VaultSnapshot,
  type Entity,
} from "../src/lib/types";
import { allocate } from "../src/domain/allocation";
import {
  monthlyCosts,
  periodReport,
  orderReport,
  expectedPayments,
  queryReport,
  isCommercialProject,
} from "../src/domain/reports";
import { financeOutput, financeContext } from "../src/ai/finance";
import { initializeVault, importAtlasJson, loadSnapshot } from "../src/lib/api";
import {
  positions,
  tradeTransaction,
  rewardRisk,
  checkStops,
} from "../src/domain/positions";
import {
  amountSupported,
  extractAmounts,
  localLedgerProposal,
  numberIssues,
  emptyProposal,
  applyFinanceActions,
  ledgerAccountOptions,
  resolveLedgerAccount,
  materializeFinanceAccounts,
} from "../src/domain/finance-capture";
import { applyBrowserProposal } from "../src/domain/proposal";
import { undoBrowserProposal } from "../src/domain/changes";
import { cloudSnapshot } from "../src/ai/cloud-contract";
export function fixture(): VaultSnapshot {
  const s = emptySnapshot();
  s.ledgerAccounts = [
    {
      id: "cash",
      name: "现金",
      kind: "ASSET",
      asset: "CNY",
      privacy: "PRIVATE",
    },
    {
      id: "usd",
      name: "美元账户",
      kind: "ASSET",
      asset: "USD",
      privacy: "PRIVATE",
    },
    {
      id: "btc",
      name: "比特币账户",
      kind: "ASSET",
      asset: "BTC",
      privacy: "PRIVATE",
    },
    { id: "expense", name: "其他支出", kind: "EXPENSE", privacy: "PRIVATE" },
    { id: "income", name: "其他收入", kind: "INCOME", privacy: "PRIVATE" },
    { id: "fee", name: "手续费", kind: "EXPENSE", privacy: "PRIVATE" },
    { id: "equity", name: "期初与调整", kind: "EQUITY", privacy: "PRIVATE" },
    {
      id: "reserve",
      name: "预留",
      kind: "ASSET",
      asset: "CNY",
      privacy: "PRIVATE",
    },
  ];
  s.transactions = [];
  return s;
}
const entity = (id: string, category = "Project"): Entity => ({
  id,
  name: id,
  category,
  status: "ACTIVE",
  privacy: "PRIVATE",
  tags: [],
  fields: [],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
});
describe("decimal ledger", () => {
  it("exact decimal, precision, rounding and currency separation", () => {
    expect(add(money("0.1", "USD"), money("0.2", "USD"))).toEqual(
      money("0.30", "USD"),
    );
    expect(units(money("0.00061700", "BTC"))).toBe(61700n);
    expect(() => money("1.01", "JPY")).toThrow();
    expect(scale(money("10", "USD"), 1n, 3n).amount).toBe("3.33");
    expect(scale(money("-10", "USD"), 1n, 3n).amount).toBe("-3.33");
    expect(() => add(money("1", "USD"), money("1", "CNY"))).toThrow();
  });
  it("balances, append-only, reversal, idempotency, references", () => {
    const s = fixture();
    const t = makeEntry({
      kind: "SPEND",
      amount: money("12.34", "CNY"),
      accountId: "cash",
      counterId: "expense",
      date: "2026-10-15",
    });
    s.transactions = [t];
    validateLedger(s);
    expect(accountBalances(s).get("cash")?.[0].amount).toBe("-12.34");
    const next = structuredClone(s);
    next.transactions!.push(reverseTransaction(t, "2026-10-15"));
    validateLedger(next, s);
    expect(accountBalances(next).get("cash")?.[0].amount).toBe("0.00");
    next.transactions![0].legs[0].money = money("-1", "CNY");
    expect(() => validateLedger(next, s)).toThrow();
    expect(() => validateLedger({ ...s, transactions: [t, t] })).toThrow();
    expect(() => validateLedger({ ...s, transactions: [] }, s)).toThrow();
  });
  it("reconciliation, platform fee and user reserve", () => {
    const s = fixture();
    s.transactions = [
      makeEntry({
        kind: "INCOME",
        amount: money("100", "CNY"),
        accountId: "cash",
        counterId: "income",
        date: "2026-10-15",
        fee: money("3", "CNY"),
        feeAccountId: "fee",
        taxRate: 0.1,
        reserveAccountId: "reserve",
      }),
    ];
    validateLedger(s);
    expect(accountBalances(s).get("cash")?.[0].amount).toBe("87.00");
    const r = reconciliation(
      s,
      "cash",
      money("88", "CNY"),
      "2026-10-15",
      "现金找零",
    );
    expect(r.transaction?.legs[0].money.amount).toBe("1.00");
    s.transactions.push(r.transaction!);
    expect(accountBalances(s).get("cash")?.[0].amount).toBe("88.00");
  });
  it("effective allocation, idle, costs, project profit and receivable", () => {
    const s = fixture();
    const server = entity("server", "Server");
    server.fields = [
      {
        id: "f",
        entityId: "server",
        key: "fee",
        valueType: "money",
        value: money("120", "CNY"),
        privacy: "PRIVATE",
        searchable: false,
      },
      {
        id: "p",
        entityId: "server",
        key: "billing_period",
        valueType: "text",
        value: "yearly",
        privacy: "PRIVATE",
        searchable: false,
      },
    ];
    const order = entity("order", "Order");
    order.fields = [
      {
        id: "q",
        entityId: "order",
        key: "quote",
        valueType: "money",
        value: money("200", "CNY"),
        privacy: "PRIVATE",
        searchable: false,
      },
    ];
    s.entities = [entity("project"), server, order];
    s.allocationRules = [
      {
        id: "r1",
        resourceId: "server",
        effectiveFrom: "2026-10-01",
        effectiveTo: "2026-11-01",
        shares: [{ projectId: "project", weight: 0.6 }],
      },
      {
        id: "r2",
        resourceId: "server",
        effectiveFrom: "2026-11-01",
        shares: [{ projectId: "project", weight: 0.8 }],
      },
    ];
    expect(
      allocate(s, "server", "2026-10-15", money("10", "CNY")).idle.amount,
    ).toBe("4.00");
    expect(
      allocate(s, "server", "2026-11-15", money("10", "CNY")).idle.amount,
    ).toBe("2.00");
    expect(monthlyCosts(s, "2026-10-01").totals[0].amount).toBe("10.00");
    s.transactions = [
      makeEntry({
        kind: "SPEND",
        amount: money("10", "CNY"),
        accountId: "cash",
        counterId: "expense",
        date: "2026-10-15",
        resourceId: "server",
      }),
      makeEntry({
        kind: "INCOME",
        amount: money("100", "CNY"),
        accountId: "cash",
        counterId: "income",
        date: "2026-10-15",
        projectId: "project",
        orderId: "order",
      }),
    ];
    validateLedger(s);
    expect(
      periodReport(s, "2026-10-01", "2026-10-31").projects[0].profit[0].amount,
    ).toBe("94.00");
    expect(orderReport(s, order)?.due.amount).toBe("100.00");
  });
  it("FIFO partial sale includes fees; LIFO is explicit", () => {
    const s = fixture();
    const trade = (
      side: "BUY" | "SELL",
      qty: string,
      gross: string,
      fee: string,
      date: string,
    ) =>
      tradeTransaction(s, {
        side,
        quantity: money(qty, "BTC"),
        gross: money(gross, "USD"),
        fee: money(fee, "USD"),
        holdingId: "btc",
        cashId: "usd",
        clearingId: "equity",
        feeAccountId: "fee",
        date,
      });
    s.transactions!.push(trade("BUY", "1", "100", "2", "2026-10-01"));
    s.transactions!.push(trade("BUY", "1", "200", "2", "2026-10-02"));
    s.transactions!.push(trade("SELL", "0.5", "150", "1", "2026-10-03"));
    validateLedger(s);
    const p = positions(s)[0];
    expect(p.quantityMoney.amount).toBe("1.50000000");
    expect(p.costMoney.amount).toBe("253.00");
    expect(p.realizedMoney.amount).toBe("98.00");
    expect(positions(s, "LIFO")[0].realizedMoney.amount).toBe("48.00");
    expect(() => trade("SELL", "2", "300", "1", "2026-10-04")).toThrow();
    s.financeRecords = [
      {
        id: "price",
        type: "price",
        asset: "BTC",
        value: money("400", "USD"),
        date: "2026-10-15",
      },
    ];
    expect(positions(s)[0].unrealized?.amount).toBe("347.00");
  });
  it("stops create cooldown and review without placing trades", () => {
    const s = fixture();
    s.financeRecords = [
      {
        id: "p",
        type: "plan",
        asset: "BTC",
        quantity: money("1", "BTC"),
        entry: money("100", "USD"),
        target: money("150", "USD"),
        stop: money("80", "USD"),
        status: "OPEN",
        cooldownDays: 3,
        review: "",
        date: "2026-10-01",
      },
      {
        id: "quote",
        type: "price",
        asset: "BTC",
        value: money("70", "USD"),
        date: "2026-10-15",
      },
    ];
    expect(rewardRisk(s.financeRecords[0] as any)).toBe("2.50");
    const next = checkStops(s, "2026-10-15");
    expect(next.financeRecords?.[0]).toMatchObject({
      status: "STOPPED",
      cooldownUntil: "2026-10-18",
      reviewDue: "2026-10-15",
    });
    expect(next.transactions).toHaveLength(0);
  });
  it("proposal confirmation and undo produce a complete inverse", () => {
    const s = fixture();
    const p = localLedgerProposal("今天现金付了八块", s, "2026-10-15")!;
    s.captures = [
      {
        id: "capture",
        rawText: "今天现金付了八块",
        inputType: "text",
        timestamp: "2026-10-15T00:00:00Z",
        status: "PENDING",
      },
    ];
    s.proposals = [
      {
        id: "p",
        captureId: "capture",
        status: "PENDING",
        content: p,
        provider: "local",
        createdAt: "2026-10-15T00:00:00Z",
        entityIds: [],
      },
    ];
    const next = applyBrowserProposal(s, "p", p);
    expect(accountBalances(next).get("cash")?.[0].amount).toBe("-8.00");
    const undone = undoBrowserProposal(next, "p");
    validateLedger(undone, next);
    expect(undone.transactions).toHaveLength(2);
    expect(accountBalances(undone).get("cash")?.[0].amount).toBe("0.00");
  });
  it("50k entries monthly aggregation and project report within 300ms", () => {
    const s = fixture();
    s.entities = [entity("project")];
    const t = makeEntry({
      kind: "SPEND",
      amount: money("0.01", "CNY"),
      accountId: "cash",
      counterId: "expense",
      date: "2026-10-15",
      projectId: "project",
    });
    s.transactions = Array.from({ length: 50000 }, (_, i) => ({
      ...t,
      id: `tx${i}`,
      idempotencyKey: `key${i}`,
    }));
    const start = performance.now();
    const report = periodReport(s, "2026-10-01", "2026-10-31");
    const elapsed = performance.now() - start;
    expect(report.expense[0].amount).toBe("500.00");
    expect(report.projects[0].profit[0].amount).toBe("-500.00");
    console.log(`50k monthly+projects: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(300);
  });
});
describe("synthetic amount guard", () => {
  const cases: Array<[string, string, string]> = [
    ["八块", "8", "CNY"],
    ["十三元", "13", "CNY"],
    ["十元", "10", "CNY"],
    ["一百零二元", "102", "CNY"],
    ["两千元", "2000", "CNY"],
    ["三万五千元", "35000", "CNY"],
    ["一万零八元", "10008", "CNY"],
    ["九角", "9", "CNY"],
    ["零点一元", "0.1", "CNY"],
    ["十三点五元", "13.5", "CNY"],
    ["一百二十三点四五元", "123.45", "CNY"],
    ["1.2k 美元", "1200", "USD"],
    ["2m USD", "2000000", "USD"],
    ["1.5万人民币", "15000", "CNY"],
    ["0.00000001 BTC", "0.00000001", "BTC"],
    ["0.00061700 BTC", "0.000617", "BTC"],
    ["100 日元", "100", "JPY"],
    ["30 USD", "30", "USD"],
    ["23.50 HKD", "23.5", "HKD"],
    ["2.99美元", "2.99", "USD"],
    ["1,234.56 CNY", "1234.56", "CNY"],
    ["0.01 CNY", "0.01", "CNY"],
    ["０.５元", "0.5", "CNY"],
    ["99欧元", "99", "EUR"],
    ["八十八港元", "88", "HKD"],
    ["七千日元", "7000", "JPY"],
    ["三百台币", "300", "TWD"],
    ["0.000000000000000001 ETH", "0.000000000000000001", "ETH"],
    ["10.00 GBP", "10", "GBP"],
    ["四千五百六十七元", "4567", "CNY"],
    ["五十元", "50", "CNY"],
    ["一亿人民币", "100000000", "CNY"],
  ];
  for (const [text, amount, asset] of cases)
    it(text, () =>
      expect(amountSupported(money(amount, asset), text)).toBe(true),
    );
  it("ambiguous, negation, multiple amounts and source mismatch stay pending", () => {
    const s = fixture();
    expect(
      localLedgerProposal("现金付了八块左右", s)?.uncertainty.length,
    ).toBeGreaterThan(0);
    expect(
      localLedgerProposal("现金还没付八块", s)?.financeActions,
    ).toHaveLength(0);
    expect(
      localLedgerProposal("现金付了八块和九块", s)?.financeActions,
    ).toHaveLength(0);
    expect(
      localLedgerProposal("现金付了八块；现金付了九块", s)?.financeActions,
    ).toHaveLength(2);
    expect(amountSupported(money("80", "CNY"), "八块")).toBe(false);
    expect(extractAmounts("JPY 1.50")).toHaveLength(0);
  });
});
describe("finance boundaries and old data", () => {
  it("keeps ordinary expenses with no account setup and saves them atomically", () => {
    const s = emptySnapshot();
    const p = financeOutput(
      {
        entries: [
          {
            kind: "SPEND",
            amount: money("3.9", "CNY"),
            accountId: "",
            counterId: "",
            occurredAt: "",
            note: "早餐",
            evidence: "早餐3.9",
          },
        ],
        uncertainty: [],
      },
      "早餐3.9",
      s,
    );
    expect(p.uncertainty).toEqual([]);
    const next = applyFinanceActions(s, p.financeActions!);
    expect(next.transactions).toHaveLength(1);
    const legs = next.transactions![0].legs;
    expect(
      next.ledgerAccounts!.find((a) => a.id === legs[0].accountId)?.name,
    ).toBe("未指定账户");
    expect(
      next.ledgerAccounts!.find((a) => a.id === legs[1].accountId)?.name,
    ).toBe("餐饮");
  });
  it("keeps all five meal and taxi expenses without payment accounts", () => {
    const raw =
      "早餐3.9，午餐22.5，晚餐18.5，打车两次，第一次11.07，第二次14.7，通过BTCUSDT交易，让自己的USDT从156.56涨到了157.32，暂时还没有进行下一次交易的打算";
    const p = localLedgerProposal(raw, emptySnapshot(), "2026-10-16")!;
    const next = applyFinanceActions(emptySnapshot(), p.financeActions!);
    expect(next.transactions).toHaveLength(5);
    expect(next.transactions!.every((t) => t.occurredAt === "2026-10-16")).toBe(
      true,
    );
    expect(periodReport(next, "2026-10-16", "2026-10-16").expense).toEqual([
      money("70.67", "CNY"),
    ]);
    expect(
      next
        .ledgerAccounts!.filter((a) => a.kind === "EXPENSE")
        .map((a) => a.name)
        .sort(),
    ).toEqual(["出行", "餐饮"]);
    expect(p.uncertainty).toEqual([]);
    const saved = applyFinanceActions(emptySnapshot(), p.financeActions!);
    const otherDraft = localLedgerProposal(
      "早餐9元",
      emptySnapshot(),
      "2026-10-16",
    )!;
    expect(
      applyFinanceActions(
        saved,
        materializeFinanceAccounts(saved, otherDraft.financeActions!),
      ).transactions,
    ).toHaveLength(6);
  });
  it("uses an existing asset card without duplicating the account on the next entry", () => {
    const s = emptySnapshot();
    const card = entity("card", "Payment Card");
    card.name = "我的银行卡";
    s.entities = [card];
    const p = localLedgerProposal("我的银行卡付了8元早餐", s)!;
    const next = applyFinanceActions(s, p.financeActions!);
    expect(
      next.ledgerAccounts!.find(
        (a) => a.id === next.transactions![0].legs[0].accountId,
      )?.entityRef,
    ).toBe(card.id);
    const second = localLedgerProposal("我的银行卡付了9元晚餐", next)!;
    const saved = applyFinanceActions(next, second.financeActions!);
    expect(
      saved.ledgerAccounts!.filter((a) => a.entityRef === card.id),
    ).toHaveLength(1);
    expect(saved.transactions).toHaveLength(2);
  });
  it("lets a new typed wallet and category save together, and materializes cloud asset choices", () => {
    const s = emptySnapshot();
    s.entities = [entity("card", "Payment Card")];
    const context = financeContext(s);
    const remote = cloudSnapshot({
      ...context,
      ledgerAccounts: context.accounts,
      requestId: "synthetic_request_123",
      kind: "ledger",
      text: "card早餐8元",
      now: "2026-10-16T00:00:00Z",
      relations: [],
      events: [],
    } as any);
    const accountId = context.accounts.find((a) => a.name === "card")!.id;
    const p = financeOutput(
      {
        entries: [
          {
            kind: "SPEND",
            amount: money("8", "CNY"),
            accountId,
            counterId: "",
            occurredAt: "2026-10-16",
            note: "早餐",
            evidence: "card早餐8元",
          },
        ],
        uncertainty: [],
      },
      "card早餐8元",
      remote,
    );
    const actions = materializeFinanceAccounts(s, p.financeActions!);
    const next = applyFinanceActions(s, actions);
    const savedCard = next.ledgerAccounts!.find((a) => a.entityRef === "card")!;
    expect(savedCard).toBeDefined();
    expect(savedCard.id).not.toBe(accountId);
    expect(savedCard.id).not.toContain("card");
    expect(
      p.financeActions!.find((a) => a.type === "ledger.add")?.transaction
        .legs[0].accountId,
    ).toBe(accountId);
    const row = actions.find((a) => a.type === "ledger.add")!;
    if (row.type !== "ledger.add") throw new Error("missing row");
    const wallet = resolveLedgerAccount(
      s,
      actions,
      "我的零钱",
      "ASSET",
      "CNY",
      "未指定账户",
    );
    const category = resolveLedgerAccount(
      s,
      actions,
      "工作餐",
      "EXPENSE",
      "CNY",
      "其他支出",
    );
    row.transaction.legs[0].accountId = wallet.id;
    row.transaction.legs[1].accountId = category.id;
    const edited = applyFinanceActions(
      s,
      materializeFinanceAccounts(s, actions),
    );
    expect(edited.ledgerAccounts!.map((a) => a.name).sort()).toEqual([
      "工作餐",
      "我的零钱",
    ]);
  });
  it("includes named accounts beyond forty, excludes secret cards, and requires explicit business confirmation", () => {
    const s = emptySnapshot();
    s.entities = Array.from({ length: 60 }, (_, i) =>
      entity(`card-${i}`, "Payment Card"),
    );
    s.entities[0].privacy = "SECRET";
    expect(
      financeContext(s, "card-59早餐8元").accounts.some(
        (a) => a.name === "card-59",
      ),
    ).toBe(true);
    expect(ledgerAccountOptions(s).some((a) => a.name === "card-0")).toBe(
      false,
    );
    const project = entity("personal");
    expect(isCommercialProject(project)).toBe(false);
    project.fields = [
      {
        id: "f",
        entityId: project.id,
        key: "commercial",
        value: true,
        valueType: "boolean",
        privacy: "PRIVATE",
        searchable: false,
      },
    ];
    expect(isCommercialProject(project)).toBe(true);
    project.fields[0].value = false;
    expect(isCommercialProject(project)).toBe(false);
  });
  it("legacy text fees and quotes stay editable without entering reports", () => {
    const s = fixture(),
      e = entity("service", "Subscription"),
      o = entity("order", "Order");
    e.fields = [
      {
        id: "f",
        entityId: e.id,
        key: "fee",
        valueType: "text",
        value: "30 USD",
        privacy: "PRIVATE",
        searchable: false,
      },
    ];
    o.fields = [
      { ...e.fields[0], id: "q", entityId: o.id, key: "quote", value: "待议" },
    ];
    s.entities = [e, o];
    expect(monthlyCosts(s, "2026-10-01").totals).toEqual([]);
    expect(orderReport(s, o)).toBeUndefined();
  });
  it("transfer direction follows explicit words, independent of account order", () => {
    const s = fixture();
    s.ledgerAccounts!.push({
      id: "bank",
      name: "银行卡",
      kind: "ASSET",
      asset: "CNY",
      privacy: "PRIVATE",
    });
    for (const input of ["银行卡转账100元到现金", "从银行卡转入现金100元"]) {
      const p = localLedgerProposal(input, s)!;
      expect(p.uncertainty).toEqual([]);
      const a = p.financeActions![0];
      expect(a.type).toBe("ledger.add");
      if (a.type === "ledger.add") {
        expect(a.transaction.legs[0]).toMatchObject({
          accountId: "bank",
          money: { amount: "-100.00" },
        });
        expect(a.transaction.legs[1]).toMatchObject({
          accountId: "cash",
          money: { amount: "100.00" },
        });
      }
    }
    expect(
      localLedgerProposal("现金和银行卡转账100元", s)?.financeActions,
    ).toHaveLength(0);
  });
  it("query uses only selected project shares and preserves original allocation on reversal", () => {
    const s = fixture();
    s.entities = [entity("a"), entity("b"), entity("server", "Server")];
    s.allocationRules = [
      {
        id: "r1",
        resourceId: "server",
        effectiveFrom: "2026-10-01",
        effectiveTo: "2026-11-01",
        shares: [
          { projectId: "a", weight: 0.6 },
          { projectId: "b", weight: 0.2 },
        ],
      },
      {
        id: "r2",
        resourceId: "server",
        effectiveFrom: "2026-11-01",
        shares: [{ projectId: "a", weight: 1 }],
      },
    ];
    const t = makeEntry({
      kind: "SPEND",
      amount: money("100", "CNY"),
      accountId: "cash",
      counterId: "expense",
      date: "2026-10-01",
      resourceId: "server",
    });
    s.transactions = [t];
    const q = {
      from: "2026-10-01",
      to: "2026-10-31",
      projectId: "a",
      metric: "profit" as const,
      groupBy: "project" as const,
      search: "",
    };
    expect(queryReport(s, q).profit[0].amount).toBe("-60.00");
    s.transactions.push(reverseTransaction(t, "2026-11-01"));
    expect(
      periodReport(s, "2026-10-01", "2026-11-30").projects[0].profit[0].amount,
    ).toBe("0.00");
    expect(periodReport(s, "2026-10-01", "2026-11-30").idle[0].amount).toBe(
      "0.00",
    );
  });
  it("cannot reclassify accounts or change quote currency after trading", () => {
    const s = fixture();
    const input = {
      side: "BUY" as const,
      quantity: money("1", "BTC"),
      gross: money("100", "USD"),
      fee: money("0", "USD"),
      holdingId: "btc",
      cashId: "usd",
      clearingId: "equity",
      feeAccountId: "fee",
      date: "2026-10-01",
    };
    s.transactions = [tradeTransaction(s, input)];
    const edited = structuredClone(s);
    edited.ledgerAccounts!.find((a) => a.id === "usd")!.kind = "EXPENSE";
    expect(() => validateLedger(edited, s)).toThrow();
    expect(() =>
      tradeTransaction(s, {
        ...input,
        side: "SELL",
        gross: money("200", "CNY"),
        fee: money("0", "CNY"),
        cashId: "cash",
      }),
    ).toThrow();
  });
  it("model amount hallucination stays uncertain and secret accounts never enter context", () => {
    const s = fixture();
    s.ledgerAccounts!.push({
      id: "secret",
      name: "hidden account",
      kind: "ASSET",
      asset: "CNY",
      privacy: "SECRET",
    });
    expect(financeContext(s).accounts.some((a) => a.id === "secret")).toBe(
      false,
    );
    const p = financeOutput(
      {
        entries: [
          {
            kind: "SPEND",
            amount: money("80", "CNY"),
            accountId: "cash",
            counterId: "expense",
            occurredAt: "2026-10-15",
            projectId: "",
            resourceId: "",
            orderId: "",
            note: "",
            evidence: "现金付了八块",
          },
        ],
        uncertainty: [],
      },
      "现金付了八块",
      s,
    );
    expect(p.uncertainty.length).toBeGreaterThan(0);
  });
  it("preview import preserves financial records and rolls back a conflicting file", async () => {
    await initializeVault("synthetic only");
    const s = fixture();
    s.transactions = [
      makeEntry({
        kind: "SPEND",
        amount: money("8", "CNY"),
        accountId: "cash",
        counterId: "expense",
        date: "2026-10-15",
      }),
    ];
    s.opaqueRecords = [
      { kind: "FutureBudget", data: { id: "future", value: "keep-me" } },
    ];
    const file = (snapshot: VaultSnapshot) =>
      JSON.stringify({ format: "amiya-atlas", version: 1, snapshot });
    const imported = await importAtlasJson(file(s));
    expect(imported.transactions).toHaveLength(1);
    expect(imported.opaqueRecords).toEqual(s.opaqueRecords);
    expect((await importAtlasJson(file(s))).transactions).toHaveLength(1);
    const bad = structuredClone(s);
    bad.ledgerAccounts![0].name = "conflict";
    await expect(importAtlasJson(file(bad))).rejects.toThrow();
    expect((await loadSnapshot()).ledgerAccounts![0].name).toBe("现金");
  });
});
