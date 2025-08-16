// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import GateApi from "gate-api";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
// أضف هذا في server.js بعد app.use(express.json());
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(__dirname));

// إعداد Gate API Client
const client = new GateApi.ApiClient();
client.setApiKeySecret(process.env.GATEIO_API_KEY, process.env.GATEIO_API_SECRET);
const spotApi = new GateApi.SpotApi(client);

// ✅ Health Check
app.get("/healthz", (req, res) => res.json({ status: "ok" }));

// ✅ رصيد المحفظة
app.get("/proxy/balances", async (req, res) => {
  try {
    const result = await spotApi.listSpotAccounts();
    res.json(result.body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ الأوامر المفتوحة
app.get("/proxy/orders/open", async (req, res) => {
  try {
    const result = await spotApi.listSpotOrders({ status: "open" });
    res.json(result.body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ إنشاء أمر شراء/بيع
app.post("/proxy/orders", async (req, res) => {
  try {
    const order = {
      currency_pair: req.body.currency_pair, // مثل: BTC_USDT
      type: req.body.type || "market",       // market أو limit
      side: req.body.side,                   // buy أو sell
      amount: req.body.amount,               // مثل: 0.001
      price: req.body.price                  // مطلوب فقط للـ limit
    };

    const result = await spotApi.createOrder(order);
    res.json(result.body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ إلغاء أمر
app.delete("/proxy/orders/:id", async (req, res) => {
  try {
    const result = await spotApi.cancelOrder(req.params.id, req.query.currency_pair);
    res.json(result.body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ سجل الأوامر المنفذة
app.get("/proxy/orders/history", async (req, res) => {
  try {
    const result = await spotApi.listSpotOrders({ status: "finished" });
    res.json(result.body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🚀 تشغيل السيرفر
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Proxy يعمل على المنفذ ${PORT}`));
