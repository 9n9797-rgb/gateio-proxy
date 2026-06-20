// lib/strategy.js
// محرك القرار التكيّفي: يجمع "أصوات" المؤشرات الفنية بأوزان قابلة للتعلّم
// لكل مستخدم على حدة، ويُحدّث الأوزان تلقائياً بعد إغلاق كل صفقة بناءً على
// ربحها أو خسارتها (هذا هو "التعلّم من الأخطاء السابقة" — صفقات خاسرة تُنزل
// وزن المؤشرات التي أعطت الإشارة الخاطئة، وصفقات رابحة تزيد وزن المؤشرات
// الصحيحة). كل مستخدم له أوزان مستقلة لأن أسلوبه وأزواجه قد تختلف.

import db from "./db.js";
import { computeAllIndicators } from "./indicators.js";

const DEFAULT_WEIGHTS = {
  rsi: 1,
  macd: 1,
  trend: 1, // سعر فوق/تحت المتوسطات
  obv: 1
};

const MIN_WEIGHT = 0.1;
const MAX_WEIGHT = 3;
const LEARNING_RATE = 0.08;
const MISTAKE_LOOKBACK = 15;
const MISTAKE_DAMPEN = 0.6; // أقصى تخفيض للدرجة عند تشابه كامل مع نمط خسارة سابق

export function getWeights(userId) {
  const row = db.prepare("SELECT weights FROM strategy_weights WHERE user_id = ?").get(userId);
  if (!row) return { ...DEFAULT_WEIGHTS };
  return { ...DEFAULT_WEIGHTS, ...JSON.parse(row.weights) };
}

function saveWeights(userId, weights) {
  db.prepare(
    `INSERT INTO strategy_weights (user_id, weights) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET weights = excluded.weights`
  ).run(userId, JSON.stringify(weights));
}

// يحوّل المؤشرات الخام إلى "أصوات" بين -1 (تشاؤمي) و +1 (تفاؤلي)
function getVotes(ind) {
  const last = ind.closes.length - 1;
  const rsiVal = ind.rsi[last] ?? 50;
  const macdHist = ind.histogram[last];
  const macdPrev = ind.histogram[last - 1];
  const price = ind.closes[last];
  const ma20 = ind.ma20[last];
  const ma50 = ind.ma50[last];

  const votes = {};

  if (rsiVal <= 35) votes.rsi = 1;
  else if (rsiVal >= 70) votes.rsi = -1;
  else if (rsiVal >= 35 && rsiVal <= 55) votes.rsi = 0.5;
  else votes.rsi = 0;

  if (macdHist != null && macdPrev != null) {
    if (macdHist > 0 && macdHist > macdPrev) votes.macd = 1;
    else if (macdHist < 0 && macdHist < macdPrev) votes.macd = -1;
    else votes.macd = 0;
  } else votes.macd = 0;

  if (ma20 != null && ma50 != null) {
    if (price > ma20 && ma20 > ma50) votes.trend = 1;
    else if (price < ma20 && ma20 < ma50) votes.trend = -1;
    else votes.trend = 0;
  } else votes.trend = 0;

  if (ind.obvTrend === "rising") votes.obv = 1;
  else if (ind.obvTrend === "falling") votes.obv = -1;
  else votes.obv = 0;

  return votes;
}

