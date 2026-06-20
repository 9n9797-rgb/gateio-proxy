// lib/riskManager.js
// طبقة حماية ثابتة (شبكة أمان) تطبَّق دائماً فوق قرار الذكاء الصناعي/الاستراتيجية،
// بغض النظر عن مدى "ثقة" المحرك بالقرار — لحماية رأس المال من الأخطاء الكارثية.
// كل الحدود قابلة للتعديل عبر متغيرات البيئة.

import { readJSON, writeJSON } from "./store.js";

const STATE_KEY = "risk-state";

function env(name, def) {
  const v = process.env[name];
  return v == null || v === "" ? def : Number(v);
}

export function getRiskConfig() {
  return {
    riskPerTradePct: env("RISK_PER_TRADE_PCT", 2),
    stopLossPct: env("STOP_LOSS_PCT", 1.5),
    takeProfitPct: env("TAKE_PROFIT_PCT", 3),
    maxOpenPositions: env("MAX_OPEN_POSITIONS", 3),
    maxPositionPct: env("MAX_POSITION_PCT", 10),
    maxDailyLossPct: env("MAX_DAILY_LOSS_PCT", 5)
  };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getState() {
  const state = readJSON(STATE_KEY, { day: todayKey(), startEquity: null, breaker: false });
  if (state.day !== todayKey()) {
    state.day = todayKey();
    state.startEquity = null;
    state.breaker = false;
  }
  return state;
}

function saveState(state) {
  writeJSON(STATE_KEY, state);
}

// يجب استدعاؤها أول كل دورة بقيمة رأس المال الحالي (equity)
export function checkDailyBreaker(currentEquity) {
  const state = getState();
  if (state.startEquity == null) state.startEquity = currentEquity;

  const lossPct = ((state.startEquity - currentEquity) / state.startEquity) * 100;
  const cfg = getRiskConfig();
  if (lossPct >= cfg.maxDailyLossPct) state.breaker = true;

  saveState(state);
  return {
    tripped: state.breaker,
    dailyPnlPct: Math.round(-lossPct * 100) / 100,
    startEquity: state.startEquity
  };
}

export function resetBreaker() {
  const state = getState();
  state.breaker = false;
  state.startEquity = null;
  saveState(state);
}

// يحدد حجم المركز بناءً على وقف الخسارة (ATR) ونسبة المخاطرة المسموحة من رأس المال
export function sizePosition({ equity, price, atr }) {
  const cfg = getRiskConfig();
  const riskAmount = equity * (cfg.riskPerTradePct / 100);
  const stopDistance = atr && atr > 0 ? atr * 1.5 : price * (cfg.stopLossPct / 100);
  let qty = stopDistance > 0 ? riskAmount / stopDistance : 0;

  const maxNotional = equity * (cfg.maxPositionPct / 100);
  const maxQtyByCap = price > 0 ? maxNotional / price : 0;
  qty = Math.min(qty, maxQtyByCap);

  return {
    qty: Math.max(qty, 0),
    stopLossPrice: price - stopDistance,
    takeProfitPrice: price + stopDistance * (cfg.takeProfitPct / cfg.stopLossPct)
  };
}

export function canOpenNewPosition(openPositionsCount) {
  const cfg = getRiskConfig();
  return openPositionsCount < cfg.maxOpenPositions;
}
