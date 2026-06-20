// server.js
// Node 18+ (يدعم fetch مدمج)
// تشغيل: node server.js

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import GateApi from "gate-api";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import session from "express-session";
import bcrypt from "bcryptjs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== إنشاء تطبيق Express =====
const app = express();
app.set("trust proxy", 1); // خلف بروكسي Render — مطلوب لكوكيز secure
app.use(cors());
app.use(express.json());

// ===== نظام الحسابات (تسجيل دخول لكل مستخدم) =====
// ملاحظة: التخزين في ملف JSON على القرص — يُعاد ضبطه عند كل عملية نشر جديدة
// على Render (القرص غير دائم) إلا إذا أضيف قرص دائم (Persistent Disk).
const USERS_FILE = path.join(__dirname, "data", "users.json");
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch (_) { return []; }
}
function saveUsers(users) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

if (!process.env.SESSION_SECRET) {
  console.warn("⚠️ SESSION_SECRET غير مضبوط — سيتم توليد مفتاح مؤقت (تنتهي الجلسات عند إعادة التشغيل)");
}
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 3600000
  }
}));

const PUBLIC_PATHS = new Set(["/login.html", "/healthz", "/proxy/health"]);
function isPublicPath(p) {
  return PUBLIC_PATHS.has(p) || p.startsWith("/auth/");
}

app.post("/auth/register", (req, res) => {
  const { username, password, register_code, agree_terms } = req.body || {};
  if (!agree_terms) return res.status(400).json({ error: "يجب الموافقة على الشروط وإقرار عدم الضمان قبل إنشاء الحساب" });
  if (!process.env.REGISTER_CODE) return res.status(403).json({ error: "التسجيل مغلق — لم يتم ضبط REGISTER_CODE من لوحة Render" });
  if (register_code !== process.env.REGISTER_CODE) return res.status(403).json({ error: "رمز الدعوة غير صحيح" });
  if (!username || !password || password.length < 6) return res.status(400).json({ error: "اسم مستخدم وكلمة مرور (6 أحرف على الأقل) مطلوبة" });

  const users = loadUsers();
  if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: "اسم المستخدم مستخدم بالفعل" });
  }
  const user = {
    id: crypto.randomUUID(),
    username,
    password_hash: bcrypt.hashSync(password, 10),
    agreed_terms_at: new Date().toISOString(),
    created_at: new Date().toISOString()
  };
  users.push(user);
  saveUsers(users);
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ ok: true, username: user.username });
});

app.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const users = loadUsers();
  const user = users.find(u => u.username.toLowerCase() === String(username || "").toLowerCase());
  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    return res.status(401).json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ ok: true, username: user.username });
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/auth/me", (req, res) => {
  res.json({ authenticated: !!req.session.userId, username: req.session.username || null });
});

app.use((req, res, next) => {
  if (isPublicPath(req.path)) return next();
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith("/proxy/") || req.headers.accept?.includes("application/json")) {
    return res.status(401).json({ error: "يلزم تسجيل الدخول", login_required: true });
  }
  return res.redirect("/login.html");
});

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

// ===== Yahoo Finance Crumb (required for quoteSummary) =====
let _yahooCrumb = null;
let _yahooCookies = '';
let _yahooCrumbAt = 0;
const CRUMB_TTL = 6 * 3600000;

async function getYahooCrumb() {
  if (_yahooCrumb && Date.now() - _yahooCrumbAt < CRUMB_TTL) return _yahooCrumb;
  try {
    const r1 = await withTimeout(fetch('https://fc.yahoo.com/', {
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' }
    }), 5000).catch(() => null);
    let cookieStr = '';
    if (r1) {
      const rawCookies = typeof r1.headers.getSetCookie === 'function'
        ? r1.headers.getSetCookie()
        : [r1.headers.get('set-cookie') || ''];
      cookieStr = rawCookies.filter(Boolean).map(c => c.split(';')[0]).join('; ');
    }
    const r2 = await withTimeout(fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        ...(cookieStr ? { 'Cookie': cookieStr } : {})
      }
    }), 5000);
    const text = await r2.text();
    if (text && text.length < 50 && !text.includes('{')) {
      _yahooCrumb = text.trim();
      _yahooCookies = cookieStr;
      _yahooCrumbAt = Date.now();
      return _yahooCrumb;
    }
  } catch (_) {}
  return null;
}

async function fetchYahooQuoteSummary(symbol, modules) {
  const crumb = await getYahooCrumb();
  if (!crumb) return null;
  const moduleStr = Array.isArray(modules) ? modules.join(',') : modules;
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${encodeURIComponent(moduleStr)}&crumb=${encodeURIComponent(crumb)}`;
  const r = await withTimeout(fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      ...((_yahooCookies) ? { 'Cookie': _yahooCookies } : {})
    }
  }), 8000);
  if (!r.ok) return null;
  const json = await r.json();
  return json?.quoteSummary?.result?.[0] || null;
}

async function fetchAnalystRecs(symbol) {
  const result = await fetchYahooQuoteSummary(symbol, ['recommendationTrend', 'upgradeDowngradeHistory', 'financialData']);
  if (!result) return null;
  const trend = result.recommendationTrend?.trend?.[0] || {};
  const history = (result.upgradeDowngradeHistory?.history || []).slice(0, 20);
  const fd = result.financialData || {};
  const total = (trend.strongBuy||0) + (trend.buy||0) + (trend.hold||0) + (trend.sell||0) + (trend.strongSell||0);
  const consMap = { strong_buy:'شراء قوي', buy:'شراء', hold:'احتفظ', sell:'بيع', strong_sell:'بيع قوي' };
  return {
    total_analysts: total,
    strong_buy:  trend.strongBuy  || 0,
    buy:         trend.buy        || 0,
    hold:        trend.hold       || 0,
    sell:        trend.sell       || 0,
    strong_sell: trend.strongSell || 0,
    consensus:    fd.recommendationKey || 'none',
    consensus_ar: consMap[fd.recommendationKey] || 'لا توصية',
    consensus_mean: fd.recommendationMean?.raw ?? null,
    target_high:   fd.targetHighPrice?.raw   ?? null,
    target_low:    fd.targetLowPrice?.raw    ?? null,
    target_mean:   fd.targetMeanPrice?.raw   ?? null,
    target_median: fd.targetMedianPrice?.raw ?? null,
    recent_actions: history.map(h => ({
      firm:         h.firm || '',
      from:         h.fromGrade || '',
      to:           h.toGrade || '',
      action:       h.action || '',
      price_target: h.currentPriceTarget || null,
      date:         h.epochGradeDate ? new Date(h.epochGradeDate * 1000).toISOString().split('T')[0] : null
    }))
  };
}

// Sentiment
const POS_W = ['surge','beat','record','profit','growth','buy','upgrade','strong','bullish','gains','rally','soar','positive','exceed','revenue','innovation'];
const NEG_W = ['drop','miss','loss','decline','cut','downgrade','weak','bearish','sell','fall','crash','risk','lower','concern','lawsuit','investigation','fraud'];
const calcSentiment = t => Math.max(-2, Math.min(2,
  POS_W.filter(w => (t||'').toLowerCase().includes(w)).length -
  NEG_W.filter(w => (t||'').toLowerCase().includes(w)).length
));

// ===== دوال داخلية: أخبار / كونغرس / توصية =====

// خريطة الرموز الشائعة للعملات إلى صيغة Yahoo (BTC_USDT -> BTC-USD) لجلب أخبار حقيقية
function toYahooNewsQuery(symbol, type) {
  if (type !== 'crypto') return symbol;
  const base = symbol.replace(/_.*$/, ''); // BTC_USDT -> BTC
  return `${base}-USD`;
}

// ترجمة آلية مجانية (MyMemory) — بدون مفتاح، مناسبة لعناوين قصيرة
async function translateToArabic(text) {
  if (!text) return text;
  try {
    const r = await withTimeout(fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|ar`
    ), 6000);
    const j = await r.json();
    const translated = j?.responseData?.translatedText;
    return translated && !translated.startsWith('QUERY LENGTH') ? translated : text;
  } catch (_) {
    return text;
  }
}

