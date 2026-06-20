// lib/autopilot.js
// المنسّق الرئيسي متعدد المستخدمين: يفحص كل مستخدم فعّل التداول (paper/live)
// بشكل دوري، يستشير محرك الاستراتيجية (وطبقة الذكاء الصناعي الاختيارية)،
// يطبّق إدارة المخاطر، ثم بحسب اختيار المستخدم (decision_mode):
//   - recommend_only: يسجّل توصية فقط، والمستخدم يقرر التنفيذ يدوياً
//   - auto: ينفّذ القرار تلقائياً (محفظة وهمية paper، أو حساب حقيقي live)

import db from "./db.js";
import { decide, learnFromTrade } from "./strategy.js";
import { refineDecision } from "./ai.js";
import { computeAllIndicators } from "./indicators.js";
import * as risk from "./riskManager.js";
import * as paper from "./portfolio.js";
import { getSpotApiFor } from "./exchangeKeys.js";

let timer = null;
const candleCache = new Map(); // pair -> { raw, ts } لتقليل عدد الطلبات لكل دورة

async function fetchCandles(pair, interval = "15m", limit = 100) {
  const cacheKey = `${pair}:${interval}`;
  const cached = candleCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 20000) return cached.raw;

  const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Gate.io ${r.status}`);
  const raw = await r.json();
  candleCache.set(cacheKey, { raw, ts: Date.now() });
  return raw;
}

function getLivePositions(userId) {
  const rows = db.prepare("SELECT * FROM live_positions WHERE user_id = ?").all(userId);
  const map = {};
  for (const r of rows) {
    map[r.pair] = {
      qty: r.qty, entryPrice: r.entry_price, stopLossPrice: r.stop_loss_price,
      takeProfitPrice: r.take_profit_price, votes: r.votes ? JSON.parse(r.votes) : {},
      openedAt: r.opened_at
    };
  }
  return map;
}

function saveLivePosition(userId, pair, pos) {
  db.prepare(
    `INSERT INTO live_positions (user_id, pair, qty, entry_price, stop_loss_price, take_profit_price, votes, opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, pair) DO UPDATE SET qty=excluded.qty, entry_price=excluded.entry_price,
       stop_loss_price=excluded.stop_loss_price, take_profit_price=excluded.take_profit_price,
       votes=excluded.votes, opened_at=excluded.opened_at`
  ).run(userId, pair, pos.qty, pos.entryPrice, pos.stopLossPrice, pos.takeProfitPrice, JSON.stringify(pos.votes || {}), pos.openedAt);
}

function deleteLivePosition(userId, pair) {
  db.prepare("DELETE FROM live_positions WHERE user_id = ? AND pair = ?").run(userId, pair);
}

function recordTrade(userId, trade) {
  db.prepare(
    `INSERT INTO trades (user_id, pair, qty, entry_price, exit_price, pnl_pct, reason, mode, votes, opened_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId, trade.pair, trade.qty, trade.entryPrice, trade.exitPrice, trade.pnlPct,
    trade.reason, trade.mode, JSON.stringify(trade.votes || {}), trade.openedAt, trade.closedAt
  );
}

