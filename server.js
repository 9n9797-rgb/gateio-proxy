import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

const API_KEY = process.env.GATEIO_API_KEY;
const API_SECRET = process.env.GATEIO_API_SECRET;

// ✅ دالة تجيب توقيت Gate.io (ثواني Unix)
async function getServerTime() {
  const r = await fetch("https://api.gateio.ws/api/v4/time");
  const data = await r.json();
  return data.server_time.toString();
}

// ✅ دالة التوقيع (مع Debug Logs)
async function signRequest(method, endpoint, query_string = "", body = "") {
  const ts = await getServerTime(); // 🕒 التوقيت من Gate.io نفسه

  const body_str = body && Object.keys(body).length > 0 ? JSON.stringify(body) : "";
  const payload = [method.toUpperCase(), endpoint, query_string, body_str, ts].join("\n");

  // 📝 Debug logs
  console.log("=== SIGN DEBUG ===");
  console.log("Payload:\n", payload);
  console.log("Timestamp (Gate.io):", ts);

  const signature = crypto
    .createHmac("sha512", API_SECRET)
    .update(payload)
    .digest("hex");

  console.log("Signature:", signature);
  console.log("=================");

  return { signature, timestamp: ts };
}

// ✅ Helper: قراءة الرد (JSON أو نص خام)
async function parseGateResponse(r, res) {
  const text = await r.text();
  try {
    const data = JSON.parse(text);
    res.json(data);
  } catch {
    console.error("Gate.io raw response:", text);
    res.status(r.status).send(text);
  }
}

// ✅ Endpoint: رصيد الحساب
app.get("/proxy/balances", async (req, res) => {
  try {
    const endpoint = "/api/v4/spot/accounts";
    const url = `https://api.gateio.ws${endpoint}`;
    const { signature, timestamp } = await signRequest("GET", endpoint);

    const r = await fetch(url, {
      method: "GET",
      headers: {
        "KEY": API_KEY,
        "SIGN": signature,
        "Timestamp": timestamp,
        "Content-Type": "application/json",
      },
    });

    await parseGateResponse(r, res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ Endpoint: إنشاء أمر (شراء/بيع)
app.post("/proxy/orders", async (req, res) => {
  try {
    const endpoint = "/api/v4/spot/orders";
    const url = `https://api.gateio.ws${endpoint}`;
    const body = req.body;
    const { signature, timestamp } = await signRequest("POST", endpoint, "", body);

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

    await parseGateResponse(r, res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ Health check
app.get("/healthz", (req, res) => res.status(200).send("OK"));

// 🚀 تشغيل السيرفر
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Proxy يعمل على المنفذ ${PORT}`));
