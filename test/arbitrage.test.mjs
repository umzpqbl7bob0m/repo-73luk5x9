import test from "node:test";
import assert from "node:assert/strict";
import { calculateTrade, findOpportunities } from "../src/arbitrage.mjs";

test("calculateTrade includes trading, transfer and slippage costs", () => {
  const result = calculateTrade({
    capitalUsd: 1000,
    buyPrice: 100,
    sellPrice: 105,
    buyTakerPercent: 0.1,
    sellTakerPercent: 0.1,
    slippagePercent: 0.1,
    withdrawalAsset: 0.01,
    networkCostUsd: 1
  });
  assert.ok(result.profitUsd > 40 && result.profitUsd < 50);
  assert.ok(result.costs.buyFeeUsd > 0);
  assert.ok(result.costs.sellFeeUsd > 0);
  assert.equal(
    result.costs.totalUsd,
    result.costs.buyFeeUsd
      + result.costs.sellFeeUsd
      + result.costs.slippageUsd
      + result.costs.withdrawalUsd
      + result.costs.networkCostUsd
  );
});

test("findOpportunities sorts profitable routes first", () => {
  const quotes = [
    { source: "binance", venueType: "cex", base: "ABC", bid: 9.9, ask: 10, liquidityUsd: 1_000_000, network: "multi", isDemo: false },
    { source: "okx", venueType: "cex", base: "ABC", bid: 11, ask: 11.1, liquidityUsd: 1_000_000, network: "multi", isDemo: false }
  ];
  const fee = { takerPercent: 0.1, transferMinutes: 10, withdrawal: { default: 0 } };
  const result = findOpportunities(quotes, { binance: fee, okx: fee, dex: fee }, {
    capitalUsd: 1000,
    minProfitUsd: 1,
    minProfitPercent: 0.1,
    maxSpreadPercent: 15,
    slippagePercent: 0,
    minLiquidityUsd: 50_000,
    networkCostsUsd: { multi: 1, default: 1 }
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].buy.source, "binance");
  assert.equal(result[0].sell.source, "okx");
  assert.equal(result[0].profitable, true);
});

test("findOpportunities rejects illiquid and implausibly wide routes", () => {
  const fee = { takerPercent: 0.1, transferMinutes: 10, withdrawal: { default: 0 } };
  const config = {
    capitalUsd: 1000,
    minProfitUsd: 1,
    minProfitPercent: 0.1,
    maxSpreadPercent: 15,
    slippagePercent: 0,
    minLiquidityUsd: 50_000,
    networkCostsUsd: { multi: 1, default: 1 }
  };
  const quotes = [
    { source: "binance", venueType: "cex", base: "FAKE", bid: 1, ask: 1, liquidityUsd: 1_000_000, network: "multi", isDemo: false },
    { source: "okx", venueType: "cex", base: "FAKE", bid: 100, ask: 101, liquidityUsd: 1_000_000, network: "multi", isDemo: false },
    { source: "gate", venueType: "cex", base: "THIN", bid: 1, ask: 1, liquidityUsd: 100, network: "multi", isDemo: false },
    { source: "kucoin", venueType: "cex", base: "THIN", bid: 1.1, ask: 1.2, liquidityUsd: 1_000_000, network: "multi", isDemo: false }
  ];
  assert.deepEqual(findOpportunities(quotes, {
    binance: fee, okx: fee, gate: fee, kucoin: fee, dex: fee
  }, config), []);
});
