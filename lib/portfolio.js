// lib/portfolio.js
// محفظة وهمية (Paper Trading) لكل مستخدم لمحاكاة الشراء/البيع بدون أموال
// حقيقية، تُستخدم لتطوير الذكاء الصناعي عبر صفقات تجريبية قبل ربطه بحساب
// حقيقي أو لمن يريد فقط "توصيات" دون تنفيذ فعلي.

import db from "./db.js";

const FEE_RATE = 0.002; // محاكاة عمولة Taker تقريبية 0.2%

function startBalance() {
  return Number(process.env.PAPER_START_BALANCE || 10000);
}

export function getPortfolio(userId) {
  let row = db.prepare("SELECT * FROM paper_wallets WHERE user_id = ?").get(userId);
  if (!row) {
    db.prepare(
      "INSERT INTO paper_wallets (user_id, cash, created_at) VALUES (?, ?, ?)"
    ).run(userId, startBalance(), new Date().toISOString());
    row = db.prepare("SELECT * FROM paper_wallets WHERE user_id = ?").get(userId);
  }
  return {
    cash: row.cash,
    positions: JSON.parse(row.positions || "{}"),
    realizedPnl: row.realized_pnl,
    createdAt: row.created_at
  };
}

function save(userId, p) {
  db.prepare(
    "UPDATE paper_wallets SET cash = ?, positions = ?, realized_pnl = ? WHERE user_id = ?"
  ).run(p.cash, JSON.stringify(p.positions), p.realizedPnl, userId);
}

export function resetPortfolio(userId) {
  db.prepare(
    `INSERT INTO paper_wallets (user_id, cash, positions, realized_pnl, created_at) VALUES (?, ?, '{}', 0, ?)
     ON CONFLICT(user_id) DO UPDATE SET cash = excluded.cash, positions = '{}', realized_pnl = 0, created_at = excluded.created_at`
  ).run(userId, startBalance(), new Date().toISOString());
  return getPortfolio(userId);
}

export function equity(portfolio, priceLookup) {
  let positionsValue = 0;
  for (const [pair, pos] of Object.entries(portfolio.positions)) {
    const price = priceLookup?.[pair] ?? pos.entryPrice;
    positionsValue += pos.qty * price;
  }
  return portfolio.cash + positionsValue;
}

export function openPosition(userId, pair, { qty, price, stopLossPrice, takeProfitPrice, votes }) {
  const p = getPortfolio(userId);
  const cost = qty * price;
  const fee = cost * FEE_RATE;
  if (cost + fee > p.cash) return { ok: false, reason: "رصيد وهمي غير كافٍ" };

  p.cash -= cost + fee;
  p.positions[pair] = { qty, entryPrice: price, stopLossPrice, takeProfitPrice, votes, openedAt: new Date().toISOString() };
  save(userId, p);
  return { ok: true, position: p.positions[pair] };
}

export function closePosition(userId, pair, price, reason = "signal") {
  const p = getPortfolio(userId);
  const pos = p.positions[pair];
  if (!pos) return { ok: false, reason: "لا يوجد مركز مفتوح" };

  const proceeds = pos.qty * price;
  const fee = proceeds * FEE_RATE;
  p.cash += proceeds - fee;

  const pnl = proceeds - fee - pos.qty * pos.entryPrice;
  const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  p.realizedPnl += pnl;
  delete p.positions[pair];
  save(userId, p);

  const trade = {
    pair, qty: pos.qty, entryPrice: pos.entryPrice, exitPrice: price,
    pnl: Math.round(pnl * 1e6) / 1e6, pnlPct: Math.round(pnlPct * 100) / 100,
    reason, votes: pos.votes, openedAt: pos.openedAt, closedAt: new Date().toISOString(), mode: "paper"
  };

  db.prepare(
    `INSERT INTO trades (user_id, pair, qty, entry_price, exit_price, pnl_pct, reason, mode, votes, opened_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId, trade.pair, trade.qty, trade.entryPrice, trade.exitPrice, trade.pnlPct,
    trade.reason, trade.mode, JSON.stringify(trade.votes), trade.openedAt, trade.closedAt
  );

  return { ok: true, trade };
}
