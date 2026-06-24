#!/usr/bin/env python3
"""Live runner for the volatility-squeeze breakout rule validated in
scripts/btc5m_backtest_novel.py (best config: BB(30) on 1m closes, 120-candle
squeeze lookback, squeeze_pct=0.7, 30-candle hold - net positive after fees
both in-sample and on an out-of-sample temporal split).

Unlike the clock-bucket momentum runner (btc5m_gateio_runner.py), this rule
isn't aligned to 5-minute buckets: it continuously watches realized
volatility (Bollinger Band width) on 1-minute candles, waits for a squeeze
(width well below its own recent average), and enters the moment price
breaks out of the squeeze's high/low range. Holds for a fixed number of
1-minute candles, then exits - independent of clock alignment.

Reuses the order-placement primitives (open_spot/close_spot/open_futures/
close_futures) from btc5m_gateio_runner.py so --execute behaves identically:
without it, every fill is simulated at the live ticker price with zero funds
at risk; with it, GATEIO_API_KEY/GATEIO_API_SECRET are required and real
orders are placed.
"""
import argparse
import datetime as dt
import json
import statistics
import time
from typing import Any, Optional

import requests

from btc5m_gateio_runner import close_futures, close_spot, open_futures, open_spot

UTC = dt.timezone.utc
GATEIO_REST = "https://api.gateio.ws/api/v4"


def ts_utc() -> str:
    return dt.datetime.now(UTC).isoformat().replace("+00:00", "Z")


def fetch_recent_1m_candles(n: int) -> list[dict[str, Any]]:
    now = int(time.time())
    r = requests.get(
        f"{GATEIO_REST}/spot/candlesticks",
        params={"currency_pair": "BTC_USDT", "interval": "1m", "from": now - n * 60, "to": now},
        timeout=10,
    )
    r.raise_for_status()
    rows = r.json()
    out = [{
        "ts": int(c[0]), "close": float(c[2]), "high": float(c[3]),
        "low": float(c[4]), "open": float(c[5]), "base_volume": float(c[6]),
    } for c in rows]
    out.sort(key=lambda x: x["ts"])
    return out


def bb_width(closes: list[float], period: int) -> Optional[float]:
    if len(closes) < period:
        return None
    window = closes[-period:]
    mid = sum(window) / period
    sd = statistics.pstdev(window)
    return (4 * sd) / mid if mid else None


def detect_squeeze_breakout(
    candles: list[dict[str, Any]], bb_period: int, squeeze_lookback: int, squeeze_pct: float
) -> Optional[str]:
    """Returns 'LONG'/'SHORT' if the latest candle is a breakout out of a
    just-ended squeeze, else None. Mirrors squeeze_breakout_backtest's logic
    in btc5m_backtest_novel.py exactly so live behavior matches the backtest."""
    closes = [c["close"] for c in candles]
    needed = bb_period + squeeze_lookback
    if len(candles) < needed + 1:
        return None

    widths = []
    for i in range(len(candles) - squeeze_lookback, len(candles)):
        w = bb_width(closes[: i + 1], bb_period)
        widths.append(w)
    trail = [w for w in widths[:-1] if w is not None]
    current_width = widths[-1]
    if current_width is None or len(trail) < squeeze_lookback // 2:
        return None

    avg_trail_width = sum(trail) / len(trail)
    was_squeezed = avg_trail_width > 0 and current_width <= avg_trail_width * squeeze_pct
    if not was_squeezed:
        return None

    range_window = candles[-squeeze_lookback - 1 : -1]
    range_hi = max(c["high"] for c in range_window)
    range_lo = min(c["low"] for c in range_window)
    breakout_px = candles[-1]["close"]
    if breakout_px > range_hi:
        return "LONG"
    if breakout_px < range_lo:
        return "SHORT"
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--market", choices=["spot", "futures"], required=True)
    ap.add_argument("--bb-period", type=int, default=30)
    ap.add_argument("--squeeze-lookback", type=int, default=120)
    ap.add_argument("--squeeze-pct", type=float, default=0.7)
    ap.add_argument("--hold-minutes", type=int, default=30)
    ap.add_argument("--stake-usd", type=float, default=5.0)
    ap.add_argument("--leverage", type=int, default=5, help="futures only")
    ap.add_argument("--poll-sec", type=float, default=10.0)
    ap.add_argument("--entry-timeout-min", type=int, default=120)
    ap.add_argument("--execute", action="store_true")
    args = ap.parse_args()

    report: dict[str, Any] = {"started_at": ts_utc(), "params": vars(args), "checks": []}

    deadline = time.time() + args.entry_timeout_min * 60
    opened = None
    last_seen_ts = None

    while time.time() < deadline:
        candles = fetch_recent_1m_candles(args.bb_period + args.squeeze_lookback + 5)
        if not candles:
            time.sleep(args.poll_sec)
            continue
        latest_ts = candles[-1]["ts"]
        if latest_ts == last_seen_ts:
            time.sleep(args.poll_sec)
            continue
        last_seen_ts = latest_ts

        side = detect_squeeze_breakout(candles, args.bb_period, args.squeeze_lookback, args.squeeze_pct)
        report["checks"].append({"ts": ts_utc(), "candle_ts": latest_ts, "close": candles[-1]["close"], "signal": side})

        if side is None:
            time.sleep(args.poll_sec)
            continue
        if args.market == "spot" and side == "SHORT":
            time.sleep(args.poll_sec)
            continue

        opener = open_spot if args.market == "spot" else (lambda stake, ex: open_futures(stake, args.leverage, ex))
        result = opener(args.stake_usd, args.execute)
        post = result.get("order_post_result") or {}
        if not post.get("success"):
            report["checks"].append({"ts": ts_utc(), "status": "open_failed", "result": result})
            time.sleep(args.poll_sec)
            continue

        opened = {
            "side": side, "entry_price": result.get("entry_price"),
            "qty_btc": result.get("qty_btc"), "contracts": result.get("contracts"),
            "leverage": result.get("leverage"), "opened_at": ts_utc(), "open_raw": result,
        }
        break

    if not opened:
        report["finished_at"] = ts_utc()
        report["result"] = "no_entry_timeout"
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return

    report["opened"] = opened
    hold_deadline = time.time() + args.hold_minutes * 60
    while time.time() < hold_deadline:
        time.sleep(args.poll_sec)

    closer = close_spot if args.market == "spot" else close_futures
    close_arg = opened["qty_btc"] if args.market == "spot" else opened["contracts"]
    close_result = closer(close_arg, args.execute)
    report["closed"] = {"closed_at": ts_utc(), "exit_price": close_result.get("exit_price"), "raw": close_result}

    entry_price = float(opened["entry_price"] or 0)
    exit_price = float(close_result.get("exit_price") or entry_price)
    direction = 1 if opened["side"] == "LONG" else -1
    if args.market == "spot":
        pnl_usd = direction * (exit_price - entry_price) * float(opened["qty_btc"] or 0)
    else:
        from btc5m_gateio_runner import fetch_futures_contract_spec
        spec = fetch_futures_contract_spec("BTC_USDT") or {}
        multiplier = float(spec.get("quanto_multiplier") or 0.0001)
        pnl_usd = direction * (exit_price - entry_price) * float(opened["contracts"] or 0) * multiplier
    report["pnl_usd"] = pnl_usd
    report["finished_at"] = ts_utc()
    report["result"] = "done"
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
