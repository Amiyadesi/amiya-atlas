import {
  units,
  fromUnits,
  money,
  negate,
  subtract,
  add,
  divideRound,
  precision,
  scale,
  type Money,
} from "./money";
import { newId, nowIso, type VaultSnapshot } from "../lib/types";
import {
  preferences,
  dateToday,
  type Transaction,
  type TradePlan,
} from "./ledger";
export interface Lot {
  transactionId: string;
  date: string;
  quantity: bigint;
  cost: bigint;
}
export function tradeTransaction(
  s: VaultSnapshot,
  input: {
    side: "BUY" | "SELL";
    quantity: Money;
    gross: Money;
    fee: Money;
    holdingId: string;
    cashId: string;
    clearingId: string;
    feeAccountId: string;
    date: string;
  },
): Transaction {
  const q = units(input.quantity),
    g = units(input.gross),
    f = units(input.fee);
  if (
    q <= 0n ||
    g <= 0n ||
    f < 0n ||
    input.gross.asset !== input.fee.asset ||
    input.quantity.asset === input.gross.asset
  )
    throw new Error("成交数量、金额或手续费无效");
  const buy = input.side === "BUY",
    legs = [
      {
        accountId: input.holdingId,
        money: buy ? input.quantity : negate(input.quantity),
      },
      {
        accountId: input.clearingId,
        money: buy ? negate(input.quantity) : input.quantity,
      },
      {
        accountId: input.cashId,
        money: buy ? negate(input.gross) : input.gross,
      },
      {
        accountId: input.clearingId,
        money: buy ? input.gross : negate(input.gross),
      },
    ];
  const existing = positions(s).find(
    (p) => p.accountId === input.holdingId && p.asset === input.quantity.asset,
  );
  if (existing && existing.quote !== input.gross.asset)
    throw new Error("同一持仓账户需使用同一计价币种，请另建账户");
  if (f)
    legs.push(
      { accountId: input.cashId, money: negate(input.fee) },
      { accountId: input.feeAccountId, money: input.fee },
    );
  const t: Transaction = {
    id: newId("tx"),
    kind: "TRADE",
    occurredAt: input.date,
    legs,
    source: {},
    privacy: "PRIVATE",
    idempotencyKey: newId("trade"),
    createdAt: nowIso(),
  };
  if (!buy) {
    const p = positions(s).find(
      (p) =>
        p.accountId === input.holdingId && p.asset === input.quantity.asset,
    );
    if (!p || p.quantity < q) throw new Error("卖出超过已有持仓");
  }
  return t;
}
export function positions(
  s: VaultSnapshot,
  method = preferences(s)?.lotMethod ?? "FIFO",
) {
  const accounts = new Map(s.ledgerAccounts?.map((a) => [a.id, a]));
  const reversed = new Set(
    (s.transactions ?? []).filter((t) => t.reversalOf).map((t) => t.reversalOf),
  );
  const book = new Map<
    string,
    {
      accountId: string;
      asset: string;
      quote: string;
      lots: Lot[];
      realized: bigint;
      quantity: bigint;
      cost: bigint;
    }
  >();
  for (const t of [...(s.transactions ?? [])].sort(
    (a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  )) {
    if (t.kind !== "TRADE" || t.reversalOf || reversed.has(t.id)) continue;
    const clearing = t.legs.filter(
      (l) => accounts.get(l.accountId)?.kind === "EQUITY",
    );
    const holding = t.legs.find(
      (l) =>
        accounts.get(l.accountId)?.kind === "ASSET" &&
        clearing.some(
          (c) =>
            c.money.asset === l.money.asset &&
            units(c.money) === -units(l.money),
        ) &&
        units(l.money) !== 0n,
    );
    if (!holding) throw new Error("交易缺少持仓腿");
    const quoteLeg = clearing.find(
      (l) => l.money.asset !== holding.money.asset,
    );
    if (!quoteLeg) throw new Error("交易缺少成交金额");
    const quote = quoteLeg.money.asset,
      key = `${holding.accountId}:${holding.money.asset}:${quote}`;
    const p = book.get(key) ?? {
      accountId: holding.accountId,
      asset: holding.money.asset,
      quote,
      lots: [],
      realized: 0n,
      quantity: 0n,
      cost: 0n,
    };
    const delta = units(holding.money),
      gross = units(quoteLeg.money),
      fees = t.legs
        .filter(
          (l) =>
            accounts.get(l.accountId)?.kind === "EXPENSE" &&
            l.money.asset === quote,
        )
        .reduce((sum, l) => sum + units(l.money), 0n);
    if (delta > 0n)
      p.lots.push({
        transactionId: t.id,
        date: t.occurredAt,
        quantity: delta,
        cost: gross + fees,
      });
    else {
      let remaining = -delta,
        cost = 0n;
      while (remaining > 0n) {
        const index = method === "FIFO" ? 0 : p.lots.length - 1,
          lot = p.lots[index];
        if (!lot) throw new Error("交易历史存在超卖；检查日期、期初持仓与冲正");
        const take = remaining < lot.quantity ? remaining : lot.quantity,
          used =
            take === lot.quantity
              ? lot.cost
              : divideRound(lot.cost * take, lot.quantity);
        cost += used;
        lot.cost -= used;
        lot.quantity -= take;
        remaining -= take;
        if (lot.quantity === 0n) p.lots.splice(index, 1);
      }
      p.realized += -gross - fees - cost;
    }
    p.quantity = p.lots.reduce((sum, l) => sum + l.quantity, 0n);
    p.cost = p.lots.reduce((sum, l) => sum + l.cost, 0n);
    book.set(key, p);
  }
  return [...book.values()].map((p) => {
    const price = s.financeRecords
      ?.filter(
        (r) =>
          r.type === "price" &&
          r.asset === p.asset &&
          r.value.asset === p.quote &&
          r.date <= dateToday(),
      )
      .sort((a, b) =>
        ("date" in b ? b.date : "").localeCompare("date" in a ? a.date : ""),
      )[0];
    const value =
      price && "value" in price
        ? scale(price.value, p.quantity, 10n ** BigInt(precision(p.asset)))
        : undefined;
    return {
      ...p,
      quantityMoney: fromUnits(p.quantity, p.asset),
      costMoney: fromUnits(p.cost, p.quote),
      realizedMoney: fromUnits(p.realized, p.quote),
      value,
      unrealized: value
        ? subtract(value, fromUnits(p.cost, p.quote))
        : undefined,
      priceDate: price && "date" in price ? price.date : undefined,
    };
  });
}
export function rewardRisk(plan: TradePlan): string {
  const risk = units(plan.entry) - units(plan.stop),
    reward = units(plan.target) - units(plan.entry);
  if (risk <= 0n || reward <= 0n) throw new Error("止损和目标价格无效");
  return `${divideRound(reward * 100n, risk) / 100n}.${(divideRound(reward * 100n, risk) % 100n).toString().padStart(2, "0")}`;
}
export function stopPlan(plan: TradePlan, date: string): TradePlan {
  const until = new Date(`${date}T12:00:00`);
  until.setDate(until.getDate() + plan.cooldownDays);
  return {
    ...plan,
    status: "STOPPED",
    cooldownUntil: until.toLocaleDateString("sv-SE"),
    reviewDue: plan.review.trim() ? undefined : date,
  };
}
export function checkStops(s: VaultSnapshot, date: string): VaultSnapshot {
  const next = structuredClone(s);
  next.financeRecords = next.financeRecords?.map((r) => {
    if (r.type !== "plan" || r.status !== "OPEN") return r;
    const latest = next.financeRecords
      ?.filter(
        (p) =>
          p.type === "price" &&
          p.asset === r.asset &&
          p.value.asset === r.stop.asset &&
          p.date <= date &&
          p.date >= r.date,
      )
      .sort((a, b) =>
        ("date" in b ? b.date : "").localeCompare("date" in a ? a.date : ""),
      )[0];
    return latest?.type === "price" && units(latest.value) <= units(r.stop)
      ? stopPlan(r, latest.date)
      : r;
  });
  return next;
}
