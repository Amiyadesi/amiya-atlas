import { z } from "zod";
import {
  moneySchema,
  units,
  fromUnits,
  negate,
  money,
  subtract,
  ratio,
  type Money,
} from "./money";
import { newId, nowIso, type VaultSnapshot, type Privacy } from "../lib/types";

const id = z.string().min(1).max(200),
  date = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(
      (s) =>
        Number.isFinite(Date.parse(s)) &&
        new Date(s).toISOString().slice(0, 10) === s,
      "日期无效",
    );
const privacy = z.enum(["PUBLIC", "PRIVATE", "SECRET"]);
export const accountSchema = z.strictObject({
  id,
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["ASSET", "LIABILITY", "INCOME", "EXPENSE", "EQUITY"]),
  asset: z.string().optional(),
  entityRef: id.optional(),
  parentId: id.optional(),
  archived: z.boolean().optional(),
  privacy: privacy.default("PRIVATE"),
});
export type LedgerAccount = z.infer<typeof accountSchema>;
export const legSchema = z.strictObject({
  accountId: id,
  money: moneySchema,
  projectId: id.optional(),
  resourceId: id.optional(),
});
export type Leg = z.infer<typeof legSchema>;
export const transactionSchema = z.strictObject({
  id,
  occurredAt: date,
  precision: z.enum(["day", "month"]).optional(),
  kind: z.enum(["SPEND", "INCOME", "TRANSFER", "TRADE", "ADJUST", "OPENING"]),
  legs: z.array(legSchema).min(2).max(30),
  payee: z.string().max(500).optional(),
  note: z.string().max(5000).optional(),
  refs: z
    .strictObject({ orderId: id.optional(), subscriptionId: id.optional() })
    .optional(),
  source: z.strictObject({
    captureId: id.optional(),
    import: z.string().max(500).optional(),
  }),
  idempotencyKey: id,
  reversalOf: id.optional(),
  createdAt: z.iso.datetime({ offset: true }),
  privacy,
});
export type Transaction = z.infer<typeof transactionSchema>;
export const allocationSchema = z.strictObject({
  id,
  resourceId: id,
  effectiveFrom: date,
  effectiveTo: date.optional(),
  shares: z
    .array(z.strictObject({ projectId: id, weight: z.number().min(0).max(1) }))
    .max(100),
});
export type AllocationRule = z.infer<typeof allocationSchema>;
export const financeRecordSchema = z.discriminatedUnion("type", [
  z.strictObject({
    id,
    type: z.literal("price"),
    asset: z.string(),
    value: moneySchema,
    date,
  }),
  z.strictObject({
    id,
    type: z.literal("rate"),
    asset: z.string(),
    value: moneySchema,
    date,
  }),
  z.strictObject({
    id,
    type: z.literal("budget"),
    month: z.string().regex(/^\d{4}-\d{2}$/),
    value: moneySchema,
    projectId: id.optional(),
  }),
  z.strictObject({
    id,
    type: z.literal("reconciliation"),
    accountId: id,
    date,
    balance: moneySchema,
    createdAt: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    id,
    type: z.literal("plan"),
    asset: z.string(),
    quantity: moneySchema,
    entry: moneySchema,
    target: moneySchema,
    stop: moneySchema,
    status: z.enum(["PLANNED", "OPEN", "CLOSED", "STOPPED"]),
    cooldownDays: z.number().int().min(0).max(365),
    cooldownUntil: date.optional(),
    reviewDue: date.optional(),
    review: z.string().max(5000),
    date,
  }),
  z.strictObject({
    id,
    type: z.literal("preferences"),
    lotMethod: z.enum(["FIFO", "LIFO"]),
    showEntries: z.boolean(),
    taxRate: z.number().min(0).max(1),
    reserveAccountId: id.optional(),
  }),
]);
export type FinanceRecord = z.infer<typeof financeRecordSchema>;
export type TradePlan = Extract<FinanceRecord, { type: "plan" }>;
export const financeActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("account.add"), account: accountSchema }),
  z.strictObject({
    type: z.literal("ledger.add"),
    transaction: transactionSchema,
    evidence: z.string().min(1).max(10000),
  }),
  z.strictObject({
    type: z.literal("ledger.reverse"),
    transactionId: id,
    id,
    idempotencyKey: id,
    occurredAt: date,
  }),
]);
export type FinanceAction = z.infer<typeof financeActionSchema>;
export const dateToday = () => new Date().toLocaleDateString("sv-SE");
export const preferences = (s: VaultSnapshot) =>
  s.financeRecords?.find(
    (r): r is Extract<FinanceRecord, { type: "preferences" }> =>
      r.type === "preferences",
  );

