// lib/crypto.js
// تشفير مفاتيح Gate.io الخاصة بكل مستخدم (AES-256-GCM) قبل حفظها في قاعدة
// البيانات، وتجزئة رموز تسجيل الدخول (OTP) بدلاً من تخزينها كنص صريح.

import crypto from "crypto";

function getMasterKey() {
  const hex = process.env.APP_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "APP_ENCRYPTION_KEY مطلوب (مفتاح AES-256 بصيغة hex من 64 حرفاً). أنشئه بالأمر: openssl rand -hex 32"
    );
  }
  return Buffer.from(hex, "hex");
}

export function encrypt(plainText) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decrypt(payloadB64) {
  const key = getMasterKey();
  const buf = Buffer.from(payloadB64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function randomLoginCode() {
  return String(crypto.randomInt(100000, 1000000)); // 6 أرقام
}
