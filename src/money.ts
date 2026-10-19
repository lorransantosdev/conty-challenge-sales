const DECIMAL = /^(\d+)(?:\.(\d{1,2}))?$/;

/** R$ 1,000,000,000.00. Keeps any realistic sum of amounts far from 2^53. */
export const MAX_CENTS = 100_000_000_000;

/**
 * Parses an amount into integer cents. Accepts a decimal string ("150.00",
 * "150.5") or a JSON number with at most two decimals. Money never goes through
 * float arithmetic past this point. Zero is only accepted when `allowZero` is set
 * (an order paid in full with a 100% coupon is still a sale; a refund of 0 is not).
 */
export function parseCents(value: unknown, options: { allowZero?: boolean } = {}): number | null {
  let text: string;
  if (typeof value === "string") {
    text = value.trim();
  } else if (typeof value === "number" && Number.isFinite(value)) {
    text = String(value);
  } else {
    return null;
  }
  const match = DECIMAL.exec(text);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return null;
  if (cents < 0 || (cents === 0 && !options.allowZero)) return null;
  return cents;
}
