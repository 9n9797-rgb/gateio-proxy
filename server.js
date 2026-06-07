// server.js
// Node 18+ (يدعم fetch مدمج)
// تشغيل: node server.js

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import GateApi from "gate-api";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== إنشاء تطبيق Express =====
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // يخدم الملفات الساكنة بجانب server.js

// ===== Gate API Client =====
const client = new GateApi.ApiClient();
client.setApiKeySecret(process.env.GATEIO_API_KEY, process.env.GATEIO_API_SECRET);
const spotApi = new GateApi.SpotApi(client);

// ===== أدوات مساعدة =====
const withTimeout = (p, ms = 5000) =>
  Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);

const upstreamError = (e, extra = {}) => ({
  upstream: false,
  error: String(e?.message || e),
  ...extra
});

// Cache
const _cache = new Map();
const memoGet = (key, fn, ttl) => {
  const h = _cache.get(key);
  if (h && Date.now() - h.at < ttl) return Promise.resolve(h.v);
  return fn().then(v => { _cache.set(key, { v, at: Date.now() }); return v; });
};

// Sentiment
const POS_W = ['surge','beat','record','profit','growth','buy','upgrade','strong','bullish','gains','rally','soar','positive','exceed','revenue','innovation'];
const NEG_W = ['drop','miss','loss','decline','cut','downgrade','weak','bearish','sell','fall','crash','risk','lower','concern','lawsuit','investigation','fraud'];
const calcSentiment = t => Math.max(-2, Math.min(2,
  POS_W.filter(w => (t||'').toLowerCase().includes(w)).length -
  NEG_W.filter(w => (t||'').toLowerCase().includes(w)).length
));

