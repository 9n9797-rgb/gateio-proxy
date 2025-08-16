import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

const API_KEY = process.env.GATEIO_API_KEY;
const API_SECRET = process.env.GATEIO_API_SECRET;

// ✅ دالة التوقيع مع Debug Logs
function signRequest(method, endpoint, query_string = "", body = "") {
  const ts = Math.floor(Date.now() / 1000).toString();
  const body_str = body && Object.keys(body).length > 0 ? JSON.stringify(body) : "";
  const payload = [method.toUpperCase(), endpoint, query_string, body_str, ts].join("\n");

  // 📝 Debug logs
  console.log("🔑 Signing payload:");
  console.log(payload);
  console.log("⏱ Timestamp:", ts);

  const signature = crypto
    .createHmac("sha512", API_SECRET)
    .update(payload)
    .digest("hex");

  console.log("✅ Signature:", signature);

  return { signature, timestamp: ts };
}

// ✅ Endpoint لعرض الرصيد
app.get("/proxy/balances", async (req, res) => {
  try {
    const endpoint = "/api/v4/spot/accounts";
    const url = `https://api.gateio.ws${endpoint}`;
    const { signature, timestamp } = signRequest("GET", endpoint);

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

// ✅ Health check
app.get("/healthz", (req, res) => res.status(200).send("OK"));

// 🚀 تشغيل السيرفر
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Proxy يعمل على المنفذ ${PORT}`));
