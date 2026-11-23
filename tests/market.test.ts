import { expect, it, vi } from "vitest";
import {
  convertAtMarket,
  fetchMarketRates,
  marketPrice,
} from "../src/lib/market";
import { money } from "../src/domain/money";

it("converts live rates without rounding a unit price before valuing the holding", () => {
  const market = {
    rates: { USD: "1", CNY: "7", JPY: "140", BTC: "0.00002", USDT: "1.001" },
    fetchedAt: "2026-10-16T00:00:00Z",
    source: "fixture",
  };
  expect(convertAtMarket(money("100", "JPY"), "USD", market)).toEqual(
    money("0.71", "USD"),
  );
  expect(convertAtMarket(money("0.1", "BTC"), "CNY", market)).toEqual(
    money("35000", "CNY"),
  );
  expect(convertAtMarket(money("100", "USD"), "USDT", market)).toEqual(
    money("100.1", "USDT"),
  );
  expect(marketPrice("JPY", "USD", market)).toBe("0.00714286");
  expect(() => convertAtMarket(money("1", "ETH"), "USD", market)).toThrow(
    "暂无 ETH/USD 行情",
  );
});
it("rejects invalid public rates and fetches prices without account credentials", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        data: { currency: "USD", rates: { USD: "1", BTC: "-2" } },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        data: { currency: "USD", rates: { USD: "1", BTC: "0.00002" } },
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  try {
    await expect(fetchMarketRates()).rejects.toThrow("行情数据无效");
    expect((await fetchMarketRates()).rates.BTC).toBe("0.00002");
    expect(fetcher).toHaveBeenLastCalledWith(
      "https://api.coinbase.com/v2/exchange-rates?currency=USD",
      expect.objectContaining({ credentials: "omit" }),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
