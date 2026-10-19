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
| POST | `/creators` | Registers a creator: `{id, name, coupon_code?, utm_code?}`. Codes are normalized and unique; the response shows them as stored. |
| POST | `/webhooks/orders` | Ingests an order. `201` created, `200` duplicate, `202` ignored (not a captured sale), `400` invalid. |
| POST | `/webhooks/refunds` | Ingests a refund. `201` created, `200` duplicate, `409` same id with another order or amount, `400` invalid. |
| GET | `/orders/:id` | Order, attribution and the signals behind it, refunded and net value, and every refund with requested vs applied amount. |
| GET | `/refunds/pending` | Refunds still waiting for their order. |
| GET | `/refunds/:id` | One refund, including a pending one. |
| GET | `/creators/:id/sales` | `orders`, `gross_cents`, `refunded_cents`, `net_cents` for the creator. |

### Order payload

The essentials of a Shopify order:

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

Shopify field names are accepted too: `total_price`, `financial_status`,
`discount_codes[].code` (every code is read) and UTMs in the `landing_site` query
string (`/x?utm_campaign=ana#top`; the fragment is ignored).

- **Status:** `paid`, `partially_refunded` and `refunded` mean the money was captured,
  so the order is stored as a sale (the refunds themselves come through the refund
  webhook). Any other status (`pending`, `voided`, ...) answers `202` and stores
  nothing. An order without a status is taken as paid.
- **Total:** `0.00` is a valid sale (an order paid in full with a 100% coupon).
- **Ids** may be strings or integers. Integers above 2^53 are rejected because
  they lose precision; send them as strings.

### Refund payload

The service's own shape, `{ "id": "ref_1", "order_id": "ord_1", "amount": "50.00" }`.
A Shopify refund, with the amount in `transactions[].amount` (kind `refund`), is
accepted too. The refund needs its own `id`; that is what makes retries safe.

### Money

Amounts are a decimal string or a JSON number with at most two decimals, up to
R$ 1,000,000,000.00. They are stored as integer cents and never go through float
arithmetic.

## Attribution rule

Implemented in one place, [`src/attribution.ts`](src/attribution.ts), with unit and HTTP tests.

1. A creator owns a `coupon_code` and a `utm_code`. Coupons are matched
   case-insensitively against every discount code on the order; the UTM code is
   matched against `utm_campaign`.
2. A sale goes to at most one creator.
3. **Tie-break: when coupon and UTM point at different creators, the coupon wins.**
   The coupon is a code the creator owns and the buyer typed; a UTM only says which
   link the click came from.
4. With several creator coupons on one order, the first one the store sent wins.
5. Whenever another signal pointed at a different creator, the order is flagged
   `attribution.conflict: true`. The order view also returns the coupon codes and
   UTMs the decision was made from, so it can be audited.
6. No match means the order is stored unattributed.

The attribution is decided once, when the order is first ingested. A repeated
webhook does not recalculate it, and a creator registered after the order does
not get it retroactively.

## Idempotency

- An order is identified by its `id`. A repeated webhook returns `200` with
  `duplicate: true` and changes nothing, so the sale is never summed twice. The
  first version wins; later edits of the same order are not applied.
- A refund is identified by its own `id`. A retry with the same order and amount
  is a no-op (`200`). The same id with a different order or amount is answered
  `409` and the first refund is kept, so a conflicting payload is never dropped silently.

## Refunds

A refund never deletes or rewrites the order. The order keeps its `total_cents`
and its creator; the net value is `total - sum(applied refunds)`.

- **Partial:** reduces the net value (`status: partially_refunded`).
- **Full:** the net value goes to zero (`status: refunded`), which zeroes the sale
  for the creator; the attribution stays in the history.
- **Several refunds:** each distinct refund id is applied once, in arrival order.
- **Cap:** the sum of applied refunds never passes the sale value. An excess is cut
  and the refund is stored with `requested_cents` and a smaller `applied_cents`
  (`state: "capped"`), so nothing is lost silently.
- **Refund before the order:** it is stored as `state: "pending"` (`applied_cents: null`)
  and applied, in arrival order and under the same cap, when the order arrives.
  If that order never arrives as a captured sale, the refund stays pending and is
  listed in `GET /refunds/pending`.

Every ingestion runs in a single transaction. Concurrent duplicates were checked
with 160 parallel requests against the running server: one sale, refunds applied
once, applied sum equal to the order total.

## Out of scope

- No webhook authentication (Shopify's `X-Shopify-Hmac-Sha256`) and no auth on
  `/creators`. In production both would be required.
- A single currency is assumed. The currency is stored per order, but the sales per
  creator are not split by currency.

## Layout

```
src/attribution.ts  the attribution rule (single place)
src/orders.ts       order/refund ingestion, views and per-creator sales
src/payloads.ts     webhook payload parsing
src/money.ts        amount -> integer cents
src/db.ts           schema and transaction helper
src/app.ts          HTTP routes
```

## AI use and review

I used AI to help design the data model, draft the code and tests, and review the
result. I reviewed the code, ran the suite (44 tests) and `tsc --noEmit`, checked
each rule in this README against a test, and stress-tested duplicates and refunds
against the running server. I made the design decisions listed above, notably the
coupon-over-UTM tie-break and the cap on refunds. No real store is connected.
