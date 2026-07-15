import { createServer } from "node:http";
import { readFile, writeFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { collectQuotes } from "./src/connectors/index.mjs";
import { calculateTrade, findOpportunities } from "./src/arbitrage.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const CONFIG_PATH = join(ROOT, "data", "config.json");
const FEES_PATH = join(ROOT, "data", "fees.json");
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

let scanCache = null;
let scanPromise = null;

async function jsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

async function body(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 100_000) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function validateConfig(input, current) {
  const next = structuredClone(current);
  const numeric = {
    capitalUsd: [10, 10_000_000],
    minProfitUsd: [-10_000, 1_000_000],
    minProfitPercent: [-100, 10_000],
    slippagePercent: [0, 20],
    minLiquidityUsd: [0, 1_000_000_000],
    scanIntervalSeconds: [5, 3600],
    requestTimeoutMs: [1000, 30000]
  };
  for (const [key, [minimum, maximum]] of Object.entries(numeric)) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`Invalid ${key}`);
    }
    next[key] = value;
  }
  if (Array.isArray(input.enabledSources)) {
    const allowed = new Set(["binance", "okx", "bybit", "gate", "kucoin", "dexscreener"]);
    next.enabledSources = input.enabledSources.filter((source) => allowed.has(source));
  }
  if (Array.isArray(input.dexWatchlist)) {
    next.dexWatchlist = input.dexWatchlist.slice(0, 30).map((token) => {
      const chainId = String(token.chainId ?? "").trim();
      const tokenAddress = String(token.tokenAddress ?? "").trim();
      const symbol = String(token.symbol ?? "").trim().toUpperCase();
      if (!chainId || !tokenAddress || !symbol || symbol.length > 20) {
        throw new Error("Invalid DEX watchlist item");
      }
      return { chainId, tokenAddress, symbol };
    });
  }
  if (typeof input.demoFallback === "boolean") next.demoFallback = input.demoFallback;
  return next;
}

async function scan(force = false) {
  const config = await jsonFile(CONFIG_PATH);
  const maxAge = config.scanIntervalSeconds * 1000;
  if (!force && scanCache && Date.now() - scanCache.createdAt < maxAge) return scanCache.payload;
  if (scanPromise) return scanPromise;
  scanPromise = (async () => {
    const fees = await jsonFile(FEES_PATH);
    const startedAt = Date.now();
    const collected = await collectQuotes(config);
    const opportunities = findOpportunities(collected.quotes, fees, config);
    const payload = {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      quoteCount: collected.quotes.length,
      assetCount: new Set(collected.quotes.map((quote) => quote.base)).size,
      profitableCount: opportunities.filter((item) => item.profitable).length,
      demoMode: collected.demoMode,
      sources: collected.sources,
      opportunities
    };
    scanCache = { createdAt: Date.now(), payload };
    return payload;
  })().finally(() => {
    scanPromise = null;
  });
  return scanPromise;
}

async function api(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json(response, 200, { status: "ok", service: "atlas-arbitrage", time: new Date().toISOString() });
  }
  if (request.method === "GET" && url.pathname === "/api/config") {
    return json(response, 200, await jsonFile(CONFIG_PATH));
  }
  if (request.method === "PUT" && url.pathname === "/api/config") {
    const current = await jsonFile(CONFIG_PATH);
    const next = validateConfig(await body(request), current);
    await writeFile(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    scanCache = null;
    return json(response, 200, next);
  }
  if (request.method === "GET" && url.pathname === "/api/fees") {
    return json(response, 200, await jsonFile(FEES_PATH));
  }
  if (request.method === "GET" && url.pathname === "/api/scan") {
    return json(response, 200, await scan(url.searchParams.get("force") === "1"));
  }
  if (request.method === "POST" && url.pathname === "/api/calculate") {
    const input = await body(request);
    const required = [
      "capitalUsd", "buyPrice", "sellPrice", "buyTakerPercent", "sellTakerPercent",
      "slippagePercent", "withdrawalAsset", "networkCostUsd"
    ];
    const values = Object.fromEntries(required.map((key) => [key, Number(input[key])]));
    if (Object.values(values).some((value) => !Number.isFinite(value) || value < 0)
      || values.capitalUsd === 0 || values.buyPrice === 0 || values.sellPrice === 0) {
      throw new Error("Calculator values must be non-negative numbers");
    }
    return json(response, 200, calculateTrade(values));
  }
  return false;
}

async function staticFile(request, response, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const path = normalize(join(PUBLIC_DIR, requested));
  if (!path.startsWith(PUBLIC_DIR)) return false;
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    const content = await readFile(path);
    response.writeHead(200, {
      "content-type": MIME[extname(path)] ?? "application/octet-stream",
      "cache-control": extname(path) === ".html" ? "no-cache" : "public, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    });
    if (request.method === "HEAD") response.end();
    else response.end(content);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await api(request, response, url);
      if (handled !== false) return;
      return json(response, 404, { error: "API route not found" });
    }
    if (await staticFile(request, response, url)) return;
    const fallback = await readFile(join(PUBLIC_DIR, "index.html"));
    response.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-cache" });
    response.end(fallback);
  } catch (error) {
    json(response, error.message.includes("Invalid") ? 400 : 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Atlas Arbitrage listening on http://${HOST}:${PORT}`);
});
