import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

const API_KEY = process.env.GATEIO_API_KEY;
const API_SECRET = process.env.GATEIO_API_SECRET;

async function getServerTime() {
  const r = await fetch("https://api.gateio.ws/api/v4/time");
  const data = await r.json();
  return data.server_time.toString();
}

async function signRequest(method, endpoint, query_string = "", body = "") {
  const ts = await getServerTime();
  const body_str = body && Object.keys(body).length > 0 ? JSON.stringify(body) : "";
  const payload = [method.toUpperCase(), endpoint, query_string, body_str, ts].join("\n");

  const signature = crypto
    .createHmac("sha512", API_SECRET)
    .update(payload)
    .digest("hex");

  return { signature, timestamp: ts };
}

// ✅ Helper: يرجع الرد الخام للعميل مباشرة
async function parseGateResponse(r, res) {
  const text = await r.text();
  const headers = Object.fromEntries(r.headers.entries());

  res.status(r.status).json({
    status: r.status,
    headers: headers,
    body: text
  });
}

// 🆕 نسخة تحقق
app.get("/version-check", (req, res) => {
  res.json({
    version: "v3.0",
    parsePreview: parseGateResponse.toString().slice(0, 200)
  });
});

// 🆕 Debug مطلق لمسار balances
app.get("/proxy/balances", async (req, res) => {
  console.log("🚀 دخل فعلياً على /proxy/balances v3.0");
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

    const text = await r.text();
    console.log("=== RAW RESPONSE FROM GATE.IO ===");
    console.log(text);
    console.log("================================");

    res.status(200).json({
      debug: true,
      status: r.status,
      headers: Object.fromEntries(r.headers.entries()),
      raw: text
    });
  } catch (e) {
    console.error("❌ ERROR in /proxy/balances:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/proxy/orders", async (req, res) => {
  console.log("🚀 دخل فعلياً على /proxy/orders v3.0");
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

    const text = await r.text();
    console.log("=== RAW ORDER RESPONSE ===");
    console.log(text);
    console.log("==========================");

    res.status(200).json({
      debug: true,
      status: r.status,
      headers: Object.fromEntries(r.headers.entries()),
      raw: text
    });
  } catch (e) {
    console.error("❌ ERROR in /proxy/orders:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/healthz", (req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Proxy v3.0 يعمل على المنفذ ${PORT}`));
