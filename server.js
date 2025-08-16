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

// ✅ Helper: preview raw response
async function parseGateResponse(r, res) {
  const text = await r.text();
  const headers = Object.fromEntries(r.headers.entries());

  try {
    const data = JSON.parse(text);
    res.json(data);
  } catch {
    console.error("❌ ERROR in parseGateResponse, Gate.io raw reply:");
    console.error(text.slice(0, 300)); // اطبع أول 300 حرف باللوق

    res.status(r.status).json({
      status: r.status,
      headers,
      preview: text.slice(0, 500) // أول 500 حرف بس
    });
  }
}

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

// 🆕 Debug endpoint: يرجع الرد الخام
app.get("/proxy/debug-balances", async (req, res) => {
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
    res.status(r.status).json({
      status: r.status,
      preview: text.slice(0, 500) // أول 500 حرف
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/healthz", (req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Debug Proxy يعمل على المنفذ ${PORT}`));
