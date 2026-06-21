#!/usr/bin/env python3
"""Systematic parameter sweep over the BTC momentum entry rule, instead of
hand-picking one timeframe/threshold at a time. Tests many combinations of
bucket length, move threshold, trend filter, and volume filter against
historical Gate.io data, with realistic round-trip fees subtracted, and
ranks them by net PnL so we can see honestly whether *any* combination
clears the fee hurdle on a meaningful sample size.

Gate.io only keeps ~10000 candles of history per interval, so 1-minute
candles only reach back ~6.9 days; for the 1h/4h buckets we fetch native
5-minute candles instead (covers ~34.7 days) rather than aggregating from
1m, to get a large enough sample for those longer timeframes.
"""
import itertools
import json
import time
from typing import Any, Optional

from btc5m_backtest import avg_volume, ema_series, fetch_candles


def bucket_n(ts: int, period: int) -> int:
    return ts - (ts % period)


def build_buckets_n(candles: list[dict[str, Any]], period: int, unit_seconds: int) -> dict[int, list[dict[str, Any]]]:
    n_units = period // unit_seconds
    buckets: dict[int, list[dict[str, Any]]] = {}
    for c in candles:
        b = bucket_n(c["ts"], period)
        buckets.setdefault(b, []).append(c)
    return {
        b: sorted(cs, key=lambda x: x["ts"])
        for b, cs in buckets.items()
        if len(cs) == n_units
    }


def run_one(
    buckets: dict[int, list[dict[str, Any]]],
    candles: list[dict[str, Any]],
    idx_by_ts: dict[int, int],
    period: int,
    unit_seconds: int,
    move_min_pct: float,
    min_entry_frac: float,
    exit_before_frac: float,
    allow_short: bool,
    vol_mult: Optional[float],
    fee_pct_roundtrip: float,
    trend_ema: Optional[list[Optional[float]]],
) -> dict[str, Any]:
    min_entry_seconds_left = period * min_entry_frac
    exit_before_sec = period * exit_before_frac
    trades = []

    for bucket_start, cs in buckets.items():
        start_price = cs[0]["open"]
        for c in cs:
            sec_left = bucket_start + period - (c["ts"] + unit_seconds)
            if sec_left > min_entry_seconds_left or sec_left <= exit_before_sec:
                continue
            price_now = c["close"]
            move = price_now - start_price
            threshold = start_price * move_min_pct / 100.0
            if abs(move) < threshold:
                continue
            side = "LONG" if move > 0 else "SHORT"
            if side == "SHORT" and not allow_short:
                continue
            if vol_mult is not None:
                avgv = avg_volume(candles, idx_by_ts, c["ts"])
                if avgv is None or avgv <= 0 or c["base_volume"] < avgv * vol_mult:
                    continue
            if trend_ema is not None:
                i = idx_by_ts.get(c["ts"])
                ema_val = trend_ema[i] if i is not None else None
                if ema_val is None:
                    continue
                if side == "LONG" and price_now < ema_val:
                    continue
                if side == "SHORT" and price_now > ema_val:
                    continue
            exit_price = cs[-1]["close"]
            pnl_pct = ((exit_price - price_now) / price_now) if side == "LONG" else ((price_now - exit_price) / price_now)
            pnl_pct -= fee_pct_roundtrip / 100.0
            trades.append(pnl_pct)
            break

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


