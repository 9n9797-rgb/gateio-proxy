// lib/marketRisk.js
// كشف مخاطر السوق (لا يعتمد على مستخدم معيّن — بيانات سوقية عامة تُطبَّق على
// الجميع): مخاطر "البمب أند دمب" (تقلب سعري حاد + سيولة منخفضة)، ومخاطر فرق
// سعر العرض/الطلب (Spread) الذي يلتهم الربح فعلياً عند الدخول والخروج.
// مُستوحى من فرع `claude/code-implementation-SbvFg` (سكانر الأسهم/العملات)
// ومنقول هنا كدوال نقية لربطه بمحرك القرار متعدد المستخدمين في autopilot.js.

// quoteVolumes: حجم التداول لكل شمعة بعملة التسعير (USDT) مباشرة — هذا ما
// تُرجعه Gate.io فعلاً في حقل الحجم (وليس الحجم بالعملة الأساسية)، لذلك لا
// يُضرَب بالسعر مرة أخرى (الفرع الأصلي SbvFg كان يضربها خطأً بالسعر).
export function detectPumpRisk(closes, quoteVolumes) {
  const n = closes.length;
  if (n < 8) return { risk: false };
  const last = n - 1;
  const change1d = ((closes[last] - closes[last - 1]) / closes[last - 1]) * 100;
  const change3d = ((closes[last] - closes[last - 3]) / closes[last - 3]) * 100;
  const quoteVol24h = quoteVolumes[last] || 0;

  let severity = null;
  if (Math.abs(change1d) >= 60 || Math.abs(change3d) >= 100) {
    severity = "extreme";
  } else if ((Math.abs(change1d) >= 35 || Math.abs(change3d) >= 60) && quoteVol24h < 5_000_000) {
    severity = "high";
  } else if (Math.abs(change1d) >= 35 || Math.abs(change3d) >= 60) {
    severity = "medium";
  } else if (Math.abs(change1d) >= 20 && quoteVol24h < 1_000_000) {
    severity = "medium";
  }

  if (!severity) return { risk: false };
  const dir = change1d >= 0 ? "+" : "";
  const reason = severity === "extreme"
    ? `⚠️ تحرك سعري غير طبيعي (${dir}${change1d.toFixed(1)}% خلال 24 ساعة) — نمط نموذجي لعملات البمب أند دمب (Shitcoin)، يُنصح بتجنبها تماماً`
    : severity === "high"
      ? `⚠️ تحرك حاد (${dir}${change1d.toFixed(1)}%) مع سيولة منخفضة جداً (${(quoteVol24h / 1e6).toFixed(1)}م$) — خطر مضاربة عالٍ`
      : `⚠️ تقلب أعلى من الطبيعي (${dir}${change1d.toFixed(1)}% خلال 24 ساعة) — تعامل بحذر`;

  return {
    risk: true,
    severity,
    change_1d: Math.round(change1d * 100) / 100,
    change_3d: Math.round(change3d * 100) / 100,
    quote_volume_24h: Math.round(quoteVol24h),
    reason
  };
}

export function detectSpreadRisk(bid, ask) {
  if (!bid || !ask || ask <= 0 || bid <= 0) return { risk: false };
  const spreadPct = ((ask - bid) / ask) * 100;
  let severity = null;
  if (spreadPct >= 1.5) severity = "high";
  else if (spreadPct >= 0.5) severity = "medium";
  if (!severity) return { risk: false, spread_pct: Math.round(spreadPct * 100) / 100 };
  return {
    risk: true,
    severity,
    spread_pct: Math.round(spreadPct * 100) / 100,
    reason: severity === "high"
      ? `⚠️ فرق سعر العرض/الطلب مرتفع جداً (${spreadPct.toFixed(2)}%) — ستخسر من فرق السعر وحده عند البيع حتى لو ربحت فنياً، تجنّب هذه العملة`
      : `⚠️ فرق سعر العرض/الطلب أعلى من المعتاد (${spreadPct.toFixed(2)}%) — احسب تكلفة الدخول والخروج قبل التداول`
  };
}

const tickerCache = new Map(); // pair -> { ticker, ts }
const TICKER_CACHE_MS = 20000;

export async function fetchGateTicker(pair) {
  const cached = tickerCache.get(pair);
  if (cached && Date.now() - cached.ts < TICKER_CACHE_MS) return cached.ticker;
  try {
    const r = await fetch(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${pair}`);
    if (!r.ok) return null;
    const arr = await r.json();
    const ticker = Array.isArray(arr) ? arr[0] : null;
    tickerCache.set(pair, { ticker, ts: Date.now() });
    return ticker;
  } catch (_) {
    return null;
  }
}

const dailyCandleCache = new Map(); // pair -> { raw, ts }
const DAILY_CACHE_MS = 5 * 60 * 1000;

async function fetchDailyCandles(pair) {
  const cached = dailyCandleCache.get(pair);
  if (cached && Date.now() - cached.ts < DAILY_CACHE_MS) return cached.raw;
  try {
    const r = await fetch(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=1d&limit=10`);
    if (!r.ok) return null;
    const raw = await r.json();
    dailyCandleCache.set(pair, { raw, ts: Date.now() });
    return raw;
  } catch (_) {
    return null;
  }
}

// يُجمَع تقييم البمب والسبريد لزوج معيّن — يُستخدم في autopilot.js قبل تنفيذ
// أي شراء (تطبيق موحّد على كل المستخدمين لأن البيانات سوقية وليست شخصية).
export async function evaluateMarketRisk(pair) {
  const [dailyRaw, ticker] = await Promise.all([fetchDailyCandles(pair), fetchGateTicker(pair)]);

  let pump = { risk: false };
  if (Array.isArray(dailyRaw) && dailyRaw.length >= 8) {
    // صيغة شموع Gate.io: [timestamp, volume_quote, close, high, low, open]
    const closes = dailyRaw.map(c => Number(c[2]));
    const quoteVolumes = dailyRaw.map(c => Number(c[1]));
    pump = detectPumpRisk(closes, quoteVolumes);
  }

  let spread = { risk: false };
  if (ticker) {
    spread = detectSpreadRisk(Number(ticker.highest_bid), Number(ticker.lowest_ask));
  }

  const severityRank = { medium: 1, high: 2, extreme: 3 };
  let worst = null;
  if (pump.risk) worst = pump;
  if (spread.risk && (!worst || (severityRank[spread.severity] || 0) > (severityRank[worst.severity] || 0))) {
    worst = spread;
  }

  return { pump, spread, worst: worst || { risk: false } };
}
