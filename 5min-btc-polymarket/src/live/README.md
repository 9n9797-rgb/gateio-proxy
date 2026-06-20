# pm_live_trade_runner.py

Execution engine for the BTC 5m skill, matching the CLI/JSON contract that
`scripts/test_btc_5m_session_exit_sl.py` expects from
`pm-hl-conservative-plus-repo` (which is not published by the upstream
project). Built from scratch using the official `py-clob-client` library.

## Modes

- **No `--execute` (default):** reads real public market data (Gamma API +
  CLOB order books) and prints a *simulated* fill at the current best
  bid/ask. No private key, no API creds, no funds at risk. This is what lets
  the parent skill's open -> monitor -> close loop be exercised end-to-end
  against live prices safely.
- **`--execute`:** places a real signed order on the live Polymarket CLOB.
  Requires these environment variables:
  - `PM_PRIVATE_KEY` — wallet private key (Polygon)
  - `PM_API_KEY`, `PM_API_SECRET`, `PM_API_PASSPHRASE` — CLOB API creds
  - `PM_FUNDER` / `PM_ADDRESS` (optional) — funding address if different
    from the signer
  - `PM_SIGNATURE_TYPE` (optional, default `2`)

## Running the skill against this runner

```bash
cd 5min-btc-polymarket
mkdir -p .venv/bin && ln -sf "$(command -v python3)" .venv/bin/python
python3 scripts/test_btc_5m_session_exit_sl.py \
  --profile conservative --repo "$(pwd)" \
  --entry-timeout-min 5 --poll-sec 5
```

Add `--execute` only after `PM_PRIVATE_KEY`/`PM_API_*` are set and you have
deliberately decided to risk real funds.

## Known upstream quirk

The parent script enters using the CLOB best-ask price but checks the
stop-loss using the Gamma `outcomePrices` field for the same side. Those two
prices are not the same probability/price space, so the stop-loss can trigger
immediately after entry even when the CLOB price hasn't moved. This is a
pre-existing inconsistency in `scripts/test_btc_5m_session_exit_sl.py`
(`get_side_price_from_slug`), not something introduced by this runner.