// ===== دوال داخلية: أخبار / كونغرس / توصية =====
async function fetchNews(symbol) {
  // Try Yahoo Finance search API for news
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=8&enableFuzzyQuery=false&quotesCount=0`;
  const r = await withTimeout(fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible)', 'Accept': 'application/json' }
  }), 8000);
  const json = await r.json();
  return (json?.news || []).map(n => ({
    title: n.title || '',
    publisher: n.publisher || '',
    published_at: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
    url: n.link || '',
    sentiment: calcSentiment(n.title)
  }));
}

async function fetchCongressTrades(symbol, days = 90) {
  const since = new Date(Date.now() - days * 86400000);
  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible)' };

  const [house, senate] = await Promise.all([
    memoGet('house_all', async () => {
      const r = await withTimeout(fetch(
        'https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json',
        { headers }), 25000);
      const d = await r.json();
      return Array.isArray(d) ? d : [];
    }, 2 * 3600000),

    memoGet('senate_all', async () => {
      const r = await withTimeout(fetch(
        'https://senate-stock-watcher-data.s3-us-west-2.amazonaws.com/aggregate/all_transactions.json',
        { headers }), 25000);
      const d = await r.json();
      return Array.isArray(d) ? d : [];
    }, 2 * 3600000)
  ]);

  const mapHouse = t => ({
    trader:  t.representative || 'Unknown',
    party:   t.party || null,
    type:    (t.type || '').toLowerCase().includes('purchase') ? 'purchase' : 'sale',
    amount:  t.amount || '',
    date:    t.transaction_date || t.disclosure_date || '',
    chamber: 'house'
  });

  const mapSenate = t => ({
    trader:  t.senator || `${t.first_name || ''} ${t.last_name || ''}`.trim() || 'Unknown',
    party:   t.party || null,
    type:    (t.type || '').toLowerCase().includes('purchase') ? 'purchase' : 'sale',
    amount:  t.amount || '',
    date:    t.transaction_date || '',
    chamber: 'senate'
  });

  const all = [
    ...house.filter(t => (t.ticker||'').toUpperCase() === symbol && t.transaction_date && new Date(t.transaction_date) >= since).map(mapHouse),
    ...senate.filter(t => (t.ticker||'').toUpperCase() === symbol && t.transaction_date && new Date(t.transaction_date) >= since).map(mapSenate)
  ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 30);

  return {
    trades: all,
    buys:  all.filter(t => t.type === 'purchase').length,
    sells: all.filter(t => t.type === 'sale').length,
    total: all.length
  };
}

function buildRecommendation(analysis, congress, news) {
  // --- Technical score (max 4) ---
  let tech = 0;
  const { rsi, obv_trend, above_ma20, price, high, low } = analysis;
  if (rsi >= 35 && rsi <= 55)      tech += 1.5;
  else if (rsi < 30)               tech += 0.5;  // oversold bounce
  else if (rsi > 70)               tech -= 1.5;
  if (obv_trend === 'rising')      tech += 1.5;
  else if (obv_trend === 'falling') tech -= 1.0;
  if (above_ma20)                  tech += 1.0;
  tech = Math.max(-4, Math.min(4, tech));

  // --- Congress score (max 3) ---
  let cong = 0;
  if (congress.total > 0) {
    cong = ((congress.buys - congress.sells) / congress.total) * 3;
  }
  cong = Math.max(-3, Math.min(3, cong));

  // --- News score (max 3) ---
  let newsScore = 0;
  if (news.length > 0) {
    newsScore = (news.reduce((a, n) => a + n.sentiment, 0) / news.length) * 1.5;
  }
  newsScore = Math.max(-3, Math.min(3, newsScore));

  const total = Math.round((tech + cong + newsScore) * 10) / 10;

  // Recommendation
  let rec, recAr, confidence;
  if      (total >= 5)  { rec = 'STRONG_BUY';  recAr = 'شراء قوي';    confidence = 85; }
  else if (total >= 3)  { rec = 'BUY';          recAr = 'شراء';        confidence = 72; }
  else if (total >= 1)  { rec = 'HOLD';         recAr = 'احتفظ';       confidence = 60; }
  else if (total >= -1) { rec = 'WATCH';        recAr = 'مراقبة';      confidence = 50; }
  else if (total >= -3) { rec = 'SELL';         recAr = 'بيع';         confidence = 65; }
  else                  { rec = 'STRONG_SELL';  recAr = 'بيع قوي';     confidence = 80; }

  if (congress.total === 0) confidence = Math.max(40, confidence - 10);
  if (news.length === 0)    confidence = Math.max(40, confidence - 5);
  confidence = Math.min(95, confidence);

  // Price targets
  const volatility = low > 0 ? (high - low) / low : 0.15;
  let upsidePct = 0, timeFrame = 'غير محدد', riskLevel = 'متوسط';

  if (total >= 5)       { upsidePct = Math.min(volatility * 80, 40);  timeFrame = '2-4 أسابيع';  riskLevel = 'متوسط'; }
  else if (total >= 3)  { upsidePct = Math.min(volatility * 55, 25);  timeFrame = '4-8 أسابيع';  riskLevel = 'متوسط'; }
  else if (total >= 1)  { upsidePct = Math.min(volatility * 30, 15);  timeFrame = '8-16 أسابيع'; riskLevel = 'منخفض-متوسط'; }
  else if (total < -1)  { upsidePct = 0;                              timeFrame = '-';            riskLevel = 'مرتفع'; }

  upsidePct = Math.round(upsidePct * 10) / 10;
  const targetPrice = upsidePct > 0 ? Math.round(price * (1 + upsidePct / 100) * 100) / 100 : null;
  const stopLoss    = upsidePct > 0 ? Math.round(price * (1 - (upsidePct / 100) / 2.5) * 100) / 100 : null;
  const rrRatio     = upsidePct > 0 ? `1:${Math.round((upsidePct / ((price - stopLoss) / price * 100)) * 10) / 10}` : null;

  // Daily tip text
  const tips = {
    STRONG_BUY:  `فرصة قوية — دخول تدريجي 3 مراحل. الهدف $${targetPrice} (+${upsidePct}%) خلال ${timeFrame}`,
    BUY:         `دخول مدروس — خصص 30-50% من المخصص. الهدف $${targetPrice} (+${upsidePct}%) خلال ${timeFrame}`,
    HOLD:        `احتفظ بمركزك — الهدف $${targetPrice} على المدى المتوسط (${timeFrame})`,
    WATCH:       `راقب السهم — انتظر كسر مستوى واضح قبل الدخول`,
    SELL:        `قلّص مركزك — ضع حد خسارة وانتظر التصحيح`,
    STRONG_SELL: `تجنب الدخول — ضغط بيع مرتفع، خطر كبير حالياً`
  };

  return {
    recommendation:    rec,
    recommendation_ar: recAr,
    confidence,
    total_score: total,
    target_price: targetPrice,
    stop_loss:    stopLoss,
    rr_ratio:     rrRatio,
    upside_pct:   upsidePct,
    time_frame:   timeFrame,
    risk_level:   riskLevel,
    scores: {
      technical: { value: Math.round(tech * 10) / 10,      label: tech >= 2 ? 'إيجابي قوي' : tech >= 0.5 ? 'إيجابي' : tech >= -0.5 ? 'محايد' : 'سلبي' },
      congress:  { value: Math.round(cong * 10) / 10,      label: congress.total === 0 ? 'لا بيانات' : congress.buys > congress.sells ? `شراء (${congress.buys})` : `بيع (${congress.sells})` },
      news:      { value: Math.round(newsScore * 10) / 10, label: newsScore > 0.5 ? 'إيجابي' : newsScore < -0.5 ? 'سلبي' : 'محايد' }
    },
    daily_tip: tips[rec] || tips.WATCH,
    analysis_reason: buildReason({ rsi, obv_trend, above_ma20, price, high, low }, congress, news, rec, upsidePct, timeFrame)
  };
}

function buildReason(analysis, congress, news, rec, upsidePct, timeFrame) {
  const parts = [];
  const { rsi, obv_trend, above_ma20 } = analysis;

  // --- RSI ---
  if (rsi >= 35 && rsi <= 55)
    parts.push(`🔵 RSI عند ${rsi} — في نطاق التجميع المثالي (35-55)، مما يشير إلى أن السهم لم يصل تشبعاً شرائياً بعد وهناك مجال للصعود`);
  else if (rsi < 30)
    parts.push(`🟢 RSI عند ${rsi} — في منطقة تشبع بيعي حاد، هذا يعني أن السهم مبيع بشكل مبالغ فيه وقد يرتد للأعلى قريباً`);
  else if (rsi > 70)
    parts.push(`🔴 RSI عند ${rsi} — في منطقة تشبع شرائي، السعر ارتفع بسرعة كبيرة وقد يشهد تصحيحاً`);
  else if (rsi > 55)
    parts.push(`🟡 RSI عند ${rsi} — فوق منطقة التجميع المثالية، السهم في حالة شراء لكن لم يصل التشبع الكامل بعد`);

  // --- OBV ---
  if (obv_trend === 'rising')
    parts.push(`📦 حجم التراكم (OBV) صاعد — هذا يعني أن المؤسسات والمستثمرين الكبار يشترون بهدوء في الخفاء بكميات متزايدة`);
  else if (obv_trend === 'falling')
    parts.push(`📉 حجم التراكم (OBV) هابط — خروج أموال مؤسسية من السهم، حتى لو بدا السعر ثابتاً هذا مؤشر تحذيري`);

  // --- MA20 ---
  if (above_ma20)
    parts.push(`📈 السعر فوق المتوسط المتحرك 20 يوم — الاتجاه الأساسي صعودي، المتوسط يعمل كدعم تحت السعر`);
  else
    parts.push(`📉 السعر تحت المتوسط المتحرك 20 يوم — المتوسط يعمل كمقاومة فوق السعر الحالي`);

  // --- Congress ---
  if (congress.total > 0) {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const thisWeek = congress.trades.filter(t => t.date >= weekAgo);
    const weekBuys = thisWeek.filter(t => t.type === 'purchase').length;
    const weekSells = thisWeek.filter(t => t.type === 'sale').length;

    if (weekBuys > 0)
      parts.push(`🏛️ هذا الأسبوع: ${weekBuys} عضو من الكونغرس/مجلس الشيوخ اشترى السهم — إشارة مؤسسية قوية جداً`);
    else if (congress.buys > 0)
      parts.push(`🏛️ خلال آخر 90 يوم: ${congress.buys} عملية شراء من الكونغرس${congress.sells > 0 ? ` و${congress.sells} عملية بيع` : ''}`);

    if (congress.buys > congress.sells && congress.buys >= 3)
      parts.push(`💡 إجماع كونغرسي: ${congress.buys} عملية شراء مقابل ${congress.sells} بيع — هذا مستوى ثقة مرتفع جداً من المطّلعين`);
  } else {
    parts.push(`🏛️ لا توجد بيانات تداول كونغرس حديثة لهذا السهم في آخر 90 يوماً`);
  }

  // --- News ---
  const posNews = news.filter(n => n.sentiment > 0);
  const negNews = news.filter(n => n.sentiment < 0);
  if (posNews.length > 0)
    parts.push(`📰 ${posNews.length} خبر إيجابي حديث${posNews[0]?.title ? `: "${posNews[0].title.slice(0,60)}..."` : ''}`);
  if (negNews.length > 0)
    parts.push(`⚠️ ${negNews.length} خبر سلبي يستحق المتابعة`);

  // --- Summary sentence ---
  const summaries = {
    STRONG_BUY:  `✅ خلاصة: تزامن ${parts.length} عوامل إيجابية في نفس الوقت — هذه الحالة نادرة وتمثل فرصة دخول قوية. الهدف +${upsidePct}% خلال ${timeFrame}.`,
    BUY:         `✅ خلاصة: أغلب المؤشرات إيجابية مع بعض التحفظ. الهدف +${upsidePct}% خلال ${timeFrame}، لكن ادخل بتدرج.`,
    HOLD:        `⏳ خلاصة: المؤشرات متوازنة ولا يوجد محفز واضح للدخول أو الخروج الآن. انتظر تأكيداً أوضح.`,
    WATCH:       `👀 خلاصة: المؤشرات متضاربة. راقب السهم وانتظر تحرك السعر فوق مستوى محوري قبل الدخول.`,
    SELL:        `⚠️ خلاصة: عوامل سلبية تتراكم. قلّص التعرض وانتظر انتهاء ضغط البيع.`,
    STRONG_SELL: `❌ خلاصة: معظم المؤشرات سلبية. تجنب الدخول حتى تتحسن الصورة بشكل واضح.`
  };

  parts.push(summaries[rec] || summaries.WATCH);
  return parts;
}

// ===== الجذر (مؤشر) =====
app.get("/", (req, res) => {
  res.json({
    service: "Gate.io Proxy v2",
    status: "running",
    docs: "/openapi.yaml",
    llm_quick_guide: "/llm-instructions",
    health: "/healthz",
    proxy_prefix: "/proxy/*"
  });
});

// ===== Healthz (محلي فقط) =====
app.get("/healthz", (req, res) => {
  res.json({ ok: true, service: "gateio-proxy-v2", ts: Date.now() });
});

// ===== /proxy/health (يطابق OpenAPI: ok/service/time) =====
app.get("/proxy/health", (req, res) => {
  res.json({
    ok: true,
    service: "gateio-proxy",
    time: new Date().toISOString()
  });
});

// ===== /proxy/healthz (فحص Upstream بدون مفاتيح) =====
app.get("/proxy/healthz", async (req, res) => {
  const checked_endpoint = "/api/v4/spot/currency_pairs";
  const url = `https://api.gateio.ws${checked_endpoint}`;
  try {
    const r = await withTimeout(fetch(url), 5000);
    if (!r.ok) return res.json({ upstream: false, status: r.status, checked_endpoint });
    return res.json({ upstream: true, status: r.status, checked_endpoint });
  } catch (e) {
    return res.json({ upstream: false, error: String(e), checked_endpoint });
  }
});