function insertRecommendation(userId, pair, decision) {
  db.prepare(
    `INSERT INTO recommendations (user_id, pair, action, score, price, atr, votes, engine, ai_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId, pair, decision.action, decision.score, decision.price, decision.atr || null,
    JSON.stringify(decision.votes || {}), decision.engine || "quant", decision.ai_reason || null,
    new Date().toISOString()
  );
}

async function runLiveOrder(userId, pair, side, qty) {
  const spotApi = getSpotApiFor(userId);
  if (!spotApi) throw new Error("لا توجد مفاتيح Gate.io مرتبطة بهذا الحساب");
  const order = { currency_pair: pair, type: "market", side, amount: String(qty) };
  const result = await spotApi.createOrder(order);
  return result.body;
}

async function processUserPair(user, settings, pair) {
  const raw = await fetchCandles(pair);
  if (!Array.isArray(raw) || raw.length < 30) return;

  const quantDecision = decide(user.id, raw);
  const decision = await refineDecision(user.id, pair, quantDecision);

  const isPaper = settings.execution === "paper";
  const isLive = settings.execution === "live";
  const isAuto = settings.decision_mode === "auto";

  const positions = isPaper ? paper.getPortfolio(user.id).positions : getLivePositions(user.id);
  const hasOpenPosition = Boolean(positions[pair]);

  if (hasOpenPosition) {
    const pos = positions[pair];
    const price = decision.price;
    const hitStop = price <= pos.stopLossPrice;
    const hitTarget = price >= pos.takeProfitPrice;
    const exitSignal = decision.action === "SELL";

    if (hitStop || hitTarget || exitSignal) {
      const reason = hitStop ? "stop_loss" : hitTarget ? "take_profit" : "signal";

      if (!isAuto) {
        // وقف الخسارة/جني الربح يُنفَّذان دائماً تلقائياً لحماية رأس المال،
        // حتى في وضع "توصيات فقط" — التوصيات اليدوية فقط لفتح/إغلاق بقرار السوق العادي
        if (!(hitStop || hitTarget)) {
          insertRecommendation(user.id, pair, decision);
          return;
        }
      }

      if (isPaper) {
        const res = paper.closePosition(user.id, pair, price, reason);
        if (res.ok) learnFromTrade(user.id, { votes: res.trade.votes, pnlPct: res.trade.pnlPct });
      } else if (isLive) {
        await runLiveOrder(user.id, pair, "sell", pos.qty);
        const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
        deleteLivePosition(user.id, pair);
        const trade = {
          pair, qty: pos.qty, entryPrice: pos.entryPrice, exitPrice: price,
          pnlPct: Math.round(pnlPct * 100) / 100, reason, votes: pos.votes,
          openedAt: pos.openedAt, closedAt: new Date().toISOString(), mode: "live"
        };
        recordTrade(user.id, trade);
        learnFromTrade(user.id, { votes: pos.votes, pnlPct });
      }
    }
    return;
  }

  if (decision.action === "BUY") {
    if (!isAuto) {
      insertRecommendation(user.id, pair, decision);
      return;
    }

    const openCount = Object.keys(positions).length;
    if (!risk.canOpenNewPosition(openCount)) return;

    const equityValue = isPaper
      ? paper.equity(paper.getPortfolio(user.id), { [pair]: decision.price })
      : Number(process.env.LIVE_EQUITY_ESTIMATE_USDT || 1000);

    const breaker = risk.checkDailyBreaker(user.id, equityValue);
    if (breaker.tripped) return;

    const { qty, stopLossPrice, takeProfitPrice } = risk.sizePosition({
      equity: equityValue, price: decision.price, atr: decision.atr
    });
    if (qty <= 0) return;

    if (isPaper) {
      paper.openPosition(user.id, pair, { qty, price: decision.price, stopLossPrice, takeProfitPrice, votes: decision.votes });
    } else if (isLive) {
      await runLiveOrder(user.id, pair, "buy", qty);
      saveLivePosition(user.id, pair, {
        qty, entryPrice: decision.price, stopLossPrice, takeProfitPrice,
        votes: decision.votes, openedAt: new Date().toISOString()
      });
    }
  }
}

async function runCycle() {
  candleCache.clear();
  const activeUsers = db
    .prepare("SELECT u.id, u.email, s.* FROM user_settings s JOIN users u ON u.id = s.user_id WHERE s.execution != 'off'")
    .all();

  for (const row of activeUsers) {
    const user = { id: row.id, email: row.email };
    const settings = { execution: row.execution, decision_mode: row.decision_mode };
    const pairs = (row.pairs || "").split(",").map(s => s.trim()).filter(Boolean);

    for (const pair of pairs) {
      try {
        await processUserPair(user, settings, pair);
      } catch (e) {
        console.error(`autopilot error user=${user.id} pair=${pair}:`, e.message);
      }
    }
  }
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

export function runCycleOnce() {
  return runCycle();
}

// تنفيذ توصية معلّقة يدوياً بطلب من المستخدم (لمن اختار "توصيات فقط")
export async function executeRecommendation(userId, recommendationId) {
  const rec = db
    .prepare("SELECT * FROM recommendations WHERE id = ? AND user_id = ?")
    .get(recommendationId, userId);
  if (!rec) throw new Error("التوصية غير موجودة");
  if (rec.status !== "pending") throw new Error("هذه التوصية تم تنفيذها أو إلغاؤها مسبقاً");

  const settings = db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(userId);
  const isPaper = settings.execution === "paper";
  const isLive = settings.execution === "live";
  if (!isPaper && !isLive) throw new Error("فعّل وضع paper أو live أولاً لتنفيذ التوصيات");

  const votes = rec.votes ? JSON.parse(rec.votes) : {};
  const positions = isPaper ? paper.getPortfolio(userId).positions : getLivePositions(userId);

  if (rec.action === "BUY") {
    if (positions[rec.pair]) throw new Error("يوجد مركز مفتوح بالفعل على هذا الزوج");

    const equityValue = isPaper
      ? paper.equity(paper.getPortfolio(userId), { [rec.pair]: rec.price })
      : Number(process.env.LIVE_EQUITY_ESTIMATE_USDT || 1000);
    const { qty, stopLossPrice, takeProfitPrice } = risk.sizePosition({
      equity: equityValue, price: rec.price, atr: rec.atr
    });
    if (qty <= 0) throw new Error("تعذّر حساب حجم الصفقة");

    if (isPaper) {
      const res = paper.openPosition(userId, rec.pair, { qty, price: rec.price, stopLossPrice, takeProfitPrice, votes });
      if (!res.ok) throw new Error(res.reason);
    } else {
      await runLiveOrder(userId, rec.pair, "buy", qty);
      saveLivePosition(userId, rec.pair, { qty, entryPrice: rec.price, stopLossPrice, takeProfitPrice, votes, openedAt: new Date().toISOString() });
    }
  } else if (rec.action === "SELL") {
    const pos = positions[rec.pair];
    if (!pos) throw new Error("لا يوجد مركز مفتوح على هذا الزوج لإغلاقه");

    if (isPaper) {
      const res = paper.closePosition(userId, rec.pair, rec.price, "recommendation");
      if (res.ok) learnFromTrade(userId, { votes: res.trade.votes, pnlPct: res.trade.pnlPct });
    } else {
      await runLiveOrder(userId, rec.pair, "sell", pos.qty);
      const pnlPct = ((rec.price - pos.entryPrice) / pos.entryPrice) * 100;
      deleteLivePosition(userId, rec.pair);
      recordTrade(userId, {
        pair: rec.pair, qty: pos.qty, entryPrice: pos.entryPrice, exitPrice: rec.price,
        pnlPct: Math.round(pnlPct * 100) / 100, reason: "recommendation", votes: pos.votes,
        openedAt: pos.openedAt, closedAt: new Date().toISOString(), mode: "live"
      });
      learnFromTrade(userId, { votes: pos.votes, pnlPct });
    }
  }

  db.prepare("UPDATE recommendations SET status = 'executed' WHERE id = ?").run(recommendationId);
  return { ok: true };
}

// تحليل كامل لزوج معيّن بأوزان وتعلّم هذا المستخدم تحديداً (تُستخدم في صفحة التحليل)
export async function analyzePair(userId, pair, interval = "15m") {
  const raw = await fetchCandles(pair, interval, 150);
  if (!Array.isArray(raw) || raw.length < 30) throw new Error("بيانات غير كافية لهذا الزوج");

  const quantDecision = decide(userId, raw);
  const decision = await refineDecision(userId, pair, quantDecision);

  const ind = computeAllIndicators(raw);
  const last = ind.closes.length - 1;

  return {
    pair,
    interval,
    ...decision,
    high: Math.max(...ind.highs),
    low: Math.min(...ind.lows),
    change_pct: ind.closes.length >= 2
      ? Math.round(((ind.closes[last] - ind.closes[last - 1]) / ind.closes[last - 1]) * 10000) / 100
      : 0,
    candles: raw.map((_, i) => ({
      time: ind.times[i],
      open: ind.opens[i],
      high: ind.highs[i],
      low: ind.lows[i],
      close: ind.closes[i],
      volume: ind.volumes[i],
      rsi: ind.rsi[i] ?? null,
      ma20: ind.ma20[i] ?? null,
      ma50: ind.ma50[i] ?? null
    }))
  };
}

// ينشئ توصية من تحليل فوري وينفّذها مباشرة بطلب المستخدم من صفحة التحليل
export async function analyzeAndExecute(userId, pair, interval = "15m") {
  const decision = await analyzePair(userId, pair, interval);
  if (decision.action === "HOLD") throw new Error("القرار الحالي محايد (HOLD) — لا يوجد ما يُنفّذ");

  insertRecommendation(userId, pair, decision);
  const rec = db
    .prepare("SELECT * FROM recommendations WHERE user_id = ? AND pair = ? ORDER BY id DESC LIMIT 1")
    .get(userId, pair);
  return executeRecommendation(userId, rec.id);
}

export function dismissRecommendation(userId, recommendationId) {
  const res = db
    .prepare("UPDATE recommendations SET status = 'dismissed' WHERE id = ? AND user_id = ? AND status = 'pending'")
    .run(recommendationId, userId);
  if (res.changes === 0) throw new Error("التوصية غير موجودة أو تم التعامل معها مسبقاً");
  return { ok: true };
}
