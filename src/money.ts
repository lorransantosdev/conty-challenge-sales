const DECIMAL = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses a positive amount into integer cents. Accepts a decimal string
 * ("150.00", "150.5") or a number with at most two decimals. Money never goes
 * through float arithmetic past this point.
 */
export function parseCents(value: unknown): number | null {
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
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return cents;
}
