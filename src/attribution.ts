import type { DatabaseSync } from "node:sqlite";

export type AttributionSource = "coupon" | "utm";

export type Attribution = {
  creatorId: string | null;
  source: AttributionSource | null;
  /** Coupon and UTM pointed at different creators. */
  conflict: boolean;
};

export type AttributionSignals = {
  coupon: string | null;
  utmCampaign: string | null;
};

export function normalizeCoupon(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizeUtm(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The attribution rule lives here and only here.
 *
 * - A sale goes to at most one creator.
 * - The coupon wins over the UTM: it is a code the creator owns and the buyer
 *   typed, while a UTM only says which link the click came from.
 * - When coupon and UTM point at different creators the coupon wins and the
 *   order is flagged with `conflict` so the choice stays auditable.
 * - No match means the sale is not attributed.
 */
export function decideAttribution(couponCreator: string | null, utmCreator: string | null): Attribution {
  if (couponCreator) {
    return {
      creatorId: couponCreator,
      source: "coupon",
      conflict: utmCreator !== null && utmCreator !== couponCreator,
    };
  }
  if (utmCreator) return { creatorId: utmCreator, source: "utm", conflict: false };
  return { creatorId: null, source: null, conflict: false };
}

function creatorBy(db: DatabaseSync, column: "coupon_code" | "utm_code", value: string | null): string | null {
  if (!value) return null;
  const row = db.prepare(`SELECT id FROM creators WHERE ${column} = ?`).get(value) as { id: string } | undefined;
  return row?.id ?? null;
}

export function attributeOrder(db: DatabaseSync, signals: AttributionSignals): Attribution {
  const coupon = signals.coupon ? normalizeCoupon(signals.coupon) : null;
  const utm = signals.utmCampaign ? normalizeUtm(signals.utmCampaign) : null;
  return decideAttribution(creatorBy(db, "coupon_code", coupon), creatorBy(db, "utm_code", utm));
}
