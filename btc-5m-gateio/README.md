# BTC 5m Momentum on Gate.io

Same momentum-into-close idea as `../5min-btc-polymarket`, but trading real
BTC on Gate.io directly (spot or USDT-margined futures) instead of betting
on a Polymarket Up/Down market. Built so it works with the Gate.io account
this proxy repo already targets — no Polygon wallet needed.

## How it works
- Aligns to 5-minute clock buckets (`now - now % 300`).
- Tracks the BTC/USDT price at the start of each bucket via Gate.io's public
  ticker (`/spot/tickers`).
- Once `seconds_left <= --min-entry-seconds-left` (default 130s) and the
  price has moved at least `--btc-move-min-usd` (default $70) from the
  bucket-start price, opens a position in the direction of the move
  (LONG if up, SHORT if down).
- Spot has no shorting, so spot mode only takes LONG entries.
- Closes at `--exit-before-sec` before the bucket ends, or earlier if price
  moves against the entry by `--stop-loss-pct` (default 50%, i.e. a wide
  safety net rather than a tight scalping stop).

## Modes
- **No `--execute` (default):** reads live public Gate.io prices and
  simulates a fill — no credentials, no funds at risk. This is what was used
  to verify the open/monitor/close loop end-to-end.
- **`--execute`:** places real orders. Requires `GATEIO_API_KEY` and
  `GATEIO_API_SECRET` in the environment (same variables `server.js` in this
  repo already uses).

## Run

```bash
pip install requests gate-api

# Spot, dry-run
python3 scripts/btc5m_gateio_runner.py --market spot --entry-timeout-min 60

# Futures, dry-run, 5x leverage
python3 scripts/btc5m_gateio_runner.py --market futures --leverage 5 --entry-timeout-min 60

# Real spot trading (only after setting GATEIO_API_KEY / GATEIO_API_SECRET)
python3 scripts/btc5m_gateio_runner.py --market spot --stake-usd 5 --execute
```

## Risk notes
- Futures with leverage can lose more than the margin posted if price moves
  fast against the position; the stop-loss here is a best-effort price check
  polled every `--poll-sec`, not a guaranteed exchange-side stop order.
- `--btc-move-min-usd` and `--stop-loss-pct` are unvalidated defaults
  carried over from the Polymarket skill's documented strategy, not a
  backtested edge for direct spot/futures trading. Treat this as a starting
  point, not a proven strategy.
- Always dry-run first and verify the JSON report before ever using
  `--execute`.
