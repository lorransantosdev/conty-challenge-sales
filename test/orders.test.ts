import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

type App = ReturnType<typeof createApp>;
type Json = Record<string, any>;

async function post(app: App, path: string, body: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

async function get(app: App, path: string) {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as Json };
}

const order = (over: Json = {}) => ({ id: "ord_1", total: "200.00", coupon: "ANA10", ...over });

describe("order ingestion and attribution", () => {
  let app: App;

  beforeEach(async () => {
    app = createApp(openDatabase(":memory:"));
    await post(app, "/creators", { id: "crt_ana", name: "Ana", coupon_code: "ana10", utm_code: "ana" });
    await post(app, "/creators", { id: "crt_bruno", name: "Bruno", coupon_code: "BRUNO15", utm_code: "bruno" });
  });

  it("attributes a paid order by coupon, case-insensitively", async () => {
    const res = await post(app, "/webhooks/orders", order({ coupon: "Ana10" }));
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({
      creator_id: "crt_ana",
      total_cents: 20000,
      net_cents: 20000,
      status: "paid",
      attribution: { source: "coupon", conflict: false },
    });
  });

  it("attributes by UTM campaign when there is no coupon", async () => {
    const res = await post(app, "/webhooks/orders", {
      id: "ord_2",
      total: "50.00",
      utm: { source: "instagram", campaign: "Bruno" },
    });
    expect(res.body.order).toMatchObject({ creator_id: "crt_bruno", attribution: { source: "utm" } });
  });

  it("reads the coupon and UTMs from a Shopify-like payload", async () => {
    const res = await post(app, "/webhooks/orders", {
      id: 8209829119461,
      total_price: "75.50",
      financial_status: "paid",
      discount_codes: [{ code: "BRUNO15" }],
      landing_site: "/products/x?utm_campaign=ana&utm_source=tiktok",
    });
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ creator_id: "crt_bruno", total_cents: 7550 });
  });

  it("tie-break: coupon wins over a UTM of another creator and the conflict is recorded", async () => {
    const res = await post(app, "/webhooks/orders", order({ utm: { campaign: "bruno" } }));
    expect(res.body.order).toMatchObject({
      creator_id: "crt_ana",
      attribution: { source: "coupon", conflict: true },
    });
  });

  it("leaves the order unattributed when nothing matches", async () => {
    const res = await post(app, "/webhooks/orders", order({ coupon: "NOPE" }));
    expect(res.body.order).toMatchObject({ creator_id: null, attribution: { source: null } });
  });

  it("a repeated webhook does not add the sale again", async () => {
    expect((await post(app, "/webhooks/orders", order())).status).toBe(201);
    const again = await post(app, "/webhooks/orders", order());
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    const sales = await get(app, "/creators/crt_ana/sales");
    expect(sales.body).toMatchObject({ orders: 1, gross_cents: 20000, net_cents: 20000 });
  });

  it("a repeat does not re-attribute the order, even if the payload changed", async () => {
    await post(app, "/webhooks/orders", order());
    await post(app, "/webhooks/orders", order({ coupon: "BRUNO15", total: "999.00" }));
    const res = await get(app, "/orders/ord_1");
    expect(res.body).toMatchObject({ creator_id: "crt_ana", total_cents: 20000 });
  });

  it("ignores orders that are not paid", async () => {
    const res = await post(app, "/webhooks/orders", order({ status: "pending" }));
    expect(res.status).toBe(202);
    expect((await get(app, "/orders/ord_1")).status).toBe(404);
  });

  it("rejects invalid payloads", async () => {
    expect((await post(app, "/webhooks/orders", { total: "10.00" })).status).toBe(400);
    expect((await post(app, "/webhooks/orders", { id: "x", total: "10.999" })).status).toBe(400);
    expect((await post(app, "/webhooks/orders", { id: "x", total: "-5" })).status).toBe(400);
  });

  it("rejects numeric ids beyond 2^53 (they lose precision) but accepts them as strings", async () => {
    const unsafe = await app.request("/webhooks/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"id": 820982911946154508, "total": "10.00"}',
    });
    expect(unsafe.status).toBe(400);
    const asString = await post(app, "/webhooks/orders", { id: "820982911946154508", total: "10.00" });
    expect(asString.status).toBe(201);
  });

  it("stores a paid order with total 0.00 (100% coupon) and attributes it", async () => {
    const res = await post(app, "/webhooks/orders", order({ total: "0.00" }));
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ creator_id: "crt_ana", total_cents: 0, net_cents: 0, status: "paid" });
  });

  it("checks the status before the total, so a non-sale order is ignored, not rejected", async () => {
    const res = await post(app, "/webhooks/orders", order({ status: "pending", total: "0.00" }));
    expect(res.status).toBe(202);
  });

  it("stores an order whose first webhook already says partially_refunded", async () => {
    const res = await post(app, "/webhooks/orders", order({ financial_status: "partially_refunded" }));
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ creator_id: "crt_ana", total_cents: 20000 });
  });

  it("reads every discount code and attributes to the first creator coupon", async () => {
    const res = await post(app, "/webhooks/orders", {
      id: "ord_multi",
      total: "80.00",
      discount_codes: [{ code: "FREESHIP" }, { code: "bruno15" }],
    });
    expect(res.body.order).toMatchObject({
      creator_id: "crt_bruno",
      attribution: { source: "coupon", conflict: false, coupon_codes: ["FREESHIP", "BRUNO15"] },
    });
  });

  it("flags a conflict when two creator coupons are on the same order", async () => {
    const res = await post(app, "/webhooks/orders", {
      id: "ord_two",
      total: "80.00",
      discount_codes: [{ code: "ANA10" }, { code: "BRUNO15" }],
    });
    expect(res.body.order).toMatchObject({ creator_id: "crt_ana", attribution: { conflict: true } });
  });

  it("ignores the URL fragment when reading UTMs from landing_site", async () => {
    const res = await post(app, "/webhooks/orders", {
      id: "ord_hash",
      total: "10.00",
      landing_site: "/p?utm_campaign=ana&utm_source=ig#top",
    });
    expect(res.body.order).toMatchObject({
      creator_id: "crt_ana",
      attribution: { source: "utm", utm: { campaign: "ana", source: "ig" } },
    });
  });

  it("returns the signals behind the attribution so it can be audited", async () => {
    const res = await post(app, "/webhooks/orders", order({ utm: { source: "ig", medium: "social", campaign: "Bruno" } }));
    expect(res.body.order.attribution).toEqual({
      source: "coupon",
      conflict: true,
      coupon_codes: ["ANA10"],
      utm: { source: "ig", medium: "social", campaign: "bruno" },
    });
  });

  it("rejects totals above the maximum amount", async () => {
    expect((await post(app, "/webhooks/orders", order({ total: "1000000000.01" }))).status).toBe(400);
  });

  it("returns the creator as stored (normalized) and rejects non-string codes", async () => {
    const created = await post(app, "/creators", { id: "crt_caio", name: "Caio", coupon_code: " caio5 ", utm_code: "Caio" });
    expect(created.body).toEqual({ id: "crt_caio", name: "Caio", coupon_code: "CAIO5", utm_code: "caio" });
    expect((await post(app, "/creators", { id: "crt_d", name: "D", coupon_code: 123 })).status).toBe(400);
  });

  it("does not allow two creators to share a coupon or UTM code", async () => {
    const res = await post(app, "/creators", { id: "crt_x", name: "X", coupon_code: "ANA10" });
    expect(res.status).toBe(409);
  });
});

