#!/usr/bin/env python3
"""Two genuinely different entry hypotheses, distinct from the momentum/reversal
rule already ruled out in btc5m_backtest_sweep.py (958 combos, 0 profitable):

1. Volatility-squeeze breakout: wait for a period of unusually LOW realized
   range (a "squeeze"), then enter only when price breaks out of that
   compressed range. Idea: compressed volatility often precedes a real
   directional move, so the breakout itself (not just any mid-bucket move)
   is the signal, independent of clock-bucket timing.

2. Time-of-day seasonality: instead of assuming all hours are equal, measure
   whether BTC's intraday move size/win-rate for the existing momentum rule
   varies meaningfully by UTC hour, then check whether restricting trading to
   the best hours alone (without changing the rule) turns a fee-losing
   strategy into a fee-winning one.

Both run against the same historical Gate.io candles already proven to be
the best available sample (1m for ~6.9 days, 5m for ~30 days).
"""
import json
import statistics
import time
from typing import Any, Optional

from btc5m_backtest import fetch_candles


def stdev_window(closes: list[float], i: int, period: int) -> Optional[float]:
    if i < period - 1:
        return None
    window = closes[i - period + 1:i + 1]
    return statistics.pstdev(window)


def bb_width_series(closes: list[float], period: int) -> list[Optional[float]]:
    out: list[Optional[float]] = []
    for i in range(len(closes)):
        if i < period - 1:
            out.append(None)
            continue
        window = closes[i - period + 1:i + 1]
        mid = sum(window) / period
        sd = statistics.pstdev(window)
        out.append((4 * sd) / mid if mid else None)  # width of (mid +/- 2sd) relative to price
    return out


def squeeze_breakout_backtest(
    candles: list[dict[str, Any]],
    unit_seconds: int,
    bb_period: int,
    squeeze_lookback: int,
    squeeze_pct: float,
    hold_units: int,
    fee_pct_roundtrip: float,
    allow_short: bool = True,
) -> dict[str, Any]:
    """squeeze_pct: current BB width must be <= this fraction of the trailing
    squeeze_lookback average width to count as 'squeezed'. hold_units: how many
    candles to hold after a breakout entry (fixed-bar exit, not clock-bucket)."""
    closes = [c["close"] for c in candles]
    highs = [c["high"] for c in candles]
    lows = [c["low"] for c in candles]
    width = bb_width_series(closes, bb_period)

    trades = []
    i = bb_period + squeeze_lookback
    n = len(candles)
    while i < n - hold_units:
        w = width[i]
        if w is None:
            i += 1
            continue
        trail = [x for x in width[i - squeeze_lookback:i] if x is not None]
        if len(trail) < squeeze_lookback // 2:
            i += 1
            continue
        avg_trail_width = sum(trail) / len(trail)
        was_squeezed = avg_trail_width > 0 and w <= avg_trail_width * squeeze_pct
        if not was_squeezed:
            i += 1
            continue
        # squeeze range = high/low over the squeeze_lookback window ending at i
        range_window = candles[i - squeeze_lookback:i]
        range_hi = max(c["high"] for c in range_window)
        range_lo = min(c["low"] for c in range_window)
        breakout_px = candles[i]["close"]
        if breakout_px > range_hi:
            side = "LONG"
        elif breakout_px < range_lo:
            side = "SHORT"
        else:
            i += 1
            continue
        if side == "SHORT" and not allow_short:
            i += 1
            continue
        entry_price = breakout_px
        exit_price = candles[i + hold_units]["close"]
        pnl_pct = ((exit_price - entry_price) / entry_price) if side == "LONG" else ((entry_price - exit_price) / entry_price)
        pnl_pct -= fee_pct_roundtrip / 100.0
        trades.append(pnl_pct)
        i += hold_units  # don't re-enter mid-hold

    if not trades:
        return {"entries": 0, "win_rate": None, "total_pnl_pct": 0.0, "avg_pnl_pct_per_trade": None}
    wins = sum(1 for t in trades if t > 0)
    total = sum(trades)
    return {
        "entries": len(trades),
        "win_rate": round(wins / len(trades), 3),
        "total_pnl_pct": round(total * 100, 3),
        "avg_pnl_pct_per_trade": round((total / len(trades)) * 100, 4),
    }