// ===== أرصدة المحفظة (مطابقة للـ schema: currency/available/frozen/total) =====
app.get("/proxy/balances", async (req, res) => {
  try {
    const result = await spotApi.listSpotAccounts();
    const raw = result.body || [];

    const shaped = raw.map(x => {
      const currency = String(x.currency ?? x.currency_code ?? "");
      const available = String(x.available ?? x.available_balance ?? "0");
      const frozenVal = x.frozen ?? x.freeze ?? x.locked ?? 0;
      const frozen = String(frozenVal);
      const totalNum = (parseFloat(available) || 0) + (parseFloat(frozen) || 0);
      const total = String(totalNum);
      return { currency, available, frozen, total };
    });

    res.json(shaped);
  } catch (e) {
    // نحافظ على شكل السكيمة لعدم كسر Actions
    res.status(200).json([
      { currency: "USDT", available: "0.00", frozen: "0.00", total: "0.00" }
    ]);
  }
});

// ===== الأوامر المفتوحة =====
app.get("/proxy/orders/open", async (req, res) => {
  try {
    const result = await spotApi.listSpotOrders({ status: "open" });
    res.json(result.body);
  } catch (e) {
    res.status(200).json(upstreamError(e));
  }
});

// ===== إنشاء أمر (market/limit) =====
app.post("/proxy/orders", async (req, res) => {
  try {
    const order = {
      currency_pair: req.body.currency_pair, // مثال: BTC_USDT
      type: req.body.type || "market",       // market أو limit
      side: req.body.side,                   // buy أو sell
      amount: req.body.amount,               // مثال: 0.001
      price: req.body.price                  // مطلوب فقط للـ limit
    };

    const result = await spotApi.createOrder(order);
    res.json(result.body);
  } catch (e) {
    res.status(200).json(upstreamError(e));
  }
});

