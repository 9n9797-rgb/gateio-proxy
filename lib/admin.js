// lib/admin.js
// أدوات لوحة الأدمن: قوائم المستخدمين، التفعيل/التعطيل، إحصاءات المنصة،
// وتقرير عن أداء محرك الذكاء (الكمّي + ذاكرة الأخطاء البرمجية).

import db from "./db.js";

export function listUsers() {
  const rows = db
    .prepare(
      `SELECT
        u.id, u.email, u.created_at, u.disabled,
        s.execution, s.decision_mode, s.pairs,
        w.cash, w.realized_pnl,
        CASE WHEN k.user_id IS NULL THEN 0 ELSE 1 END AS has_keys,
        (SELECT COUNT(*) FROM trades t WHERE t.user_id = u.id) AS trade_count
       FROM users u
       LEFT JOIN user_settings s ON s.user_id = u.id
       LEFT JOIN paper_wallets w ON w.user_id = u.id
       LEFT JOIN exchange_keys k ON k.user_id = u.id
       ORDER BY u.id DESC`
    )
    .all();

  return rows.map(r => ({
    id: r.id,
    email: r.email,
    created_at: r.created_at,
    disabled: Boolean(r.disabled),
    execution: r.execution || "off",
    decision_mode: r.decision_mode || "recommend_only",
    pairs: r.pairs || "",
    paper_cash: r.cash ?? null,
    paper_realized_pnl: r.realized_pnl ?? null,
    has_exchange_keys: Boolean(r.has_keys),
    trade_count: r.trade_count
  }));
}

export function toggleUser(userId, disabled) {
  const res = db
    .prepare("UPDATE users SET disabled = ? WHERE id = ?")
    .run(disabled ? 1 : 0, userId);
  if (res.changes === 0) throw new Error("المستخدم غير موجود");
  return { ok: true };
}

export function platformStats() {
  const totalUsers = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  const disabledUsers = db.prepare("SELECT COUNT(*) AS n FROM users WHERE disabled = 1").get().n;
  const activeSubscribers = db
    .prepare("SELECT COUNT(*) AS n FROM user_settings WHERE execution != 'off'")
    .get().n;
  const liveTraders = db
    .prepare("SELECT COUNT(*) AS n FROM user_settings WHERE execution = 'live'")
    .get().n;

  const paperTotals = db
    .prepare("SELECT COALESCE(SUM(cash),0) AS cash, COALESCE(SUM(realized_pnl),0) AS pnl FROM paper_wallets")
    .get();

  const trades = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END), 0) AS wins,
        COALESCE(SUM(CASE WHEN pnl_pct < 0 THEN 1 ELSE 0 END), 0) AS losses,
        COALESCE(SUM(CASE WHEN pnl_pct > 0 THEN qty * entry_price * pnl_pct / 100.0 ELSE 0 END), 0) AS gross_profit,
        COALESCE(SUM(CASE WHEN pnl_pct < 0 THEN qty * entry_price * pnl_pct / 100.0 ELSE 0 END), 0) AS gross_loss
       FROM trades`
    )
    .get();

  const liveTrades = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN pnl_pct > 0 THEN qty * entry_price * pnl_pct / 100.0 ELSE 0 END), 0) AS gross_profit,
        COALESCE(SUM(CASE WHEN pnl_pct < 0 THEN qty * entry_price * pnl_pct / 100.0 ELSE 0 END), 0) AS gross_loss
       FROM trades WHERE mode = 'live'`
    )
    .get();

  return {
    total_users: totalUsers,
    disabled_users: disabledUsers,
    active_subscribers: activeSubscribers,
    live_traders: liveTraders,
    paper_total_cash: Math.round(paperTotals.cash * 100) / 100,
    paper_total_realized_pnl: Math.round(paperTotals.pnl * 100) / 100,
    trades_total: trades.total,
    trades_wins: trades.wins,
    trades_losses: trades.losses,
    win_rate_pct: trades.total > 0 ? Math.round((trades.wins / trades.total) * 1000) / 10 : 0,
    gross_profit_usdt: Math.round(trades.gross_profit * 100) / 100,
    gross_loss_usdt: Math.round(trades.gross_loss * 100) / 100,
    net_pnl_usdt: Math.round((trades.gross_profit + trades.gross_loss) * 100) / 100,
    live_trades_total: liveTrades.total,
    live_gross_profit_usdt: Math.round(liveTrades.gross_profit * 100) / 100,
    live_gross_loss_usdt: Math.round(liveTrades.gross_loss * 100) / 100
  };
}

