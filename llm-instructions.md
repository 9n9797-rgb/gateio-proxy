# LLM Quick Guide for Gate.io Proxy v2

## Endpoints
- Health (server only): `GET /healthz`
- Proxy health (check upstream): `GET /proxy/healthz`
- Wallet balances: `GET /proxy/balances`
- Open orders: `GET /proxy/orders/open`
- Place order: `POST /proxy/orders`
- Cancel order: `DELETE /proxy/orders/:id`
- Finished orders: `GET /proxy/orders/history`

## Response shape (balances)
```json
[
  { "currency":"USDT", "available":"123.45", "frozen":"0.00", "total":"123.45" },
  { "currency":"BTC",  "available":"0.056",  "frozen":"0.000", "total":"0.056" }
]
