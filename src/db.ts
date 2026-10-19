import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS creators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  coupon_code TEXT UNIQUE,
  utm_code TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  coupon_code TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  creator_id TEXT,
  attribution_source TEXT,
  attribution_conflict INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL
);

-- order_id has no foreign key on purpose: a refund can arrive before its order.
-- applied_cents is NULL while the refund is pending (order not received yet).
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  requested_cents INTEGER NOT NULL,
  applied_cents INTEGER,
  received_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE INDEX IF NOT EXISTS refunds_order_id ON refunds (order_id);
CREATE INDEX IF NOT EXISTS orders_creator_id ON orders (creator_id);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
