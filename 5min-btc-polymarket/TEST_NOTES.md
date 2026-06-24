# Test Notes (Dry-Run Verification)

Source: https://github.com/Novals83/5min-btc-polymarket

## What was verified
Ran `scripts/test_btc_5m_session_exit_sl.py --profile conservative` (no `--execute`)
against the live Polymarket API.

- Market resolution worked: found the active `btc-updown-5m-<bucket>` event via
  `gamma-api.polymarket.com`.
- CLOB best-ask polling worked (no API key needed for read-only quotes).
- Signal logic worked correctly: UP ask reached ~0.81-0.83, above the 0.70
  threshold, and the script correctly selected the UP side.

## Key finding: execution engine is missing from this repo
Order placement is delegated via `subprocess` to:

```
<repo>/src/live/pm_live_trade_runner.py
```

where `<repo>` defaults to a sibling directory `pm-hl-conservative-plus-repo`.
That directory/repo is **not included** in `Novals83/5min-btc-polymarket` and is
not public. Attempting a run produced:

```
No such file or directory: '.venv/bin/python'
```

This confirms: this repository is a decision/orchestration layer only
(market monitoring + entry/exit signal logic + risk config). It cannot place
real or paper trades on its own — a separate, unpublished execution engine
(`pm_live_trade_runner.py`) is required to actually submit orders via
`py_clob_client`.

## Practical implication
To use this for real trading you would need to either:
1. Obtain/build `pm-hl-conservative-plus-repo` with a compatible
   `src/live/pm_live_trade_runner.py` CLI (`--market-slug`, `--force-side`,
   `--start-equity`, `--risk-frac`, `--max-notional-usd`, `--close-token-id`,
   `--close-shares`, `--execute`, etc.), or
2. Write your own runner matching that CLI contract.

No real funds or credentials were used in this test; only public read-only
market data endpoints were called.
