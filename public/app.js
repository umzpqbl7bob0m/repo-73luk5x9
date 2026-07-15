const state = {
  config: null,
  fees: null,
  scan: null,
  opportunities: [],
  dexWatchlist: [],
  timer: null
};

const sourceLabels = {
  binance: "Binance",
  okx: "OKX",
  bybit: "Bybit",
  gate: "Gate.io",
  kucoin: "KuCoin",
  dexscreener: "DexScreener"
};

const viewTitles = {
  dashboard: "Арбитражный обзор",
  signals: "Арбитражные сигналы",
  calculator: "Калькулятор прибыли",
  fees: "Комиссии площадок",
  settings: "Настройки сканера"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function money(value, maximumFractionDigits = 2) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits
  }).format(value ?? 0);
}

function number(value, maximumFractionDigits = 2) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits }).format(value ?? 0);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  window.setTimeout(() => toast.classList.add("hidden"), 2800);
}

async function request(path, options) {
  const response = await fetch(path, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Ошибка запроса");
  return payload;
}

function switchView(name) {
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $("#page-title").textContent = viewTitles[name];
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function statusBadge(confidence) {
  const labels = { high: "Высокая", medium: "Средняя", low: "Низкая" };
  return node("span", `badge ${confidence}`, labels[confidence]);
}

function venueName(source) {
  if (source.startsWith("dex:")) return source.slice(4).toUpperCase();
  return sourceLabels[source] ?? source;
}

function assetCell(item) {
  const wrapper = node("div", "asset-cell");
  wrapper.append(node("span", "asset-logo", item.base.slice(0, 3)));
  const details = node("div");
  details.append(node("strong", "", item.base));
  details.append(node("small", "", `${item.buy.quote} → ${item.sell.quote}`));
  wrapper.append(details);
  return wrapper;
}

function routeCell(item) {
  const wrapper = node("div", "route-cell");
  const line = node("div");
  line.append(node("strong", "", venueName(item.buy.source)));
  line.append(node("span", "route-arrow", "→"));
  line.append(node("strong", "", venueName(item.sell.source)));
  wrapper.append(line);
  wrapper.append(node("small", "", `${money(item.buy.ask, 6)} → ${money(item.sell.bid, 6)}`));
  return wrapper;
}

function detailsButton(item) {
  const button = node("button", "row-button", "План");
  button.type = "button";
  button.addEventListener("click", () => openOpportunity(item));
  return button;
}

function tableRow(item, full = false) {
  const row = document.createElement("tr");
  const asset = document.createElement("td");
  asset.append(assetCell(item));
  row.append(asset);

  if (full) {
    const buy = document.createElement("td");
    buy.append(node("strong", "", venueName(item.buy.source)), node("small", "", money(item.buy.ask, 6)));
    row.append(buy);
    const sell = document.createElement("td");
    sell.append(node("strong", "", venueName(item.sell.source)), node("small", "", money(item.sell.bid, 6)));
    row.append(sell);
    const gross = node("td", "positive", `+${number(item.grossSpreadPercent, 3)}%`);
    row.append(gross);
    row.append(node("td", "", money(item.costs.totalUsd)));
    const profit = node("td", item.profitUsd >= 0 ? "positive" : "negative", `${item.profitUsd >= 0 ? "+" : ""}${money(item.profitUsd)}`);
    row.append(profit);
    const score = document.createElement("td");
    score.append(statusBadge(item.confidence));
    if (item.demo) score.append(node("span", "badge demo", "demo"));
    row.append(score);
  } else {
    const route = document.createElement("td");
    route.append(routeCell(item));
    row.append(route);
    row.append(node("td", "positive", `+${number(item.grossSpreadPercent, 3)}%`));
    row.append(node("td", item.profitUsd >= 0 ? "positive" : "negative", `${item.profitUsd >= 0 ? "+" : ""}${money(item.profitUsd)}`));
    row.append(node("td", "", `≈ ${item.transferMinutes} мин`));
  }

  const action = document.createElement("td");
  action.append(detailsButton(item));
  row.append(action);
  return row;
}

function renderOpportunities() {
  const dashboard = $("#dashboard-opportunities");
  dashboard.replaceChildren();
  const top = state.opportunities.slice(0, 7);
  top.forEach((item) => dashboard.append(tableRow(item)));
  $("#dashboard-empty").classList.toggle("hidden", top.length > 0);

  const query = $("#signal-search").value.trim().toUpperCase();
  const filter = $("#signal-filter").value;
  const filtered = state.opportunities.filter((item) => {
    if (query && !item.base.includes(query)) return false;
    if (filter === "profitable" && !item.profitable) return false;
    if (filter === "high" && item.confidence !== "high") return false;
    return true;
  });
  const all = $("#all-opportunities");
  all.replaceChildren();
  filtered.forEach((item) => all.append(tableRow(item, true)));
  $("#signals-empty").classList.toggle("hidden", filtered.length > 0);
}

function renderSources() {
  const list = $("#source-list");
  list.replaceChildren();
  state.scan.sources.forEach((source) => {
    const item = node("div", "source-item");
    item.append(node("span", "source-logo", source.id.slice(0, 2).toUpperCase()));
    const details = node("div");
    details.append(node("strong", "", sourceLabels[source.id] ?? source.id));
    details.append(node("small", "", source.error ?? `${number(source.quotes, 0)} котировок`));
    item.append(details, node("span", `status-dot ${source.status}`));
    list.append(item);
  });
  const online = state.scan.sources.filter((source) => source.status === "online").length;
  $("#sidebar-status").textContent = online ? "Сканер активен" : "Нет соединений";
  $("#sidebar-sources").textContent = `${online} из ${state.scan.sources.length} источников онлайн`;
}

function renderMetrics() {
  const best = state.opportunities[0];
  $("#metric-signals").textContent = number(state.opportunities.length, 0);
  $("#metric-profitable").textContent = `${number(state.scan.profitableCount, 0)} выше заданного порога`;
  $("#metric-profit").textContent = best ? money(best.profitUsd) : "—";
  $("#metric-profit-percent").textContent = best ? `${number(best.profitPercent, 3)}% после комиссий` : "нет маршрутов";
  $("#metric-assets").textContent = number(state.scan.assetCount, 0);
  $("#metric-quotes").textContent = `${number(state.scan.quoteCount, 0)} котировок`;
  $("#metric-speed").textContent = `${number(state.scan.durationMs, 0)} ms`;
  $("#updated-at").textContent = `Обновлено ${new Date(state.scan.generatedAt).toLocaleTimeString("ru-RU")}`;
  $("#demo-notice").classList.toggle("hidden", !state.scan.demoMode);
}

function openOpportunity(item) {
  $("#dialog-title").textContent = `${item.base}: ${venueName(item.buy.source)} → ${venueName(item.sell.source)}`;
  const summary = $("#dialog-summary");
  summary.replaceChildren();
  [
    ["Капитал", money(item.capitalUsd)],
    ["Gross spread", `+${number(item.grossSpreadPercent, 3)}%`],
    ["Все расходы", money(item.costs.totalUsd)],
    ["Net P&L", money(item.profitUsd)]
  ].forEach(([label, value]) => {
    const card = node("div", "summary-item");
    card.append(node("small", "", label), node("strong", "", value));
    summary.append(card);
  });
  const list = $("#instruction-list");
  list.replaceChildren();
  item.instructions.forEach((instruction) => list.append(node("li", "", instruction)));
  $("#opportunity-dialog").showModal();
}

async function runScan(force = false) {
  const button = $("#refresh-button");
  button.disabled = true;
  button.textContent = "Сканирование…";
  try {
    state.scan = await request(`/api/scan${force ? "?force=1" : ""}`);
    state.opportunities = state.scan.opportunities;
    renderMetrics();
    renderSources();
    renderOpportunities();
  } catch (error) {
    showToast(`Ошибка сканирования: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Обновить";
  }
}

function renderFees() {
  const grid = $("#fee-grid");
  grid.replaceChildren();
  Object.entries(state.fees).forEach(([id, fee]) => {
    const card = node("article", "fee-card");
    const header = node("div", "fee-card-header");
    header.append(node("strong", "", fee.label), node("span", "badge medium", id === "dex" ? "DEX" : "CEX"));
    card.append(header);
    [
      ["Maker", `${fee.makerPercent}%`],
      ["Taker", `${fee.takerPercent}%`],
      ["Перевод", `≈ ${fee.transferMinutes} мин`],
      ["Вывод BTC", `${fee.withdrawal.BTC ?? "—"}`],
      ["Вывод ETH", `${fee.withdrawal.ETH ?? "—"}`]
    ].forEach(([label, value]) => {
      const line = node("div", "fee-line");
      line.append(node("span", "", label), node("b", "", value));
      card.append(line);
    });
    grid.append(card);
  });
}

function renderSettings() {
  const form = $("#settings-form");
  ["capitalUsd", "minProfitUsd", "minProfitPercent", "maxSpreadPercent", "slippagePercent", "minLiquidityUsd", "scanIntervalSeconds"]
    .forEach((name) => {
      form.elements[name].value = state.config[name];
    });
  form.elements.demoFallback.checked = state.config.demoFallback;

  const toggles = $("#exchange-toggles");
  toggles.replaceChildren();
  Object.entries(sourceLabels).forEach(([id, label]) => {
    const wrapper = node("label", "exchange-toggle");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = id;
    input.name = "enabledSources";
    input.checked = state.config.enabledSources.includes(id);
    wrapper.append(input, node("span", "", label));
    toggles.append(wrapper);
  });
  state.dexWatchlist = structuredClone(state.config.dexWatchlist);
  renderWatchlist();
}

function renderWatchlist() {
  const list = $("#dex-watchlist");
  list.replaceChildren();
  state.dexWatchlist.forEach((token, index) => {
    const row = node("div", "token-row");
    row.append(node("strong", "", token.symbol), node("span", "", token.chainId), node("code", "", token.tokenAddress));
    const remove = node("button", "remove-token", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `Удалить ${token.symbol}`);
    remove.addEventListener("click", () => {
      state.dexWatchlist.splice(index, 1);
      renderWatchlist();
    });
    row.append(remove);
    list.append(row);
  });
}

function restartTimer() {
  if (state.timer) window.clearInterval(state.timer);
  state.timer = window.setInterval(() => runScan(false), state.config.scanIntervalSeconds * 1000);
}

async function saveSettings(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = {
    capitalUsd: Number(form.get("capitalUsd")),
    minProfitUsd: Number(form.get("minProfitUsd")),
    minProfitPercent: Number(form.get("minProfitPercent")),
    maxSpreadPercent: Number(form.get("maxSpreadPercent")),
    slippagePercent: Number(form.get("slippagePercent")),
    minLiquidityUsd: Number(form.get("minLiquidityUsd")),
    scanIntervalSeconds: Number(form.get("scanIntervalSeconds")),
    demoFallback: form.get("demoFallback") === "on",
    enabledSources: form.getAll("enabledSources"),
    dexWatchlist: state.dexWatchlist
  };
  try {
    state.config = await request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    $("#save-status").textContent = "Настройки сохранены";
    restartTimer();
    await runScan(true);
  } catch (error) {
    $("#save-status").textContent = error.message;
  }
}

async function calculate(event) {
  event.preventDefault();
  const payload = Object.fromEntries(
    [...new FormData(event.currentTarget).entries()].map(([key, value]) => [key, Number(value)])
  );
  try {
    const result = await request("/api/calculate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const positive = result.profitUsd >= 0;
    $("#calc-profit").textContent = `${positive ? "+" : ""}${money(result.profitUsd)}`;
    $("#calc-profit").className = positive ? "positive" : "negative";
    $("#calc-percent").textContent = `${positive ? "+" : ""}${number(result.profitPercent, 3)}%`;
    $("#calc-percent").className = positive ? "positive" : "negative";
    const breakdown = $("#cost-breakdown");
    breakdown.replaceChildren();
    const rows = [
      ["Комиссия покупки", result.costs.buyFeeUsd],
      ["Комиссия продажи", result.costs.sellFeeUsd],
      ["Slippage", result.costs.slippageUsd],
      ["Комиссия вывода", result.costs.withdrawalUsd],
      ["Газ / сеть", result.costs.networkCostUsd],
      ["Финальная сумма", result.finalUsd]
    ];
    rows.forEach(([label, value]) => {
      const row = node("div", "cost-row");
      row.append(node("span", "", label), node("strong", "", money(value)));
      breakdown.append(row);
    });
  } catch (error) {
    showToast(error.message);
  }
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$("[data-view-jump]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.viewJump)));
  $("#refresh-button").addEventListener("click", () => runScan(true));
  $("#signal-search").addEventListener("input", renderOpportunities);
  $("#signal-filter").addEventListener("change", renderOpportunities);
  $("#close-dialog").addEventListener("click", () => $("#opportunity-dialog").close());
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#calculator-form").addEventListener("submit", calculate);
  $("#add-token").addEventListener("click", () => {
    const symbol = $("#new-token-symbol").value.trim().toUpperCase();
    const chainId = $("#new-token-chain").value.trim();
    const tokenAddress = $("#new-token-address").value.trim();
    if (!symbol || !chainId || !tokenAddress) return showToast("Заполните символ, сеть и адрес контракта");
    state.dexWatchlist.push({ symbol, chainId, tokenAddress });
    ["#new-token-symbol", "#new-token-chain", "#new-token-address"].forEach((selector) => {
      $(selector).value = "";
    });
    renderWatchlist();
  });
}

async function initialize() {
  bindEvents();
  try {
    [state.config, state.fees] = await Promise.all([
      request("/api/config"),
      request("/api/fees")
    ]);
    renderFees();
    renderSettings();
    restartTimer();
    await runScan(false);
    $("#calculator-form").requestSubmit();
  } catch (error) {
    showToast(`Ошибка запуска: ${error.message}`);
  }
}

initialize();