const INDICATOR_LABELS = {
  rsi: "RSI",
  macd: "MACD",
  trend: "اتجاه المتوسطات",
  obv: "حجم التداول (OBV)"
};

// تقرير عن تطوّر محرك القرار عبر كل المستخدمين: أي مؤشر اكتسب ثقة أعلى من
// المتوسط الافتراضي (1) يعني أن المحرك "تعلّم" أنه موثوق أكثر من تجربته،
// والعكس لمن انخفض وزنه. كما يقيس نسبة الفوز ومدى نشاط ذاكرة الأخطاء.
export function aiReport() {
  const weightRows = db.prepare("SELECT weights FROM strategy_weights").all();
  const sums = { rsi: 0, macd: 0, trend: 0, obv: 0 };
  const counts = { rsi: 0, macd: 0, trend: 0, obv: 0 };
  for (const row of weightRows) {
    const w = JSON.parse(row.weights || "{}");
    for (const key of Object.keys(sums)) {
      if (typeof w[key] === "number") {
        sums[key] += w[key];
        counts[key]++;
      }
    }
  }
  const avgWeights = {};
  for (const key of Object.keys(sums)) {
    avgWeights[key] = counts[key] > 0 ? Math.round((sums[key] / counts[key]) * 1000) / 1000 : 1;
  }

  const ranked = Object.entries(avgWeights).sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];

  const tradeStats = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END), 0) AS wins
       FROM trades`
    )
    .get();
  const winRate = tradeStats.total > 0 ? Math.round((tradeStats.wins / tradeStats.total) * 1000) / 10 : null;

  const usersLearning = counts.rsi; // عدد المستخدمين الذين لديهم أوزان فعلية (تعلّموا من صفقات سابقة)

  const mistakeAvoidedTrades = db
    .prepare("SELECT COUNT(*) AS n FROM trades WHERE reason = 'recommendation' OR reason = 'signal'")
    .get().n;

  const summaryParts = [];
  summaryParts.push(
    `أفضل مؤشر حالياً عبر كل المستخدمين هو "${INDICATOR_LABELS[best[0]]}" بوزن متوسط ${best[1]} (الافتراضي 1)، ` +
    `بينما أضعفها هو "${INDICATOR_LABELS[worst[0]]}" بوزن ${worst[1]}.`
  );
  if (winRate !== null) {
    summaryParts.push(`نسبة الفوز الإجمالية لكل الصفقات المغلقة على المنصة: ${winRate}%.`);
  }
  summaryParts.push(
    `${usersLearning} من المستخدمين لديهم أوزان تعلّم خاصة بهم (تغيّرت عن القيم الافتراضية بعد صفقات حقيقية أو وهمية).`
  );
  summaryParts.push(
    "الابتكار الأساسي في هذا الإصدار: \"ذاكرة الأخطاء البرمجية\" — محرك مستقل عن أي LLM يقارن نمط " +
    "أصوات المؤشرات الحالي بأنماط صفقات خاسرة سابقة لكل مستخدم وزوج على حدة، ويخفّف قرار الشراء/البيع " +
    "تلقائياً إذا تشابه النمط الحالي مع خطأ سابق، مما يقلل تكرار الأخطاء نفسها دون تدخل بشري أو تكلفة LLM."
  );

  return {
    avg_weights: avgWeights,
    best_indicator: { key: best[0], label: INDICATOR_LABELS[best[0]], weight: best[1] },
    worst_indicator: { key: worst[0], label: INDICATOR_LABELS[worst[0]], weight: worst[1] },
    users_with_learned_weights: usersLearning,
    overall_win_rate_pct: winRate,
    total_closed_trades: tradeStats.total,
    summary: summaryParts.join(" ")
  };
}
