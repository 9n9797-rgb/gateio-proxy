// lib/store.js
// تخزين بسيط على شكل ملفات JSON (بدون قاعدة بيانات خارجية) لسهولة النشر على أي VPS.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

export function readJSON(name, fallback) {
  const p = filePath(name);
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJSON(name, data) {
  const p = filePath(name);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

export function appendJSONArray(name, item, maxItems = 5000) {
  const arr = readJSON(name, []);
  arr.push(item);
  if (arr.length > maxItems) arr.splice(0, arr.length - maxItems);
  writeJSON(name, arr);
  return arr;
}
