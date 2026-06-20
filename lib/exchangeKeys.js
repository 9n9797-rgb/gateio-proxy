// lib/exchangeKeys.js
// تخزين واسترجاع مفاتيح Gate.io الخاصة بكل مستخدم بشكل مشفّر. السر بالنص
// الصريح لا يُحمَّل في الذاكرة إلا لحظة إنشاء عميل Gate.io لتنفيذ صفقة حقيقية.

import GateApi from "gate-api";
import db from "./db.js";
import { encrypt, decrypt } from "./crypto.js";

export function setKeys(userId, apiKey, apiSecret) {
  if (!apiKey || !apiSecret) throw new Error("api_key و api_secret مطلوبان");
  db.prepare(
    `INSERT INTO exchange_keys (user_id, api_key_enc, api_secret_enc, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET api_key_enc = excluded.api_key_enc, api_secret_enc = excluded.api_secret_enc, updated_at = excluded.updated_at`
  ).run(userId, encrypt(apiKey), encrypt(apiSecret), new Date().toISOString());
}

export function removeKeys(userId) {
  db.prepare("DELETE FROM exchange_keys WHERE user_id = ?").run(userId);
}

export function hasKeys(userId) {
  return Boolean(db.prepare("SELECT 1 FROM exchange_keys WHERE user_id = ?").get(userId));
}

// يُرجع عميل SpotApi جاهز لمستخدم معيّن، أو null إن لم يربط مفاتيحه
export function getSpotApiFor(userId) {
  const row = db.prepare("SELECT * FROM exchange_keys WHERE user_id = ?").get(userId);
  if (!row) return null;

  const apiKey = decrypt(row.api_key_enc);
  const apiSecret = decrypt(row.api_secret_enc);
  const client = new GateApi.ApiClient();
  client.setApiKeySecret(apiKey, apiSecret);
  return new GateApi.SpotApi(client);
}
