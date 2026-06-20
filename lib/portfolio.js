// lib/portfolio.js
// محفظة وهمية (Paper Trading) لمحاكاة الشراء/البيع بدون أموال حقيقية،
// تُستخدم لتطوير الذكاء الصناعي عبر صفقات تجريبية قبل ربطه بحساب حقيقي.

import { readJSON, writeJSON, appendJSONArray } from "./store.js";

const PORTFOLIO_KEY = "paper-portfolio";
const FEE_RATE = 0.002; // محاكاة عمولة Taker تقريبية 0.2%

function startBalance() {
  return Number(process.env.PAPER_START_BALANCE || 10000);
}

function defaultPortfolio() {
  return {
    cash: startBalance(),
    positions: {}, // pair -> { qty, entryPrice, stopLossPrice, takeProfitPrice, votes, openedAt }
    realizedPnl: 0,
    createdAt: new Date().toISOString()
  };
}

export function getPortfolio() {
  return readJSON(PORTFOLIO_KEY, defaultPortfolio());
}

function save(p) {
  writeJSON(PORTFOLIO_KEY, p);
}

export function resetPortfolio() {
  const p = defaultPortfolio();
  save(p);
  return p;
}

export function equity(portfolio, priceLookup) {
  let positionsValue = 0;
  for (const [pair, pos] of Object.entries(portfolio.positions)) {
    const price = priceLookup?.[pair] ?? pos.entryPrice;
    positionsValue += pos.qty * price;
  }
  return portfolio.cash + positionsValue;
}

export function openPosition(pair, { qty, price, stopLossPrice, takeProfitPrice, votes }) {
  const p = getPortfolio();
  const cost = qty * price;
  const fee = cost * FEE_RATE;
  if (cost + fee > p.cash) return { ok: false, reason: "رصيد وهمي غير كافٍ" };

  p.cash -= cost + fee;
  p.positions[pair] = { qty, entryPrice: price, stopLossPrice, takeProfitPrice, votes, openedAt: new Date().toISOString() };
  save(p);
  return { ok: true, position: p.positions[pair] };
}

export function closePosition(pair, price, reason = "signal") {
  const p = getPortfolio();
  const pos = p.positions[pair];
  if (!pos) return { ok: false, reason: "لا يوجد مركز مفتوح" };

  const proceeds = pos.qty * price;
  const fee = proceeds * FEE_RATE;
  p.cash += proceeds - fee;

  const pnl = proceeds - fee - pos.qty * pos.entryPrice;
  const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  p.realizedPnl += pnl;
  delete p.positions[pair];
  save(p);

  const trade = {
    pair, qty: pos.qty, entryPrice: pos.entryPrice, exitPrice: price,
    pnl: Math.round(pnl * 1e6) / 1e6, pnlPct: Math.round(pnlPct * 100) / 100,
    reason, votes: pos.votes, openedAt: pos.openedAt, closedAt: new Date().toISOString(), mode: "paper"
  };
  appendJSONArray("trade-journal", trade);
  return { ok: true, trade };
}
