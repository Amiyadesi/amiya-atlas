import { z } from "zod";

export interface Asset {
  code: string;
  decimals: number;
  kind: "FIAT" | "CRYPTO";
}
export interface Money {
  amount: string;
  asset: string;
}
export const ASSETS: Asset[] = [
  ...["CNY", "USD", "HKD", "TWD", "EUR", "GBP", "SGD", "AUD", "CAD"].map(
    (code) => ({ code, decimals: 2, kind: "FIAT" as const }),
  ),
  ...["JPY", "KRW"].map((code) => ({
    code,
    decimals: 0,
    kind: "FIAT" as const,
  })),
  { code: "BTC", decimals: 8, kind: "CRYPTO" },
  { code: "ETH", decimals: 18, kind: "CRYPTO" },
  { code: "USDT", decimals: 6, kind: "CRYPTO" },
];
export const moneySchema = z
  .strictObject({
    amount: z.string().regex(/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/),
    asset: z.string().regex(/^[A-Z][A-Z0-9]{1,11}$/),
  })
  .refine((m) => {
    const a = ASSETS.find((a) => a.code === m.asset);
    return !!a && (m.amount.split(".")[1]?.length ?? 0) <= a.decimals;
  }, "币种或金额精度无效");
export function precision(asset: string, assets = ASSETS): number {
  const found = assets.find((a) => a.code === asset);
  if (!found) throw new Error(`未知币种：${asset}`);
  return found.decimals;
}
export function units(money: Money, assets = ASSETS): bigint {
  moneySchema.parse(money);
  const decimals = precision(money.asset, assets),
    negative = money.amount.startsWith("-");
  const [whole, fraction = ""] = money.amount.replace(/^-/, "").split(".");
  if (fraction.length > decimals)
    throw new Error(`${money.asset} 最多 ${decimals} 位小数`);
  return BigInt(whole + fraction.padEnd(decimals, "0")) * (negative ? -1n : 1n);
}
export function fromUnits(
  value: bigint,
  asset: string,
  assets = ASSETS,
): Money {
  const decimals = precision(asset, assets),
    negative = value < 0n,
    text = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const amount =
    (negative ? "-" : "") +
    (decimals ? `${text.slice(0, -decimals)}.${text.slice(-decimals)}` : text);
  return moneySchema.parse({ amount, asset });
}
export function money(amount: string, asset: string): Money {
  return fromUnits(units({ amount, asset }), asset);
}
export function add(a: Money, b: Money): Money {
  if (a.asset !== b.asset) throw new Error("不同币种不能相加");
  return fromUnits(units(a) + units(b), a.asset);
}
export function negate(a: Money): Money {
  return fromUnits(-units(a), a.asset);
}
export function subtract(a: Money, b: Money): Money {
  return add(a, negate(b));
}
export function divideRound(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("除数必须大于零");
  const sign = n < 0n ? -1n : 1n;
  const a = n < 0n ? -n : n;
  return sign * ((a + d / 2n) / d);
}
export function scale(a: Money, n: bigint, d = 1n): Money {
  return fromUnits(divideRound(units(a) * n, d), a.asset);
}
export const formatMoney = (m: Money) =>
  `${m.asset} ${money(m.amount, m.asset).amount}`;
export function total(values: Money[]): Money[] {
  const totals = new Map<string, bigint>();
  for (const m of values)
    totals.set(m.asset, (totals.get(m.asset) ?? 0n) + units(m));
  return [...totals].map(([asset, n]) => fromUnits(n, asset));
}
export function ratio(amount: Money, weight: number): Money {
  if (
    !Number.isFinite(weight) ||
    weight < 0 ||
    weight > 1 ||
    Math.abs(weight * 1e6 - Math.round(weight * 1e6)) > 0.00001
  )
    throw new Error("比例必须为 0–100%，最多四位百分比小数");
  return scale(amount, BigInt(Math.round(weight * 1e6)), 1000000n);
}
