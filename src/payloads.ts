import { parseCents } from "./money.ts";
import type { OrderInput, RefundInput } from "./orders.ts";

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
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

function utmFrom(body: Record_): OrderInput["utm"] {
  const utm = isRecord(body.utm) ? body.utm : {};
  const landing = typeof body.landing_site === "string" ? body.landing_site : "";
  const query = new URLSearchParams(landing.includes("?") ? landing.slice(landing.indexOf("?") + 1) : "");
  const pick = (key: string) => textOf(utm[key]) ?? textOf(query.get(`utm_${key}`));
  return { source: pick("source"), medium: pick("medium"), campaign: pick("campaign") };
}

function couponFrom(body: Record_): string | null {
  const direct = textOf(body.coupon);
  if (direct) return direct;
  const codes = Array.isArray(body.discount_codes) ? body.discount_codes : [];
  const first = codes.find(isRecord);
  return first ? textOf(first.code) : null;
}

/**
 * Accepts the essentials of a store order (Shopify-like): `id`, `total` or
 * `total_price`, `status` or `financial_status`, `coupon` or `discount_codes[0].code`,
 * and UTMs as `utm: {source, medium, campaign}` or inside `landing_site`.
 */
export function parseOrder(body: unknown): Parsed<OrderInput> | { ok: "ignored"; status: string } {
  if (!isRecord(body)) return { ok: false, error: "invalid body" };
  const id = idOf(body.id);
  if (!id) return { ok: false, error: "id is required" };
  const totalCents = parseCents(body.total ?? body.total_price);
  if (totalCents === null) return { ok: false, error: "total must be a positive amount with at most 2 decimals" };

  const status = (textOf(body.status) ?? textOf(body.financial_status) ?? "paid").toLowerCase();
  if (status !== "paid") return { ok: "ignored", status };

  return {
    ok: true,
    value: {
      id,
      totalCents,
      currency: (textOf(body.currency) ?? "BRL").toUpperCase(),
      coupon: couponFrom(body),
      utm: utmFrom(body),
    },
  };
}

export function parseRefund(body: unknown): Parsed<RefundInput> {
  if (!isRecord(body)) return { ok: false, error: "invalid body" };
  const id = idOf(body.id);
  if (!id) return { ok: false, error: "id is required" };
  const orderId = idOf(body.order_id);
  if (!orderId) return { ok: false, error: "order_id is required" };
  const amountCents = parseCents(body.amount);
  if (amountCents === null) return { ok: false, error: "amount must be a positive amount with at most 2 decimals" };
  return { ok: true, value: { id, orderId, amountCents } };
}

export type CreatorInput = { id: string; name: string; couponCode: string | null; utmCode: string | null };

export function parseCreator(body: unknown): Parsed<CreatorInput> {
  if (!isRecord(body)) return { ok: false, error: "invalid body" };
  const id = idOf(body.id);
  const name = textOf(body.name);
  if (!id || !name) return { ok: false, error: "id and name are required" };
  return {
    ok: true,
    value: { id, name, couponCode: textOf(body.coupon_code), utmCode: textOf(body.utm_code) },
  };
}
