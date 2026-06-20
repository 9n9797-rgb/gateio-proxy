#!/usr/bin/env python3
"""BTC 5-minute momentum runner that trades directly on Gate.io (spot or
USDT-margined futures) instead of betting on a Polymarket Up/Down market.

Same core idea as the Polymarket skill (5min-btc-polymarket): align to
5-minute clock buckets, wait until near the end of the bucket, and only
enter if BTC has made a real dollar move in that bucket. The difference is
that here the "position" is an actual spot buy/sell or futures long/short
on Gate.io, not a binary-outcome token.

Without --execute this never signs/sends a real order: it simulates a fill
at the live ticker price so the full open -> monitor -> close loop can be
exercised against real market data with zero funds at risk.

With --execute it requires GATEIO_API_KEY / GATEIO_API_SECRET and places
real orders.
"""
import argparse
import datetime as dt
import json
import os
import time
from typing import Any, Optional

import requests

UTC = dt.timezone.utc
GATEIO_REST = "https://api.gateio.ws/api/v4"


def ts_utc() -> str:
    return dt.datetime.now(UTC).isoformat().replace("+00:00", "Z")


def bucket_5m(ts: int) -> int:
    return ts - (ts % 300)


def fetch_btc_price() -> Optional[float]:
    try:
        r = requests.get(f"{GATEIO_REST}/spot/tickers", params={"currency_pair": "BTC_USDT"}, timeout=4)
        r.raise_for_status()
        arr = r.json()
        return float(arr[0]["last"]) if arr else None
    except Exception:
        return None


def fetch_futures_contract_spec(contract: str = "BTC_USDT") -> Optional[dict[str, Any]]:
    try:
        r = requests.get(f"{GATEIO_REST}/futures/usdt/contracts/{contract}", timeout=6)
        r.raise_for_status()
        return r.json()
    except Exception:
        return None


def gate_clients():
    """Build authenticated gate_api clients. Only called when --execute is set."""
    import gate_api

    api_key = os.getenv("GATEIO_API_KEY") or ""
    api_secret = os.getenv("GATEIO_API_SECRET") or ""
    if not api_key or not api_secret:
        raise RuntimeError("missing credentials: GATEIO_API_KEY/GATEIO_API_SECRET are required for --execute")
    cfg = gate_api.Configuration(key=api_key, secret=api_secret)
    client = gate_api.ApiClient(cfg)
    return gate_api.SpotApi(client), gate_api.FuturesApi(client)


# ---------------------------------------------------------------- spot ----

def open_spot(stake_usd: float, execute: bool) -> dict[str, Any]:
    price = fetch_btc_price()
    if price is None:
        return {"order_post_result": {"success": False, "status": "no_price_feed"}}

    if not execute:
        qty = round(stake_usd / price, 8)
        return {
            "entry_price": price,
            "qty_btc": qty,
            "simulated": True,
            "order_post_result": {"success": True, "status": "matched", "filled_total": stake_usd},
        }

    import gate_api

    spot_api, _ = gate_clients()
    order = gate_api.Order(currency_pair="BTC_USDT", type="market", account="spot", side="buy", amount=str(stake_usd))
    resp = spot_api.create_order(order)
    qty = float(getattr(resp, "filled_amount", 0) or 0)
    avg_price = float(getattr(resp, "avg_deal_price", 0) or price)
    return {
        "entry_price": avg_price,
        "qty_btc": qty,
        "order_post_result": {"success": True, "status": str(getattr(resp, "status", "")), "order_id": getattr(resp, "id", None)},
    }


def close_spot(qty_btc: float, execute: bool) -> dict[str, Any]:
    price = fetch_btc_price()
    if not execute:
        return {
            "exit_price": price,
            "simulated": True,
            "order_post_result": {"success": True, "status": "matched", "filled_total": (price or 0) * qty_btc},
        }

    import gate_api

    spot_api, _ = gate_clients()
    order = gate_api.Order(currency_pair="BTC_USDT", type="market", account="spot", side="sell", amount=f"{qty_btc:.8f}")
    resp = spot_api.create_order(order)
    avg_price = float(getattr(resp, "avg_deal_price", 0) or price or 0)
    return {
        "exit_price": avg_price,
        "order_post_result": {"success": True, "status": str(getattr(resp, "status", "")), "order_id": getattr(resp, "id", None)},
    }


# ------------------------------------------------------------- futures ----

def contracts_for_notional(notional_usd: float, price: float, spec: dict[str, Any]) -> int:
    multiplier = float(spec.get("quanto_multiplier") or 0.0001)
    size = int(notional_usd / (price * multiplier))
    return max(int(spec.get("order_size_min") or 1), size)


def open_futures(stake_usd: float, leverage: int, execute: bool) -> dict[str, Any]:
    price = fetch_btc_price()
    spec = fetch_futures_contract_spec("BTC_USDT")
    if price is None or spec is None:
        return {"order_post_result": {"success": False, "status": "no_price_or_spec"}}

    notional = stake_usd * leverage
    size = contracts_for_notional(notional, price, spec)

    if not execute:
        return {
            "entry_price": price,
            "contracts": size,
            "leverage": leverage,
            "simulated": True,
            "order_post_result": {"success": True, "status": "matched"},
        }

    import gate_api

    _, futures_api = gate_clients()
    futures_api.update_position_leverage(settle="usdt", contract="BTC_USDT", leverage=str(leverage))
    order = gate_api.FuturesOrder(contract="BTC_USDT", size=size, price="0", tif="ioc")
    resp = futures_api.create_futures_order(settle="usdt", futures_order=order)
    return {
        "entry_price": float(getattr(resp, "fill_price", 0) or price),
        "contracts": size,
        "leverage": leverage,
        "order_post_result": {"success": True, "status": str(getattr(resp, "status", "")), "order_id": getattr(resp, "id", None)},
    }


