import type { DatabaseSync } from "node:sqlite";

export type AttributionSource = "coupon" | "utm";

export type Attribution = {
  creatorId: string | null;
  source: AttributionSource | null;
  /** Another signal (a second coupon or the UTM) pointed at a different creator. */
  conflict: boolean;
};

export type AttributionSignals = {
  /** Every discount code on the order, in the order the store sent them. */
  coupons: string[];
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
 * - A coupon wins over the UTM: it is a code the creator owns and the buyer
 *   typed, while a UTM only says which link the click came from.
 * - With several creator coupons on one order, the first one the store sent wins.
 * - When another signal points at a different creator, the winner is kept and
 *   the order is flagged with `conflict` so the choice stays auditable.
 * - No match means the sale is not attributed.
 *
 * `couponCreators` is the creator matched by each coupon, in order (null when
 * the coupon belongs to no creator).
 */
export function decideAttribution(couponCreators: Array<string | null>, utmCreator: string | null): Attribution {
  const candidates = couponCreators.filter((id): id is string => id !== null);
  const winner = candidates[0] ?? utmCreator;
  if (!winner) return { creatorId: null, source: null, conflict: false };
  const others = [...candidates, utmCreator].filter((id): id is string => id !== null);
  return {
    creatorId: winner,
    source: candidates.length > 0 ? "coupon" : "utm",
    conflict: others.some((id) => id !== winner),
  };
}

function creatorBy(db: DatabaseSync, column: "coupon_code" | "utm_code", value: string | null): string | null {
  if (!value) return null;
  const row = db.prepare(`SELECT id FROM creators WHERE ${column} = ?`).get(value) as { id: string } | undefined;
  return row?.id ?? null;
}

export function attributeOrder(db: DatabaseSync, signals: AttributionSignals): Attribution {
  const couponCreators = signals.coupons.map((code) => creatorBy(db, "coupon_code", normalizeCoupon(code)));
  const utm = signals.utmCampaign ? normalizeUtm(signals.utmCampaign) : null;
  return decideAttribution(couponCreators, creatorBy(db, "utm_code", utm));
}
