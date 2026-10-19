# Conty. Sales attribution

Webhook ingestion for store orders (Shopify-like), attribution of each sale to at
most one creator, and refunds that reverse the sale without erasing history.
No real store is connected.

## Run

Node 22.

```bash
npm install
npm test
npm run dev   # http://127.0.0.1:3003, SQLite in data/sales.sqlite (DB_PATH)
```

## API

| Method | Path | What it does |
|---|---|---|
| POST | `/creators` | Registers a creator: `{id, name, coupon_code?, utm_code?}`. Coupon and UTM codes are unique. |
| POST | `/webhooks/orders` | Ingests a paid order. `201` created, `200` duplicate, `202` ignored (not paid), `400` invalid. |
| POST | `/webhooks/refunds` | Ingests a refund `{id, order_id, amount}`. `201` created, `200` duplicate, `400` invalid. |
| GET | `/orders/:id` | Order, attribution, refunded and net value, and every refund with requested vs applied amount. |
| GET | `/refunds/:id` | One refund, including ones still pending because the order has not arrived. |
| GET | `/creators/:id/sales` | `orders`, `gross_cents`, `refunded_cents`, `net_cents` for the creator. |

Order payload (the essentials of a Shopify order):

```json
{
  "id": "ord_1",
  "total": "200.00",
  "currency": "BRL",
  "status": "paid",
  "coupon": "ANA10",
  "utm": { "source": "instagram", "medium": "social", "campaign": "ana" }
}
```

`total_price`, `financial_status`, `discount_codes[0].code` and UTMs inside
`landing_site` (`/x?utm_campaign=ana`) are accepted too. Ids may be strings or
integers; integers above 2^53 are rejected because they lose precision, send
them as strings. Money is parsed from a decimal string with at most two
decimals and stored as integer cents, never as a float.

## Attribution rule

Implemented in one place, [`src/attribution.ts`](src/attribution.ts), with tests.

1. A creator owns a `coupon_code` and a `utm_code`. The coupon is matched against
   the order coupon (case-insensitive); the UTM code is matched against `utm_campaign`.
2. A sale goes to at most one creator.
3. **Tie-break: when coupon and UTM point at different creators, the coupon wins.**
   The coupon is a code the creator owns and the buyer typed; a UTM only says which
   link the click came from. The order is flagged `attribution.conflict: true` so
   the decision stays auditable.
4. No match means the order is stored unattributed.

The attribution is decided once, when the order is first ingested, and is not
recalculated by a repeated webhook.

## Idempotency

- An order is identified by its `id`. A repeated webhook returns `200` with
  `duplicate: true` and changes nothing, so the sale is never summed twice.
- A refund is identified by its own `id`. A repeated refund is a no-op.
- Only `paid` orders count; any other status answers `202` and is not stored.

## Refunds

A refund never deletes or rewrites the order. The order keeps its `total_cents`
and its creator; the net value is `total - sum(applied refunds)`.

- **Partial:** reduces the net value (`status: partially_refunded`).
- **Full:** net value goes to zero (`status: refunded`); the attribution is kept in the history.
- **Several refunds:** each distinct refund id is applied once, in arrival order.
- **Cap:** the sum of applied refunds never passes the sale value. An excess is
  cut and the refund is stored with `requested_cents` and a smaller `applied_cents`
  (`state: "capped"`), so nothing is lost silently.
- **Refund before the order:** it is stored as `state: "pending"` (`applied_cents: null`)
  and applied, in arrival order and under the same cap, when the order arrives.

Every ingestion runs in a single transaction.

## Layout

```
src/attribution.ts  the attribution rule (single place)
src/orders.ts       order/refund ingestion, views and per-creator sales
src/payloads.ts     webhook payload parsing
src/money.ts        decimal string -> integer cents
src/db.ts           schema and transaction helper
src/app.ts          HTTP routes
```
