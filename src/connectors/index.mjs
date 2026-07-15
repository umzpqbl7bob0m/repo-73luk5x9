const STABLE_QUOTES = ["USDT", "USDC", "FDUSD", "USD"];

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function splitCompactSymbol(symbol) {
  const quote = STABLE_QUOTES.find((candidate) => symbol.endsWith(candidate));
  if (!quote) return null;
  return { base: symbol.slice(0, -quote.length), quote };
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "AtlasArbitrage/1.0" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function quote(source, base, quoteAsset, bid, ask, volumeUsd = 0) {
  return {
    source,
    venueType: "cex",
    symbol: `${base}/${quoteAsset}`,
    base: base === "WETH" ? "ETH" : base,
    quote: quoteAsset,
    bid: number(bid),
    ask: number(ask),
    volumeUsd: number(volumeUsd),
    liquidityUsd: number(volumeUsd),
    network: "multi",
    isDemo: false
  };
}

async function binance(timeoutMs) {
  const rows = await fetchJson("https://api.binance.com/api/v3/ticker/24hr", timeoutMs);
  return rows.flatMap((row) => {
    const pair = splitCompactSymbol(row.symbol);
    if (!pair || !number(row.bidPrice) || !number(row.askPrice)) return [];
    return [quote("binance", pair.base, pair.quote, row.bidPrice, row.askPrice, row.quoteVolume)];
  });
}

async function okx(timeoutMs) {
  const payload = await fetchJson("https://www.okx.com/api/v5/market/tickers?instType=SPOT", timeoutMs);
  return payload.data.flatMap((row) => {
    const [base, quoteAsset] = row.instId.split("-");
    if (!STABLE_QUOTES.includes(quoteAsset) || !number(row.bidPx) || !number(row.askPx)) return [];
    return [quote("okx", base, quoteAsset, row.bidPx, row.askPx, number(row.volCcy24h) * number(row.last))];
  });
}

async function bybit(timeoutMs) {
  const payload = await fetchJson("https://api.bybit.com/v5/market/tickers?category=spot", timeoutMs);
  return payload.result.list.flatMap((row) => {
    const pair = splitCompactSymbol(row.symbol);
    if (!pair || !number(row.bid1Price) || !number(row.ask1Price)) return [];
    return [quote("bybit", pair.base, pair.quote, row.bid1Price, row.ask1Price, row.turnover24h)];
  });
}

async function gate(timeoutMs) {
  const rows = await fetchJson("https://api.gateio.ws/api/v4/spot/tickers", timeoutMs);
  return rows.flatMap((row) => {
    const [base, quoteAsset] = row.currency_pair.split("_");
    if (!STABLE_QUOTES.includes(quoteAsset) || !number(row.highest_bid) || !number(row.lowest_ask)) return [];
    return [quote("gate", base, quoteAsset, row.highest_bid, row.lowest_ask, row.quote_volume)];
  });
}

async function kucoin(timeoutMs) {
  const payload = await fetchJson("https://api.kucoin.com/api/v1/market/allTickers", timeoutMs);
  return payload.data.ticker.flatMap((row) => {
    const [base, quoteAsset] = row.symbol.split("-");
    if (!STABLE_QUOTES.includes(quoteAsset) || !number(row.buy) || !number(row.sell)) return [];
    return [quote("kucoin", base, quoteAsset, row.buy, row.sell, row.volValue)];
  });
}

async function dexScreener(timeoutMs, watchlist, minLiquidityUsd) {
  const settled = await Promise.allSettled(
    watchlist.map(async (token) => {
      const url = `https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(token.chainId)}/${encodeURIComponent(token.tokenAddress)}`;
      const rows = await fetchJson(url, timeoutMs);
      return rows
        .filter((row) => number(row.priceUsd) && number(row.liquidity?.usd) >= minLiquidityUsd)
        .sort((a, b) => number(b.liquidity?.usd) - number(a.liquidity?.usd))
        .slice(0, 4)
        .flatMap((row) => {
          const baseSymbol = row.baseToken?.symbol === "WETH" ? "ETH" : row.baseToken?.symbol;
          const watchedSymbol = token.symbol === "WETH" ? "ETH" : token.symbol;
          if (baseSymbol !== watchedSymbol) return [];
          const mid = number(row.priceUsd);
          return [{
            source: `dex:${row.dexId}`,
            venueType: "dex",
            symbol: `${watchedSymbol}/USD`,
            base: watchedSymbol,
            quote: "USD",
            bid: mid * 0.997,
            ask: mid * 1.003,
            volumeUsd: number(row.volume?.h24),
            liquidityUsd: number(row.liquidity?.usd),
            network: token.chainId,
            pairAddress: row.pairAddress,
            url: row.url,
            isDemo: false
          }];
        });
    })
  );
  return settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}

const CONNECTORS = { binance, okx, bybit, gate, kucoin };

export async function collectQuotes(config) {
  const jobs = config.enabledSources
    .filter((source) => source !== "dexscreener" && CONNECTORS[source])
    .map(async (source) => {
      try {
        const quotes = await CONNECTORS[source](config.requestTimeoutMs);
        return { source, quotes, error: null };
      } catch (error) {
        return { source, quotes: [], error: error.message };
      }
    });

  if (config.enabledSources.includes("dexscreener")) {
    jobs.push(
      dexScreener(
        config.requestTimeoutMs,
        config.dexWatchlist,
        config.minLiquidityUsd
      ).then((quotes) => ({ source: "dexscreener", quotes, error: null }))
        .catch((error) => ({ source: "dexscreener", quotes: [], error: error.message }))
    );
  }

  const results = await Promise.all(jobs);
  let quotes = results.flatMap((result) => result.quotes);
  const liveSources = results.filter((result) => result.quotes.length > 0).length;

  if (liveSources < 2 && config.demoFallback) {
    quotes = quotes.concat(demoQuotes());
  }

  return {
    quotes,
    sources: results.map((result) => ({
      id: result.source,
      status: result.error ? "error" : "online",
      quotes: result.quotes.length,
      error: result.error
    })),
    demoMode: liveSources < 2 && config.demoFallback
  };
}

function demoQuotes() {
  return [
    ["binance", "BTC", 64780, 64800, 1500000000],
    ["okx", "BTC", 65120, 65145, 990000000],
    ["bybit", "ETH", 3488, 3491, 720000000],
    ["gate", "ETH", 3521, 3525, 180000000],
    ["kucoin", "SOL", 156.1, 156.25, 90000000],
    ["binance", "SOL", 157.2, 157.35, 500000000]
  ].map(([source, base, bid, ask, volumeUsd]) => ({
    ...quote(source, base, "USDT", bid, ask, volumeUsd),
    isDemo: true
  }));
}
