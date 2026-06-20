// lib/ai.js
// طبقة استدلال اختيارية بنموذج لغوي (LLM) فوق قرار الاستراتيجية الكمّية.
// إن لم يتوفر OPENAI_API_KEY، أو فشل الاتصال، يعود النظام تلقائياً لقرار
// المحرك الكمّي (quant) دون توقف — الذكاء الصناعي هنا "إضافة" لا "اعتمادية".

import { readJSON } from "./store.js";

function withTimeout(p, ms = 8000) {
  return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);
}

function recentMistakesSummary(pair, limit = 20) {
  const journal = readJSON("trade-journal", []);
  const losses = journal.filter(t => t.pair === pair && t.pnlPct < 0).slice(-limit);
  if (losses.length === 0) return "لا توجد صفقات خاسرة سابقة مسجّلة لهذا الزوج.";
  const avgLoss = losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length;
  const commonVotes = {};
  for (const t of losses) {
    for (const [k, v] of Object.entries(t.votes || {})) {
      commonVotes[k] = (commonVotes[k] || 0) + v;
    }
  }
  return `آخر ${losses.length} صفقة خاسرة بمتوسط خسارة ${avgLoss.toFixed(2)}%. اتجاه الأصوات وقتها: ${JSON.stringify(commonVotes)}.`;
}

export async function isAvailable() {
  return Boolean(process.env.OPENAI_API_KEY);
}

// يأخذ قرار الاستراتيجية الكمّية ويطلب من النموذج تأكيده أو رفضه مع سبب
export async function refineDecision(pair, quantDecision) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ...quantDecision, engine: "quant", ai_reason: null };

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const mistakes = recentMistakesSummary(pair);

  const prompt = `أنت محلل تداول مخاطر-أولاً. القرار الكمّي الحالي للزوج ${pair}: ${quantDecision.action} بدرجة ثقة ${quantDecision.score}.
المؤشرات: ${JSON.stringify(quantDecision.indicators)}.
أصوات المؤشرات: ${JSON.stringify(quantDecision.votes)}.
سياق الأخطاء السابقة لهذا الزوج: ${mistakes}
هل تؤكد هذا القرار أم تعدّله؟ أجب بصيغة JSON فقط بالشكل:
{"action":"BUY|SELL|HOLD","confidence":0-1,"reason":"سبب مختصر بالعربية"}`;

  try {
    const res = await withTimeout(
      fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          response_format: { type: "json_object" }
        })
      }),
      8000
    );
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content);

    const action = ["BUY", "SELL", "HOLD"].includes(parsed.action) ? parsed.action : quantDecision.action;
    return {
      ...quantDecision,
      action,
      engine: "llm",
      ai_confidence: parsed.confidence ?? null,
      ai_reason: parsed.reason ?? null
    };
  } catch (e) {
    return { ...quantDecision, engine: "quant", ai_reason: `fallback (${e.message})` };
  }
}