describe("refunds", () => {
  let app: App;

  beforeEach(async () => {
    app = createApp(openDatabase(":memory:"));
    await post(app, "/creators", { id: "crt_ana", name: "Ana", coupon_code: "ANA10" });
  });

  it("a partial refund reduces the net value and keeps the attribution and history", async () => {
    await post(app, "/webhooks/orders", order());
    const refund = await post(app, "/webhooks/refunds", { id: "ref_1", order_id: "ord_1", amount: "50.00" });
    expect(refund.status).toBe(201);
    expect(refund.body.refund).toMatchObject({ requested_cents: 5000, applied_cents: 5000, state: "applied" });

    const res = await get(app, "/orders/ord_1");
    expect(res.body).toMatchObject({
      status: "partially_refunded",
      creator_id: "crt_ana",
      refunded_cents: 5000,
      net_cents: 15000,
    });
    expect(res.body.refunds).toHaveLength(1);
  });

  it("a full refund zeroes the net value without deleting the order", async () => {
    await post(app, "/webhooks/orders", order());
    await post(app, "/webhooks/refunds", { id: "ref_1", order_id: "ord_1", amount: "200.00" });
    const res = await get(app, "/orders/ord_1");
    expect(res.body).toMatchObject({ status: "refunded", net_cents: 0, creator_id: "crt_ana" });
    expect((await get(app, "/creators/crt_ana/sales")).body).toMatchObject({
      orders: 1,
      gross_cents: 20000,
      refunded_cents: 20000,
      net_cents: 0,
    });
  });

  it("a repeated refund (same id) is applied once", async () => {
    await post(app, "/webhooks/orders", order());
    const body = { id: "ref_1", order_id: "ord_1", amount: "60.00" };
    expect((await post(app, "/webhooks/refunds", body)).status).toBe(201);
    const again = await post(app, "/webhooks/refunds", body);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect((await get(app, "/orders/ord_1")).body).toMatchObject({ refunded_cents: 6000, net_cents: 14000 });
  });

  it("several distinct partial refunds add up", async () => {
    await post(app, "/webhooks/orders", order());
    await post(app, "/webhooks/refunds", { id: "ref_1", order_id: "ord_1", amount: "30.00" });
    await post(app, "/webhooks/refunds", { id: "ref_2", order_id: "ord_1", amount: "20.00" });
    expect((await get(app, "/orders/ord_1")).body).toMatchObject({ refunded_cents: 5000, net_cents: 15000 });
  });

  it("the sum of refunds never passes the sale value", async () => {
    await post(app, "/webhooks/orders", order());
    await post(app, "/webhooks/refunds", { id: "ref_1", order_id: "ord_1", amount: "150.00" });
    const over = await post(app, "/webhooks/refunds", { id: "ref_2", order_id: "ord_1", amount: "100.00" });
    expect(over.body.refund).toMatchObject({ requested_cents: 10000, applied_cents: 5000, state: "capped" });
    const again = await post(app, "/webhooks/refunds", { id: "ref_3", order_id: "ord_1", amount: "10.00" });
    expect(again.body.refund).toMatchObject({ applied_cents: 0, state: "capped" });

    const res = await get(app, "/orders/ord_1");
    expect(res.body).toMatchObject({ status: "refunded", refunded_cents: 20000, net_cents: 0 });
    expect(res.body.refunds.map((r: Json) => r.requested_cents)).toEqual([15000, 10000, 1000]);
  });

  it("a refund that arrives before the order stays pending and is applied when the order arrives", async () => {
    const early = await post(app, "/webhooks/refunds", { id: "ref_1", order_id: "ord_1", amount: "50.00" });
    expect(early.status).toBe(201);
    expect(early.body.refund).toMatchObject({ state: "pending", applied_cents: null });
    expect((await get(app, "/refunds/ref_1")).body.state).toBe("pending");

    await post(app, "/webhooks/orders", order());
    expect((await get(app, "/refunds/ref_1")).body).toMatchObject({ state: "applied", applied_cents: 5000 });
    expect((await get(app, "/orders/ord_1")).body).toMatchObject({
      status: "partially_refunded",
      creator_id: "crt_ana",
      net_cents: 15000,
    });
  });

  it("early refunds are applied in arrival order and still respect the cap", async () => {
    await post(app, "/webhooks/refunds", { id: "ref_1", order_id: "ord_1", amount: "150.00" });
    await post(app, "/webhooks/refunds", { id: "ref_2", order_id: "ord_1", amount: "100.00" });
    await post(app, "/webhooks/orders", order());
    const res = await get(app, "/orders/ord_1");
    expect(res.body.refunded_cents).toBe(20000);
    expect(res.body.refunds.map((r: Json) => [r.id, r.applied_cents])).toEqual([
      ["ref_1", 15000],
      ["ref_2", 5000],
    ]);
  });

  it("an early refund sent twice, then a repeated order, is applied once", async () => {
    const body = { id: "ref_1", order_id: "ord_1", amount: "50.00" };
    await post(app, "/webhooks/refunds", body);
    await post(app, "/webhooks/refunds", body);
    await post(app, "/webhooks/orders", order());
    await post(app, "/webhooks/orders", order());
    expect((await get(app, "/orders/ord_1")).body).toMatchObject({ refunded_cents: 5000, net_cents: 15000 });
  });

  it("the same refund id with a different amount or order is a conflict (409) and the first is kept", async () => {
    await post(app, "/webhooks/orders", order());
    await post(app, "/webhooks/refunds", { id: "ref_1", order_id: "ord_1", amount: "10.00" });
    const amount = await post(app, "/webhooks/refunds", { id: "ref_1", order_id: "ord_1", amount: "50.00" });
    expect(amount.status).toBe(409);
    expect(amount.body.refund).toMatchObject({ requested_cents: 1000 });
    const other = await post(app, "/webhooks/refunds", { id: "ref_1", order_id: "ord_9", amount: "10.00" });
    expect(other.status).toBe(409);
    expect((await get(app, "/orders/ord_1")).body).toMatchObject({ refunded_cents: 1000 });
  });

  it("accepts a Shopify refund with the amount in transactions", async () => {
    await post(app, "/webhooks/orders", order());
    const res = await post(app, "/webhooks/refunds", {
      id: 9001,
      order_id: "ord_1",
      transactions: [
        { kind: "refund", amount: "30.00" },
        { kind: "refund", amount: "5.50" },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.refund).toMatchObject({ id: "9001", requested_cents: 3550, applied_cents: 3550 });
  });

  it("lists refunds still waiting for their order", async () => {
    await post(app, "/webhooks/refunds", { id: "ref_1", order_id: "ord_late", amount: "5.00" });
    await post(app, "/webhooks/orders", order({ id: "ord_late", status: "voided" }));
    const pending = await get(app, "/refunds/pending");
    expect(pending.body.refunds.map((r: Json) => r.id)).toEqual(["ref_1"]);
    await post(app, "/webhooks/orders", order({ id: "ord_late" }));
    expect((await get(app, "/refunds/pending")).body.refunds).toEqual([]);
  });

  it("rejects invalid refunds", async () => {
    expect((await post(app, "/webhooks/refunds", { order_id: "ord_1", amount: "1.00" })).status).toBe(400);
    expect((await post(app, "/webhooks/refunds", { id: "r", amount: "1.00" })).status).toBe(400);
    expect((await post(app, "/webhooks/refunds", { id: "r", order_id: "ord_1", amount: "0" })).status).toBe(400);
  });

  it("sales per creator only count their own orders", async () => {
    await post(app, "/creators", { id: "crt_bruno", name: "Bruno", coupon_code: "BRUNO15" });
    await post(app, "/webhooks/orders", order());
    await post(app, "/webhooks/orders", order({ id: "ord_2", total: "100.00", coupon: "BRUNO15" }));
    await post(app, "/webhooks/refunds", { id: "ref_1", order_id: "ord_2", amount: "40.00" });
    expect((await get(app, "/creators/crt_ana/sales")).body).toMatchObject({ orders: 1, net_cents: 20000 });
    expect((await get(app, "/creators/crt_bruno/sales")).body).toMatchObject({ orders: 1, net_cents: 6000 });
    expect((await get(app, "/creators/crt_missing/sales")).status).toBe(404);
  });
});
