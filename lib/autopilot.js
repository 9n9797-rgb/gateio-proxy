// lib/autopilot.js
// المنسّق الرئيسي للتداول الآلي: يفحص الأزواج المحددة بشكل دوري، يستشير
// محرك الاستراتيجية (وطبقة الذكاء الصناعي الاختيارية)، يطبّق إدارة المخاطر،
// ثم ينفّذ القرار حسب الوضع الحالي: off | signal | paper | live.

import { readJSON, writeJSON, appendJSONArray } from "./store.js";
import { decide, learnFromTrade } from "./strategy.js";
import { refineDecision } from "./ai.js";
import * as risk from "./riskManager.js";
import * as paper from "./portfolio.js";

const STATE_KEY = "autopilot-state";
const VALID_MODES = ["off", "signal", "paper", "live"];

let spotApiRef = null;
let timer = null;

export function init(spotApi) {
  spotApiRef = spotApi;
}

function defaultState() {
  return {
    mode: "off",
    pairs: (process.env.AUTOPILOT_PAIRS || "BTC_USDT,ETH_USDT").split(",").map(s => s.trim()),
    livePositions: {}, // pair -> { qty, entryPrice, stopLossPrice, takeProfitPrice, votes, orderId }
    lastRunAt: null,
    lastError: null,
    cyclesRun: 0
  };
}

export function getState() {
  return { ...defaultState(), ...readJSON(STATE_KEY, {}) };
}

function saveState(state) {
  writeJSON(STATE_KEY, state);
}

export function setMode(mode) {
  if (!VALID_MODES.includes(mode)) throw new Error(`وضع غير صالح: ${mode}`);
  if (mode === "live" && process.env.AUTOPILOT_ALLOW_LIVE !== "true") {
    throw new Error("التداول الحقيقي معطّل. فعّله بضبط AUTOPILOT_ALLOW_LIVE=true في متغيرات البيئة أولاً.");
  }
  const state = getState();
  state.mode = mode;
  saveState(state);
  if (mode === "off") stopLoop();
  else startLoop();
  return state;
}

export function setPairs(pairs) {
  const state = getState();
  state.pairs = pairs;
  saveState(state);
  return state;
}

async function fetchCandles(pair, interval = "15m", limit = 100) {
  const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Gate.io ${r.status}`);
  return r.json();
}

async function runLiveOrder(pair, side, qty) {
  if (!spotApiRef) throw new Error("Gate API client غير مُهيأ");
  const order = { currency_pair: pair, type: "market", side, amount: String(qty) };
  const result = await spotApiRef.createOrder(order);
  return result.body;
}

async function processPair(pair, state) {
  const raw = await fetchCandles(pair);
  if (!Array.isArray(raw) || raw.length < 30) return;

  const quantDecision = decide(raw);
  const decision = await refineDecision(pair, quantDecision);

  const isPaperMode = state.mode === "paper";
  const isLiveMode = state.mode === "live";
  const positions = isLiveMode ? state.livePositions : paper.getPortfolio().positions;
  const hasOpenPosition = Boolean(positions[pair]);

  // فحص وقف الخسارة/جني الربح للمراكز المفتوحة أولاً
  if (hasOpenPosition) {
    const pos = positions[pair];
    const price = decision.price;
    const hitStop = price <= pos.stopLossPrice;
    const hitTarget = price >= pos.takeProfitPrice;
    const exitSignal = decision.action === "SELL";

    if (hitStop || hitTarget || exitSignal) {
      const reason = hitStop ? "stop_loss" : hitTarget ? "take_profit" : "signal";
      if (isPaperMode) {
        const res = paper.closePosition(pair, price, reason);
        if (res.ok) learnFromTrade({ votes: res.trade.votes, pnlPct: res.trade.pnlPct });
      } else if (isLiveMode) {
        await runLiveOrder(pair, "sell", pos.qty);
        const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
        delete state.livePositions[pair];
        const trade = {
          pair, qty: pos.qty, entryPrice: pos.entryPrice, exitPrice: price,
          pnlPct: Math.round(pnlPct * 100) / 100, reason, votes: pos.votes,
          openedAt: pos.openedAt, closedAt: new Date().toISOString(), mode: "live"
        };
        appendJSONArray("trade-journal", trade);
        learnFromTrade({ votes: pos.votes, pnlPct });
      }
    }
    return; // لا نفتح مركزاً جديداً على زوج له مركز مفتوح بالفعل
  }

  // فتح مركز جديد عند إشارة شراء، مع تطبيق إدارة المخاطر
  if (decision.action === "BUY") {
    const openCount = Object.keys(positions).length;
    if (!risk.canOpenNewPosition(openCount)) return;

    const equityValue = isPaperMode
      ? paper.equity(paper.getPortfolio(), { [pair]: decision.price })
      : Number(process.env.LIVE_EQUITY_ESTIMATE_USDT || 1000);

    const breaker = risk.checkDailyBreaker(equityValue);
    if (breaker.tripped) return;

    const { qty, stopLossPrice, takeProfitPrice } = risk.sizePosition({
      equity: equityValue, price: decision.price, atr: decision.atr
    });
    if (qty <= 0) return;

    if (isPaperMode) {
      paper.openPosition(pair, { qty, price: decision.price, stopLossPrice, takeProfitPrice, votes: decision.votes });
    } else if (isLiveMode) {
      await runLiveOrder(pair, "buy", qty);
      state.livePositions[pair] = {
        qty, entryPrice: decision.price, stopLossPrice, takeProfitPrice,
        votes: decision.votes, openedAt: new Date().toISOString()
      };
    }
  }

  if (state.mode === "signal") {
    appendJSONArray("signal-log", { pair, ...decision, at: new Date().toISOString() }, 1000);
  }
}

async function runCycle() {
  const state = getState();
  if (state.mode === "off") return;

  for (const pair of state.pairs) {
    try {
      await processPair(pair, state);
    } catch (e) {
      state.lastError = `${pair}: ${e.message}`;
    }
  }
  state.lastRunAt = new Date().toISOString();
  state.cyclesRun = (state.cyclesRun || 0) + 1;
  saveState(state);
}

export function startLoop() {
  if (timer) return;
  const intervalMs = Number(process.env.AUTOPILOT_INTERVAL_MS || 60000);
  timer = setInterval(() => { runCycle().catch(() => {}); }, intervalMs);
  runCycle().catch(() => {});
}

export function stopLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function bootstrapFromSavedState() {
  const state = getState();
  if (state.mode !== "off") startLoop();
}
