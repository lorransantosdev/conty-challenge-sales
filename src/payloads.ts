import { parseCents } from "./money.ts";
import type { OrderInput, RefundInput } from "./orders.ts";

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

type JsonObject = Record<string, unknown>;

/**
 * Order statuses that mean the money was captured. A refund only exists after a
 * payment, so an order whose first webhook already says (partially_)refunded is
 * still a sale; the refunds themselves come through the refund webhook.
 */
const SALE_STATUSES = new Set(["paid", "partially_refunded", "refunded"]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function landingQuery(body: JsonObject): URLSearchParams {
  if (typeof body.landing_site !== "string" || body.landing_site === "") return new URLSearchParams();
  try {
    // the base only makes relative paths parseable; the hash is dropped by URL
    return new URL(body.landing_site, "http://landing.invalid").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function utmFrom(body: JsonObject): OrderInput["utm"] {
  const utm = isObject(body.utm) ? body.utm : {};
  const query = landingQuery(body);
  const pick = (key: string) => textOf(utm[key]) ?? textOf(query.get(`utm_${key}`));
  return { source: pick("source"), medium: pick("medium"), campaign: pick("campaign") };
}

function couponsFrom(body: JsonObject): string[] {
  const codes: string[] = [];
  const direct = textOf(body.coupon);
  if (direct) codes.push(direct);
  if (Array.isArray(body.discount_codes)) {
    for (const entry of body.discount_codes) {
      const code = isObject(entry) ? textOf(entry.code) : null;
      if (code) codes.push(code);
    }
  }
  return codes;
}

/**
 * Accepts the essentials of a store order (Shopify-like): `id`, `total` or
 * `total_price`, `status` or `financial_status`, `coupon` and/or
 * `discount_codes[].code`, and UTMs as `utm: {source, medium, campaign}` or in
 * the `landing_site` query string. An order without a status is taken as paid.
 */
export function parseOrder(body: unknown): Parsed<OrderInput> | { ok: "ignored"; status: string } {
  if (!isObject(body)) return { ok: false, error: "invalid body" };
  const id = idOf(body.id);
  if (!id) return { ok: false, error: "id is required" };

  const status = (textOf(body.status) ?? textOf(body.financial_status) ?? "paid").toLowerCase();
  if (!SALE_STATUSES.has(status)) return { ok: "ignored", status };

  const totalCents = parseCents(body.total ?? body.total_price, { allowZero: true });
  if (totalCents === null) return { ok: false, error: "total must be an amount >= 0 with at most 2 decimals" };

  return {
    ok: true,
    value: {
      id,
      totalCents,
      currency: (textOf(body.currency) ?? "BRL").toUpperCase(),
      coupons: couponsFrom(body),
      utm: utmFrom(body),
    },
  };
}

/** Sums `transactions[].amount` of a Shopify refund, skipping non-refund kinds. */
function transactionsAmount(body: JsonObject): number | null {
  if (!Array.isArray(body.transactions)) return null;
  let total = 0;
  let found = false;
  for (const entry of body.transactions) {
    if (!isObject(entry)) continue;
    if (entry.kind !== undefined && entry.kind !== "refund") continue;
    const cents = parseCents(entry.amount);
    if (cents === null) return null;
    total += cents;
    found = true;
  }
  return found ? total : null;
}

/**
 * A refund is `{id, order_id, amount}`. A Shopify refund shape, with the amount
 * spread over `transactions[].amount`, is accepted too.
 */
export function parseRefund(body: unknown): Parsed<RefundInput> {
  if (!isObject(body)) return { ok: false, error: "invalid body" };
  const id = idOf(body.id);
  if (!id) return { ok: false, error: "id is required" };
  const orderId = idOf(body.order_id);
  if (!orderId) return { ok: false, error: "order_id is required" };
  const amountCents = body.amount !== undefined ? parseCents(body.amount) : transactionsAmount(body);
  if (amountCents === null) return { ok: false, error: "amount must be a positive amount with at most 2 decimals" };
  return { ok: true, value: { id, orderId, amountCents } };
}

export type CreatorInput = { id: string; name: string; couponCode: string | null; utmCode: string | null };

export function parseCreator(body: unknown): Parsed<CreatorInput> {
  if (!isObject(body)) return { ok: false, error: "invalid body" };
  const id = idOf(body.id);
  const name = textOf(body.name);
  if (!id || !name) return { ok: false, error: "id and name are required" };
  for (const key of ["coupon_code", "utm_code"] as const) {
    if (body[key] !== undefined && body[key] !== null && textOf(body[key]) === null) {
      return { ok: false, error: `${key} must be a non-empty string` };
    }
  }
  return {
    ok: true,
    value: { id, name, couponCode: textOf(body.coupon_code), utmCode: textOf(body.utm_code) },
  };
}
