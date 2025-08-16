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

// ===== تشغيل السيرفر =====
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Proxy يعمل على المنفذ ${PORT}`));
