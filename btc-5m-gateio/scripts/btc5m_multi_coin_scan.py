#!/usr/bin/env python3
"""Scan a broad set of liquid coins (not just BTC) with the single
best-performing hypothesis from prior research - volatility-squeeze
breakout, LONG-only/spot - to see if the edge that failed BTC/ETH/SOL
robustness checks happens to hold up on some other coin.

Stablecoins, RWA/treasury tokens, and fund-wrapper tokens (USDT, USDC,
DAI, PAX Gold, BlackRock BUIDL, etc.) are excluded on purpose: they have
no real volatility for a breakout strategy to act on. The candidate list
below is liquid, genuinely volatile coins drawn from the current top-100
market-cap list that are plausibly listed on Gate.io spot as *_USDT.

For each coin: fetch ~30 days of 5m candles, run a small squeeze-breakout
config sweep (LONG-only, realistic 0.1% fee), keep the best config with
>=15 entries, then immediately stress-test that best config with a
first-half/second-half split - exactly the same rigor applied to BTC/ETH/SOL
earlier, so a promising number is never reported without checking whether
it's time-stable.
"""
import json
import time

from btc5m_backtest import fetch_candles
from btc5m_backtest_novel import squeeze_breakout_backtest

CANDIDATES = [
    "BTC", "ETH", "BNB", "XRP", "SOL", "TRX", "DOGE", "ADA", "LINK", "XLM",
    "BCH", "LTC", "HBAR", "SUI", "NEAR", "AVAX", "UNI", "DOT", "APT", "ARB",
    "ICP", "FIL", "ETC", "ALGO", "AAVE", "PEPE", "RENDER", "POL", "KAS",
    "ZEC", "XMR", "OKB", "QNT", "CAKE", "MNT", "ONDO", "MORPHO",
]

CONFIGS = [
    (6, 24, 0.5, 6),
    (6, 24, 0.7, 6),
    (6, 24, 0.5, 12),
    (6, 24, 0.7, 12),
]


def scan_coin(symbol: str) -> dict:
    pair = f"{symbol}_USDT"
    try:
        candles = fetch_candles(pair, "5m", 300, 30.0)
    except Exception as e:
        return {"symbol": symbol, "status": f"fetch_failed: {e}"}
    if len(candles) < 500:
        return {"symbol": symbol, "status": f"insufficient_data ({len(candles)} candles)"}

    best = None
    for bb, lookback, sp, hold in CONFIGS:
        res = squeeze_breakout_backtest(candles, 300, bb, lookback, sp, hold, 0.1, allow_short=False)
        if res["entries"] >= 15 and (best is None or res["total_pnl_pct"] > best["total_pnl_pct"]):
            best = {"bb_period": bb, "squeeze_lookback": lookback, "squeeze_pct": sp, "hold_units": hold, **res}

    if best is None:
        return {"symbol": symbol, "status": "no_config_with_15plus_entries", "n_candles": len(candles)}

    mid = len(candles) // 2
    first = squeeze_breakout_backtest(candles[:mid], 300, best["bb_period"], best["squeeze_lookback"], best["squeeze_pct"], best["hold_units"], 0.1, allow_short=False)
    second = squeeze_breakout_backtest(candles[mid:], 300, best["bb_period"], best["squeeze_lookback"], best["squeeze_pct"], best["hold_units"], 0.1, allow_short=False)
    robust = (
        best["total_pnl_pct"] > 0
        and first["total_pnl_pct"] > 0
        and second["total_pnl_pct"] > 0
        and (first["entries"] or 0) >= 5
        and (second["entries"] or 0) >= 5
    )
    return {
        "symbol": symbol, "status": "ok", "n_candles": len(candles),
        "best_config": best, "first_half": first, "second_half": second,
        "robust_both_halves_positive": robust,
    }


def main() -> None:
    results = []
    for sym in CANDIDATES:
        print(f"scanning {sym}...", flush=True)
        r = scan_coin(sym)
        results.append(r)
        if r.get("status") == "ok":
            b = r["best_config"]
            print(
                f"  best: bb={b['bb_period']} lb={b['squeeze_lookback']} sq={b['squeeze_pct']} hold={b['hold_units']}  "
                f"entries={b['entries']}  net_pnl={b['total_pnl_pct']:+.3f}%  "
                f"halves=({r['first_half']['total_pnl_pct']:+.3f}%, {r['second_half']['total_pnl_pct']:+.3f}%)  "
                f"robust={r['robust_both_halves_positive']}"
            )
        else:
            print(f"  {r['status']}")
        time.sleep(0.3)

    ok = [r for r in results if r.get("status") == "ok"]
    robust = [r for r in ok if r["robust_both_halves_positive"]]
    print(f"\n=== SUMMARY: {len(ok)}/{len(CANDIDATES)} coins scanned successfully, "
          f"{len(robust)} passed the both-halves-positive robustness check ===")
    for r in robust:
        b = r["best_config"]
        print(f"{r['symbol']}: net_pnl={b['total_pnl_pct']:+.3f}%  entries={b['entries']}  "
              f"halves=({r['first_half']['total_pnl_pct']:+.3f}%, {r['second_half']['total_pnl_pct']:+.3f}%)")

    import os
    os.makedirs("runtime", exist_ok=True)
    with open("runtime/multi_coin_squeeze_scan.json", "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print("\nfull results written to runtime/multi_coin_squeeze_scan.json")


if __name__ == "__main__":
    main()
