// lib/priceStream.js
// بث السعر اللحظي عبر WebSocket: اتصال واحد فقط مع Gate.io (spot.tickers)
// يُعاد توزيع تحديثاته على كل عملاء المتصفح المشتركين بنفس الزوج، بدل أن
// يستعلم كل عميل عبر polling كل عدة ثوانٍ — يقلّل التأخير من ثوانٍ إلى أجزاء
// من الثانية. منقول من فرع `claude/code-implementation-SbvFg`.

import { WebSocketServer, WebSocket } from "ws";
import { verifyToken } from "./auth.js";

const subscribers = new Map(); // pair -> Set<ws>
let upstream = null;
let connecting = false;

function send(ws, event, pair) {
  ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: "spot.tickers", event, payload: [pair] }));
}

function ensureUpstream() {
  if (upstream && upstream.readyState === WebSocket.OPEN) return upstream;
  if (connecting) return null;
  connecting = true;
  const ws = new WebSocket("wss://api.gateio.ws/ws/v4/");

  ws.on("open", () => {
    connecting = false;
    upstream = ws;
    for (const pair of subscribers.keys()) send(ws, "subscribe", pair);
  });

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (msg.channel !== "spot.tickers" || msg.event !== "update" || !msg.result) return;
    const r = msg.result;
    const pair = r.currency_pair;
    const subs = subscribers.get(pair);
    if (!subs || subs.size === 0) return;
    const payload = JSON.stringify({
      pair,
      price: parseFloat(r.last),
      change_1d_pct: Math.round(parseFloat(r.change_percentage) * 100) / 100,
      high: parseFloat(r.high_24h),
      low: parseFloat(r.low_24h),
      ts: Date.now()
    });
    for (const client of subs) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  });

  ws.on("close", () => { upstream = null; connecting = false; setTimeout(ensureUpstream, 2000); });
  ws.on("error", () => {});
  return ws;
}

function subscribe(pair, clientWs) {
  if (!subscribers.has(pair)) subscribers.set(pair, new Set());
  subscribers.get(pair).add(clientWs);
  const ws = ensureUpstream();
  if (ws && ws.readyState === WebSocket.OPEN) send(ws, "subscribe", pair);
}

function unsubscribe(pair, clientWs) {
  const subs = subscribers.get(pair);
  if (!subs) return;
  subs.delete(clientWs);
  if (subs.size === 0) {
    subscribers.delete(pair);
    if (upstream && upstream.readyState === WebSocket.OPEN) send(upstream, "unsubscribe", pair);
  }
}

const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (clientWs, pair) => {
  subscribe(pair, clientWs);
  clientWs.on("close", () => unsubscribe(pair, clientWs));
  clientWs.on("error", () => unsubscribe(pair, clientWs));
});

// يُستدعى من server.js على حدث "upgrade" لمسار /ws/price?symbol=BTC_USDT&token=...
export function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/ws/price") { socket.destroy(); return; }

  const token = url.searchParams.get("token");
  const user = verifyToken(token);
  if (!user || user.disabled) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  let pair = (url.searchParams.get("symbol") || "").toUpperCase();
  if (pair && !pair.includes("_")) pair = `${pair}_USDT`;
  if (!pair || pair === "_USDT") { socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, clientWs => wss.emit("connection", clientWs, pair));
}
