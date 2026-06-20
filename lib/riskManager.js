// lib/riskManager.js
// طبقة حماية ثابتة (شبكة أمان) تُطبَّق دائماً فوق قرار الذكاء الصناعي/الاستراتيجية
// لكل مستخدم، بغض النظر عن مدى "ثقة" المحرك بالقرار — لحماية رأس ماله من
// الأخطاء الكارثية. الحدود الافتراضية قابلة للتعديل عبر متغيرات البيئة
// (تنطبق على كل المستخدمين بنفس القيم في هذا الإصدار).

import db from "./db.js";

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

function getState(userId) {
  let row = db.prepare("SELECT * FROM risk_state WHERE user_id = ?").get(userId);
  if (!row || row.day !== todayKey()) {
    db.prepare(
      `INSERT INTO risk_state (user_id, day, start_equity, breaker) VALUES (?, ?, NULL, 0)
       ON CONFLICT(user_id) DO UPDATE SET day = excluded.day, start_equity = NULL, breaker = 0`
    ).run(userId, todayKey());
    row = db.prepare("SELECT * FROM risk_state WHERE user_id = ?").get(userId);
  }
  return row;
}

function saveState(userId, state) {
  db.prepare(
    "UPDATE risk_state SET day = ?, start_equity = ?, breaker = ? WHERE user_id = ?"
  ).run(state.day, state.start_equity, state.breaker ? 1 : 0, userId);
}

// يجب استدعاؤها أول كل دورة بقيمة رأس المال الحالي (equity)
export function checkDailyBreaker(userId, currentEquity) {
  const state = getState(userId);
  if (state.start_equity == null) state.start_equity = currentEquity;

  const lossPct = ((state.start_equity - currentEquity) / state.start_equity) * 100;
  const cfg = getRiskConfig();
  if (lossPct >= cfg.maxDailyLossPct) state.breaker = 1;

  saveState(userId, state);
  return {
    tripped: Boolean(state.breaker),
    dailyPnlPct: Math.round(-lossPct * 100) / 100,
    startEquity: state.start_equity
  };
}

export function resetBreaker(userId) {
  const state = getState(userId);
  state.breaker = 0;
  state.start_equity = null;
  saveState(userId, state);
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
