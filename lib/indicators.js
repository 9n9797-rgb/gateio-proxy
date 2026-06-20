// lib/indicators.js
// مؤشرات فنية مشتركة: RSI, MACD, MA, OBV, ATR

export function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return closes.map(() => 50);
  const result = new Array(period).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
}

export function calculateEMA(values, period) {
  const k = 2 / (period + 1);
  const ema = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) continue;
    prev = prev == null ? values[i] : values[i] * k + prev * (1 - k);
    ema[i] = prev;
  }
  return ema;
}

export function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = calculateEMA(closes, fast);
  const emaSlow = calculateEMA(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  const signalLine = calculateEMA(macdLine, signal);
  const histogram = macdLine.map((v, i) =>
    v != null && signalLine[i] != null ? v - signalLine[i] : null
  );
  return { macdLine, signalLine, histogram };
}

export function calculateOBV(closes, volumes) {
  const obv = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) obv.push(obv[i - 1] + volumes[i]);
    else if (closes[i] < closes[i - 1]) obv.push(obv[i - 1] - volumes[i]);
    else obv.push(obv[i - 1]);
  }
  return obv;
}

export function getOBVTrend(obv) {
  if (obv.length < 10) return "neutral";
  const n = obv.length;
  const recent = obv.slice(n - 5).reduce((a, b) => a + b, 0) / 5;
  const older = obv.slice(n - 10, n - 5).reduce((a, b) => a + b, 0) / 5;
  if (recent > older * 1.005) return "rising";
  if (recent < older * 0.995) return "falling";
  return "neutral";
}

export function calculateMA(closes, period = 20) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    return closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

export function calculateATR(highs, lows, closes, period = 14) {
  const tr = highs.map((h, i) => {
    if (i === 0) return h - lows[i];
    return Math.max(
      h - lows[i],
      Math.abs(h - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  });
  return calculateEMA(tr, period);
}

// يحسب كل المؤشرات المطلوبة دفعة واحدة من شموع Gate.io الخام
// raw candle: [time, vol, close, high, low, open, closed]
export function computeAllIndicators(raw) {
  const closes = raw.map(c => parseFloat(c[2]));
  const highs = raw.map(c => parseFloat(c[3]));
  const lows = raw.map(c => parseFloat(c[4]));
  const opens = raw.map(c => parseFloat(c[5]));
  const volumes = raw.map(c => parseFloat(c[1]));
  const times = raw.map(c => parseInt(c[0]) * 1000);

  const rsi = calculateRSI(closes, 14);
  const obv = calculateOBV(closes, volumes);
  const obvTrend = getOBVTrend(obv);
  const ma20 = calculateMA(closes, 20);
  const ma50 = calculateMA(closes, 50);
  const atr = calculateATR(highs, lows, closes, 14);
  const { macdLine, signalLine, histogram } = calculateMACD(closes);

  return {
    closes, highs, lows, opens, volumes, times,
    rsi, obv, obvTrend, ma20, ma50, atr,
    macdLine, signalLine, histogram
  };
}
