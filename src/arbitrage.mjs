function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function feeFor(source, fees) {
  return source.startsWith("dex:") ? fees.dex : fees[source] ?? fees.dex;
}

function withdrawalFor(fee, asset) {
  return fee.withdrawal?.[asset] ?? fee.withdrawal?.default ?? 0;
}

export function calculateTrade({
  capitalUsd,
  buyPrice,
  sellPrice,
  buyTakerPercent,
  sellTakerPercent,
  slippagePercent,
  withdrawalAsset,
  networkCostUsd
}) {
  const buyFeeUsd = capitalUsd * (buyTakerPercent / 100);
  const purchasedAsset = (capitalUsd - buyFeeUsd) / buyPrice;
  const slippageAsset = purchasedAsset * (slippagePercent / 100);
  const transferableAsset = Math.max(0, purchasedAsset - slippageAsset - withdrawalAsset);
  const grossSaleUsd = transferableAsset * sellPrice;
  const sellSlippageUsd = grossSaleUsd * (slippagePercent / 100);
  const sellFeeUsd = (grossSaleUsd - sellSlippageUsd) * (sellTakerPercent / 100);
  const finalUsd = grossSaleUsd - sellSlippageUsd - sellFeeUsd - networkCostUsd;
  const profitUsd = finalUsd - capitalUsd;

  return {
    purchasedAsset,
    transferableAsset,
    grossSaleUsd,
    finalUsd,
    profitUsd,
    profitPercent: (profitUsd / capitalUsd) * 100,
    costs: {
      buyFeeUsd,
      sellFeeUsd,
      slippageUsd: slippageAsset * buyPrice + sellSlippageUsd,
      withdrawalUsd: withdrawalAsset * sellPrice,
      networkCostUsd,
      totalUsd: capitalUsd + grossSaleUsd - finalUsd - capitalUsd
    }
  };
}

function confidence(opportunity) {
  const liquidity = Math.min(opportunity.buy.liquidityUsd, opportunity.sell.liquidityUsd);
  const score = (liquidity >= 10_000_000 ? 2 : liquidity >= 500_000 ? 1 : 0)
    + (opportunity.grossSpreadPercent < 3 ? 1 : 0)
    + (opportunity.buy.isDemo || opportunity.sell.isDemo ? -2 : 1);
  return score >= 3 ? "high" : score >= 1 ? "medium" : "low";
}

function instructions(buy, sell, base, trade, transferMinutes) {
  const network = buy.network === "multi" ? "совместимую сеть вывода и депозита" : buy.network;
  return [
    `Проверьте статус депозита и вывода ${base} на обеих площадках; выберите ${network}.`,
    `Пополните ${buy.source} и купите примерно ${round(trade.purchasedAsset, 8)} ${base} лимитным или рыночным ордером около $${round(buy.ask, 6)}.`,
    `Выведите ${base} с ${buy.source} на адрес депозита ${sell.source}; расчетный интервал — ${transferMinutes} мин.`,
    `После подтверждений продайте ${round(trade.transferableAsset, 8)} ${base} на ${sell.source} около $${round(sell.bid, 6)}.`,
    `Перед исполнением повторите расчет: ожидаемый результат $${round(trade.profitUsd)} (${round(trade.profitPercent)}%).`
  ];
}

export function findOpportunities(quotes, fees, config) {
  const byAsset = new Map();
  for (const quote of quotes) {
    if (!quote.base || !quote.ask || !quote.bid || quote.ask <= 0 || quote.bid <= 0) continue;
    if (!byAsset.has(quote.base)) byAsset.set(quote.base, []);
    byAsset.get(quote.base).push(quote);
  }

  const opportunities = [];
  for (const [base, assetQuotes] of byAsset) {
    for (const buy of assetQuotes) {
      for (const sell of assetQuotes) {
        if (buy.source === sell.source || sell.bid <= buy.ask) continue;
        const buyFee = feeFor(buy.source, fees);
        const sellFee = feeFor(sell.source, fees);
        const withdrawalAsset = buy.venueType === "dex" ? 0 : withdrawalFor(buyFee, base);
        const networkCostUsd = config.networkCostsUsd[buy.network]
          ?? config.networkCostsUsd.default;
        const trade = calculateTrade({
          capitalUsd: config.capitalUsd,
          buyPrice: buy.ask,
          sellPrice: sell.bid,
          buyTakerPercent: buyFee.takerPercent,
          sellTakerPercent: sellFee.takerPercent,
          slippagePercent: config.slippagePercent,
          withdrawalAsset,
          networkCostUsd
        });
        const grossSpreadPercent = ((sell.bid - buy.ask) / buy.ask) * 100;
        if (grossSpreadPercent < 0.02) continue;

        const transferMinutes = Math.max(buyFee.transferMinutes, sellFee.transferMinutes);
        const opportunity = {
          id: `${base}-${buy.source}-${sell.source}`,
          base,
          buy,
          sell,
          grossSpreadPercent: round(grossSpreadPercent, 4),
          capitalUsd: config.capitalUsd,
          profitUsd: round(trade.profitUsd),
          profitPercent: round(trade.profitPercent, 4),
          finalUsd: round(trade.finalUsd),
          costs: Object.fromEntries(
            Object.entries(trade.costs).map(([key, value]) => [key, round(value)])
          ),
          transferMinutes,
          profitable: trade.profitUsd >= config.minProfitUsd
            && trade.profitPercent >= config.minProfitPercent,
          demo: buy.isDemo || sell.isDemo,
          instructions: instructions(buy, sell, base, trade, transferMinutes)
        };
        opportunity.confidence = confidence(opportunity);
        opportunities.push(opportunity);
      }
    }
  }

  return opportunities
    .sort((a, b) => b.profitUsd - a.profitUsd)
    .slice(0, 150);
}
