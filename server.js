import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

const API_KEY = process.env.GATEIO_API_KEY;
const API_SECRET = process.env.GATEIO_API_SECRET;

// ✅ دالة التوقيع (مصدرها من مستندات Gate.io الرسمية)
function signRequest(method, endpoint, query_string, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body_str = body ? JSON.stringify(body) : "";
  const payload = [method, endpoint, query_string, body_str, timestamp].join("\n");

  const signature = crypto
    .createHmac("sha512", API_SECRET)
    .update(payload)
    .digest("hex");

  return { signature, timestamp };
}

// ✅ Endpoint لعرض الرصيد
app.get("/proxy/balances", async (req, res) => {
  try {
    const endpoint = "/api/v4/spot/accounts";
    const url = `https://api.gateio.ws${endpoint}`;
    const { signature, timestamp } = signRequest("GET", endpoint, "", null);

    const r = await fetch(url, {
      method: "GET",
      headers: {
        "KEY": API_KEY,
        "SIGN": signature,
        "Timestamp": timestamp,
        "Content-Type": "application/json",
      },
    });

    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ Endpoint لإنشاء أمر (شراء/بيع)
app.post("/proxy/orders", async (req, res) => {
  try {
    const endpoint = "/api/v4/spot/orders";
    const url = `https://api.gateio.ws${endpoint}`;
    const body = req.body;
    const { signature, timestamp } = signRequest("POST", endpoint, "", body);

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "KEY": API_KEY,
        "SIGN": signature,
        "Timestamp": timestamp,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ Endpoint صحي لفحص الخدمة
app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

// 🚀 تشغيل السيرفر
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Proxy يعمل على المنفذ ${PORT}`));
