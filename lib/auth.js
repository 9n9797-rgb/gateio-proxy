// lib/auth.js
// تسجيل/دخول بكلمة سر تقليدية + استعادة كلمة السر برمز يُرسل للبريد.
// كلمات السر تُخزَّن مُجزَّأة (scrypt + ملح عشوائي لكل مستخدم) ولا تُحفظ كنص صريح.

import db from "./db.js";
import { hashCode, hashPassword, verifyPassword, randomToken, randomLoginCode } from "./crypto.js";
import { sendResetCode } from "./mailer.js";

const RESET_CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 يوم
const MAX_RESET_REQUESTS_PER_HOUR = 5;
const MIN_PASSWORD_LENGTH = 8;

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPassword(password) {
  return typeof password === "string" && password.length >= MIN_PASSWORD_LENGTH;
}

function createSession(userId) {
  const token = randomToken();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(
    token,
    userId,
    Date.now() + SESSION_TTL_MS
  );
  return token;
}

export function register(email, password) {
  if (!isValidEmail(email)) throw new Error("بريد إلكتروني غير صالح");
  if (!isValidPassword(password)) throw new Error(`كلمة السر يجب أن تكون ${MIN_PASSWORD_LENGTH} أحرف على الأقل`);

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) throw new Error("هذا البريد مسجَّل بالفعل، سجّل الدخول بدلاً من ذلك");

  const r = db
    .prepare("INSERT INTO users (email, created_at, password_hash) VALUES (?, ?, ?)")
    .run(email, new Date().toISOString(), hashPassword(password));
  const userId = r.lastInsertRowid;

  db.prepare("INSERT INTO user_settings (user_id) VALUES (?)").run(userId);
  db.prepare(
    "INSERT INTO paper_wallets (user_id, cash, created_at) VALUES (?, ?, ?)"
  ).run(userId, Number(process.env.PAPER_START_BALANCE || 10000), new Date().toISOString());

  const token = createSession(userId);
  return { token, user: { id: userId, email } };
}

export function login(email, password) {
  if (!isValidEmail(email) || !password) throw new Error("بريد أو كلمة سر غير صحيحة");

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) throw new Error("بريد أو كلمة سر غير صحيحة");
  if (user.disabled) throw new Error("تم تعطيل حسابك، تواصل مع الدعم");
  if (!user.password_hash) {
    throw new Error("هذا الحساب لا يملك كلمة سر بعد، استخدم \"استعادة كلمة السر\" لتعيين واحدة");
  }
  if (!verifyPassword(password, user.password_hash)) throw new Error("بريد أو كلمة سر غير صحيحة");

  const token = createSession(user.id);
  return { token, user: { id: user.id, email: user.email } };
}

// نفس الرمز المُرسَل للبريد يُستخدم أيضاً لمن لديه حساب قديم بلا كلمة سر
// (تُعيَّن له كلمة سر جديدة عبر هذا المسار بدلاً من بناء مسار ترحيل منفصل)
export async function requestPasswordReset(email) {
  if (!isValidEmail(email)) throw new Error("بريد إلكتروني غير صالح");

  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentCount = db
    .prepare("SELECT COUNT(*) AS n FROM password_resets WHERE email = ? AND created_at > ?")
    .get(email, oneHourAgo).n;
  if (recentCount >= MAX_RESET_REQUESTS_PER_HOUR) {
    throw new Error("عدد كبير من الطلبات، حاول لاحقاً");
  }

  const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!user) return true; // لا نكشف عدم وجود الحساب لمن يطلب الاستعادة

  const code = randomLoginCode();
  db.prepare(
    "INSERT INTO password_resets (email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).run(email, hashCode(code), Date.now() + RESET_CODE_TTL_MS, Date.now());

  await sendResetCode(email, code);
  return true;
}

export function resetPassword(email, code, newPassword) {
  if (!isValidEmail(email) || !code) throw new Error("بيانات غير صالحة");
  if (!isValidPassword(newPassword)) throw new Error(`كلمة السر يجب أن تكون ${MIN_PASSWORD_LENGTH} أحرف على الأقل`);

  const row = db
    .prepare(
      "SELECT * FROM password_resets WHERE email = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1"
    )
    .get(email, Date.now());
  if (!row || row.code_hash !== hashCode(code)) throw new Error("رمز غير صحيح أو منتهي");

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) throw new Error("الحساب غير موجود");

  db.prepare("UPDATE password_resets SET used = 1 WHERE id = ?").run(row.id);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), user.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id); // إنهاء كل الجلسات القديمة احتياطاً

  return true;
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
  if (user.disabled) return res.status(403).json({ ok: false, error: "تم تعطيل حسابك، تواصل مع الدعم" });

  req.user = user;
  next();
}

export function logout(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

// صلاحية الأدمن: عبر متغير بيئة ADMIN_EMAILS بصيغة "a@x.com,b@y.com"
function adminEmails() {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email) {
  return adminEmails().includes(String(email || "").trim().toLowerCase());
}

export function requireAdmin(req, res, next) {
  if (!req.user || !isAdminEmail(req.user.email)) {
    return res.status(403).json({ ok: false, error: "صلاحيات أدمن مطلوبة" });
  }
  next();
}