def run_squeeze_sweep(candles_1m, candles_5m, dense: bool = False) -> list[dict[str, Any]]:
    results = []
    if not dense:
        configs = [
            # (candles, unit_seconds, label, bb_period, squeeze_lookback, hold_units)
            (candles_1m, 60, "1m", 20, 60, 15),
            (candles_1m, 60, "1m", 20, 60, 30),
            (candles_1m, 60, "1m", 20, 120, 15),
            (candles_1m, 60, "1m", 30, 120, 30),
            (candles_5m, 300, "5m", 20, 36, 6),   # 36*5m=3h lookback, hold 30m
            (candles_5m, 300, "5m", 20, 36, 12),  # hold 1h
            (candles_5m, 300, "5m", 20, 72, 12),  # 6h lookback, hold 1h
        ]
        squeeze_pcts = [0.5, 0.7]
    else:
        # dense neighborhood scan around the one promising config
        # (bb=30, lookback=120, squeeze_pct=0.7, hold=30 on 1m) to check robustness
        configs = [
            (candles_1m, 60, "1m", bb, lb, hold)
            for bb in (25, 30, 35)
            for lb in (90, 120, 150)
            for hold in (20, 30, 40)
        ]
        squeeze_pcts = [0.6, 0.7, 0.8]
    fee_options = [0.1, 0.05]
    for candles, unit_seconds, label, bb_period, lookback, hold in configs:
        for sp in squeeze_pcts:
            for fee in fee_options:
                res = squeeze_breakout_backtest(candles, unit_seconds, bb_period, lookback, sp, hold, fee)
                results.append({
                    "strategy": "squeeze_breakout", "granularity": label,
                    "bb_period": bb_period, "squeeze_lookback": lookback,
                    "squeeze_pct": sp, "hold_units": hold, "fee_pct": fee,
                    **res,
                })
    return results


