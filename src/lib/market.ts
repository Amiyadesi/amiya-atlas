import { z } from "zod";
import {
  ASSETS,
  divideRound,
  fromUnits,
  precision,
  units,
  type Money,
} from "../domain/money";

export interface MarketRates {
  rates: Record<string, string>;
  fetchedAt: string;
  source: string;
}
const responseSchema = z.object({
  data: z.object({
    currency: z.literal("USD"),
    rates: z.record(z.string(), z.string()),
  }),
});
let cached: MarketRates | undefined;
export async function fetchMarketRates(): Promise<MarketRates> {
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < 60_000)
    return cached;
  const response = await fetch(
    "https://api.coinbase.com/v2/exchange-rates?currency=USD",
    { credentials: "omit", signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok) throw new Error("行情暂时不可用，稍后重试");
  const { data } = responseSchema.parse(await response.json());
  const rates: Record<string, string> = {};
  for (const { code } of ASSETS) {
    const rate = data.rates[code];
    if (rate === undefined) continue;
    if (!/^\d{1,20}(?:\.\d{1,24})?$/.test(rate) || decimal(rate).n <= 0n)
      throw new Error("行情数据无效");
    rates[code] = rate;
  }
  cached = { rates, fetchedAt: new Date().toISOString(), source: "Coinbase" };
  return cached;
}
function decimal(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return { n: BigInt(whole + fraction), d: 10n ** BigInt(fraction.length) };
}
function ratePair(asset: string, quote: string, market: MarketRates) {
  if (!market.rates[asset] || !market.rates[quote])
    throw new Error(`暂无 ${asset}/${quote} 行情`);
  const base = decimal(market.rates[asset]),
    target = decimal(market.rates[quote]);
  return { n: target.n * base.d, d: target.d * base.n };
}
export function convertAtMarket(
  value: Money,
  quote: string,
  market: MarketRates,
): Money {
  const rate = ratePair(value.asset, quote, market);
  return fromUnits(
    divideRound(
      units(value) * rate.n * 10n ** BigInt(precision(quote)),
      rate.d * 10n ** BigInt(precision(value.asset)),
    ),
    quote,
  );
}
export function marketPrice(
  asset: string,
  quote: string,
  market: MarketRates,
): string {
  const rate = ratePair(asset, quote, market);
  const text = divideRound(rate.n * 100_000_000n, rate.d)
    .toString()
    .padStart(9, "0");
  return `${text.slice(0, -8)}.${text.slice(-8)}`.replace(/\.?0+$/, "");
}
