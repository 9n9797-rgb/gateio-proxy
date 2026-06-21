#!/usr/bin/env python3
"""Backtest the BTC 5-minute momentum entry rule against Gate.io's historical
1-minute candles, instead of waiting hours for a live paper-trading session.

Mirrors the live runner's decision logic (scripts/btc5m_gateio_runner.py):
align to 5-minute buckets, only consider an entry once <= --min-entry-seconds-left
remain, require a real move of at least a threshold (fixed $ or % of price),
and exit at --exit-before-sec before the bucket ends (or never bothers with a
poll-driven stop-loss here since 1m candles can't resolve sub-minute moves).

Additionally supports a volume-confirmation filter ("strong buying/selling"):
require the triggering candle's volume to be >= --vol-mult times the trailing
average volume, similar to how OBV/volume is used elsewhere in this repo
(server.js calculateOBV/getOBVTrend) to separate a real push from noise.
"""
import argparse
import json
import time
from typing import Any, Optional

import requests

GATEIO_REST = "https://api.gateio.ws/api/v4"


def fetch_candles_1m(currency_pair: str, days: float) -> list[dict[str, Any]]:
    now = int(time.time())
    start = now - int(days * 86400)
    out: list[dict[str, Any]] = []
    cursor = start
    while cursor < now:
        chunk_to = min(cursor + 999 * 60, now)
        r = requests.get(
            f"{GATEIO_REST}/spot/candlesticks",
            params={"currency_pair": currency_pair, "interval": "1m", "from": cursor, "to": chunk_to},
            timeout=10,
        )
        r.raise_for_status()
        rows = r.json()
        if not rows:
            cursor = chunk_to + 60
            continue
        for c in rows:
            out.append({
                "ts": int(c[0]),
                "close": float(c[2]),
                "high": float(c[3]),
                "low": float(c[4]),
                "open": float(c[5]),
                "base_volume": float(c[6]),
            })
        cursor = out[-1]["ts"] + 60
        time.sleep(0.05)
    out.sort(key=lambda x: x["ts"])
    # de-dup by ts
    seen = set()
    dedup = []
    for c in out:
        if c["ts"] in seen:
            continue
        seen.add(c["ts"])
        dedup.append(c)
    return dedup


def bucket_5m(ts: int) -> int:
    return ts - (ts % 300)


def build_buckets(candles_1m: list[dict[str, Any]]) -> dict[int, list[dict[str, Any]]]:
    buckets: dict[int, list[dict[str, Any]]] = {}
    for c in candles_1m:
        b = bucket_5m(c["ts"])
        buckets.setdefault(b, []).append(c)
    return {b: sorted(cs, key=lambda x: x["ts"]) for b, cs in buckets.items() if len(cs) == 5}


def avg_volume(candles_1m: list[dict[str, Any]], idx_by_ts: dict[int, int], ts: int, lookback: int = 20) -> Optional[float]:
    i = idx_by_ts.get(ts)
    if i is None or i < lookback:
        return None
    window = candles_1m[i - lookback:i]
    return sum(c["base_volume"] for c in window) / len(window)


def ema_series(closes: list[float], period: int) -> list[Optional[float]]:
    k = 2.0 / (period + 1)
    out: list[Optional[float]] = []
    ema = None
    for i, px in enumerate(closes):
        if i < period - 1:
            out.append(None)
            continue
        if ema is None:
            ema = sum(closes[i - period + 1:i + 1]) / period
        else:
            ema = px * k + ema * (1 - k)
        out.append(ema)
    return out


