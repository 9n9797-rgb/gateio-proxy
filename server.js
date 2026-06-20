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
import * as autopilot from "./lib/autopilot.js";
import * as paper from "./lib/portfolio.js";
import * as strategy from "./lib/strategy.js";
import * as risk from "./lib/riskManager.js";
import { calculateRSI, calculateOBV, getOBVTrend, calculateMA } from "./lib/indicators.js";
import db from "./lib/db.js";
import { requestLoginCode, verifyLoginCode, requireAuth, logout } from "./lib/auth.js";
import { setKeys, removeKeys, hasKeys } from "./lib/exchangeKeys.js";
import { executeRecommendation, dismissRecommendation } from "./lib/autopilot.js";

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

// ===== حسابات المؤشرات الفنية: مستوردة من lib/indicators.js (مشتركة مع الأوتوبايلوت) =====

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

// ===== تسجيل الدخول بدون كلمة مرور (رمز يُرسل للبريد) =====
app.post("/auth/request-code", async (req, res) => {
  try {
    await requestLoginCode(req.body.email);
    res.json({ ok: true, message: "تم إرسال رمز الدخول إلى بريدك" });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/auth/verify-code", (req, res) => {
  try {
    const result = verifyLoginCode(req.body.email, req.body.code);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/auth/logout", requireAuth, (req, res) => {
  logout(req.headers.authorization.slice(7));
  res.json({ ok: true });
});

app.get("/account/me", requireAuth, (req, res) => {
  res.json({ id: req.user.id, email: req.user.email, has_exchange_keys: hasKeys(req.user.id) });
});

// ===== ربط/فك ربط مفاتيح Gate.io الخاصة بالمستخدم (تُشفّر قبل الحفظ) =====
app.post("/account/exchange-keys", requireAuth, (req, res) => {
  try {
    setKeys(req.user.id, req.body.api_key, req.body.api_secret);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.delete("/account/exchange-keys", requireAuth, (req, res) => {
  removeKeys(req.user.id);
  res.json({ ok: true });
});

app.get("/account/exchange-keys/status", requireAuth, (req, res) => {
  res.json({ connected: hasKeys(req.user.id) });
});

// ===== الأوتوبايلوت: التداول الآلي بالذكاء الصناعي (لكل مستخدم بياناته الخاصة) =====

function getUserSettings(userId) {
  const row = db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(userId);
  return {
    execution: row.execution,
    decision_mode: row.decision_mode,
    pairs: (row.pairs || "").split(",").map(s => s.trim()).filter(Boolean)
  };
}

app.get("/autopilot/status", requireAuth, (req, res) => {
  const settings = getUserSettings(req.user.id);
  const wallet = paper.getPortfolio(req.user.id);
  const livePositions = db.prepare("SELECT * FROM live_positions WHERE user_id = ?").all(req.user.id);
  res.json({
    execution: settings.execution,
    decision_mode: settings.decision_mode,
    pairs: settings.pairs,
    has_exchange_keys: hasKeys(req.user.id),
    paper_positions: wallet.positions,
    live_positions: livePositions,
    risk_config: risk.getRiskConfig()
  });
});

// تحديث إعدادات الأوتوبايلوت: وضع التنفيذ والقرار والأزواج المتابَعة
app.post("/autopilot/settings", requireAuth, (req, res) => {
  const { execution, decision_mode, pairs } = req.body;
  if (execution && !["off", "paper", "live"].includes(execution)) {
    return res.status(400).json({ ok: false, error: "execution غير صالح" });
  }
  if (execution === "live" && process.env.AUTOPILOT_ALLOW_LIVE !== "true") {
    return res.status(400).json({ ok: false, error: "التداول الحقيقي معطّل على هذا الخادم (AUTOPILOT_ALLOW_LIVE)" });
  }
  if (execution === "live" && !hasKeys(req.user.id)) {
    return res.status(400).json({ ok: false, error: "اربط مفاتيح Gate.io أولاً من /account/exchange-keys" });
  }
  if (decision_mode && !["auto", "recommend_only"].includes(decision_mode)) {
    return res.status(400).json({ ok: false, error: "decision_mode غير صالح" });
  }

  const current = getUserSettings(req.user.id);
  const next = {
    execution: execution ?? current.execution,
    decision_mode: decision_mode ?? current.decision_mode,
    pairs: Array.isArray(pairs) && pairs.length ? pairs.join(",") : current.pairs.join(",")
  };
  db.prepare(
    "UPDATE user_settings SET execution = ?, decision_mode = ?, pairs = ? WHERE user_id = ?"
  ).run(next.execution, next.decision_mode, next.pairs, req.user.id);

  res.json({ ok: true, settings: getUserSettings(req.user.id) });
});

// سجل الصفقات المغلقة (حقيقية وتجريبية)
app.get("/autopilot/trades", requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const rows = db
    .prepare("SELECT * FROM trades WHERE user_id = ? ORDER BY id DESC LIMIT ?")
    .all(req.user.id, limit);
  res.json(rows.map(r => ({ ...r, votes: r.votes ? JSON.parse(r.votes) : {} })));
});

// التوصيات المعلّقة (لمن اختار وضع "توصيات فقط")
app.get("/autopilot/recommendations", requireAuth, (req, res) => {
  const status = req.query.status || "pending";
  const rows = db
    .prepare("SELECT * FROM recommendations WHERE user_id = ? AND status = ? ORDER BY id DESC LIMIT 100")
    .all(req.user.id, status);
  res.json(rows.map(r => ({ ...r, votes: r.votes ? JSON.parse(r.votes) : {} })));
});

app.post("/autopilot/recommendations/:id/execute", requireAuth, async (req, res) => {
  try {
    await executeRecommendation(req.user.id, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/autopilot/recommendations/:id/dismiss", requireAuth, (req, res) => {
  try {
    dismissRecommendation(req.user.id, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// محفظة التداول الوهمي (Paper Trading) لتطوير الذكاء الصناعي بدون مخاطرة
app.get("/autopilot/portfolio", requireAuth, (req, res) => {
  const wallet = paper.getPortfolio(req.user.id);
  res.json({
    cash: wallet.cash,
    positions: wallet.positions,
    realized_pnl: wallet.realizedPnl,
    equity: paper.equity(wallet, {}),
    created_at: wallet.createdAt
  });
});

// إعادة تصفير المحفظة الوهمية للبدء من جديد
app.post("/autopilot/portfolio/reset", requireAuth, (req, res) => {
  const wallet = paper.resetPortfolio(req.user.id);
  res.json({ ok: true, wallet });
});

// أوزان المؤشرات التي تعلّمها النظام من نتائج صفقات هذا المستخدم
app.get("/autopilot/weights", requireAuth, (req, res) => {
  res.json(strategy.getWeights(req.user.id));
});

app.post("/autopilot/weights/reset", requireAuth, (req, res) => {
  res.json(strategy.resetWeights(req.user.id));
});

// تشغيل حلقة الأوتوبايلوت (تفحص كل المستخدمين النشطين دورياً)
autopilot.startLoop();

// ===== تشغيل السيرفر =====
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Proxy يعمل على المنفذ ${PORT}`));
