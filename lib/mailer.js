// lib/mailer.js
// إرسال رمز تسجيل الدخول بالبريد. إن لم تُضبط بيانات SMTP في .env يطبع
// النظام الرمز في سجل الخادم (Console) فقط — هذا للتجربة المحلية ولا يصلح
// للإنتاج إطلاقاً، لأن أي شخص يقرأ السجلات سيرى رموز دخول المستخدمين.

import nodemailer from "nodemailer";

function isSmtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  return transporter;
}

export async function sendResetCode(email, code) {
  if (!isSmtpConfigured()) {
    console.log(`⚠️  [DEV ONLY] لم يتم ضبط SMTP — رمز استعادة كلمة السر لـ ${email} هو: ${code}`);
    return { dev: true };
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await getTransporter().sendMail({
    from,
    to: email,
    subject: "رمز استعادة كلمة السر",
    text: `رمز استعادة كلمة السر الخاص بك: ${code}\nصالح لمدة 10 دقائق. إن لم تطلب هذا، تجاهل الرسالة.`
  });
  return { dev: false };
}
