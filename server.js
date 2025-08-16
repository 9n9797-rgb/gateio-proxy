import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import GateApi from "gate-api";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const config = new GateApi.Configuration({
  key: process.env.GATEIO_API_KEY,
  secret: process.env.GATEIO_API_SECRET,
});
const spotApi = new GateApi.SpotApi(config);

// ==================== API ====================

// Health check
app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

// 🔹 عرض الرصيد
app.get("/proxy/balances", async (req, res) => {
  try {
    const result = await spotApi.listSpotAccounts();
    res.json(result.body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🔹 إنشاء طلب (شراء/بيع)
app.post("/proxy/orders", async (req, res) => {
  try {
    const order = new GateApi.Order(req.body);
    const result = await spotApi.createOrder(order);
    res.json(result.body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== OpenAPI ====================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.get("/openapi.yaml", (req, res) => {
  const yamlPath = path.join(__dirname, "openapi.yaml");
  if (fs.existsSync(yamlPath)) {
    res.setHeader("Content-Type", "application/yaml");
    res.sendFile(yamlPath);
  } else {
    res.status(404).send("openapi.yaml not found");
  }
});

// ==================== Run Server ====================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