def close_futures(contracts: int, execute: bool) -> dict[str, Any]:
    price = fetch_btc_price()
    if not execute:
        return {
            "exit_price": price,
            "simulated": True,
            "order_post_result": {"success": True, "status": "matched"},
        }

    import gate_api

    _, futures_api = gate_clients()
    order = gate_api.FuturesOrder(contract="BTC_USDT", size=-contracts, price="0", tif="ioc", reduce_only=True)
    resp = futures_api.create_futures_order(settle="usdt", futures_order=order)
    return {
        "exit_price": float(getattr(resp, "fill_price", 0) or price or 0),
        "order_post_result": {"success": True, "status": str(getattr(resp, "status", "")), "order_id": getattr(resp, "id", None)},
    }


# ----------------------------------------------------------------- main ----

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--market", choices=["spot", "futures"], required=True)
    ap.add_argument("--btc-move-min-usd", type=float, default=70.0)
    ap.add_argument("--stake-usd", type=float, default=5.0)
    ap.add_argument("--leverage", type=int, default=5, help="futures only")
    ap.add_argument("--stop-loss-pct", type=float, default=0.5, help="close if price moves this %% against entry, relative to the bucket move target")
    ap.add_argument("--min-entry-seconds-left", type=int, default=130, help="only consider entries once <= N seconds remain in the bucket")
    ap.add_argument("--exit-before-sec", type=int, default=20, help="time-exit this many seconds before bucket end")
    ap.add_argument("--poll-sec", type=float, default=5.0)
    ap.add_argument("--entry-timeout-min", type=int, default=60)
    ap.add_argument("--execute", action="store_true")
    args = ap.parse_args()

    report: dict[str, Any] = {
        "started_at": ts_utc(),
        "params": vars(args),
        "attempts": [],
    }

    deadline = time.time() + args.entry_timeout_min * 60
    bucket_id: Optional[int] = None
    bucket_start_price: Optional[float] = None
    opened = None

    while time.time() < deadline:
        now = time.time()
        cur_bucket = bucket_5m(int(now))
        sec_left = cur_bucket + 300 - now

        if cur_bucket != bucket_id:
            bucket_id = cur_bucket
            bucket_start_price = fetch_btc_price()

        price_now = fetch_btc_price()
        move_usd = (price_now - bucket_start_price) if (price_now is not None and bucket_start_price is not None) else None

        report["attempts"].append({
            "ts": ts_utc(), "bucket": bucket_id, "seconds_left": sec_left,
            "bucket_start_price": bucket_start_price, "price_now": price_now, "move_usd": move_usd,
        })

        if sec_left > args.min_entry_seconds_left or sec_left <= args.exit_before_sec:
            time.sleep(args.poll_sec)
            continue

        if move_usd is None or abs(move_usd) < args.btc_move_min_usd:
            time.sleep(args.poll_sec)
            continue

        side = "LONG" if move_usd > 0 else "SHORT"
        if args.market == "spot" and side == "SHORT":
            # spot has no short selling; skip and wait for the next bucket
            time.sleep(args.poll_sec)
            continue

        opener = open_spot if args.market == "spot" else (lambda stake, ex: open_futures(stake, args.leverage, ex))
        result = opener(args.stake_usd, args.execute)
        post = result.get("order_post_result") or {}
        if not post.get("success"):
            report["attempts"].append({"ts": ts_utc(), "status": "open_failed", "result": result})
            time.sleep(args.poll_sec)
            continue

        opened = {
            "bucket": bucket_id, "side": side, "entry_price": result.get("entry_price"),
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
    entry_price = float(opened["entry_price"] or 0)
    bucket_end = opened["bucket"] + 300
    sl_price = entry_price * (1 - args.stop_loss_pct) if opened["side"] == "LONG" else entry_price * (1 + args.stop_loss_pct)

    close_reason = None
    while True:
        now = time.time()
        if now >= bucket_end - args.exit_before_sec:
            close_reason = "time_exit"
            break
        px = fetch_btc_price()
        if px is not None:
            if opened["side"] == "LONG" and px <= sl_price:
                close_reason = "stop_loss"
                break
            if opened["side"] == "SHORT" and px >= sl_price:
                close_reason = "stop_loss"
                break
        time.sleep(args.poll_sec)

    closer = close_spot if args.market == "spot" else close_futures
    close_arg = opened["qty_btc"] if args.market == "spot" else opened["contracts"]
    close_result = closer(close_arg, args.execute)
    report["closed"] = {
        "reason": close_reason, "closed_at": ts_utc(),
        "exit_price": close_result.get("exit_price"), "raw": close_result,
    }

    exit_price = float(close_result.get("exit_price") or entry_price)
    if args.market == "spot":
        pnl_usd = (exit_price - entry_price) * float(opened["qty_btc"] or 0)
    else:
        spec = fetch_futures_contract_spec("BTC_USDT") or {}
        multiplier = float(spec.get("quanto_multiplier") or 0.0001)
        direction = 1 if opened["side"] == "LONG" else -1
        pnl_usd = direction * (exit_price - entry_price) * float(opened["contracts"] or 0) * multiplier
    report["pnl_usd"] = pnl_usd
    report["finished_at"] = ts_utc()
    report["result"] = "done"
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