export function validateLedger(
  s: VaultSnapshot,
  previous?: VaultSnapshot,
): void {
  const accounts = new Map(
    (s.ledgerAccounts ?? []).map((a) => [a.id, accountSchema.parse(a)]),
  );
  const entities = new Map(s.entities.map((e) => [e.id, e]));
  const ids = new Set<string>();
  const unique = (id: string) => {
    if (ids.has(id)) throw new Error("重复账本记录 ID");
    ids.add(id);
  };
  const ref = (id: string | undefined, category?: string) => {
    if (
      id &&
      (!entities.has(id) ||
        (category && entities.get(id)?.category !== category))
    )
      throw new Error("账本引用的资产、项目或订单不存在");
  };
  for (const a of s.ledgerAccounts ?? []) {
    unique(a.id);
    ref(a.entityRef);
    if (a.asset) units({ amount: "0", asset: a.asset });
    if (a.parentId && !accounts.has(a.parentId))
      throw new Error("上级账户不存在");
    const visited = new Set([a.id]);
    let parent = a.parentId;
    while (parent) {
      if (visited.has(parent)) throw new Error("账户层级不能循环");
      visited.add(parent);
      parent = accounts.get(parent)?.parentId;
    }
  }
  const keys = new Set<string>(),
    reversed = new Set<string>();
  const txs = new Map((s.transactions ?? []).map((t) => [t.id, t]));
  for (const raw of s.transactions ?? []) {
    const t = transactionSchema.parse(raw);
    unique(t.id);
    if (keys.has(t.idempotencyKey)) throw new Error("重复入账");
    keys.add(t.idempotencyKey);
    ref(t.refs?.orderId, "Order");
    ref(t.refs?.subscriptionId);
    const sums = new Map<string, bigint>();
    let nonzero = false;
    for (const l of t.legs) {
      const a = accounts.get(l.accountId);
      if (!a) throw new Error("流水账户不存在");
      if (a.asset && a.asset !== l.money.asset)
        throw new Error("账户币种不匹配");
      ref(l.projectId, "Project");
      ref(l.resourceId);
      const n = units(l.money);
      nonzero ||= n !== 0n;
      sums.set(l.money.asset, (sums.get(l.money.asset) ?? 0n) + n);
    }
    if (!nonzero || [...sums.values()].some((n) => n !== 0n))
      throw new Error("流水每种币种必须分别平衡，金额不能全为零");
    if (t.reversalOf) {
      const old = txs.get(t.reversalOf);
      if (
        !old ||
        old.reversalOf ||
        reversed.has(old.id) ||
        t.occurredAt < old.occurredAt ||
        t.legs.length !== old.legs.length ||
        old.kind !== t.kind ||
        JSON.stringify(old.refs) !== JSON.stringify(t.refs)
      )
        throw new Error("冲正对象无效或已经冲正");
      reversed.add(old.id);
      for (let i = 0; i < t.legs.length; i++) {
        const a = t.legs[i],
          b = old.legs[i];
        if (
          a.accountId !== b.accountId ||
          a.projectId !== b.projectId ||
          a.resourceId !== b.resourceId ||
          a.money.asset !== b.money.asset ||
          units(a.money) !== -units(b.money)
        )
          throw new Error("冲正必须完整抵消原流水");
      }
    } else validateEntryAccounts(t, accounts);
  }
  for (const raw of s.allocationRules ?? []) {
    const a = allocationSchema.parse(raw);
    unique(a.id);
    ref(a.resourceId);
    if (a.effectiveTo && a.effectiveTo <= a.effectiveFrom)
      throw new Error("分摊结束日期必须晚于生效日期");
    let sum = 0;
    const projects = new Set();
    for (const share of a.shares) {
      ref(share.projectId, "Project");
      ratio(money("1", "USD"), share.weight);
      sum += Math.round(share.weight * 1e6);
      if (projects.has(share.projectId)) throw new Error("重复分摊项目");
      projects.add(share.projectId);
    }
    if (sum > 1e6) throw new Error("分摊比例总和不能超过 100%");
    if (
      (s.allocationRules ?? []).some(
        (b) =>
          b.id !== a.id &&
          b.resourceId === a.resourceId &&
          b.effectiveFrom < (a.effectiveTo ?? "9999") &&
          a.effectiveFrom < (b.effectiveTo ?? "9999"),
      )
    )
      throw new Error("同一资源的分摊生效期不能重叠");
  }
  for (const raw of s.financeRecords ?? []) {
    const r = financeRecordSchema.parse(raw);
    unique(r.id);
    if ("value" in r) units(r.value);
    if (r.type === "price" || r.type === "rate") {
      units({ amount: "1", asset: r.asset });
      if (units(r.value) <= 0n || r.asset === r.value.asset)
        throw new Error("价格或汇率无效");
    }
    if (r.type === "budget") {
      ref(r.projectId, "Project");
      if (units(r.value) < 0n) throw new Error("预算不能为负");
    }
    if (r.type === "reconciliation") {
      if (!accounts.has(r.accountId)) throw new Error("对账账户不存在");
      units(r.balance);
      if (accounts.get(r.accountId)?.asset !== r.balance.asset)
        throw new Error("对账币种不匹配");
    }
    if (
      r.type === "preferences" &&
      r.reserveAccountId &&
      !accounts.has(r.reserveAccountId)
    )
      throw new Error("预留账户不存在");
    if (r.type === "plan") {
      for (const m of [r.quantity, r.entry, r.target, r.stop])
        if (units(m) <= 0n) throw new Error("计划价格与数量必须大于零");
      if (
        r.quantity.asset !== r.asset ||
        r.target.asset !== r.entry.asset ||
        r.stop.asset !== r.entry.asset ||
        units(r.target) <= units(r.entry) ||
        units(r.stop) >= units(r.entry)
      )
        throw new Error("目标价应高于入场价，止损价应低于入场价");
    }
  }
  if (
    (s.financeRecords ?? []).filter((r) => r.type === "preferences").length > 1
  )
    throw new Error("重复账本设置");
  const pref = preferences(s);
  if (
    pref?.reserveAccountId &&
    accounts.get(pref.reserveAccountId)?.kind !== "ASSET"
  )
    throw new Error("预留账户必须是资产账户");
  const holdingQuotes = new Map<string, string>(),
    holdings = new Map<string, bigint>();
  for (const t of [...(s.transactions ?? [])].sort(
    (a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  )) {
    if (t.kind !== "TRADE" || t.reversalOf || reversed.has(t.id)) continue;
    const first = t.legs[0],
      clearing = t.legs.filter(
        (l) => accounts.get(l.accountId)?.kind === "EQUITY",
      ),
      quote = clearing.find((l) => l.money.asset !== first.money.asset)?.money
        .asset;
    if (
      accounts.get(first.accountId)?.kind !== "ASSET" ||
      clearing.length !== 2 ||
      !quote ||
      !clearing.some(
        (l) =>
          l.money.asset === first.money.asset &&
          units(l.money) === -units(first.money),
      )
    )
      throw new Error("交易必须含持仓、资金与逐币种清算分录");
    const key = `${first.accountId}:${first.money.asset}`,
      prior = holdingQuotes.get(key);
    if (prior && prior !== quote)
      throw new Error("同一持仓账户需使用同一计价币种，请另建账户");
    holdingQuotes.set(key, quote);
    const balance = (holdings.get(key) ?? 0n) + units(first.money);
    if (balance < 0n) throw new Error("交易历史存在超卖，请检查日期或冲正");
    holdings.set(key, balance);
  }
  if (previous) {
    for (const old of previous.transactions ?? []) {
      const found = txs.get(old.id);
      if (JSON.stringify(old) !== JSON.stringify(found))
        throw new Error("已入账流水不能修改或删除，请冲正");
    }
    for (const old of previous.ledgerAccounts ?? []) {
      const next = accounts.get(old.id);
      if (
        (previous.transactions ?? []).some((t) =>
          t.legs.some((l) => l.accountId === old.id),
        ) &&
        (!next || next.kind !== old.kind || next.asset !== old.asset)
      )
        throw new Error("已有流水的账户不能改变类型或币种");
    }
    for (const old of previous.allocationRules ?? []) {
      const next = s.allocationRules?.find((r) => r.id === old.id);
      if (
        !next ||
        JSON.stringify({ ...next, effectiveTo: old.effectiveTo }) !==
          JSON.stringify(old) ||
        (next.effectiveTo !== old.effectiveTo &&
          (!next.effectiveTo || next.effectiveTo < dateToday()))
      )
        throw new Error("历史分摊不能改写，请新增生效版本");
    }
  }
}
function validateEntryAccounts(
  t: Transaction,
  accounts: Map<string, LedgerAccount>,
) {
  const kind = (i: number) => accounts.get(t.legs[i].accountId)!.kind;
  const fund = (i: number) => ["ASSET", "LIABILITY"].includes(kind(i));
  if (["SPEND", "INCOME", "TRANSFER", "OPENING"].includes(t.kind)) {
    const counter =
      t.kind === "SPEND"
        ? "EXPENSE"
        : t.kind === "INCOME"
          ? "INCOME"
          : t.kind === "OPENING"
            ? "EQUITY"
            : null;
    if (
      !fund(0) ||
      (counter ? kind(1) !== counter : !fund(1)) ||
      t.legs[0].accountId === t.legs[1].accountId
    )
      throw new Error("付款/收款账户与分类不匹配");
    if (
      t.kind !== "OPENING" &&
      (units(t.legs[0].money) * (t.kind === "INCOME" ? 1n : -1n) <= 0n ||
        units(t.legs[1].money) !== -units(t.legs[0].money))
    )
      throw new Error("收支金额方向无效");
  }
  if (t.kind === "TRADE") {
    if (
      ![4, 6].includes(t.legs.length) ||
      kind(0) !== "ASSET" ||
      kind(2) !== "ASSET" ||
      kind(1) !== "EQUITY" ||
      t.legs[1].accountId !== t.legs[3].accountId ||
      t.legs[0].accountId === t.legs[2].accountId ||
      t.legs[0].money.asset === t.legs[2].money.asset ||
      units(t.legs[0].money) * units(t.legs[3].money) <= 0n ||
      units(t.legs[2].money) !== -units(t.legs[3].money)
    )
      throw new Error("交易的持仓、资金和清算分录无效");
    if (
      t.legs.length === 6 &&
      (t.legs[4].accountId !== t.legs[2].accountId ||
        kind(5) !== "EXPENSE" ||
        t.legs[5].money.asset !== t.legs[2].money.asset ||
        units(t.legs[5].money) <= 0n ||
        units(t.legs[4].money) !== -units(t.legs[5].money))
    )
      throw new Error("交易手续费分录无效");
  }
}
export function accountBalances(
  s: VaultSnapshot,
  until = "9999-99-99",
): Map<string, Money[]> {
  const values = new Map<string, Map<string, bigint>>();
  for (const t of s.transactions ?? []) {
    if (t.occurredAt > until) continue;
    for (const l of t.legs) {
      const a = values.get(l.accountId) ?? new Map();
      a.set(l.money.asset, (a.get(l.money.asset) ?? 0n) + units(l.money));
      values.set(l.accountId, a);
    }
  }
  return new Map(
    [...values].map(([id, assets]) => [
      id,
      [...assets].map(([asset, n]) => fromUnits(n, asset)),
    ]),
  );
}
export function reverseTransaction(
  t: Transaction,
  occurredAt = dateToday(),
  id = newId("tx"),
  idempotencyKey = newId("reverse"),
): Transaction {
  if (t.reversalOf) throw new Error("不能冲正冲正记录");
  return {
    ...structuredClone(t),
    id,
    idempotencyKey,
    occurredAt,
    reversalOf: t.id,
    createdAt: nowIso(),
    note: `冲正：${t.note ?? t.payee ?? ""}`,
    source: {},
    legs: t.legs.map((l) => ({ ...l, money: negate(l.money) })),
  };
}
export interface EntryInput {
  kind: Transaction["kind"];
  amount: Money;
  accountId: string;
  counterId: string;
  date: string;
  note?: string;
  payee?: string;
  projectId?: string;
  resourceId?: string;
  orderId?: string;
  fee?: Money;
  feeAccountId?: string;
  taxRate?: number;
  reserveAccountId?: string;
  privacy?: Privacy;
}
export function makeEntry(input: EntryInput): Transaction {
  const { kind, amount } = input;
  if (units(amount) <= 0n) throw new Error("金额必须大于零");
  if (input.accountId === input.counterId) throw new Error("两个账户不能相同");
  const incoming = kind === "INCOME" || kind === "OPENING";
  const refs = {
    projectId: input.projectId || undefined,
    resourceId: input.resourceId || undefined,
  };
  const legs: Leg[] = [
    { accountId: input.accountId, money: incoming ? amount : negate(amount) },
    {
      accountId: input.counterId,
      money: incoming ? negate(amount) : amount,
      ...refs,
    },
  ];
  if (input.fee && units(input.fee) > 0n) {
    if (!input.feeAccountId || input.fee.asset !== amount.asset)
      throw new Error("请选择同币种手续费账户");
    legs.push(
      { accountId: input.accountId, money: negate(input.fee) },
      { accountId: input.feeAccountId, money: input.fee, ...refs },
    );
  }
  if (incoming && input.taxRate) {
    if (!input.reserveAccountId || input.reserveAccountId === input.accountId)
      throw new Error("请选择独立预留账户");
    const tax = ratio(amount, input.taxRate);
    legs.push(
      { accountId: input.accountId, money: negate(tax) },
      { accountId: input.reserveAccountId, money: tax },
    );
  }
  return {
    id: newId("tx"),
    idempotencyKey: newId("entry"),
    kind,
    occurredAt: input.date,
    legs,
    source: {},
    privacy: input.privacy ?? "PRIVATE",
    note: input.note,
    payee: input.payee,
    refs:
      input.orderId || input.resourceId
        ? {
            orderId: input.orderId || undefined,
            subscriptionId: input.resourceId || undefined,
          }
        : undefined,
    createdAt: nowIso(),
  };
}
export function reconciliation(
  s: VaultSnapshot,
  accountId: string,
  actual: Money,
  date: string,
  reason: string,
): { transaction?: Transaction; record: FinanceRecord } {
  const expected =
      accountBalances(s, date)
        .get(accountId)
        ?.find((m) => m.asset === actual.asset) ?? money("0", actual.asset),
    diff = subtract(actual, expected);
  const equity = s.ledgerAccounts?.find(
    (a) => a.kind === "EQUITY" && !a.archived,
  );
  if (!equity) throw new Error("请先创建调整账户");
  const transaction =
    units(diff) === 0n
      ? undefined
      : {
          id: newId("tx"),
          kind: "ADJUST" as const,
          occurredAt: date,
          legs: [
            { accountId, money: diff },
            { accountId: equity.id, money: negate(diff) },
          ],
          note: reason,
          source: {},
          privacy: "PRIVATE" as const,
          idempotencyKey: newId("adjust"),
          createdAt: nowIso(),
        };
  if (transaction && !reason.trim()) throw new Error("请填写差额原因");
  return {
    transaction,
    record: {
      id: newId("reconcile"),
      type: "reconciliation",
      accountId,
      date,
      balance: actual,
      createdAt: nowIso(),
    },
  };
}
export function ledgerCsv(
  s: VaultSnapshot,
  transactions = s.transactions ?? [],
): string {
  const names = new Map(s.ledgerAccounts?.map((a) => [a.id, a.name]));
  const cell = (v: unknown) =>
    `"${String(v ?? "")
      .replace(/^[=+@\-]/, "'$&")
      .replaceAll('"', '""')}"`;
  return (
    "\uFEFF" +
    [
      [
        "日期",
        "流水ID",
        "类型",
        "账户",
        "金额",
        "币种",
        "项目",
        "资源",
        "订单",
        "备注",
      ],
      ...transactions.flatMap((t) =>
        t.legs.map((l) => [
          t.occurredAt,
          t.id,
          t.kind,
          names.get(l.accountId),
          l.money.amount,
          l.money.asset,
          l.projectId,
          l.resourceId,
          t.refs?.orderId,
          t.note,
        ]),
      ),
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n")
  );
}