// ===== إلغاء أمر =====
app.delete("/proxy/orders/:id", async (req, res) => {
  try {
    const result = await spotApi.cancelOrder(req.params.id, req.query.currency_pair);
    res.json(result.body);
  } catch (e) {
    res.status(200).json(upstreamError(e));
  }
});

// ===== سجل الأوامر المنفذة =====
app.get("/proxy/orders/history", async (req, res) => {
  try {
    const result = await spotApi.listSpotOrders({ status: "finished" });
    res.json(result.body);
  } catch (e) {
    res.status(200).json(upstreamError(e));
  }
});

// ===== تقديم ملفات التوثيق (إن وجدت) =====
app.get("/openapi.yaml", (req, res) => {
  const p = path.join(__dirname, "openapi.yaml");
  if (fs.existsSync(p)) {
    res.type("text/yaml; charset=utf-8");
    return res.sendFile(p);
  }
  res.status(404).json({ error: "openapi.yaml not found" });
});

app.get("/llm-instructions", (req, res) => {
  const p = path.join(__dirname, "llm-instructions.md");
  if (fs.existsSync(p)) {
    res.type("text/markdown; charset=utf-8");
    return res.sendFile(p);
  }
  res.status(404).json({ error: "llm-instructions.md not found" });
});

// ===== حسابات المؤشرات الفنية =====
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return closes.map(() => 50);
  const result = new Array(period).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
}

function calculateOBV(closes, volumes) {
  const obv = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) obv.push(obv[i - 1] + volumes[i]);
    else if (closes[i] < closes[i - 1]) obv.push(obv[i - 1] - volumes[i]);
    else obv.push(obv[i - 1]);
  }
  return obv;
}

function getOBVTrend(obv) {
  if (obv.length < 10) return "neutral";
  const n = obv.length;
  const recent = obv.slice(n - 5).reduce((a, b) => a + b, 0) / 5;
  const older  = obv.slice(n - 10, n - 5).reduce((a, b) => a + b, 0) / 5;
  if (recent > older * 1.005) return "rising";
  if (recent < older * 0.995) return "falling";
  return "neutral";
}

function calculateMA(closes, period = 20) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    return closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

