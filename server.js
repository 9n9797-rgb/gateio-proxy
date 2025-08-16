import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

const API_KEY = process.env.GATEIO_API_KEY;
const API_SECRET = process.env.GATEIO_API_SECRET;

function signRequest(method, url, query_string, body) {
  const timestamp = Math.floor(Date.now() / 1000);
  const body_str = body ? JSON.stringify(body) : "";
  const payload = `${method}\n${url}\n${query_string}\n${body_str}\n${timestamp}`;
  const hmac = crypto.createHmac("sha512", API_SECRET);
  hmac.update(payload);
  const signature = hmac.digest("hex");
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
        "Timestamp": timestamp,
        "SIGN": signature,
        "Content-Type": "application/json",
      },
    });

    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ Endpoint لإنشاء أمر
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
        "Timestamp": timestamp,
        "SIGN": signature,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Proxy يعمل على المنفذ ${PORT}`));
