// lib/strategy.js
// محرك القرار التكيّفي: يجمع "أصوات" المؤشرات الفنية بأوزان قابلة للتعلّم،
// ويُحدّث الأوزان تلقائياً بعد إغلاق كل صفقة بناءً على ربحها أو خسارتها
// (هذا هو "التعلّم من الأخطاء السابقة" — صفقات خاسرة تُنزل وزن المؤشرات
//  التي أعطت الإشارة الخاطئة، وصفقات رابحة تزيد وزن المؤشرات الصحيحة).

import { readJSON, writeJSON } from "./store.js";
import { computeAllIndicators } from "./indicators.js";

const WEIGHTS_KEY = "strategy-weights";
const DEFAULT_WEIGHTS = {
  rsi: 1,
  macd: 1,
  trend: 1,   // سعر فوق/تحت المتوسطات
  obv: 1
};

const MIN_WEIGHT = 0.1;
const MAX_WEIGHT = 3;
const LEARNING_RATE = 0.08;

export function getWeights() {
  return { ...DEFAULT_WEIGHTS, ...readJSON(WEIGHTS_KEY, {}) };
}

function saveWeights(weights) {
  writeJSON(WEIGHTS_KEY, weights);
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

  // RSI: شراء عند تشبّع بيعي/تعافي، بيع عند تشبّع شرائي
  if (rsiVal <= 35) votes.rsi = 1;
  else if (rsiVal >= 70) votes.rsi = -1;
  else if (rsiVal >= 35 && rsiVal <= 55) votes.rsi = 0.5;
  else votes.rsi = 0;

  // MACD: تقاطع واتجاه الهيستوجرام
  if (macdHist != null && macdPrev != null) {
    if (macdHist > 0 && macdHist > macdPrev) votes.macd = 1;
    else if (macdHist < 0 && macdHist < macdPrev) votes.macd = -1;
    else votes.macd = 0;
  } else votes.macd = 0;

  // الاتجاه العام: السعر مقابل المتوسطات المتحركة
  if (ma20 != null && ma50 != null) {
    if (price > ma20 && ma20 > ma50) votes.trend = 1;
    else if (price < ma20 && ma20 < ma50) votes.trend = -1;
    else votes.trend = 0;
  } else votes.trend = 0;

  // OBV: تأكيد تدفق السيولة
  if (ind.obvTrend === "rising") votes.obv = 1;
  else if (ind.obvTrend === "falling") votes.obv = -1;
  else votes.obv = 0;

  return votes;
}

// يحلل شموع زوج وُيرجع قراراً + تفاصيل الأصوات والأوزان (تُستخدم لاحقاً للتعلّم)
export function decide(rawCandles, { buyThreshold = 0.5, sellThreshold = -0.4 } = {}) {
  const ind = computeAllIndicators(rawCandles);
  const weights = getWeights();
  const votes = getVotes(ind);

  let weightedSum = 0;
  let weightTotal = 0;
  for (const key of Object.keys(votes)) {
    weightedSum += votes[key] * weights[key];
    weightTotal += weights[key];
  }
  const score = weightTotal > 0 ? weightedSum / weightTotal : 0;

  let action = "HOLD";
  if (score >= buyThreshold) action = "BUY";
  else if (score <= sellThreshold) action = "SELL";

  const last = ind.closes.length - 1;
  return {
    action,
    score: Math.round(score * 1000) / 1000,
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
export function learnFromTrade({ votes, pnlPct }) {
  if (!votes) return getWeights();
  const weights = getWeights();
  const outcome = pnlPct > 0 ? 1 : pnlPct < 0 ? -1 : 0;
  if (outcome === 0) return weights;

  for (const key of Object.keys(votes)) {
    const vote = votes[key];
    if (vote === 0) continue;
    // إذا توافق صوت المؤشر مع اتجاه الصفقة الرابحة → زيادة وزنه، والعكس صحيح
    const agreement = Math.sign(vote) === outcome ? 1 : -1;
    const delta = LEARNING_RATE * agreement * Math.min(Math.abs(pnlPct), 5);
    weights[key] = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, (weights[key] ?? 1) + delta));
  }
  saveWeights(weights);
  return weights;
}

export function resetWeights() {
  saveWeights({ ...DEFAULT_WEIGHTS });
  return getWeights();
}
