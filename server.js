// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import GateApi from "gate-api";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// إعداد Gate API
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

// ✅ إنشاء أمر (شراء / بيع)
app.post("/proxy/orders", async (req, res) => {
  try {
    const order = {
      currency_pair: req.body.currency_pair, // "BTC_USDT"
      type: req.body.type || "limit",       // "limit" or "market"
      side: req.body.side,                  // "buy" or "sell"
      amount: req.body.amount,              // "0.001"
      price: req.body.price                 // مطلوب فقط للـ LIMIT
    };

    const result = await spotApi.createSpotOrder(order);
    res.json(result.body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ إلغاء أمر
app.delete("/proxy/orders/:id", async (req, res) => {
  try {
    const result = await spotApi.cancelSpotOrder(req.params.id, { currency_pair: req.query.currency_pair });
    res.json(result.body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ سجل الأوامر
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
