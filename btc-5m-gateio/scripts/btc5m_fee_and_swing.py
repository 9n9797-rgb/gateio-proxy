#!/usr/bin/env python3
"""Two remaining directions from the research synthesis, both LONG-only/spot
(per the live-execution constraint - futures/short stays backtest-only or
unused):

1. Fee sensitivity: does the squeeze-breakout LONG-only result (already
   measured net negative at the realistic 0.1% taker round-trip fee) turn
   positive at a lower fee, the kind achievable with maker/limit orders
   instead of market/taker orders? If the LONG-only edge is negative even
   at zero fee, no fee structure rescues it - that tells us whether maker
   orders are even worth building order-placement logic for.

2. Swing trading: instead of minutes-scale entries (where the realistic 0.1%
   fee is large relative to the available price move), test a Donchian-style
   breakout - price closes above its highest close of the last N candles -
   held for hours, targeting a materially larger average move per trade so
   the fixed fee is a much smaller fraction of the edge.
"""
import json
from typing import Any, Optional

from btc5m_backtest_novel import squeeze_breakout_backtest
from btc5m_backtest import fetch_candles


def fee_sensitivity_sweep(candles_5m: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # time-equivalent of the best 1m config (bb=30, lookback=120, hold=30) on 5m units
    configs = [
        (6, 24, 0.7, 6),
        (6, 24, 0.5, 6),
        (8, 36, 0.7, 12),
    ]
    fees = [0.1, 0.075, 0.05, 0.02, 0.0]
    out = []
    for bb, lookback, sp, hold in configs:
        for fee in fees:
            res = squeeze_breakout_backtest(candles_5m, 300, bb, lookback, sp, hold, fee, allow_short=False)
            out.append({
                "bb_period": bb, "squeeze_lookback": lookback, "squeeze_pct": sp,
                "hold_units": hold, "fee_pct": fee, **res,
            })
    return out


def donchian_breakout_series(candles: list[dict[str, Any]], lookback: int) -> list[Optional[float]]:
    """Highest high of the lookback candles BEFORE the current one (exclusive)."""
    out: list[Optional[float]] = []
    for i in range(len(candles)):
        if i < lookback:
            out.append(None)
            continue
        window = candles[i - lookback:i]
        out.append(max(c["high"] for c in window))
    return out


def swing_breakout_backtest(
    candles: list[dict[str, Any]],
    lookback: int,
    hold_units: int,
    min_move_pct: float,
    fee_pct_roundtrip: float,
) -> dict[str, Any]:
    """LONG-only: enter when close breaks above its N-candle high by at least
    min_move_pct (to filter marginal breakouts), hold for hold_units candles
    (fixed-bar exit), no re-entry mid-hold."""
    donchian_hi = donchian_breakout_series(candles, lookback)
    trades = []
    i = lookback
    n = len(candles)
    while i < n - hold_units:
        hi = donchian_hi[i]
        if hi is None:
            i += 1
            continue
        px = candles[i]["close"]
        move_pct = (px - hi) / hi * 100.0
        if move_pct < min_move_pct:
            i += 1
            continue
        entry_price = px
        exit_price = candles[i + hold_units]["close"]
        pnl_pct = (exit_price - entry_price) / entry_price
        pnl_pct -= fee_pct_roundtrip / 100.0
        trades.append(pnl_pct)
        i += hold_units

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


def main() -> None:
    print("fetching ~30 days of 5m candles for BTC...")
    candles_5m = fetch_candles("BTC_USDT", "5m", 300, 30.0)
    print(f"got {len(candles_5m)} 5m candles")

    print("\n=== FEE SENSITIVITY: squeeze breakout, LONG-only ===")
    fee_results = fee_sensitivity_sweep(candles_5m)
    for r in fee_results:
        print(
            f"bb={r['bb_period']:>2} lookback={r['squeeze_lookback']:>3} squeeze_pct={r['squeeze_pct']} "
            f"hold={r['hold_units']:>2} fee={r['fee_pct']}%  entries={r['entries']:4d}  "
            f"win_rate={r['win_rate']}  net_pnl={r['total_pnl_pct']:+.3f}%  avg/trade={r['avg_pnl_pct_per_trade']}"
        )
    any_positive_at_zero_fee = any(r["fee_pct"] == 0.0 and r["total_pnl_pct"] > 0 for r in fee_results)
    print(f"\nany config net positive even at ZERO fee: {any_positive_at_zero_fee}"
          f" -> {'fee reduction alone CANNOT rescue this rule' if not any_positive_at_zero_fee else 'fee reduction may help'}")

    print("\n=== SWING TRADING: Donchian breakout, LONG-only, multi-hour holds ===")
    # lookback/hold in 5m units: 6=30m, 12=1h, 48=4h, 96=8h, 288=24h
    lookbacks = [48, 96, 144, 288]
    holds = [24, 48, 96, 144]
    min_moves = [0.1, 0.2, 0.3, 0.5]
    fees = [0.1, 0.05]
    results = []
    for lb in lookbacks:
        for hold in holds:
            for mm in min_moves:
                for fee in fees:
                    res = swing_breakout_backtest(candles_5m, lb, hold, mm, fee)
                    results.append({
                        "lookback": lb, "hold_units": hold, "min_move_pct": mm, "fee_pct": fee, **res,
                    })

    meaningful = [r for r in results if r["entries"] >= 10]
    meaningful.sort(key=lambda r: r["total_pnl_pct"], reverse=True)
    print(f"ran {len(results)} combos, {len(meaningful)} meaningful (entries>=10)")
    print("=== TOP 15 ===")
    for r in meaningful[:15]:
        print(
            f"lookback={r['lookback']:>3} hold={r['hold_units']:>3} min_move={r['min_move_pct']}% fee={r['fee_pct']}%  "
            f"entries={r['entries']:3d}  win_rate={r['win_rate']}  net_pnl={r['total_pnl_pct']:+.3f}%  "
            f"avg/trade={r['avg_pnl_pct_per_trade']}"
        )
    profitable = [r for r in meaningful if r["total_pnl_pct"] > 0]
    print(f"\nprofitable combos: {len(profitable)} / {len(meaningful)}")

    realistic = [r for r in meaningful if r["fee_pct"] == 0.1]
    realistic.sort(key=lambda r: r["total_pnl_pct"], reverse=True)
    if realistic:
        best = realistic[0]
        print(f"\nbest at realistic 0.1% fee: lookback={best['lookback']} hold={best['hold_units']} "
              f"min_move={best['min_move_pct']}%  net_pnl={best['total_pnl_pct']:+.3f}%  entries={best['entries']}")
        mid = len(candles_5m) // 2
        for label, chunk in (("first half", candles_5m[:mid]), ("second half", candles_5m[mid:])):
            res = swing_breakout_backtest(chunk, best["lookback"], best["hold_units"], best["min_move_pct"], 0.1)
            print(f"{label:12s} entries={res['entries']:3d}  win_rate={res['win_rate']}  "
                  f"net_pnl={res['total_pnl_pct']:+.3f}%  avg/trade={res['avg_pnl_pct_per_trade']}")

    import os
    os.makedirs("runtime", exist_ok=True)
    with open("runtime/fee_and_swing_results.json", "w") as f:
        json.dump({"fee_sensitivity": fee_results, "swing": results}, f, ensure_ascii=False, indent=2)
    print("\nfull results written to runtime/fee_and_swing_results.json")


if __name__ == "__main__":
    main()