// ===== تحليل التجميع =====
app.get("/proxy/analyze/:pair", async (req, res) => {
  const pair = req.params.pair.toUpperCase();
  const limit = Math.min(parseInt(req.query.limit) || 60, 200);
  const interval = req.query.interval || "1d";
  const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=${interval}&limit=${limit}`;

  try {
    const r = await withTimeout(fetch(url), 8000);
    if (!r.ok) {
      const txt = await r.text();
      return res.status(200).json({ error: `Gate.io ${r.status}: ${txt}`, pair });
    }
    const raw = await r.json();
    if (!Array.isArray(raw) || raw.length < 5)
      return res.status(200).json({ error: "بيانات غير كافية", pair });

    // [time, vol, close, high, low, open, closed]
    const closes  = raw.map(c => parseFloat(c[2]));
    const highs   = raw.map(c => parseFloat(c[3]));
    const lows    = raw.map(c => parseFloat(c[4]));
    const opens   = raw.map(c => parseFloat(c[5]));
    const volumes = raw.map(c => parseFloat(c[1]));
    const times   = raw.map(c => parseInt(c[0]) * 1000);

    const rsiArr  = calculateRSI(closes, 14);
    const obvArr  = calculateOBV(closes, volumes);
    const ma20Arr = calculateMA(closes, 20);

    const last     = closes.length - 1;
    const lastRSI  = rsiArr[last]  ?? 50;
    const lastMA20 = ma20Arr[last] ?? closes[last];
    const lastClose = closes[last];
    const obvTrend  = getOBVTrend(obvArr);
    const aboveMA   = lastClose > lastMA20;

    // درجة التجميع
    let score = 0;
    if (aboveMA) score++;
    if (lastRSI >= 35 && lastRSI <= 55) score++;
    if (obvTrend === "rising") score++;

    const signal = score >= 2 ? "accumulation" : score === 1 ? "neutral" : "distribution";

    // أعلى/أدنى سعر خلال الفترة
    const highPeriod = Math.max(...highs);
    const lowPeriod  = Math.min(...lows);
    const change24h  = closes.length >= 2
      ? ((closes[last] - closes[last - 1]) / closes[last - 1]) * 100 : 0;

    res.json({
      pair,
      interval,
      price:     lastClose,
      change24h: Math.round(change24h * 100) / 100,
      high:      highPeriod,
      low:       lowPeriod,
      rsi:       Math.round(lastRSI * 10) / 10,
      obv_trend: obvTrend,
      above_ma20: aboveMA,
      ma20:      Math.round(lastMA20 * 100) / 100,
      signal,
      score,
      candles: raw.map((_, i) => ({
        time:   times[i],
        open:   opens[i],
        high:   highs[i],
        low:    lows[i],
        close:  closes[i],
        volume: volumes[i],
        rsi:    rsiArr[i]  ?? null,
        ma20:   ma20Arr[i] ?? null,
        obv:    obvArr[i]  ?? 0
      }))
    });
  } catch (e) {
    res.status(200).json(upstreamError(e, { pair }));
  }
});

// ===== قائمة أزواج Gate.io الشائعة =====
app.get("/proxy/pairs", async (req, res) => {
  const url = "https://api.gateio.ws/api/v4/spot/currency_pairs";
  try {
    const r = await withTimeout(fetch(url), 6000);
    const all = await r.json();
    const popular = all
      .filter(p => p.quote === "USDT" && p.trade_status === "tradable")
      .slice(0, 100)
      .map(p => ({ id: p.id, base: p.base, quote: p.quote }));
    res.json(popular);
  } catch (e) {
    res.status(200).json(upstreamError(e));
  }
});

// ===== تحليل الأسهم الأمريكية (Yahoo Finance) =====
app.get("/proxy/stock/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const range    = ["1mo","3mo","6mo","1y","2y"].includes(req.query.range) ? req.query.range : "3mo";
  const interval = ["1d","1wk"].includes(req.query.interval) ? req.query.interval : "1d";

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;

  try {
    const r = await withTimeout(fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9"
      }
    }), 8000);

    const json = await r.json();
    const result = json?.chart?.result?.[0];
    if (!result) {
      const errMsg = json?.chart?.error?.description || "رمز السهم غير موجود";
      return res.status(200).json({ error: errMsg, symbol });
    }

    const meta       = result.meta;
    const timestamps = result.timestamp || [];
    const q          = result.indicators?.quote?.[0] || {};
    const closes     = (q.close  || []).map(v => v ?? null);
    const opens      = (q.open   || []).map(v => v ?? null);
    const highs      = (q.high   || []).map(v => v ?? null);
    const lows       = (q.low    || []).map(v => v ?? null);
    const volumes    = (q.volume || []).map(v => v ?? 0);

    // تنظيف القيم الفارغة (null من Yahoo)
    const validCloses = closes.filter(Boolean);
    if (validCloses.length < 5)
      return res.status(200).json({ error: "بيانات غير كافية", symbol });

    const rsiArr  = calculateRSI(closes.map(v => v ?? 0), 14);
    const obvArr  = calculateOBV(closes.map(v => v ?? 0), volumes);
    const ma20Arr = calculateMA(closes.map(v => v ?? 0), 20);

    const last      = closes.length - 1;
    const lastClose = meta.regularMarketPrice ?? closes[last];
    const lastRSI   = rsiArr[last]  ?? 50;
    const lastMA20  = ma20Arr[last] ?? lastClose;
    const obvTrend  = getOBVTrend(obvArr);
    const aboveMA   = lastClose > lastMA20;

    let score = 0;
    if (aboveMA) score++;
    if (lastRSI >= 35 && lastRSI <= 55) score++;
    if (obvTrend === "rising") score++;

    const signal   = score >= 2 ? "accumulation" : score === 1 ? "neutral" : "distribution";
    const change1d = meta.regularMarketChangePercent ??
      (closes[last] && closes[last-1] ? ((closes[last] - closes[last-1]) / closes[last-1]) * 100 : 0);

    res.json({
      symbol,
      name:       meta.longName || meta.shortName || symbol,
      exchange:   meta.exchangeName || "",
      currency:   meta.currency || "USD",
      price:      Math.round(lastClose * 100) / 100,
      change1d:   Math.round(change1d * 100) / 100,
      high:       Math.max(...highs.filter(Boolean)),
      low:        Math.min(...lows.filter(Boolean)),
      rsi:        Math.round(lastRSI * 10) / 10,
      obv_trend:  obvTrend,
      above_ma20: aboveMA,
      ma20:       Math.round(lastMA20 * 100) / 100,
      signal,
      score,
      candles: timestamps.map((t, i) => ({
        time:   t * 1000,
        open:   opens[i],
        high:   highs[i],
        low:    lows[i],
        close:  closes[i],
        volume: volumes[i],
        rsi:    rsiArr[i]  ?? null,
        ma20:   ma20Arr[i] ?? null,
        obv:    obvArr[i]  ?? 0
      }))
    });
  } catch (e) {
    res.status(200).json(upstreamError(e, { symbol }));
  }
});

// GET /proxy/news/:symbol
app.get("/proxy/news/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const news = await memoGet(`news_${symbol}`, () => fetchNews(symbol), 10 * 60000);
    res.json({ symbol, count: news.length, news });
  } catch (e) {
    res.json({ symbol, count: 0, news: [], error: String(e) });
  }
});

// GET /proxy/congress/:symbol
app.get("/proxy/congress/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const days   = Math.min(parseInt(req.query.days) || 90, 365);
  try {
    const data = await fetchCongressTrades(symbol, days);
    res.json({ symbol, ...data });
  } catch (e) {
    res.json({ symbol, trades: [], buys: 0, sells: 0, total: 0, error: String(e) });
  }
});

// GET /proxy/recommend/:symbol?type=stock|crypto&range=3mo
app.get("/proxy/recommend/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const type   = req.query.type === 'crypto' ? 'crypto' : 'stock';
  const range  = req.query.range || '3mo';

  try {
    let analysis;

    if (type === 'crypto') {
      // Use Gate.io candles
      const pair  = symbol.includes('_') ? symbol : `${symbol}_USDT`;
      const url   = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=1d&limit=60`;
      const r     = await withTimeout(fetch(url), 8000);
      const raw   = await r.json();
      if (!Array.isArray(raw) || raw.length < 5)
        return res.json({ error: 'بيانات غير كافية للعملة', symbol });

      const closes  = raw.map(c => parseFloat(c[2]));
      const highs   = raw.map(c => parseFloat(c[3]));
      const lows    = raw.map(c => parseFloat(c[4]));
      const volumes = raw.map(c => parseFloat(c[1]));
      const last    = closes.length - 1;

      const rsiArr  = calculateRSI(closes, 14);
      const obvArr  = calculateOBV(closes, volumes);
      const ma20Arr = calculateMA(closes, 20);
      const obvTrend= getOBVTrend(obvArr);

      analysis = {
        symbol: pair, name: pair, type: 'crypto',
        price:      closes[last],
        change1d:   last > 0 ? Math.round(((closes[last]-closes[last-1])/closes[last-1])*10000)/100 : 0,
        high:       Math.max(...highs),
        low:        Math.min(...lows),
        rsi:        Math.round((rsiArr[last]??50)*10)/10,
        obv_trend:  obvTrend,
        above_ma20: closes[last] > (ma20Arr[last] ?? closes[last]),
        ma20:       Math.round((ma20Arr[last]??closes[last])*100)/100
      };
    } else {
      // Use Yahoo Finance
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
      const r   = await withTimeout(fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      }), 8000);
      const json   = await r.json();
      const result = json?.chart?.result?.[0];
      if (!result) return res.json({ error: 'رمز السهم غير موجود', symbol });

      const meta    = result.meta;
      const q       = result.indicators?.quote?.[0] || {};
      const closes  = (q.close||[]).map(v=>v??0);
      const highs   = (q.high||[]).map(v=>v??0);
      const lows    = (q.low||[]).map(v=>v??0);
      const volumes = (q.volume||[]).map(v=>v??0);
      const last    = closes.length - 1;

      const rsiArr  = calculateRSI(closes, 14);
      const obvArr  = calculateOBV(closes, volumes);
      const ma20Arr = calculateMA(closes, 20);
      const obvTrend= getOBVTrend(obvArr);
      const lastClose = meta.regularMarketPrice ?? closes[last];

      analysis = {
        symbol, name: meta.longName || meta.shortName || symbol, type: 'stock',
        exchange:   meta.exchangeName || '',
        price:      Math.round(lastClose * 100) / 100,
        change1d:   Math.round((meta.regularMarketChangePercent ?? 0) * 100) / 100,
        high:       Math.max(...highs.filter(Boolean)),
        low:        Math.min(...lows.filter(Boolean)),
        rsi:        Math.round((rsiArr[last]??50)*10)/10,
        obv_trend:  obvTrend,
        above_ma20: lastClose > (ma20Arr[last] ?? lastClose),
        ma20:       Math.round((ma20Arr[last]??lastClose)*100)/100
      };
    }

    // Parallel: congress (stocks only) + news
    const [congressResult, newsResult] = await Promise.allSettled([
      type === 'stock'
        ? fetchCongressTrades(symbol, 90)
        : Promise.resolve({ trades: [], buys: 0, sells: 0, total: 0 }),
      memoGet(`news_${symbol}`, () => fetchNews(symbol), 10 * 60000)
    ]);

    const congress = congressResult.status === 'fulfilled' ? congressResult.value : { trades: [], buys: 0, sells: 0, total: 0 };
    const news     = newsResult.status === 'fulfilled' ? newsResult.value : [];

    const rec = buildRecommendation(analysis, congress, news);

    res.json({
      date: new Date().toISOString().split('T')[0],
      ...analysis,
      ...rec,
      congress_activity: congress.trades.slice(0, 10),
      recent_news:       news.slice(0, 6)
    });
  } catch (e) {
    res.json(upstreamError(e, { symbol }));
  }
});

