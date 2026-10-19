import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { normalizeCoupon, normalizeUtm } from "./attribution.ts";
import { creatorSales, getOrder, getRefund, ingestOrder, ingestRefund, pendingRefunds } from "./orders.ts";
import { parseCreator, parseOrder, parseRefund } from "./payloads.ts";

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

export function createApp(db: DatabaseSync) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/creators", async (c) => {
    const parsed = parseCreator(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const creator = {
      id: parsed.value.id,
      name: parsed.value.name,
      coupon_code: parsed.value.couponCode ? normalizeCoupon(parsed.value.couponCode) : null,
      utm_code: parsed.value.utmCode ? normalizeUtm(parsed.value.utmCode) : null,
    };
    try {
      db.prepare("INSERT INTO creators (id, name, coupon_code, utm_code) VALUES (?, ?, ?, ?)").run(
        creator.id,
        creator.name,
        creator.coupon_code,
        creator.utm_code,
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return c.json({ error: "creator id, coupon_code or utm_code already in use" }, 409);
    }
    return c.json(creator, 201);
  });

  app.post("/webhooks/orders", async (c) => {
    const parsed = parseOrder(await c.req.json().catch(() => null));
    if (parsed.ok === "ignored") {
      return c.json({ ignored: true, reason: `status ${parsed.status} is not a captured sale` }, 202);
    }
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const { outcome, order } = ingestOrder(db, parsed.value);
    return c.json({ duplicate: outcome === "duplicate", order }, outcome === "created" ? 201 : 200);
  });

  app.post("/webhooks/refunds", async (c) => {
    const parsed = parseRefund(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const { outcome, refund } = ingestRefund(db, parsed.value);
    if (outcome === "conflict") {
      return c.json({ error: "refund id already used with another order_id or amount", refund }, 409);
    }
    return c.json({ duplicate: outcome === "duplicate", refund }, outcome === "created" ? 201 : 200);
  });

  app.get("/orders/:id", (c) => {
    const order = getOrder(db, c.req.param("id"));
    return order ? c.json(order) : c.json({ error: "order not found" }, 404);
  });

  app.get("/refunds/pending", (c) => c.json({ refunds: pendingRefunds(db) }));

  app.get("/refunds/:id", (c) => {
    const refund = getRefund(db, c.req.param("id"));
    return refund ? c.json(refund) : c.json({ error: "refund not found" }, 404);
  });

  app.get("/creators/:id/sales", (c) => {
    const id = c.req.param("id");
    const exists = db.prepare("SELECT 1 AS ok FROM creators WHERE id = ?").get(id);
    if (!exists) return c.json({ error: "creator not found" }, 404);
    return c.json(creatorSales(db, id));
  });

  return app;
}
