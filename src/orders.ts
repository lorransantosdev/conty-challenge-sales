import type { DatabaseSync } from "node:sqlite";
import { attributeOrder, normalizeCoupon, normalizeUtm, type AttributionSource } from "./attribution.ts";
import { inTransaction } from "./db.ts";

export type OrderInput = {
  id: string;
  totalCents: number;
  currency: string;
  coupon: string | null;
  utm: { source: string | null; medium: string | null; campaign: string | null };
};

export type RefundInput = { id: string; orderId: string; amountCents: number };

type OrderRow = {
  id: string;
  total_cents: number;
  currency: string;
  creator_id: string | null;
  attribution_source: AttributionSource | null;
  attribution_conflict: number;
  received_at: string;
};

type RefundRow = {
  id: string;
  order_id: string;
  requested_cents: number;
  applied_cents: number | null;
  received_at: string;
  applied_at: string | null;
};

export type RefundView = {
  id: string;
  order_id: string;
  requested_cents: number;
  /** null while the order has not arrived yet. */
  applied_cents: number | null;
  state: "pending" | "applied" | "capped";
  received_at: string;
  applied_at: string | null;
};

export type OrderView = {
  id: string;
  total_cents: number;
  currency: string;
  status: "paid" | "partially_refunded" | "refunded";
  creator_id: string | null;
  attribution: { source: AttributionSource | null; conflict: boolean };
  refunded_cents: number;
  net_cents: number;
  refunds: RefundView[];
};

export function refundView(row: RefundRow): RefundView {
  const state =
    row.applied_cents === null ? "pending" : row.applied_cents < row.requested_cents ? "capped" : "applied";
  return {
    id: row.id,
    order_id: row.order_id,
    requested_cents: row.requested_cents,
    applied_cents: row.applied_cents,
    state,
    received_at: row.received_at,
    applied_at: row.applied_at,
  };
}

function appliedTotal(db: DatabaseSync, orderId: string): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(applied_cents), 0) AS n FROM refunds WHERE order_id = ?")
    .get(orderId) as { n: number };
  return Number(row.n);
}

/** Applies a refund to an order, never letting the applied sum pass the order total. */
function applyRefund(db: DatabaseSync, refundId: string, order: OrderRow, requested: number, now: string): void {
  const remaining = Math.max(0, order.total_cents - appliedTotal(db, order.id));
  const applied = Math.min(requested, remaining);
  db.prepare("UPDATE refunds SET applied_cents = ?, applied_at = ? WHERE id = ?").run(applied, now, refundId);
}

export function ingestOrder(db: DatabaseSync, input: OrderInput): { outcome: "created" | "duplicate"; order: OrderView } {
  return inTransaction(db, () => {
    const existing = db.prepare("SELECT * FROM orders WHERE id = ?").get(input.id) as OrderRow | undefined;
    if (existing) return { outcome: "duplicate", order: viewOrder(db, existing) };

    const attribution = attributeOrder(db, { coupon: input.coupon, utmCampaign: input.utm.campaign });
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO orders (id, total_cents, currency, coupon_code, utm_source, utm_medium, utm_campaign,
         creator_id, attribution_source, attribution_conflict, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.totalCents,
      input.currency,
      input.coupon ? normalizeCoupon(input.coupon) : null,
      input.utm.source,
      input.utm.medium,
      input.utm.campaign ? normalizeUtm(input.utm.campaign) : null,
      attribution.creatorId,
      attribution.source,
      attribution.conflict ? 1 : 0,
      now,
    );

    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(input.id) as OrderRow;
    const pending = db
      .prepare(
        "SELECT id, requested_cents FROM refunds WHERE order_id = ? AND applied_cents IS NULL ORDER BY received_at, rowid",
      )
      .all(input.id) as Array<{ id: string; requested_cents: number }>;
    for (const refund of pending) applyRefund(db, refund.id, order, refund.requested_cents, now);

    return { outcome: "created", order: viewOrder(db, order) };
  });
}

export function ingestRefund(
  db: DatabaseSync,
  input: RefundInput,
): { outcome: "created" | "duplicate"; refund: RefundView } {
  return inTransaction(db, () => {
    const existing = db.prepare("SELECT * FROM refunds WHERE id = ?").get(input.id) as RefundRow | undefined;
    if (existing) return { outcome: "duplicate", refund: refundView(existing) };

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO refunds (id, order_id, requested_cents, applied_cents, received_at, applied_at) VALUES (?, ?, ?, NULL, ?, NULL)",
    ).run(input.id, input.orderId, input.amountCents, now);

    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(input.orderId) as OrderRow | undefined;
    if (order) applyRefund(db, input.id, order, input.amountCents, now);

    const row = db.prepare("SELECT * FROM refunds WHERE id = ?").get(input.id) as RefundRow;
    return { outcome: "created", refund: refundView(row) };
  });
}

function viewOrder(db: DatabaseSync, order: OrderRow): OrderView {
  const refunds = (
    db.prepare("SELECT * FROM refunds WHERE order_id = ? ORDER BY received_at, rowid").all(order.id) as RefundRow[]
  ).map(refundView);
  const refunded = appliedTotal(db, order.id);
  const status = refunded === 0 ? "paid" : refunded >= order.total_cents ? "refunded" : "partially_refunded";
  return {
    id: order.id,
    total_cents: order.total_cents,
    currency: order.currency,
    status,
    creator_id: order.creator_id,
    attribution: { source: order.attribution_source, conflict: order.attribution_conflict === 1 },
    refunded_cents: refunded,
    net_cents: order.total_cents - refunded,
    refunds,
  };
}

export function getOrder(db: DatabaseSync, id: string): OrderView | null {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
  return order ? viewOrder(db, order) : null;
}

export function getRefund(db: DatabaseSync, id: string): RefundView | null {
  const row = db.prepare("SELECT * FROM refunds WHERE id = ?").get(id) as RefundRow | undefined;
  return row ? refundView(row) : null;
}

export function creatorSales(db: DatabaseSync, creatorId: string) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(o.total_cents), 0) AS gross,
              COALESCE(SUM((SELECT COALESCE(SUM(r.applied_cents), 0) FROM refunds r WHERE r.order_id = o.id)), 0) AS refunded
       FROM orders o WHERE o.creator_id = ?`,
    )
    .get(creatorId) as { orders: number; gross: number; refunded: number };
  return {
    creator_id: creatorId,
    orders: Number(row.orders),
    gross_cents: Number(row.gross),
    refunded_cents: Number(row.refunded),
    net_cents: Number(row.gross) - Number(row.refunded),
  };
}