async function fetchNews(symbol, type = 'stock') {
  const query = toYahooNewsQuery(symbol, type);
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&newsCount=8&enableFuzzyQuery=false&quotesCount=0`;
  const r = await withTimeout(fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible)', 'Accept': 'application/json' }
  }), 8000);
  const json = await r.json();
  const items = json?.news || [];

  const titles_ar = await Promise.all(items.map(n => translateToArabic(n.title || '')));

  return items.map((n, i) => ({
    title: n.title || '',
    title_ar: titles_ar[i] || n.title || '',
    publisher: n.publisher || '',
    published_at: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
    url: n.link || '',
    sentiment: calcSentiment(n.title)
  }));
}

async function fetchCongressTrades(symbol, days = 90) {
  const since   = new Date(Date.now() - days * 86400000);
  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible)' };

  const safeFetch = async (key, url) => {
    return memoGet(key, async () => {
      const r = await withTimeout(fetch(url, { headers }), 20000);
      if (!r.ok) return { data: [], unavailable: true };
      const text = await r.text();
      if (text.trim().startsWith('<')) return { data: [], unavailable: true }; // XML error response
      try {
        const d = JSON.parse(text);
        return { data: Array.isArray(d) ? d : [], unavailable: false };
      } catch (_) {
        return { data: [], unavailable: true };
      }
    }, 2 * 3600000);
  };

  const [houseRes, senateRes] = await Promise.all([
    safeFetch('house_all',  'https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json'),
    safeFetch('senate_all', 'https://senate-stock-watcher-data.s3-us-west-2.amazonaws.com/aggregate/all_transactions.json')
  ]);

  const sourceUnavailable = houseRes.unavailable && senateRes.unavailable;
  const house  = houseRes.data;
  const senate = senateRes.data;

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
    buys:   all.filter(t => t.type === 'purchase').length,
    sells:  all.filter(t => t.type === 'sale').length,
    total:  all.length,
    source_unavailable: sourceUnavailable
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

function calculateEMA(values, period) {
  const k   = 2 / (period + 1);
  const ema = [values[0] ?? 0];
  for (let i = 1; i < values.length; i++)
    ema.push((values[i] ?? ema[i-1]) * k + ema[i-1] * (1 - k));
  return ema;
}

function calculateROC(closes, period = 20) {
  return closes.map((c, i) =>
    i < period || closes[i-period] === 0 ? null
      : ((c - closes[i-period]) / closes[i-period]) * 100
  );
}

function calculateMACD(closes) {
  const ema12  = calculateEMA(closes, 12);
  const ema26  = calculateEMA(closes, 26);
  const line   = ema12.map((v, i) => v - ema26[i]);
  const signal = calculateEMA(line, 9);
  return { line, signal, hist: line.map((v, i) => v - signal[i]) };
}

// === Bollinger Bands ===
function calculateBollingerBands(closes, period = 20, mult = 2) {
  const ma = calculateMA(closes, period);
  return closes.map((_, i) => {
    if (i < period - 1 || ma[i] == null) return { upper: null, middle: null, lower: null, pct: null };
    const slice = closes.slice(i - period + 1, i + 1);
    const std   = Math.sqrt(slice.reduce((s, v) => s + (v - ma[i]) ** 2, 0) / period);
    const upper = ma[i] + mult * std;
    const lower = ma[i] - mult * std;
    return {
      upper:  Math.round(upper  * 100) / 100,
      middle: Math.round(ma[i]  * 100) / 100,
      lower:  Math.round(lower  * 100) / 100,
      pct:    upper !== lower ? Math.round((closes[i] - lower) / (upper - lower) * 100) : 50
    };
  });
}

// === Average True Range ===
function calculateATR(highs, lows, closes, period = 14) {
  const tr = highs.map((h, i) =>
    i === 0 ? h - lows[i]
      : Math.max(h - lows[i], Math.abs(h - closes[i-1]), Math.abs(lows[i] - closes[i-1]))
  );
  const result = new Array(period).fill(null);
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(atr);
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    result.push(atr);
  }
  return result;
}

// === Stochastic RSI ===
function calculateStochRSI(closes, period = 14, smoothK = 3, smoothD = 3) {
  const rsi = calculateRSI(closes, period);
  const raw = rsi.map((r, i) => {
    if (r == null || i < period * 2) return null;
    const win = rsi.slice(i - period + 1, i + 1).filter(v => v != null);
    if (win.length < period) return null;
    const lo = Math.min(...win), hi = Math.max(...win);
    return hi === lo ? 50 : (r - lo) / (hi - lo) * 100;
  });
  const kArr = calculateMA(raw.map(v => v ?? 0), smoothK);
  const dArr = calculateMA(kArr.map(v => v ?? 0), smoothD);
  return {
    k: raw.map((v, i) => v == null ? null : Math.round((kArr[i] ?? 0) * 10) / 10),
    d: raw.map((v, i) => v == null ? null : Math.round((dArr[i] ?? 0) * 10) / 10)
  };
}

// === Candlestick Pattern Detection ===
function detectCandlePatterns(opens, highs, lows, closes) {
  const patterns = [];
  const n = closes.length;
  for (let i = Math.max(1, n - 6); i < n; i++) {
    const o = opens[i], h = highs[i], l = lows[i], c = closes[i];
    const po = opens[i-1], pc = closes[i-1];
    const body = Math.abs(c - o), range = h - l;
    if (range < 1e-9) continue;
    const upper = h - Math.max(o, c);
    const lower = Math.min(o, c) - l;
    if      (body / range < 0.08)
      patterns.push({ bullish: null,  label: '◇ دوجي',              desc: 'تردد في السوق — انتظر اتجاهاً واضحاً' });
    else if (lower > body * 2.5 && upper < body * 0.6 && c >= o)
      patterns.push({ bullish: true,  label: '🔨 مطرقة',            desc: 'إشارة انعكاس صعودي محتملة' });
    else if (upper > body * 2.5 && lower < body * 0.6 && c <= o)
      patterns.push({ bullish: false, label: '💫 نجمة ساقطة',       desc: 'إشارة انعكاس هبوطي محتملة' });
    else if (i > 0 && pc < po && c > o && c > po && o < pc)
      patterns.push({ bullish: true,  label: '🟢 ابتلاع صعودي',     desc: 'إشارة شراء قوية جداً' });
    else if (i > 0 && pc > po && c < o && c < po && o > pc)
      patterns.push({ bullish: false, label: '🔴 ابتلاع هبوطي',     desc: 'إشارة بيع قوية' });
    else if (upper < body * 0.05 && lower < body * 0.05 && c > o)
      patterns.push({ bullish: true,  label: '🕯 شمعة صعودية كاملة', desc: 'تحكم كامل من المشترين' });
    else if (upper < body * 0.05 && lower < body * 0.05 && c < o)
      patterns.push({ bullish: false, label: '🕯 شمعة هبوطية كاملة', desc: 'تحكم كامل من البائعين' });
  }
  return patterns.slice(-4);
}

// === Market Regime ===
function detectMarketRegime(closes) {
  if (closes.length < 40) return { regime: 'غير محدد', icon: '❓', color: '#8b949e' };
  const n = closes.length;
  const ma20 = calculateMA(closes, 20);
  const ma50 = calculateMA(closes, 50);
  const last = closes[n-1], lma20 = ma20[n-1], lma50 = ma50[n-1] ?? last;
  const ref  = ma20[n-10] ?? lma20 ?? 1;
  const ma20Dir  = (lma20 - ref) / ref;
  const rangeVol = (Math.max(...closes.slice(-20)) - Math.min(...closes.slice(-20))) / last;
  if (last > lma20 && lma20 > lma50 && ma20Dir > 0.01)
    return { regime: 'ترند صاعد قوي',  icon: '🚀', color: '#3fb950' };
  if (last > lma20 && ma20Dir > 0)
    return { regime: 'ترند صاعد',       icon: '📈', color: '#58c96a' };
  if (last < lma20 && lma20 < lma50 && ma20Dir < -0.01)
    return { regime: 'ترند هابط قوي',  icon: '📉', color: '#f85149' };
  if (last < lma20 && ma20Dir < 0)
    return { regime: 'ترند هابط',       icon: '🔻', color: '#f0883e' };
  if (rangeVol > 0.12)
    return { regime: 'متقلب',           icon: '⚡', color: '#d29922' };
  return   { regime: 'متماسك',          icon: '〰️', color: '#8b949e' };
}

// === Support / Resistance (pivot-based) ===
function findSupportResistance(highs, lows, closes, lookback = 60) {
  const n  = closes.length, s = Math.max(0, n - lookback);
  const rh = highs.slice(s), rl = lows.slice(s);
  const price = closes[n - 1];
  const pivH = [], pivL = [];
  for (let i = 2; i < rh.length - 2; i++) {
    if (rh[i] >= rh[i-1] && rh[i] >= rh[i-2] && rh[i] >= rh[i+1] && rh[i] >= rh[i+2]) pivH.push(rh[i]);
    if (rl[i] <= rl[i-1] && rl[i] <= rl[i-2] && rl[i] <= rl[i+1] && rl[i] <= rl[i+2]) pivL.push(rl[i]);
  }
  const res = [...new Set(pivH.map(v => Math.round(v*100)/100))]
    .filter(v => v > price * 1.001).sort((a,b) => a-b).slice(0,2);
  const sup = [...new Set(pivL.map(v => Math.round(v*100)/100))]
    .filter(v => v < price * 0.999).sort((a,b) => b-a).slice(0,2);
  return { resistance: res, support: sup,
    period_high: Math.round(Math.max(...rh)*100)/100,
    period_low:  Math.round(Math.min(...rl)*100)/100 };
}

// === Volume Spike Detection ===
function detectVolumeSpikes(volumes, closes) {
  if (volumes.length < 20) return [];
  const avg = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const out = [];
  for (let i = Math.max(0, volumes.length - 10); i < volumes.length; i++) {
    if (volumes[i] > avg * 1.8)
      out.push({ daysAgo: volumes.length - 1 - i,
        ratio:   Math.round(volumes[i] / avg * 10) / 10,
        bullish: closes[i] >= (closes[i-1] ?? closes[i]) });
  }
  return out;
}

// === AI Score Engine (0-100) ===
function buildAIScore(closes, highs, lows, opens, volumes, congress, news) {
  const n = closes.length;
  if (n < 30) return null;
  const rsiArr    = calculateRSI(closes, 14);
  const obvArr    = calculateOBV(closes, volumes);
  const ma20Arr   = calculateMA(closes, 20);
  const ma50Arr   = calculateMA(closes, 50);
  const bbArr     = calculateBollingerBands(closes);
  const atrArr    = calculateATR(highs, lows, closes);
  const stochRSI  = calculateStochRSI(closes);
  const macdData  = calculateMACD(closes);
  const rocArr    = calculateROC(closes, 20);
  const patterns  = detectCandlePatterns(opens, highs, lows, closes);
  const regime    = detectMarketRegime(closes);
  const sr        = findSupportResistance(highs, lows, closes);
  const volSpikes = detectVolumeSpikes(volumes, closes);
  const obvTrend  = getOBVTrend(obvArr);
  const i = n - 1;
  const rsi   = rsiArr[i]  ?? 50;
  const close = closes[i];
  const ma20  = ma20Arr[i] ?? close;
  const ma50  = ma50Arr[i] ?? close;
  const bb    = bbArr[i];
  const atr   = atrArr[i];
  const stochK= stochRSI.k[i] ?? 50;
  const stochD= stochRSI.d[i] ?? 50;
  const macdL = macdData.line[i]   ?? 0;
  const macdS = macdData.signal[i] ?? 0;
  const roc20 = rocArr[i] ?? 0;

  const S = {};
  // RSI (max 20)
  if      (rsi >= 38 && rsi <= 52) S.rsi = 20;
  else if (rsi >= 32 && rsi < 38)  S.rsi = 14;
  else if (rsi >= 52 && rsi <= 62) S.rsi = 12;
  else if (rsi < 32)               S.rsi = 8;
  else if (rsi > 62 && rsi <= 72)  S.rsi = 5;
  else                             S.rsi = 0;
  // MACD (max 18)
  if      (macdL > macdS && macdL > 0 && roc20 > 2) S.macd = 18;
  else if (macdL > macdS && macdL > 0)               S.macd = 13;
  else if (macdL > macdS)                            S.macd = 8;
  else if (macdL > 0)                                S.macd = 4;
  else                                               S.macd = 0;
  // OBV (max 18)
  S.obv = obvTrend === 'rising' ? 18 : obvTrend === 'neutral' ? 6 : 0;
  // Bollinger (max 15)
  if (bb?.pct != null) {
    if      (bb.pct >= 30 && bb.pct <= 55) S.bb = 15;
    else if (bb.pct < 20)                  S.bb = 12;
    else if (bb.pct >= 55 && bb.pct <= 70) S.bb = 8;
    else if (bb.pct > 80)                  S.bb = 2;
    else                                   S.bb = 5;
  } else S.bb = 7;
  // MA structure (max 12)
  if      (close > ma20 && ma20 > ma50) S.ma = 12;
  else if (close > ma20 && close > ma50) S.ma = 9;
  else if (close > ma20)                S.ma = 5;
  else if (close > ma50)                S.ma = 3;
  else                                  S.ma = 0;
  // StochRSI (max 10)
  if      (stochK >= 20 && stochK <= 55 && stochK > stochD) S.stoch = 10;
  else if (stochK < 20)                                      S.stoch = 8;
  else if (stochK > 55 && stochK <= 75)                      S.stoch = 5;
  else                                                       S.stoch = 2;
  // Volume spikes (max 8)
  const bullSp = volSpikes.find(s => s.bullish  && s.daysAgo <= 5);
  const bearSp = volSpikes.find(s => !s.bullish && s.daysAgo <= 5);
  S.vol = bullSp ? 8 : bearSp ? 0 : 4;
  // Patterns (max 7)
  const bPat = patterns.filter(p => p.bullish === true);
  const sPat = patterns.filter(p => p.bullish === false);
  S.pat = bPat.length >= 2 ? 7 : bPat.length === 1 ? 5 : sPat.length >= 1 ? 0 : 3;
  // Congress (max 5)
  S.congress = congress.total > 0
    ? Math.min(5, Math.max(0, Math.round(((congress.buys - congress.sells) / congress.total + 1) / 2 * 5)))
    : 2;
  // News (max 5)
  if (news.length > 0) {
    const avg = news.reduce((a, nx) => a + nx.sentiment, 0) / news.length;
    S.news = Math.min(5, Math.max(0, Math.round((avg + 2) / 4 * 5)));
  } else S.news = 2;

  const total = Math.min(100, Object.values(S).reduce((a, b) => a + b, 0));

  let grade, gradeColor, gradeLabel;
  if      (total >= 80) { grade='A'; gradeColor='#3fb950'; gradeLabel='ممتاز — إشارة شراء قوية'; }
  else if (total >= 65) { grade='B'; gradeColor='#58c96a'; gradeLabel='جيد — إشارة دخول معقولة'; }
  else if (total >= 50) { grade='C'; gradeColor='#d29922'; gradeLabel='محايد — انتظر تأكيداً'; }
  else if (total >= 35) { grade='D'; gradeColor='#f0883e'; gradeLabel='ضعيف — تجنب الدخول الآن'; }
  else                  { grade='F'; gradeColor='#f85149'; gradeLabel='خطر — إشارات سلبية واضحة'; }

  let entrySignal;
  if      (total >= 70)                                              entrySignal = { type:'strong_buy', label:'🟢 شراء قوي',        desc:'تقارب إيجابي واضح بين المؤشرات — فرصة دخول قوية', color:'#3fb950' };
  else if (total >= 55 && (close > ma20 || macdL > macdS || obvTrend === 'rising'))
                                                                       entrySignal = { type:'buy',        label:'✅ دخول مناسب',      desc:'الشروط مهيأة — ادخل بـ 30-50% من المخصص',          color:'#58c96a' };
  else if (rsi < 32 && obvTrend !== 'falling')                       entrySignal = { type:'bounce',     label:'🎯 فرصة ارتداد',     desc:'تشبع بيعي — قد يرتد بالدفعات التدريجية',           color:'#58a6ff' };
  else if (total <= 30 || (rsi > 70 && obvTrend === 'falling'))      entrySignal = { type:'sell',       label:'🔴 بيع / تجنب الدخول', desc:'مؤشرات سلبية واضحة — اخرج أو لا تدخل الآن',        color:'#f85149' };
  else if (total <= 45)                                              entrySignal = { type:'avoid',      label:'🚫 تجنب الآن',       desc:'مؤشرات ضعيفة — انتظر تحسن الصورة',                color:'#f0883e' };
  else                                                                entrySignal = { type:'watch',      label:'👀 راقب وانتظر',     desc:'إشارات محايدة — انتظر تأكيداً إضافياً',            color:'#d29922' };

  const atrStop   = atr ? Math.round((close - 2.0 * atr) * 100) / 100 : null;
  const atrTarget = atr ? Math.round((close + 3.0 * atr) * 100) / 100 : null;
  const atrRR     = (atrStop && atrTarget && close > atrStop)
    ? `1:${Math.round((atrTarget - close) / (close - atrStop) * 10) / 10}` : null;

  const bbSeries = bbArr.slice(-60).map(b =>
    b?.upper ? { upper: b.upper, middle: b.middle, lower: b.lower } : { upper: null, middle: null, lower: null }
  );

  return {
    ai_score: total, grade, grade_color: gradeColor, grade_label: gradeLabel,
    score_components: S, entry_signal: entrySignal, regime,
    patterns: patterns.slice(-4), support_resistance: sr,
    volume_spikes: volSpikes.slice(-5),
    bollinger: bb ? { upper: bb.upper, middle: bb.middle, lower: bb.lower, position_pct: bb.pct } : null,
    stoch_rsi: { k: Math.round((stochK??50)*10)/10, d: Math.round((stochD??50)*10)/10 },
    rsi: Math.round(rsi*10)/10, roc20: Math.round(roc20*10)/10,
    macd: { bullish: macdL > macdS },
    atr: atr ? Math.round(atr*1000)/1000 : null,
    atr_stop: atrStop, atr_target: atrTarget, atr_rr: atrRR,
    ma: { ma20: Math.round(ma20*100)/100, ma50: Math.round(ma50*100)/100,
          above_20: close > ma20, above_50: close > ma50, bullish_cross: ma20 > ma50 },
    bb_series: bbSeries
  };
}

// ===== Breakout Score (50%+ upside scanner) =====
function calcBreakoutScore(ai) {
  let score = 0;
  const reasons = [];

  const rsi     = ai.rsi ?? 50;
  const bbPct   = ai.bollinger?.position_pct;
  const stochK  = ai.stoch_rsi?.k ?? 50;
  const stochD  = ai.stoch_rsi?.d ?? 50;
  const patterns = ai.patterns || [];
  const ma      = ai.ma || {};
  const roc20   = ai.roc20 ?? 0;
  const volSpikes = ai.volume_spikes || [];
  const obvScore  = ai.score_components?.obv ?? 0;  // 0 | 6 | 18

  // RSI sweet spot 35-52 (coiled before breakout)
  if      (rsi >= 35 && rsi <= 52) { score += 25; reasons.push(`RSI ${rsi.toFixed(1)} — منطقة تجميع مثالية`); }
  else if (rsi > 25  && rsi < 35)  { score += 15; reasons.push(`RSI ${rsi.toFixed(1)} — تشبع بيعي، ارتداد محتمل`); }
  else if (rsi > 52  && rsi <= 62) { score += 12; reasons.push(`RSI ${rsi.toFixed(1)} — زخم إيجابي معتدل`); }

  // MACD bullish
  if (ai.macd?.bullish) { score += 20; reasons.push('MACD تقاطع إيجابي صاعد'); }
  else                    score -= 5;

  // OBV trend (inferred from score_component)
  if      (obvScore >= 15) { score += 22; reasons.push('OBV صاعد — تدفق مؤسسي للشراء'); }
  else if (obvScore >= 5)  { score += 10; reasons.push('OBV محايد مع ميل للصعود'); }

  // Bollinger near lower band → coiled spring
  if      (bbPct != null && bbPct <= 20) { score += 18; reasons.push(`سعر عند ${bbPct}% من نطاق BB — ضغط قوي عند الدعم`); }
  else if (bbPct != null && bbPct <= 35) { score += 10; reasons.push(`سعر عند ${bbPct}% من BB — قريب من الدعم`); }

  // Bullish volume spike (institutional accumulation)
  const bullSpike = volSpikes.find(v => v.bullish && v.daysAgo <= 5);
  if (bullSpike) { score += 12; reasons.push(`ارتفاع حجم ×${bullSpike.ratio} على الشراء منذ ${bullSpike.daysAgo} أيام`); }

  // StochRSI oversold turning up
  if (stochK < 25 && stochK > stochD) { score += 10; reasons.push(`Stoch RSI ${stochK.toFixed(1)} — انعكاس من التشبع البيعي`); }

  // Bullish candle pattern
  const bullPats = patterns.filter(p => p.bullish === true);
  if (bullPats.length > 0) { score += 8; reasons.push(`${bullPats[0].label} — شمعة انعكاس إيجابي`); }

  // MA alignment
  if      (ma.above_20 && ma.bullish_cross) { score += 5; reasons.push('MA20 فوق MA50 وسعر فوق المتوسطات'); }
  else if (ma.above_50 && !ma.above_20)     { score += 3; reasons.push('سعر فوق MA50 — دعم طويل المدى'); }

  // Positive ROC building momentum
  if      (roc20 > 0 && roc20 < 20)  { score += 5; reasons.push(`زخم ROC20 +${roc20.toFixed(1)}% — بداية صعود`); }
  else if (roc20 >= 20)               { score -= 5; } // already ran, less upside

  // Penalty: overbought
  if (rsi > 75) score -= 10;

  return {
    breakout_score: Math.max(0, Math.min(100, Math.round(score))),
    reasons: reasons.slice(0, 5)
  };
}

// 25 US stocks to scan
const SCAN_UNIVERSE = [
  'NVDA','AAPL','MSFT','META','GOOGL','AMZN','TSLA','AMD','TSM','NFLX',
  'PLTR','CRWD','NET','SMCI','ARM','PYPL','INTC','SOFI','RKLB','DIS',
  'UBER','SQ','HOOD','COIN','MSTR'
];

// ===== مسح السوق — أفضل فرص الصعود =====
app.get('/proxy/scan', async (req, res) => {
  const top = Math.min(parseInt(req.query.top) || 5, 10);
  const cacheKey = 'market_scan';

  return memoGet(cacheKey, async () => {
    const scanOne = async sym => {
      try {
        const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=6mo`;
        const r    = await withTimeout(fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }), 12000);
        const json = await r.json();
        const result = json?.chart?.result?.[0];
        if (!result) return null;
        const q     = result.indicators?.quote?.[0] || {};
        const times = result.timestamp || [];
        let closes  = (q.close  || []).map(v => v ?? 0);
        let highs   = (q.high   || []).map(v => v ?? 0);
        let lows    = (q.low    || []).map(v => v ?? 0);
        let opens   = (q.open   || []).map(v => v ?? 0);
        let volumes = (q.volume || []).map(v => v ?? 0);
        const valid = times.reduce((acc, t, i) => {
          if (closes[i] > 0) acc.push({ t, o: opens[i], h: highs[i], l: lows[i], c: closes[i], v: volumes[i] });
          return acc;
        }, []);
        if (valid.length < 30) return null;
        opens   = valid.map(x => x.o); highs   = valid.map(x => x.h);
        lows    = valid.map(x => x.l); closes  = valid.map(x => x.c);
        volumes = valid.map(x => x.v);
        const ai = buildAIScore(closes, highs, lows, opens, volumes, { trades:[], buys:0, sells:0, total:0 }, []);
        if (!ai) return null;
        const { breakout_score, reasons } = calcBreakoutScore(ai);
        const currentPrice = closes[closes.length - 1];
        const periodHigh   = ai.support_resistance?.period_high || currentPrice;
        // Upside: distance to 6-month high OR 3×ATR target
        let upsidePct = 0;
        if (periodHigh > currentPrice * 1.02) {
          upsidePct = Math.round((periodHigh - currentPrice) / currentPrice * 100);
        } else if (ai.atr_target && ai.atr_target > currentPrice) {
          upsidePct = Math.round((ai.atr_target - currentPrice) / currentPrice * 100);
        }
        // rank: breakout 60% + AI 40%, penalise overbought RSI
        const rank = (breakout_score * 0.6 + ai.ai_score * 0.4) * (ai.rsi > 72 ? 0.65 : 1);
        return {
          symbol: sym,
          price:  Math.round(currentPrice * 100) / 100,
          ai_score: ai.ai_score, grade: ai.grade, grade_color: ai.grade_color,
          breakout_score, reasons,
          entry_signal: ai.entry_signal,
          rsi: ai.rsi, macd_bull: ai.macd?.bullish,
          ma: ai.ma, regime: ai.regime,
          atr_stop: ai.atr_stop, atr_target: ai.atr_target, atr_rr: ai.atr_rr,
          upside_pct: upsidePct,
          period_high: Math.round(periodHigh * 100) / 100,
          rank
        };
      } catch(_) { return null; }
    };

    // scan all 25 in parallel (each has 12s timeout)
    const settled = await Promise.allSettled(SCAN_UNIVERSE.map(scanOne));
    const results = settled.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
    results.sort((a, b) => b.rank - a.rank);
    return { scanned: SCAN_UNIVERSE.length, found: results.length, top: results.slice(0, top), ts: Date.now() };
  }, 30 * 60000)  // cache 30 min
  .then(d => res.json(d))
  .catch(e => res.json(upstreamError(e)));
});

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

