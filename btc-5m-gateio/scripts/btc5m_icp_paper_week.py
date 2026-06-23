#!/usr/bin/env python3
"""Simulate buying a $10,000 portfolio and trading it for one week using the
ICP squeeze-breakout rule (the only config that passed the both-halves
robustness filter in btc5m_multi_coin_scan.py), with real capital compounding
between trades. No real money moves - this is a historical simulation over
the most recent ~7 days of actual Gate.io candles, not a live forward test.

Also computes a plain buy-and-hold comparison over the same window, since
"what if I just held it" is the natural baseline for any active strategy.

Caveat printed at the end: this is the SAME historical data already used to
discover the ICP config, just a shorter recent slice of it - it is NOT a true
out-of-sample test. A true out-of-sample read requires watching it forward in
real time (which takes an actual week, paper-only, no --execute).
"""
import json
from typing import Any

from btc5m_backtest import fetch_candles
from btc5m_backtest_novel import bb_width_series


BB_PERIOD = 6
SQUEEZE_LOOKBACK = 24
SQUEEZE_PCT = 0.7
HOLD_UNITS = 6
FEE_PCT_ROUNDTRIP = 0.1
START_BALANCE = 10_000.0


def simulate_week(candles: list[dict[str, Any]]) -> dict[str, Any]:
    closes = [c["close"] for c in candles]
    width = bb_width_series(closes, BB_PERIOD)

    balance = START_BALANCE
    trades = []
    i = BB_PERIOD + SQUEEZE_LOOKBACK
    n = len(candles)
    while i < n - HOLD_UNITS:
        w = width[i]
        if w is None:
            i += 1
            continue
        trail = [x for x in width[i - SQUEEZE_LOOKBACK:i] if x is not None]
        if len(trail) < SQUEEZE_LOOKBACK // 2:
            i += 1
            continue
        avg_trail_width = sum(trail) / len(trail)
        was_squeezed = avg_trail_width > 0 and w <= avg_trail_width * SQUEEZE_PCT
        if not was_squeezed:
            i += 1
            continue
        range_window = candles[i - SQUEEZE_LOOKBACK:i]
        range_hi = max(c["high"] for c in range_window)
        breakout_px = candles[i]["close"]
        if breakout_px <= range_hi:
            i += 1  # LONG-only: skip SHORT-side breakouts entirely
            continue

        entry_price = breakout_px
        entry_ts = candles[i]["ts"]
        exit_price = candles[i + HOLD_UNITS]["close"]
        exit_ts = candles[i + HOLD_UNITS]["ts"]
        pnl_pct = (exit_price - entry_price) / entry_price - FEE_PCT_ROUNDTRIP / 100.0

        balance_before = balance
        balance *= (1 + pnl_pct)
        trades.append({
            "entry_ts": entry_ts, "exit_ts": exit_ts,
            "entry_price": entry_price, "exit_price": exit_price,
            "pnl_pct": round(pnl_pct * 100, 4),
            "balance_before": round(balance_before, 2),
            "balance_after": round(balance, 2),
        })
        i += HOLD_UNITS

    buy_hold_qty = START_BALANCE / candles[0]["close"]
    buy_hold_final = buy_hold_qty * candles[-1]["close"]

    return {
        "window_start": candles[0]["ts"], "window_end": candles[-1]["ts"],
        "n_candles": len(candles),
        "strategy_start_balance": START_BALANCE,
        "strategy_final_balance": round(balance, 2),
        "strategy_return_pct": round((balance / START_BALANCE - 1) * 100, 3),
        "n_trades": len(trades),
        "wins": sum(1 for t in trades if t["pnl_pct"] > 0),
        "losses": sum(1 for t in trades if t["pnl_pct"] < 0),
        "trades": trades,
        "buy_hold_final_balance": round(buy_hold_final, 2),
        "buy_hold_return_pct": round((buy_hold_final / START_BALANCE - 1) * 100, 3),
    }


def main() -> None:
    print("fetching ~30 days of 5m ICP_USDT candles (will use the most recent 7 days)...")
    candles_all = fetch_candles("ICP_USDT", "5m", 300, 30.0)
    seconds_per_week = 7 * 86400
    cutoff = candles_all[-1]["ts"] - seconds_per_week
    week_candles = [c for c in candles_all if c["ts"] >= cutoff]
    print(f"using {len(week_candles)} candles covering the most recent ~7 days")

    result = simulate_week(week_candles)

    print(f"\n=== $10,000 portfolio, ICP squeeze-breakout strategy, LONG-only, 1 week ===")
    print(f"trades: {result['n_trades']}  (wins={result['wins']}, losses={result['losses']})")
    for t in result["trades"]:
        print(f"  entry={t['entry_price']:.4f}  exit={t['exit_price']:.4f}  pnl={t['pnl_pct']:+.3f}%  "
              f"balance: ${t['balance_before']:,.2f} -> ${t['balance_after']:,.2f}")
    print(f"\nstart balance:  ${result['strategy_start_balance']:,.2f}")
    print(f"final balance:  ${result['strategy_final_balance']:,.2f}  ({result['strategy_return_pct']:+.3f}%)")
    print(f"\n--- comparison: just buying and holding $10,000 of ICP for the same week ---")
    print(f"buy&hold final: ${result['buy_hold_final_balance']:,.2f}  ({result['buy_hold_return_pct']:+.3f}%)")

    print("\nCAVEAT: this week is part of the SAME historical data already used to pick this")
    print("config (multi-coin scan + dense neighborhood scan on the full 30-day sample),")
    print("so it is not a true out-of-sample test - it shows what the rule would have done")
    print("on a slice of data it was indirectly tuned on. A real answer requires watching")
    print("it trade forward in real time for a week, paper-only, with no past lookback.")

    import os
    os.makedirs("runtime", exist_ok=True)
    with open("runtime/icp_paper_week.json", "w") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print("\nfull results written to runtime/icp_paper_week.json")


if __name__ == "__main__":
    main()
