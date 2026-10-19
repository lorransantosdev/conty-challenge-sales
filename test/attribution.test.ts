import { describe, expect, it } from "vitest";
import { decideAttribution } from "../src/attribution.ts";
import { parseCents } from "../src/money.ts";

describe("attribution rule", () => {
  it("attributes to the coupon creator", () => {
    expect(decideAttribution("crt_a", null)).toEqual({ creatorId: "crt_a", source: "coupon", conflict: false });
  });

  it("attributes to the UTM creator when there is no coupon match", () => {
    expect(decideAttribution(null, "crt_b")).toEqual({ creatorId: "crt_b", source: "utm", conflict: false });
  });

  it("does not attribute when nothing matches", () => {
    expect(decideAttribution(null, null)).toEqual({ creatorId: null, source: null, conflict: false });
  });

  it("tie-break: the coupon wins when coupon and UTM point at different creators", () => {
    expect(decideAttribution("crt_a", "crt_b")).toEqual({ creatorId: "crt_a", source: "coupon", conflict: true });
  });

  it("is not a conflict when coupon and UTM point at the same creator", () => {
    expect(decideAttribution("crt_a", "crt_a")).toEqual({ creatorId: "crt_a", source: "coupon", conflict: false });
  });
});

describe("parseCents", () => {
  it("parses decimal strings and numbers into integer cents", () => {
    expect(parseCents("150.00")).toBe(15000);
    expect(parseCents("150.5")).toBe(15050);
    expect(parseCents("0.10")).toBe(10);
    expect(parseCents(19.9)).toBe(1990);
  });

  it("rejects zero, negatives, extra decimals and non-numbers", () => {
    for (const bad of ["0", "-1", "1.234", "abc", "", null, undefined, {}, Number.NaN, Infinity]) {
      expect(parseCents(bad)).toBeNull();
    }
  });
});