def run_backtest(
    buckets: dict[int, list[dict[str, Any]]],
    candles_1m: list[dict[str, Any]],
    move_min_usd: Optional[float],
    move_min_pct: Optional[float],
    min_entry_seconds_left: int,
    exit_before_sec: int,
    allow_short: bool,
    vol_mult: Optional[float],
    fee_pct_roundtrip: float = 0.0,
    trend_ema_period: Optional[int] = None,
) -> dict[str, Any]:
    idx_by_ts = {c["ts"]: i for i, c in enumerate(candles_1m)}
    trades = []
    no_entry = 0

    trend_ema = None
    if trend_ema_period is not None:
        closes = [c["close"] for c in candles_1m]
        trend_ema = ema_series(closes, trend_ema_period)

    for bucket_start, cs in sorted(buckets.items()):
        start_price = cs[0]["open"]
        entered = False
        for minute_idx, c in enumerate(cs):
            sec_left = bucket_start + 300 - (c["ts"] + 60)
            if sec_left > min_entry_seconds_left or sec_left <= exit_before_sec:
                continue
            price_now = c["close"]
            move = price_now - start_price
            threshold = (start_price * move_min_pct / 100.0) if move_min_pct is not None else move_min_usd
            if abs(move) < threshold:
                continue
            side = "LONG" if move > 0 else "SHORT"
            if side == "SHORT" and not allow_short:
                continue
            if vol_mult is not None:
                avgv = avg_volume(candles_1m, idx_by_ts, c["ts"])
                if avgv is None or avgv <= 0 or c["base_volume"] < avgv * vol_mult:
                    continue
            if trend_ema is not None:
                i = idx_by_ts.get(c["ts"])
                ema_val = trend_ema[i] if i is not None else None
                if ema_val is None:
                    continue
                # only trade in the direction of the higher-timeframe trend
                if side == "LONG" and price_now < ema_val:
                    continue
                if side == "SHORT" and price_now > ema_val:
                    continue
            exit_price = cs[-1]["close"]
            pnl_pct = ((exit_price - price_now) / price_now) if side == "LONG" else ((price_now - exit_price) / price_now)
            pnl_pct -= fee_pct_roundtrip / 100.0
            trades.append({
                "bucket": bucket_start, "side": side, "entry_price": price_now,
                "exit_price": exit_price, "move_at_entry": move, "pnl_pct": pnl_pct,
            })
            entered = True
            break
        if not entered:
            no_entry += 1

    wins = sum(1 for t in trades if t["pnl_pct"] > 0)
    losses = sum(1 for t in trades if t["pnl_pct"] < 0)
    total_pnl_pct = sum(t["pnl_pct"] for t in trades)
    return {
        "total_buckets": len(buckets),
        "entries": len(trades),
        "no_entry": no_entry,
        "wins": wins,
        "losses": losses,
        "win_rate": round(wins / len(trades), 3) if trades else None,
        "total_pnl_pct": round(total_pnl_pct * 100, 3),
        "avg_pnl_pct_per_trade": round((total_pnl_pct / len(trades)) * 100, 4) if trades else None,
        "trades_sample": trades[:5],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--currency-pair", default="BTC_USDT")
    ap.add_argument("--days", type=float, default=5.0)
    ap.add_argument("--min-entry-seconds-left", type=int, default=130)
    ap.add_argument("--exit-before-sec", type=int, default=20)
    ap.add_argument("--allow-short", action="store_true", help="simulate futures-style (both directions); default LONG-only like spot")
    ap.add_argument("--vol-mult", type=float, default=None, help="require entry candle volume >= this x the trailing 20-candle average")
    ap.add_argument("--fee-pct-roundtrip", type=float, default=0.0, help="round-trip taker fee %% to subtract from every trade's pnl_pct (e.g. 0.1 for 0.1%%)")
    ap.add_argument("--trend-ema-period", type=int, default=None, help="only take entries aligned with this EMA period (in 1m candles), e.g. 60 for a 1h trend filter")
    args = ap.parse_args()

    print(f"fetching {args.days} days of 1m candles for {args.currency_pair}...")
    candles = fetch_candles_1m(args.currency_pair, args.days)
    buckets = build_buckets(candles)
    print(f"fetched {len(candles)} 1m candles -> {len(buckets)} complete 5m buckets")

    scenarios = [
        ("fixed_$30", 30.0, None),
        ("fixed_$50", 50.0, None),
        ("fixed_$70", 70.0, None),
        ("fixed_$100", 100.0, None),
        ("pct_0.04%", None, 0.04),
        ("pct_0.06%", None, 0.06),
        ("pct_0.08%", None, 0.08),
        ("pct_0.10%", None, 0.10),
    ]

    report: dict[str, Any] = {"params": vars(args), "buckets": len(buckets), "scenarios": {}}
    for name, usd, pct in scenarios:
        res = run_backtest(
            buckets, candles, usd, pct,
            args.min_entry_seconds_left, args.exit_before_sec,
            args.allow_short, args.vol_mult,
            fee_pct_roundtrip=args.fee_pct_roundtrip,
            trend_ema_period=args.trend_ema_period,
        )
        report["scenarios"][name] = res
        print(f"{name:12s} entries={res['entries']:4d}  win_rate={res['win_rate']}  "
              f"total_pnl_pct={res['total_pnl_pct']:+.3f}%  avg_pnl/trade={res['avg_pnl_pct_per_trade']}")

    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