// ===== سعر لحظي خفيف (للتحديث المباشر دون إعادة حساب التحليل الكامل) =====
app.get("/proxy/price/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const type = req.query.type === "crypto" ? "crypto" : "stock";

  try {
    if (type === "crypto") {
      const pair = symbol.includes("_") ? symbol : `${symbol}_USDT`;
      const r = await withTimeout(fetch(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${pair}`), 5000);
      const arr = await r.json();
      const t = Array.isArray(arr) ? arr[0] : null;
      if (!t) return res.status(200).json({ error: "تعذر جلب السعر", symbol: pair });
      return res.json({
        symbol: pair,
        price: parseFloat(t.last),
        change1d: Math.round(parseFloat(t.change_percentage) * 100) / 100,
        high: parseFloat(t.high_24h),
        low: parseFloat(t.low_24h),
        ts: Date.now()
      });
    }

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
    const r = await withTimeout(fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" }
    }), 5000);
    const json = await r.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) return res.status(200).json({ error: "تعذر جلب السعر", symbol });
    res.json({
      symbol,
      price: Math.round((meta.regularMarketPrice ?? 0) * 100) / 100,
      change1d: meta.previousClose
        ? Math.round(((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 10000) / 100
        : 0,
      high: meta.regularMarketDayHigh ?? null,
      low: meta.regularMarketDayLow ?? null,
      market_state: meta.marketState || null,
      ts: Date.now()
    });
  } catch (e) {
    res.status(200).json(upstreamError(e, { symbol }));
  }
});

// GET /proxy/news/:symbol?type=stock|crypto
app.get("/proxy/news/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const type = req.query.type === 'crypto' ? 'crypto' : 'stock';
  try {
    const news = await memoGet(`news_${type}_${symbol}`, () => fetchNews(symbol, type), 10 * 60000);
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

    // Parallel: congress (stocks only) + news + analysts
    const [congressResult, newsResult, analystsResult] = await Promise.allSettled([
      type === 'stock'
        ? fetchCongressTrades(symbol, 90)
        : Promise.resolve({ trades: [], buys: 0, sells: 0, total: 0 }),
      memoGet(`news_${type}_${symbol}`, () => fetchNews(symbol, type), 10 * 60000),
      type === 'stock'
        ? memoGet(`analysts_${symbol}`, () => fetchAnalystRecs(symbol), 60 * 60000)
        : Promise.resolve(null)
    ]);

    const congress  = congressResult.status  === 'fulfilled' ? congressResult.value  : { trades: [], buys: 0, sells: 0, total: 0 };
    const news      = newsResult.status      === 'fulfilled' ? newsResult.value      : [];
    const analysts  = analystsResult.status  === 'fulfilled' ? analystsResult.value  : null;

    const rec = buildRecommendation(analysis, congress, news);

    const analystsSummary = analysts ? {
      total_analysts: analysts.total_analysts,
      consensus:      analysts.consensus,
      consensus_ar:   analysts.consensus_ar,
      bullish_pct:    analysts.total_analysts > 0
        ? Math.round((analysts.strong_buy + analysts.buy) / analysts.total_analysts * 100)
        : 0,
      breakdown:      analysts.breakdown,
      price_targets:  analysts.price_targets,
      recent_actions: analysts.recent_actions.slice(0, 8)
    } : null;

    res.json({
      date: new Date().toISOString().split('T')[0],
      ...analysis,
      ...rec,
      congress_activity: congress.trades.slice(0, 10),
      recent_news:       news.slice(0, 6),
      analysts:          analystsSummary
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

// simulate one pass of the strategy; momentumFilter=true uses MACD+ROC hold logic
function _simulate(closes, volumes, times, macdData, rocArr, initialCapital, momentumFilter) {
  const n       = closes.length;
  const rsiArr  = calculateRSI(closes, 14);
  const obvArr  = calculateOBV(closes, volumes);
  const ma20Arr = calculateMA(closes, 20);

  let cash = initialCapital, shares = 0, inPosition = false;
  let entryPrice = 0, entryDate = null, peakPrice = 0;
  const trades = [], equity = [];
  const START   = 30;

  for (let i = START; i < n; i++) {
    const rsi      = rsiArr[i]  ?? 50;
    const ma20     = ma20Arr[i] ?? closes[i];
    const close    = closes[i];
    const obvTrend = getOBVTrendAt(obvArr, i);
    const aboveMA  = close > ma20;

    // === Momentum confirmation (MACD + ROC) ===
    const roc20       = rocArr[i] ?? 0;
    const macdAbove   = macdData.line[i] > macdData.signal[i];
    const momentumOn  = macdAbove && roc20 > 0;

    if (inPosition && close > peakPrice) peakPrice = close;

    // ---- Entry ----
    // الفلتر الأساسي: زخم صاعد فعلي (MACD + ROC) بدل الاعتماد فقط على RSI/OBV
    // فلتر الزخم: شرط أقوى — ROC أعلى يتطلب تسارعاً حقيقياً في السعر
    const buySignal = !inPosition
      && rsi >= 35 && rsi <= 58
      && obvTrend === 'rising'
      && aboveMA
      && macdAbove
      && (momentumFilter ? roc20 > 2 : roc20 > 0);

    // ---- Exit ----
    const stopLoss      = inPosition && close < entryPrice * 0.94;
    // وقف متحرك: بعد ربح ≥6% عن القمة، اقفل عند تراجع 4% من أعلى قمة لحماية الأرباح
    const trailingStop  = inPosition && peakPrice >= entryPrice * 1.06 && close < peakPrice * 0.96;
    const rsiExit       = inPosition && rsi > 72 && !momentumOn;
    const trendExit      = inPosition && !aboveMA && obvTrend === 'falling' && roc20 < -2;
    const macdFlip       = inPosition && !macdAbove && roc20 < -1 && rsi < 50; // MACD انقلب سلبي + سعر هابط

    const sellSignal = stopLoss || trailingStop || rsiExit || trendExit || macdFlip;

    if (buySignal) {
      shares = cash / close; entryPrice = close; entryDate = times[i]; cash = 0; inPosition = true; peakPrice = close;
    } else if (sellSignal) {
      const profitPct = ((close - entryPrice) / entryPrice) * 100;
      const reason    = stopLoss     ? 'وقف_خسارة'
        : trailingStop ? 'وقف_متحرك_حماية_ربح'
        : rsiExit      ? 'تشبع_شرائي'
        : macdFlip     ? 'انعكاس_MACD'
        : 'ضعف_مؤشرات';
      trades.push({
        entry_date:  new Date(entryDate).toISOString().split('T')[0],
        exit_date:   new Date(times[i]).toISOString().split('T')[0],
        entry_price: Math.round(entryPrice * 100) / 100,
        exit_price:  Math.round(close * 100) / 100,
        profit_pct:  Math.round(profitPct * 100) / 100,
        days_held:   Math.round((times[i] - entryDate) / 86400000),
        exit_reason: reason
      });
      cash = shares * close; shares = 0; inPosition = false; peakPrice = 0;
    }
    const val = inPosition ? shares * close : cash;
    if (i % 2 === 0) equity.push({ time: times[i], value: Math.round(val * 100) / 100 });
  }

  if (inPosition) {
    const lc = closes[n-1];
    trades.push({
      entry_date: new Date(entryDate).toISOString().split('T')[0],
      exit_date:  new Date(times[n-1]).toISOString().split('T')[0],
      entry_price: Math.round(entryPrice * 100) / 100,
      exit_price:  Math.round(lc * 100) / 100,
      profit_pct:  Math.round(((lc-entryPrice)/entryPrice)*10000)/100,
      days_held:   Math.round((times[n-1]-entryDate)/86400000),
      exit_reason: 'نهاية_الفترة'
    });
    cash = shares * lc;
  }

  const final      = Math.round(cash * 100) / 100;
  const totalRet   = ((final - initialCapital) / initialCapital) * 100;
  const periodD    = (times[n-1] - times[START]) / 86400000;
  const ann        = periodD > 30 ? (Math.pow(final/initialCapital, 365/periodD)-1)*100 : totalRet;
  const bh         = ((closes[n-1] - closes[START]) / closes[START]) * 100;
  const wins       = trades.filter(t => t.profit_pct > 0);
  const losses     = trades.filter(t => t.profit_pct <= 0);
  const winRate    = trades.length ? (wins.length/trades.length)*100 : 0;
  const avgWin     = wins.length   ? wins.reduce((a,t)=>a+t.profit_pct,0)/wins.length : 0;
  const avgLoss    = losses.length ? losses.reduce((a,t)=>a+t.profit_pct,0)/losses.length : 0;

  let peak = initialCapital, maxDD = 0;
  equity.forEach(e => {
    if (e.value > peak) peak = e.value;
    const dd = peak > 0 ? ((peak - e.value)/peak)*100 : 0;
    if (dd > maxDD) maxDD = dd;
  });

  const alpha = totalRet - bh;
  let verdict, verdictColor;
  if      (ann >= 30 && winRate >= 55) { verdict='ممتاز — النظام يتفوق على السوق بشكل واضح'; verdictColor='#3fb950'; }
  else if (ann >= 15 && winRate >= 50) { verdict='جيد — النظام مربح ومتفوق على المتوسط';     verdictColor='#58c96a'; }
  else if (ann >= 5  && totalRet > bh) { verdict='مقبول — أفضل من Buy & Hold لكن بفارق بسيط';verdictColor='#d29922'; }
  else if (totalRet > 0)               { verdict='ضعيف — النظام مربح لكن Buy & Hold أفضل منه'; verdictColor='#f0883e'; }
  else                                 { verdict='خسائر — النظام لم يكن مربحاً في هذه الفترة'; verdictColor='#f85149'; }

  return {
    final_value:       final,
    total_return:      Math.round(totalRet  * 100) / 100,
    annualized_return: Math.round(ann       * 100) / 100,
    buy_hold_return:   Math.round(bh        * 100) / 100,
    alpha:             Math.round(alpha     * 100) / 100,
    total_trades:      trades.length,
    winning_trades:    wins.length,
    losing_trades:     losses.length,
    win_rate:          Math.round(winRate   * 100) / 100,
    avg_win:           Math.round(avgWin    * 100) / 100,
    avg_loss:          Math.round(avgLoss   * 100) / 100,
    max_drawdown:      Math.round(maxDD     * 100) / 100,
    best_trade:        trades.length ? Math.max(...trades.map(t=>t.profit_pct)) : 0,
    worst_trade:       trades.length ? Math.min(...trades.map(t=>t.profit_pct)) : 0,
    period_days:       Math.round(periodD),
    verdict,
    verdict_color:     verdictColor,
    trades:            trades.slice(-15),
    equity_curve:      equity
  };
}

function runBacktest(candles, initialCapital = 10000) {
  const closes  = candles.map(c => parseFloat(c.close)  || 0);
  const volumes = candles.map(c => parseFloat(c.volume) || 0);
  const times   = candles.map(c => c.time);
  const macdData = calculateMACD(closes);
  const rocArr   = calculateROC(closes, 20);

  const basic    = _simulate(closes, volumes, times, macdData, rocArr, initialCapital, false);
  const momentum = _simulate(closes, volumes, times, macdData, rocArr, initialCapital, true);

  // Pick the equity curve of the momentum strategy for the chart
  // Return both for comparison
  return {
    initial_capital: initialCapital,
    // Main result = momentum strategy
    ...momentum,
    // Comparison
    comparison: {
      basic: {
        total_return:      basic.total_return,
        annualized_return: basic.annualized_return,
        win_rate:          basic.win_rate,
        max_drawdown:      basic.max_drawdown,
        total_trades:      basic.total_trades,
        verdict:           basic.verdict
      },
      momentum: {
        total_return:      momentum.total_return,
        annualized_return: momentum.annualized_return,
        win_rate:          momentum.win_rate,
        max_drawdown:      momentum.max_drawdown,
        total_trades:      momentum.total_trades,
        verdict:           momentum.verdict
      },
      buy_hold: {
        total_return: momentum.buy_hold_return
      }
    },
    // Both equity curves for the chart
    equity_basic:    basic.equity_curve,
    equity_momentum: momentum.equity_curve
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

// GET /proxy/ai/:symbol?type=stock|crypto&range=3mo
app.get("/proxy/ai/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const type   = req.query.type === 'crypto' ? 'crypto' : 'stock';
  const range  = ['1mo','3mo','6mo','1y'].includes(req.query.range) ? req.query.range : '3mo';

  try {
    let closes, highs, lows, opens, volumes, times;
    if (type === 'crypto') {
      const pair = symbol.includes('_') ? symbol : `${symbol}_USDT`;
      const url  = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=1d&limit=120`;
      const r    = await withTimeout(fetch(url), 8000);
      const raw  = await r.json();
      if (!Array.isArray(raw) || raw.length < 30) return res.json({ error: 'بيانات غير كافية', symbol });
      closes  = raw.map(c => parseFloat(c[2]));
      highs   = raw.map(c => parseFloat(c[3]));
      lows    = raw.map(c => parseFloat(c[4]));
      opens   = raw.map(c => parseFloat(c[5]));
      volumes = raw.map(c => parseFloat(c[1]));
      times   = raw.map(c => parseInt(c[0]) * 1000);
    } else {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
      const r   = await withTimeout(fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }), 8000);
      const json   = await r.json();
      const result = json?.chart?.result?.[0];
      if (!result) return res.json({ error: 'رمز السهم غير موجود', symbol });
      const q = result.indicators?.quote?.[0] || {};
      times   = (result.timestamp || []).map(t => t * 1000);
      closes  = (q.close  || []).map(v => v ?? 0);
      highs   = (q.high   || []).map(v => v ?? 0);
      lows    = (q.low    || []).map(v => v ?? 0);
      opens   = (q.open   || []).map(v => v ?? 0);
      volumes = (q.volume || []).map(v => v ?? 0);
    }
    // Filter zero-close candles
    const valid = times.reduce((acc, t, i) => {
      if (closes[i] > 0) acc.push({ t, o: opens[i], h: highs[i], l: lows[i], c: closes[i], v: volumes[i] });
      return acc;
    }, []);
    if (valid.length < 30) return res.json({ error: 'بيانات غير كافية', symbol });
    times   = valid.map(x => x.t);
    opens   = valid.map(x => x.o);
    highs   = valid.map(x => x.h);
    lows    = valid.map(x => x.l);
    closes  = valid.map(x => x.c);
    volumes = valid.map(x => x.v);

    const [congressRes, newsRes] = await Promise.allSettled([
      type === 'stock'
        ? fetchCongressTrades(symbol, 90)
        : Promise.resolve({ trades:[], buys:0, sells:0, total:0 }),
      memoGet(`news_${type}_${symbol}`, () => fetchNews(symbol, type), 10 * 60000)
    ]);
    const congress = congressRes.status === 'fulfilled' ? congressRes.value : { trades:[], buys:0, sells:0, total:0 };
    const news     = newsRes.status   === 'fulfilled' ? newsRes.value   : [];

    const ai = buildAIScore(closes, highs, lows, opens, volumes, congress, news);
    if (!ai) return res.json({ error: 'خطأ في الحساب', symbol });

    ai.chart_times  = times.slice(-60).map(t => { const d = new Date(t); return `${d.getMonth()+1}/${d.getDate()}`; });
    ai.close_series = closes.slice(-60).map(c => Math.round(c * 100) / 100);
    ai.current_price = Math.round(closes[closes.length - 1] * 100) / 100;
    res.json({ symbol, type, ...ai });
  } catch(e) {
    res.json(upstreamError(e, { symbol }));
  }
});

