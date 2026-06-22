#!/usr/bin/env python3
"""Fourth, structurally distinct hypothesis: VWAP deviation mean-reversion.

Every prior hypothesis compared price to either its own bucket-open price
(momentum/reversal) or its own recent high/low range (squeeze breakout).
This one compares price to a volume-weighted average price (VWAP) over a
rolling window - a genuinely different anchor that weights each candle by
how much actually traded there, not just where price happened to be.

Idea: when price strays far above/below VWAP, that's a stretch relative to
where most volume actually changed hands recently: bet on reversion back
toward VWAP (this is a real desk technique - VWAP bands are used exactly
this way in equities/futures execution and mean-reversion trading).

Backtestable on the full 30-day 5m sample (no order-book/trade-flow data
needed), unlike the order-book-imbalance hypothesis.
"""
import json
from typing import Any, Optional

from btc5m_backtest import fetch_candles


def rolling_vwap_series(candles: list[dict[str, Any]], window: int) -> list[Optional[float]]:
    out: list[Optional[float]] = []
    for i in range(len(candles)):
        if i < window - 1:
            out.append(None)
            continue
        win = candles[i - window + 1 : i + 1]
        total_vol = sum(c["base_volume"] for c in win)
        if total_vol <= 0:
            out.append(None)
            continue
        typical = sum(((c["high"] + c["low"] + c["close"]) / 3.0) * c["base_volume"] for c in win)
        out.append(typical / total_vol)
    return out


def vwap_reversion_backtest(
    candles: list[dict[str, Any]],
    vwap_window: int,
    deviation_pct: float,
    max_hold_units: int,
    fee_pct_roundtrip: float,
    allow_short: bool = True,
) -> dict[str, Any]:
    vwap = rolling_vwap_series(candles, vwap_window)
    trades = []
    i = vwap_window
    n = len(candles)
    while i < n - 1:
        v = vwap[i]
        if v is None:
            i += 1
            continue
        price = candles[i]["close"]
        dev = (price - v) / v * 100.0
        if abs(dev) < deviation_pct:
            i += 1
            continue
        side = "LONG" if dev < 0 else "SHORT"  # below VWAP -> bet reversion up; above -> bet reversion down
        if side == "SHORT" and not allow_short:
            i += 1
            continue
        entry_price = price
        exit_price = entry_price
        exit_i = i
        for j in range(i + 1, min(i + 1 + max_hold_units, n)):
            v_j = vwap[j]
            px_j = candles[j]["close"]
            exit_price = px_j
            exit_i = j
            if v_j is not None:
                reverted = (px_j >= v_j) if side == "LONG" else (px_j <= v_j)
                if reverted:
                    break
        pnl_pct = ((exit_price - entry_price) / entry_price) if side == "LONG" else ((entry_price - exit_price) / entry_price)
        pnl_pct -= fee_pct_roundtrip / 100.0
        trades.append(pnl_pct)
        i = exit_i + 1

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
    print("fetching ~30 days of 5m candles...")
    candles_5m = fetch_candles("BTC_USDT", "5m", 300, 30.0)
    print(f"got {len(candles_5m)} 5m candles (~{len(candles_5m)*5/60/24:.1f} days)")

    windows = [12, 24, 48, 96]       # 1h, 2h, 4h, 8h rolling VWAP
    deviations = [0.1, 0.2, 0.3, 0.5, 0.8]
    max_holds = [6, 12, 24]          # 30m, 1h, 2h max hold
    fees = [0.1, 0.05]

    results = []
    for window in windows:
        for dev in deviations:
            for hold in max_holds:
                for fee in fees:
                    res = vwap_reversion_backtest(candles_5m, window, dev, hold, fee)
                    results.append({
                        "vwap_window": window, "deviation_pct": dev,
                        "max_hold_units": hold, "fee_pct": fee, **res,
                    })

    meaningful = [r for r in results if r["entries"] >= 20]
    meaningful.sort(key=lambda r: r["total_pnl_pct"], reverse=True)
    print(f"\nran {len(results)} combos, {len(meaningful)} meaningful (entries>=20)")
    print("=== TOP 15 ===")
    for r in meaningful[:15]:
        print(
            f"window={r['vwap_window']:>3} dev={r['deviation_pct']}% hold={r['max_hold_units']:>3} fee={r['fee_pct']}%  "
            f"entries={r['entries']:4d}  win_rate={r['win_rate']}  net_pnl={r['total_pnl_pct']:+.3f}%  "
            f"avg/trade={r['avg_pnl_pct_per_trade']}"
        )
    profitable = [r for r in meaningful if r["total_pnl_pct"] > 0]
    print(f"\nprofitable combos: {len(profitable)} / {len(meaningful)}")

    # out-of-sample split check on the best config, realistic fee only
    realistic = [r for r in meaningful if r["fee_pct"] == 0.1]
    realistic.sort(key=lambda r: r["total_pnl_pct"], reverse=True)
    if realistic:
        best = realistic[0]
        print(f"\nbest at realistic 0.1% fee: window={best['vwap_window']} dev={best['deviation_pct']}% "
              f"hold={best['max_hold_units']}  net_pnl={best['total_pnl_pct']:+.3f}%  entries={best['entries']}")
        mid = len(candles_5m) // 2
        for label, chunk in (("first half", candles_5m[:mid]), ("second half", candles_5m[mid:])):
            res = vwap_reversion_backtest(chunk, best["vwap_window"], best["deviation_pct"], best["max_hold_units"], 0.1)
            print(f"{label:12s} entries={res['entries']:3d}  win_rate={res['win_rate']}  "
                  f"net_pnl={res['total_pnl_pct']:+.3f}%  avg/trade={res['avg_pnl_pct_per_trade']}")

    with open("runtime/vwap_reversion_results.json", "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print("\nfull results written to runtime/vwap_reversion_results.json")


if __name__ == "__main__":
    main()
