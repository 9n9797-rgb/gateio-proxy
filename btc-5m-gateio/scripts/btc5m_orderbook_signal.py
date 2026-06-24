#!/usr/bin/env python3
"""Order-book imbalance as a signal, distinct from the candle-based momentum/
reversal/squeeze rules already tested. Gate.io's REST API has no historical
order-book endpoint, so this can't be backtested on old data - it has to be
collected live and correlated against the price move that follows.

Idea: if bids heavily outweigh asks near the top of the book, that's real
buying pressure queued up (not yet reflected in trades), which should predict
a short-term up-move - and vice versa for ask-heavy books. This is a
genuinely different signal class from "price already moved X% this bucket."

Polls /spot/order_book every --poll-sec, computes an imbalance ratio over the
top --depth levels:
    imbalance = (sum(bid_sizes) - sum(ask_sizes)) / (sum(bid_sizes) + sum(ask_sizes))
range [-1, 1]. Then, --horizon-sec later, records the realized price move and
checks whether sign(imbalance) predicted sign(move), plus a fee-adjusted PnL
if traded mechanically (long when imbalance > threshold, short when < -threshold).
"""
import argparse
import json
import time
from typing import Any, Optional

import requests

GATEIO_REST = "https://api.gateio.ws/api/v4"


def fetch_order_book(depth: int) -> Optional[dict[str, Any]]:
    try:
        r = requests.get(
            f"{GATEIO_REST}/spot/order_book",
            params={"currency_pair": "BTC_USDT", "limit": depth},
            timeout=4,
        )
        r.raise_for_status()
        return r.json()
    except Exception:
        return None


def fetch_price() -> Optional[float]:
    try:
        r = requests.get(f"{GATEIO_REST}/spot/tickers", params={"currency_pair": "BTC_USDT"}, timeout=4)
        r.raise_for_status()
        arr = r.json()
        return float(arr[0]["last"]) if arr else None
    except Exception:
        return None


def imbalance_from_book(book: dict[str, Any], depth: int) -> Optional[float]:
    bids = book.get("bids") or []
    asks = book.get("asks") or []
    bid_sz = sum(float(b[1]) for b in bids[:depth])
    ask_sz = sum(float(a[1]) for a in asks[:depth])
    total = bid_sz + ask_sz
    if total <= 0:
        return None
    return (bid_sz - ask_sz) / total


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--depth", type=int, default=20)
    ap.add_argument("--poll-sec", type=float, default=5.0)
    ap.add_argument("--horizon-sec", type=int, default=60, help="how far ahead to check the realized price move")
    ap.add_argument("--duration-min", type=float, default=15.0)
    ap.add_argument("--imbalance-threshold", type=float, default=0.3, help="only count as a signal if |imbalance| >= this")
    ap.add_argument("--fee-pct-roundtrip", type=float, default=0.1)
    ap.add_argument("--out", default="runtime/orderbook_signal_log.jsonl")
    args = ap.parse_args()

    pending: list[dict[str, Any]] = []  # snapshots awaiting their horizon to elapse
    resolved: list[dict[str, Any]] = []
    deadline = time.time() + args.duration_min * 60

    with open(args.out, "a") as logf:
        while time.time() < deadline or pending:
            now = time.time()
            if now < deadline:
                book = fetch_order_book(args.depth)
                price = fetch_price()
                if book is not None and price is not None:
                    imb = imbalance_from_book(book, args.depth)
                    if imb is not None:
                        pending.append({"t0": now, "price0": price, "imbalance": imb})

            still_pending = []
            for snap in pending:
                if now - snap["t0"] >= args.horizon_sec:
                    price1 = fetch_price()
                    if price1 is not None:
                        move = price1 - snap["price0"]
                        rec = {**snap, "t1": now, "price1": price1, "move": move}
                        resolved.append(rec)
                        logf.write(json.dumps(rec) + "\n")
                        logf.flush()
                    continue
                still_pending.append(snap)
            pending = still_pending

            time.sleep(args.poll_sec)

    signals = [r for r in resolved if abs(r["imbalance"]) >= args.imbalance_threshold]
    correct = 0
    trades_pnl = []
    for r in signals:
        predicted_up = r["imbalance"] > 0
        actual_up = r["move"] > 0
        if predicted_up == actual_up:
            correct += 1
        side_long = predicted_up
        pnl_pct = (r["move"] / r["price0"]) if side_long else (-r["move"] / r["price0"])
        pnl_pct -= args.fee_pct_roundtrip / 100.0
        trades_pnl.append(pnl_pct)

    report = {
        "total_snapshots": len(resolved),
        "signals_above_threshold": len(signals),
        "directional_accuracy": round(correct / len(signals), 3) if signals else None,
        "mechanical_trade_count": len(trades_pnl),
        "mechanical_net_pnl_pct": round(sum(trades_pnl) * 100, 3) if trades_pnl else 0.0,
        "mechanical_avg_pnl_pct_per_trade": round((sum(trades_pnl) / len(trades_pnl)) * 100, 4) if trades_pnl else None,
        "params": vars(args),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