// ===== Backtesting Engine =====
function getOBVTrendAt(obv, idx) {
  if (idx < 10) return 'neutral';
  const recent = obv.slice(idx - 4, idx + 1).reduce((a, b) => a + b, 0) / 5;
  const older  = obv.slice(idx - 9, idx - 4).reduce((a, b) => a + b, 0) / 5;
  if (recent > older * 1.005) return 'rising';
  if (recent < older * 0.995) return 'falling';
  return 'neutral';
}

function runBacktest(candles, initialCapital = 10000) {
  const n       = candles.length;
  const closes  = candles.map(c => parseFloat(c.close) || 0);
  const volumes = candles.map(c => parseFloat(c.volume) || 0);
  const times   = candles.map(c => c.time);

  // Pre-compute indicators for all candles
  const rsiArr  = calculateRSI(closes, 14);
  const obvArr  = calculateOBV(closes, volumes);
  const ma20Arr = calculateMA(closes, 20);

  let cash = initialCapital;
  let shares = 0;
  let inPosition = false;
  let entryPrice = 0;
  let entryDate  = null;
  let entryIdx   = 0;

  const trades = [];
  const equity = [];

  const START = 22; // enough history for MA20 + OBV

  for (let i = START; i < n; i++) {
    const rsi      = rsiArr[i]  ?? 50;
    const ma20     = ma20Arr[i] ?? closes[i];
    const close    = closes[i];
    const obvTrend = getOBVTrendAt(obvArr, i);
    const aboveMA  = close > ma20;

    // Entry: RSI في نطاق التجميع + OBV صاعد + فوق MA20
    const buySignal  = !inPosition && rsi >= 33 && rsi <= 58 && obvTrend === 'rising' && aboveMA;
    // Exit: تشبع شرائي أو ضعف مؤشرات أو وقف خسارة 8%
    const stopLoss   = inPosition && close < entryPrice * 0.92;
    const sellSignal = inPosition && (rsi > 68 || (!aboveMA && obvTrend === 'falling') || stopLoss);

    if (buySignal) {
      shares     = cash / close;
      entryPrice = close;
      entryDate  = times[i];
      entryIdx   = i;
      cash       = 0;
      inPosition = true;
    } else if (sellSignal) {
      const exitVal   = shares * close;
      const profitPct = ((close - entryPrice) / entryPrice) * 100;
      const daysHeld  = Math.round((times[i] - entryDate) / 86400000);
      trades.push({
        entry_date:  new Date(entryDate).toISOString().split('T')[0],
        exit_date:   new Date(times[i]).toISOString().split('T')[0],
        entry_price: Math.round(entryPrice * 100) / 100,
        exit_price:  Math.round(close * 100) / 100,
        profit_pct:  Math.round(profitPct * 100) / 100,
        days_held:   daysHeld,
        exit_reason: stopLoss ? 'وقف_خسارة' : rsi > 68 ? 'تشبع_شرائي' : 'ضعف_مؤشرات'
      });
      cash       = exitVal;
      shares     = 0;
      inPosition = false;
    }

    const val = inPosition ? shares * close : cash;
    if (i % 2 === 0) equity.push({ time: times[i], value: Math.round(val * 100) / 100 });
  }

  // Close open position at last candle
  if (inPosition) {
    const lastClose = closes[n - 1];
    const profitPct = ((lastClose - entryPrice) / entryPrice) * 100;
    trades.push({
      entry_date: new Date(entryDate).toISOString().split('T')[0],
      exit_date:  new Date(times[n - 1]).toISOString().split('T')[0],
      entry_price: Math.round(entryPrice * 100) / 100,
      exit_price:  Math.round(lastClose * 100) / 100,
      profit_pct:  Math.round(profitPct * 100) / 100,
      days_held:   Math.round((times[n - 1] - entryDate) / 86400000),
      exit_reason: 'نهاية_الفترة'
    });
    cash = shares * lastClose;
  }

  const finalValue   = Math.round(cash * 100) / 100;
  const totalReturn  = ((finalValue - initialCapital) / initialCapital) * 100;
  const periodDays   = (times[n - 1] - times[START]) / 86400000;
  const annualized   = periodDays > 30
    ? (Math.pow(finalValue / initialCapital, 365 / periodDays) - 1) * 100 : totalReturn;
  const buyHold      = ((closes[n - 1] - closes[START]) / closes[START]) * 100;

  const winners   = trades.filter(t => t.profit_pct > 0);
  const losers    = trades.filter(t => t.profit_pct <= 0);
  const winRate   = trades.length > 0 ? (winners.length / trades.length) * 100 : 0;
  const avgWin    = winners.length > 0 ? winners.reduce((a, t) => a + t.profit_pct, 0) / winners.length : 0;
  const avgLoss   = losers.length  > 0 ? losers.reduce((a, t)  => a + t.profit_pct, 0) / losers.length  : 0;

  // Max drawdown
  let peak = initialCapital, maxDD = 0;
  equity.forEach(e => {
    if (e.value > peak) peak = e.value;
    const dd = peak > 0 ? ((peak - e.value) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  });

  // Verdict
  let verdict, verdictColor;
  const alpha = totalReturn - buyHold; // الفرق عن buy&hold
  if (annualized >= 30 && winRate >= 55) { verdict = 'ممتاز — النظام يتفوق على السوق بشكل واضح'; verdictColor = '#3fb950'; }
  else if (annualized >= 15 && winRate >= 50) { verdict = 'جيد — النظام مربح ومتفوق على المتوسط'; verdictColor = '#58c96a'; }
  else if (annualized >= 5  && totalReturn > buyHold) { verdict = 'مقبول — أفضل من Buy & Hold لكن بفارق بسيط'; verdictColor = '#d29922'; }
  else if (totalReturn > 0) { verdict = 'ضعيف — النظام مربح لكن Buy & Hold أفضل منه'; verdictColor = '#f0883e'; }
  else { verdict = 'خسائر — النظام لم يكن مربحاً في هذه الفترة'; verdictColor = '#f85149'; }

  return {
    initial_capital:  initialCapital,
    final_value:      finalValue,
    total_return:     Math.round(totalReturn  * 100) / 100,
    annualized_return:Math.round(annualized   * 100) / 100,
    buy_hold_return:  Math.round(buyHold      * 100) / 100,
    alpha:            Math.round(alpha        * 100) / 100,
    total_trades:     trades.length,
    winning_trades:   winners.length,
    losing_trades:    losers.length,
    win_rate:         Math.round(winRate * 100) / 100,
    avg_win:          Math.round(avgWin  * 100) / 100,
    avg_loss:         Math.round(avgLoss * 100) / 100,
    max_drawdown:     Math.round(maxDD   * 100) / 100,
    best_trade:       trades.length > 0 ? Math.max(...trades.map(t => t.profit_pct)) : 0,
    worst_trade:      trades.length > 0 ? Math.min(...trades.map(t => t.profit_pct)) : 0,
    period_days:      Math.round(periodDays),
    verdict,
    verdict_color:    verdictColor,
    trades:           trades.slice(-15),
    equity_curve:     equity
  };
}

// GET /proxy/backtest/:symbol?range=2y&type=stock|crypto
app.get("/proxy/backtest/:symbol", async (req, res) => {
  const symbol  = req.params.symbol.toUpperCase();
  const type    = req.query.type === 'crypto' ? 'crypto' : 'stock';
  const range   = ['1y','2y','3y','5y'].includes(req.query.range) ? req.query.range : '2y';
  const capital = Math.min(parseInt(req.query.capital) || 10000, 1000000);

  try {
    let candles;

    if (type === 'crypto') {
      const pair  = symbol.includes('_') ? symbol : `${symbol}_USDT`;
      const limit = range === '1y' ? 365 : range === '3y' ? 1095 : range === '5y' ? 1825 : 730;
      const url   = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=1d&limit=${limit}`;
      const r     = await withTimeout(fetch(url), 10000);
      const raw   = await r.json();
      if (!Array.isArray(raw) || raw.length < 30)
        return res.json({ error: 'بيانات غير كافية', symbol });
      candles = raw.map(c => ({
        time: parseInt(c[0]) * 1000, open: parseFloat(c[5]),
        high: parseFloat(c[3]),      low:  parseFloat(c[4]),
        close: parseFloat(c[2]),     volume: parseFloat(c[1])
      }));
    } else {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
      const r   = await withTimeout(fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      }), 10000);
      const json   = await r.json();
      const result = json?.chart?.result?.[0];
      if (!result) return res.json({ error: 'رمز السهم غير موجود', symbol });
      const q   = result.indicators?.quote?.[0] || {};
      const ts  = result.timestamp || [];
      candles   = ts.map((t, i) => ({
        time:   t * 1000,
        open:   q.open?.[i]   ?? 0,
        high:   q.high?.[i]   ?? 0,
        low:    q.low?.[i]    ?? 0,
        close:  q.close?.[i]  ?? 0,
        volume: q.volume?.[i] ?? 0
      })).filter(c => c.close > 0);
    }

    if (candles.length < 40)
      return res.json({ error: 'البيانات غير كافية للاختبار', symbol });

    const result = runBacktest(candles, capital);
    res.json({ symbol, type, range, ...result });
  } catch (e) {
    res.json(upstreamError(e, { symbol }));
  }
});

// ===== تشغيل السيرفر =====
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Proxy يعمل على المنفذ ${PORT}`));