// ===== توصيات المحللين الوول ستريت =====
app.get("/proxy/analysts/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const data = await memoGet(`analysts_${symbol}`, () => fetchAnalystRecs(symbol), 60 * 60000);
    if (!data) return res.json({ symbol, error: 'تعذر جلب بيانات المحللين', available: false });

    const { total_analysts, strong_buy, buy, hold, sell, strong_sell,
            consensus, consensus_ar, consensus_mean, target_high, target_low,
            target_mean, target_median, recent_actions } = data;

    const bullish_pct = total_analysts > 0
      ? Math.round((strong_buy + buy) / total_analysts * 100)
      : 0;

    const meanLabel = consensus_mean
      ? (consensus_mean <= 1.5 ? 'شراء قوي جداً'
        : consensus_mean <= 2.5 ? 'شراء'
        : consensus_mean <= 3.5 ? 'احتفظ'
        : consensus_mean <= 4.5 ? 'بيع'
        : 'بيع قوي')
      : null;

    res.json({
      symbol,
      total_analysts,
      consensus,
      consensus_ar,
      consensus_mean: consensus_mean ? Math.round(consensus_mean * 100) / 100 : null,
      consensus_label: meanLabel,
      bullish_pct,
      breakdown: { strong_buy, buy, hold, sell, strong_sell },
      price_targets: { high: target_high, low: target_low, mean: target_mean, median: target_median },
      recent_actions: recent_actions.slice(0, 15),
      note: 'بيانات محللي وول ستريت المعتمدين — المصدر: Yahoo Finance'
    });
  } catch (e) {
    res.json(upstreamError(e, { symbol }));
  }
});

// ===== تشغيل السيرفر =====
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Proxy يعمل على المنفذ ${PORT}`));
