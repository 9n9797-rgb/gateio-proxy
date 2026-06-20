// lib/auth.js
// تسجيل دخول بدون كلمة مرور: المستخدم يطلب رمزاً يُرسل إلى بريده، ثم يدخله
// للحصول على جلسة (Session Token). لا توجد كلمات مرور لتُسرَّب أو تُخترق.

import db from "./db.js";
import { hashCode, randomToken, randomLoginCode } from "./crypto.js";
import { sendLoginCode } from "./mailer.js";

const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 يوم
const MAX_REQUESTS_PER_HOUR = 5;

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function requestLoginCode(email) {
  if (!isValidEmail(email)) throw new Error("بريد إلكتروني غير صالح");

  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentCount = db
    .prepare("SELECT COUNT(*) AS n FROM login_codes WHERE email = ? AND created_at > ?")
    .get(email, oneHourAgo).n;
  if (recentCount >= MAX_REQUESTS_PER_HOUR) {
    throw new Error("عدد كبير من الطلبات، حاول لاحقاً");
  }

  const code = randomLoginCode();
  db.prepare(
    "INSERT INTO login_codes (email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).run(email, hashCode(code), Date.now() + CODE_TTL_MS, Date.now());

  await sendLoginCode(email, code);
  return true;
}

export function verifyLoginCode(email, code) {
  if (!isValidEmail(email) || !code) throw new Error("بيانات غير صالحة");

  const row = db
    .prepare(
      "SELECT * FROM login_codes WHERE email = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1"
    )
    .get(email, Date.now());
  if (!row || row.code_hash !== hashCode(code)) throw new Error("رمز غير صحيح أو منتهي");

  db.prepare("UPDATE login_codes SET used = 1 WHERE id = ?").run(row.id);

  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) {
    const r = db
      .prepare("INSERT INTO users (email, created_at) VALUES (?, ?)")
      .run(email, new Date().toISOString());
    user = { id: r.lastInsertRowid, email };
    db.prepare(
      "INSERT INTO user_settings (user_id) VALUES (?)"
    ).run(user.id);
    db.prepare(
      "INSERT INTO paper_wallets (user_id, cash, created_at) VALUES (?, ?, ?)"
    ).run(user.id, Number(process.env.PAPER_START_BALANCE || 10000), new Date().toISOString());
  }

  const token = randomToken();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(
    token,
    user.id,
    Date.now() + SESSION_TTL_MS
  );
  return { token, user: { id: user.id, email: user.email } };
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: "تسجيل الدخول مطلوب" });

  const session = db
    .prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > ?")
    .get(token, Date.now());
  if (!session) return res.status(401).json({ ok: false, error: "الجلسة غير صالحة أو منتهية" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id);
  if (!user) return res.status(401).json({ ok: false, error: "المستخدم غير موجود" });

  req.user = user;
  next();
}

export function logout(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