def momentum_pnl_by_hour(
    candles_1m: list[dict[str, Any]],
    period: int,
    move_min_pct: float,
    fee_pct_roundtrip: float,
) -> dict[int, dict[str, Any]]:
    """Reuse the plain momentum entry rule (no trend/vol filter) but bucket
    results by UTC hour-of-day of the entry, to see if some hours carry a real
    pre-fee edge that's being averaged away across the full day."""
    buckets: dict[int, list[dict[str, Any]]] = {}
    for c in candles_1m:
        b = c["ts"] - (c["ts"] % period)
        buckets.setdefault(b, []).append(c)
    buckets = {b: sorted(cs, key=lambda x: x["ts"]) for b, cs in buckets.items() if len(cs) == period // 60}

    min_entry_seconds_left = period * 0.4333
    exit_before_sec = period * 0.0667
    by_hour: dict[int, list[float]] = {h: [] for h in range(24)}

    for bucket_start, cs in buckets.items():
        start_price = cs[0]["open"]
        for c in cs:
            sec_left = bucket_start + period - (c["ts"] + 60)
            if sec_left > min_entry_seconds_left or sec_left <= exit_before_sec:
                continue
            price_now = c["close"]
            move = price_now - start_price
            threshold = start_price * move_min_pct / 100.0
            if abs(move) < threshold:
                continue
            side = "LONG" if move > 0 else "SHORT"
            exit_price = cs[-1]["close"]
            pnl_pct = ((exit_price - price_now) / price_now) if side == "LONG" else ((price_now - exit_price) / price_now)
            pnl_pct -= fee_pct_roundtrip / 100.0
            hour = time.gmtime(c["ts"]).tm_hour
            by_hour[hour].append(pnl_pct)
            break

    out = {}
    for h, trades in by_hour.items():
        if not trades:
            out[h] = {"entries": 0, "win_rate": None, "total_pnl_pct": 0.0, "avg_pnl_pct_per_trade": None}
            continue
        wins = sum(1 for t in trades if t > 0)
        total = sum(trades)
        out[h] = {
            "entries": len(trades),
            "win_rate": round(wins / len(trades), 3),
            "total_pnl_pct": round(total * 100, 3),
            "avg_pnl_pct_per_trade": round((total / len(trades)) * 100, 4),
        }
    return out


def main() -> None:
    print("fetching ~6.9 days of 1m candles...")
    candles_1m = fetch_candles("BTC_USDT", "1m", 60, 6.9)
    print(f"got {len(candles_1m)} 1m candles")
    print("fetching ~30 days of 5m candles...")
    candles_5m = fetch_candles("BTC_USDT", "5m", 300, 30.0)
    print(f"got {len(candles_5m)} 5m candles")

    print("\n=== HYPOTHESIS 1: volatility-squeeze breakout ===")
    sq_results = run_squeeze_sweep(candles_1m, candles_5m)
    sq_meaningful = [r for r in sq_results if r["entries"] >= 20]
    sq_meaningful.sort(key=lambda r: r["total_pnl_pct"], reverse=True)
    for r in sq_meaningful[:10]:
        print(
            f"[{r['granularity']:>3}] bb={r['bb_period']:>3} lookback={r['squeeze_lookback']:>3} "
            f"squeeze_pct={r['squeeze_pct']} hold={r['hold_units']:>3} fee={r['fee_pct']}%  "
            f"entries={r['entries']:4d}  win_rate={r['win_rate']}  net_pnl={r['total_pnl_pct']:+.3f}%  "
            f"avg/trade={r['avg_pnl_pct_per_trade']}"
        )
    sq_profitable = [r for r in sq_meaningful if r["total_pnl_pct"] > 0]
    print(f"squeeze-breakout profitable combos (entries>=20): {len(sq_profitable)} / {len(sq_meaningful)}")

    print("\n=== HYPOTHESIS 1b: dense neighborhood scan (robustness check, 1m only) ===")
    dense_results = run_squeeze_sweep(candles_1m, candles_5m, dense=True)
    dense_meaningful = [r for r in dense_results if r["entries"] >= 15]
    dense_meaningful.sort(key=lambda r: r["total_pnl_pct"], reverse=True)
    for r in dense_meaningful[:15]:
        print(
            f"bb={r['bb_period']:>3} lookback={r['squeeze_lookback']:>3} "
            f"squeeze_pct={r['squeeze_pct']} hold={r['hold_units']:>3} fee={r['fee_pct']}%  "
            f"entries={r['entries']:4d}  win_rate={r['win_rate']}  net_pnl={r['total_pnl_pct']:+.3f}%  "
            f"avg/trade={r['avg_pnl_pct_per_trade']}"
        )
    dense_profitable = [r for r in dense_meaningful if r["total_pnl_pct"] > 0]
    print(f"dense-scan profitable combos (entries>=15): {len(dense_profitable)} / {len(dense_meaningful)}")

    print("\n--- out-of-sample split test on the original promising config (bb=30, lookback=120, squeeze_pct=0.7, hold=30) ---")
    midpoint = len(candles_1m) // 2
    first_half = candles_1m[:midpoint]
    second_half = candles_1m[midpoint:]
    for label, chunk in (("first half", first_half), ("second half", second_half)):
        for fee in (0.1, 0.05):
            res = squeeze_breakout_backtest(chunk, 60, 30, 120, 0.7, 30, fee)
            print(f"{label:12s} fee={fee}%  entries={res['entries']:3d}  win_rate={res['win_rate']}  "
                  f"net_pnl={res['total_pnl_pct']:+.3f}%  avg/trade={res['avg_pnl_pct_per_trade']}")

    print("\n=== HYPOTHESIS 2: time-of-day seasonality (5m momentum, pct=0.08%, fee=0.1%) ===")
    by_hour = momentum_pnl_by_hour(candles_1m, 300, 0.08, 0.1)
    ranked_hours = sorted(by_hour.items(), key=lambda kv: kv[1]["avg_pnl_pct_per_trade"] or -999, reverse=True)
    for h, r in ranked_hours:
        if r["entries"] == 0:
            continue
        print(f"UTC hour {h:02d}:00  entries={r['entries']:3d}  win_rate={r['win_rate']}  "
              f"net_pnl={r['total_pnl_pct']:+.3f}%  avg/trade={r['avg_pnl_pct_per_trade']}")

    best_hours = [h for h, r in ranked_hours if r["entries"] >= 5 and (r["avg_pnl_pct_per_trade"] or -999) > 0]
    if best_hours:
        restricted_pnl = sum(by_hour[h]["total_pnl_pct"] for h in best_hours)
        restricted_entries = sum(by_hour[h]["entries"] for h in best_hours)
        print(f"\nrestricting to {len(best_hours)} positive-avg hours {sorted(best_hours)}: "
              f"entries={restricted_entries}  net_pnl={restricted_pnl:+.3f}%")
    else:
        print("\nno hour has a positive average pnl/trade -> hour-of-day filtering can't rescue this rule")

    with open("runtime/novel_sweep_results.json", "w") as f:
        json.dump({"squeeze_breakout": sq_results, "by_hour": by_hour}, f, ensure_ascii=False, indent=2)
    print("\nfull results written to runtime/novel_sweep_results.json")


if __name__ == "__main__":
    main()