// "الذاكرة البرمجية للأخطاء": تقيس مدى تشابه نمط الأصوات الحالي مع أنماط
// أصوات صفقات خاسرة سابقة لهذا المستخدم على هذا الزوج (مسافة إقليدية بين
// متجهَي الأصوات). تشابه=1 يعني تطابق كامل مع خطأ سابق، 0 يعني لا تشابه.
// هذه ذاكرة مبرمجة (بدون LLM) تعمل دوماً، بخلاف طبقة الذكاء الصناعي
// الاختيارية في lib/ai.js التي تحتاج OPENAI_API_KEY.
function mistakeRisk(userId, pair, votes) {
  const losses = db
    .prepare(
      "SELECT votes FROM trades WHERE user_id = ? AND pair = ? AND pnl_pct < 0 ORDER BY id DESC LIMIT ?"
    )
    .all(userId, pair, MISTAKE_LOOKBACK);
  if (losses.length === 0) return { risk: 0, matches: 0 };

  const keys = Object.keys(votes);
  let maxSim = 0;
  let matches = 0;
  for (const row of losses) {
    const past = row.votes ? JSON.parse(row.votes) : {};
    let distSq = 0;
    for (const k of keys) {
      const diff = (votes[k] ?? 0) - (past[k] ?? 0);
      distSq += diff * diff;
    }
    const dist = Math.sqrt(distSq / Math.max(keys.length, 1)); // 0..2
    const similarity = Math.max(0, 1 - dist / 2);
    if (similarity > 0.7) matches++;
    if (similarity > maxSim) maxSim = similarity;
  }
  return { risk: Math.round(maxSim * 1000) / 1000, matches };
}

// يحلل شموع زوج وُيرجع قراراً + تفاصيل الأصوات والأوزان (تُستخدم لاحقاً للتعلّم)
export function decide(userId, pair, rawCandles, { buyThreshold = 0.5, sellThreshold = -0.4 } = {}) {
  const ind = computeAllIndicators(rawCandles);
  const weights = getWeights(userId);
  const votes = getVotes(ind);

  let weightedSum = 0;
  let weightTotal = 0;
  for (const key of Object.keys(votes)) {
    weightedSum += votes[key] * weights[key];
    weightTotal += weights[key];
  }
  let score = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const rawScore = score;

  // إن كان النمط الحالي يشبه أخطاءً سابقة، نخفّف الدرجة (نحوّلها نحو HOLD)
  // بدلاً من تجاهل التشابه تماماً — هذا هو "التعلّم من الأخطاء" الفعلي.
  const { risk: mistakeRiskScore, matches: mistakeMatches } = mistakeRisk(userId, pair, votes);
  score = score * (1 - MISTAKE_DAMPEN * mistakeRiskScore);

  let action = "HOLD";
  if (score >= buyThreshold) action = "BUY";
  else if (score <= sellThreshold) action = "SELL";

  const caution = mistakeRiskScore > 0.7 && rawScore !== score && action !== (
    rawScore >= buyThreshold ? "BUY" : rawScore <= sellThreshold ? "SELL" : "HOLD"
  );

  const last = ind.closes.length - 1;
  return {
    action,
    score: Math.round(score * 1000) / 1000,
    raw_score: Math.round(rawScore * 1000) / 1000,
    mistake_risk: mistakeRiskScore,
    mistake_matches: mistakeMatches,
    caution,
    price: ind.closes[last],
    atr: ind.atr[last],
    votes,
    weights,
    indicators: {
      rsi: Math.round((ind.rsi[last] ?? 50) * 10) / 10,
      obv_trend: ind.obvTrend,
      ma20: ind.ma20[last],
      ma50: ind.ma50[last],
      macd_hist: ind.histogram[last]
    }
  };
}

// تُستدعى عند إغلاق صفقة لتعديل أوزان المؤشرات بناءً على نتيجتها (ربح/خسارة)
export function learnFromTrade(userId, { votes, pnlPct }) {
  if (!votes) return getWeights(userId);
  const weights = getWeights(userId);
  const outcome = pnlPct > 0 ? 1 : pnlPct < 0 ? -1 : 0;
  if (outcome === 0) return weights;

  for (const key of Object.keys(votes)) {
    const vote = votes[key];
    if (vote === 0) continue;
    const agreement = Math.sign(vote) === outcome ? 1 : -1;
    const delta = LEARNING_RATE * agreement * Math.min(Math.abs(pnlPct), 5);
    weights[key] = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, (weights[key] ?? 1) + delta));
  }
  saveWeights(userId, weights);
  return weights;
}

export function resetWeights(userId) {
  saveWeights(userId, { ...DEFAULT_WEIGHTS });
  return getWeights(userId);
}