def sweep_for_granularity(
    candles: list[dict[str, Any]],
    unit_seconds: int,
    bucket_periods: list[int],
    pct_thresholds: list[float],
    trend_options_minutes: list[Optional[int]],
    vol_options: list[Optional[float]],
    fee_options: list[float],
) -> list[dict[str, Any]]:
    idx_by_ts = {c["ts"]: i for i, c in enumerate(candles)}
    closes = [c["close"] for c in candles]
    ema_cache: dict[int, list[Optional[float]]] = {}

    def get_ema(period_minutes: int) -> list[Optional[float]]:
        units = max(1, (period_minutes * 60) // unit_seconds)
        if units not in ema_cache:
            ema_cache[units] = ema_series(closes, units)
        return ema_cache[units]

    results = []
    for period in bucket_periods:
        buckets = build_buckets_n(candles, period, unit_seconds)
        for trend_p in trend_options_minutes:
            trend_ema = get_ema(trend_p) if trend_p is not None else None
            for vol_mult, fee, pct in itertools.product(vol_options, fee_options, pct_thresholds):
                res = run_one(
                    buckets, candles, idx_by_ts, period, unit_seconds, pct,
                    min_entry_frac=0.4333, exit_before_frac=0.0667,
                    allow_short=True, vol_mult=vol_mult,
                    fee_pct_roundtrip=fee, trend_ema=trend_ema,
                )
                results.append({
                    "period_min": period // 60, "pct_threshold": pct,
                    "trend_ema_min": trend_p, "vol_mult": vol_mult, "fee_pct": fee,
                    "granularity_sec": unit_seconds,
                    **res,
                })
    return results


def main() -> None:
    pct_thresholds = [0.02, 0.04, 0.06, 0.08, 0.10, 0.15, 0.20, 0.30, 0.40, 0.60]
    vol_options = [None, 1.5]
    fee_options = [0.1, 0.05]

    print("fetching ~6.9 days of 1m candles (for 5m/15m/30m buckets)...")
    candles_1m = fetch_candles("BTC_USDT", "1m", 60, 6.9)
    print(f"got {len(candles_1m)} 1m candles")

    print("fetching ~30 days of 5m candles (for 1h/4h buckets)...")
    candles_5m = fetch_candles("BTC_USDT", "5m", 300, 30.0)
    print(f"got {len(candles_5m)} 5m candles")

    t0 = time.time()
    results = []
    results += sweep_for_granularity(
        candles_1m, 60, [300, 900, 1800], pct_thresholds,
        [None, 60, 240], vol_options, fee_options,
    )
    results += sweep_for_granularity(
        candles_5m, 300, [3600, 14400], pct_thresholds,
        [None, 12, 48], vol_options, fee_options,  # 12*5m=1h, 48*5m=4h EMA
    )
    print(f"ran {len(results)} combinations in {time.time()-t0:.1f}s")

    meaningful = [r for r in results if r["entries"] >= 30]
    meaningful.sort(key=lambda r: r["total_pnl_pct"], reverse=True)

    print("\n=== TOP 15 by net total PnL% (entries >= 30) ===")
    for r in meaningful[:15]:
        print(
            f"period={r['period_min']:>4}m  pct={r['pct_threshold']:.2f}%  "
            f"trend_ema={r['trend_ema_min']}  vol_mult={r['vol_mult']}  fee={r['fee_pct']}%  "
            f"entries={r['entries']:4d}  win_rate={r['win_rate']}  "
            f"net_pnl={r['total_pnl_pct']:+.3f}%  avg/trade={r['avg_pnl_pct_per_trade']}"
        )

    print("\n=== BOTTOM 5 (worst) for contrast ===")
    for r in meaningful[-5:]:
        print(
            f"period={r['period_min']:>4}m  pct={r['pct_threshold']:.2f}%  "
            f"trend_ema={r['trend_ema_min']}  vol_mult={r['vol_mult']}  fee={r['fee_pct']}%  "
            f"entries={r['entries']:4d}  win_rate={r['win_rate']}  "
            f"net_pnl={r['total_pnl_pct']:+.3f}%  avg/trade={r['avg_pnl_pct_per_trade']}"
        )

    profitable = [r for r in meaningful if r["total_pnl_pct"] > 0]
    print(f"\nprofitable combos (entries>=30, net positive): {len(profitable)} / {len(meaningful)}")

    with open("runtime/sweep_results.json", "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print("full results written to runtime/sweep_results.json")


if __name__ == "__main__":
    main()
