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
import { readJSON } from "./lib/store.js";
import { calculateRSI, calculateOBV, getOBVTrend, calculateMA } from "./lib/indicators.js";

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

// ===== الأوتوبايلوت: التداول الآلي بالذكاء الصناعي =====
autopilot.init(spotApi);

// حالة الأوتوبايلوت الحالية
app.get("/autopilot/status", (req, res) => {
  const state = autopilot.getState();
  const wallet = paper.getPortfolio();
  res.json({
    mode: state.mode,
    pairs: state.pairs,
    cycles_run: state.cyclesRun,
    last_run_at: state.lastRunAt,
    last_error: state.lastError,
    live_positions: state.livePositions,
    paper_positions: wallet.positions,
    risk_config: risk.getRiskConfig()
  });
});

// تغيير وضع التشغيل: off | signal | paper | live
app.post("/autopilot/mode", (req, res) => {
  try {
    const state = autopilot.setMode(req.body.mode);
    res.json({ ok: true, mode: state.mode });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// تحديث قائمة الأزواج المتابَعة
app.post("/autopilot/pairs", (req, res) => {
  const pairs = Array.isArray(req.body.pairs) ? req.body.pairs : [];
  if (!pairs.length) return res.status(400).json({ ok: false, error: "pairs مطلوبة" });
  const state = autopilot.setPairs(pairs);
  res.json({ ok: true, pairs: state.pairs });
});

// سجل الصفقات المغلقة (حقيقية وتجريبية)
app.get("/autopilot/trades", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const journal = readJSON("trade-journal", []);
  res.json(journal.slice(-limit).reverse());
});

// محفظة التداول الوهمي (Paper Trading) لتطوير الذكاء الصناعي بدون مخاطرة
app.get("/autopilot/portfolio", (req, res) => {
  const wallet = paper.getPortfolio();
  res.json({
    cash: wallet.cash,
    positions: wallet.positions,
    realized_pnl: wallet.realizedPnl,
    equity: paper.equity(wallet, {}),
    created_at: wallet.createdAt
  });
});

// إعادة تصفير المحفظة الوهمية للبدء من جديد
app.post("/autopilot/portfolio/reset", (req, res) => {
  const wallet = paper.resetPortfolio();
  res.json({ ok: true, wallet });
});

// أوزان المؤشرات التي تعلّمها النظام من نتائج الصفقات السابقة
app.get("/autopilot/weights", (req, res) => {
  res.json(strategy.getWeights());
});

app.post("/autopilot/weights/reset", (req, res) => {
  res.json(strategy.resetWeights());
});

// استئناف الأوتوبايلوت تلقائياً إذا كان يعمل قبل آخر إعادة تشغيل للخادم
autopilot.bootstrapFromSavedState();

// ===== تشغيل السيرفر =====
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Proxy يعمل على المنفذ ${PORT}`));
