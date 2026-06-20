#!/usr/bin/env python3
"""Execution engine for the BTC 5m skill.

Implements the CLI contract expected by
scripts/test_btc_5m_session_exit_sl.py (run_open / run_close):

Open:
  --market-slug SLUG --force-side UP|DOWN --start-equity N
  --risk-frac F --max-notional-usd N [--execute]

Close:
  --market-slug SLUG --close-token-id ID --close-shares N
  [--close-limit-price P] [--execute]

Without --execute this never talks to a wallet/private key: it only
reads public market data and prints a simulated fill, so the parent
skill's open/monitor/close loop can be exercised end-to-end risk-free.

With --execute it requires PM_PRIVATE_KEY + PM_API_KEY/SECRET/PASSPHRASE
(and optionally PM_FUNDER/PM_ADDRESS, PM_SIGNATURE_TYPE) and places a
real signed order against the live Polymarket CLOB.
"""
import argparse
import json
import os
import sys
import time
from typing import Any, Optional

import requests
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import ApiCreds, MarketOrderArgs, OrderArgs, OrderType
from py_clob_client.constants import POLYGON
from py_clob_client.order_builder.constants import BUY, SELL

CLOB_BASE = "https://clob.polymarket.com"


def emit(obj: dict[str, Any]) -> None:
    print(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def fetch_event(slug: str) -> Optional[dict[str, Any]]:
    r = requests.get("https://gamma-api.polymarket.com/events", params={"slug": slug}, timeout=12)
    r.raise_for_status()
    arr = r.json()
    return arr[0] if arr else None


def parse_json_field(v):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return v
    return v


def market_tokens(market: dict[str, Any]) -> tuple[str, str]:
    outcomes = parse_json_field(market.get("outcomes")) or []
    token_ids = parse_json_field(market.get("clobTokenIds")) or []
    up_i, down_i = 0, 1
    labs = [str(x).lower() for x in outcomes[:2]] if isinstance(outcomes, list) else []
    if len(labs) >= 2 and ("up" in labs[1] or "yes" in labs[1]):
        up_i, down_i = 1, 0
    return str(token_ids[up_i]), str(token_ids[down_i])


def resolve_market(slug: str) -> dict[str, Any]:
    ev = fetch_event(slug)
    if not ev:
        raise RuntimeError(f"market not found for slug {slug}")
    mkts = ev.get("markets") or []
    if not mkts:
        raise RuntimeError(f"no markets in event {slug}")
    return mkts[0]


def public_client() -> ClobClient:
    return ClobClient(host=CLOB_BASE, chain_id=POLYGON)


def best_bid_ask(book) -> tuple[Optional[float], Optional[float]]:
    bids = getattr(book, "bids", []) or []
    asks = getattr(book, "asks", []) or []
    best_bid = max((float(getattr(b, "price", 0) or 0) for b in bids), default=None)
    best_ask = min((float(getattr(a, "price", 0) or 0) for a in asks), default=None)
    return best_bid, best_ask


def authed_client() -> ClobClient:
    key = os.getenv("PM_PRIVATE_KEY") or ""
    funder = os.getenv("PM_FUNDER") or os.getenv("PM_ADDRESS") or None
    sig = int(os.getenv("PM_SIGNATURE_TYPE", "2"))
    api_key = os.getenv("PM_API_KEY") or ""
    api_secret = os.getenv("PM_API_SECRET") or ""
    api_passphrase = os.getenv("PM_API_PASSPHRASE") or ""
    if not key or not api_key or not api_secret or not api_passphrase:
        raise RuntimeError(
            "missing credentials: PM_PRIVATE_KEY/PM_API_KEY/PM_API_SECRET/PM_API_PASSPHRASE are required for --execute"
        )
    c = ClobClient(host=CLOB_BASE, chain_id=POLYGON, key=key, signature_type=sig, funder=funder)
    c.set_api_creds(ApiCreds(api_key=api_key, api_secret=api_secret, api_passphrase=api_passphrase))
    return c


def do_open(args: argparse.Namespace) -> None:
    market = resolve_market(args.market_slug)
    up_t, dn_t = market_tokens(market)
    token_id = up_t if args.force_side == "UP" else dn_t

    pub = public_client()
    book = pub.get_order_book(token_id)
    _, best_ask = best_bid_ask(book)
    if best_ask is None:
        emit({"close_skipped": "", "order_post_result": {"success": False, "status": "no_liquidity"}})
        return

    notional = min(args.max_notional_usd, args.start_equity * args.risk_frac)
    if notional <= 0:
        emit({"order_post_result": {"success": False, "status": "zero_notional"}})
        return

    max_spread = float(os.getenv("PM_MAX_SPREAD", "1"))
    min_top_ask_usd = float(os.getenv("PM_MIN_TOP_ASK_NOTIONAL_USD", "0"))
    best_bid, _ = best_bid_ask(book)
    spread = (best_ask - best_bid) if (best_bid is not None) else None
    if spread is not None and spread > max_spread:
        emit({"order_post_result": {"success": False, "status": "spread_too_wide"}})
        return

    if not args.execute:
        shares = round(notional / best_ask, 6)
        emit({
            "token_id": token_id,
            "entry_price": best_ask,
            "simulated": True,
            "order_post_result": {
                "success": True,
                "status": "matched",
                "takingAmount": shares,
                "makingAmount": notional,
                "orderID": f"SIM-{int(time.time() * 1000)}",
                "transactionsHashes": [],
            },
        })
        return

    order_type = OrderType.FAK if os.getenv("PM_ORDER_TYPE", "FAK").upper() == "FAK" else OrderType.FOK
    client = authed_client()
    order_args = MarketOrderArgs(
        token_id=token_id,
        amount=notional,
        side=BUY,
        price=best_ask,
        order_type=order_type,
    )
    signed = client.create_market_order(order_args)
    resp = client.post_order(signed, orderType=order_type)
    emit({
        "token_id": token_id,
        "entry_price": best_ask,
        "order_post_result": resp,
    })


def do_close(args: argparse.Namespace) -> None:
    if float(args.close_shares) <= 0:
        emit({"close_skipped": "zero_effective_shares", "order_post_result": {"success": False, "status": ""}})
        return

    if not args.execute:
        pub = public_client()
        book = pub.get_order_book(args.close_token_id)
        best_bid, _ = best_bid_ask(book)
        px = args.close_limit_price or best_bid or 0.5
        emit({
            "simulated": True,
            "order_post_result": {
                "success": True,
                "status": "matched",
                "takingAmount": args.close_shares,
                "makingAmount": args.close_shares * px,
                "orderID": f"SIM-CLOSE-{int(time.time() * 1000)}",
                "transactionsHashes": [],
            },
        })
        return

    order_type_name = os.getenv("PM_CLOSE_ORDER_TYPE", "FAK").upper()
    order_type = OrderType.GTC if order_type_name == "GTC" else OrderType.FAK
    client = authed_client()

    if order_type == OrderType.GTC:
        if not args.close_limit_price:
            raise RuntimeError("--close-limit-price is required for GTC close orders")
        order_args = OrderArgs(
            token_id=args.close_token_id,
            price=float(args.close_limit_price),
            size=float(args.close_shares),
            side=SELL,
        )
        signed = client.create_order(order_args)
        resp = client.post_order(signed, orderType=order_type)
    else:
        pub = public_client()
        book = pub.get_order_book(args.close_token_id)
        best_bid, _ = best_bid_ask(book)
        order_args = MarketOrderArgs(
            token_id=args.close_token_id,
            amount=float(args.close_shares),
            side=SELL,
            price=best_bid or 0.01,
            order_type=order_type,
        )
        signed = client.create_market_order(order_args)
        resp = client.post_order(signed, orderType=order_type)

    emit({"order_post_result": resp})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--market-slug", required=True)
    ap.add_argument("--force-side", choices=["UP", "DOWN"])
    ap.add_argument("--start-equity", type=float, default=100.0)
    ap.add_argument("--risk-frac", type=float, default=0.5)
    ap.add_argument("--max-notional-usd", type=float, default=5.0)
    ap.add_argument("--close-token-id")
    ap.add_argument("--close-shares", type=float)
    ap.add_argument("--close-limit-price", type=float, default=None)
    ap.add_argument("--execute", action="store_true")
    args = ap.parse_args()

    try:
        if args.close_token_id is not None:
            do_close(args)
        else:
            if not args.force_side:
                raise RuntimeError("--force-side is required to open a position")
            do_open(args)
    except Exception as e:
        emit({"order_post_result": {"success": False, "status": "error", "error": str(e)}})


if __name__ == "__main__":
    main()
