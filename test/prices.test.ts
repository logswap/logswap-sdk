/**
 * The decimals-aware price helpers. The chain's log-price is of the WEI ratio; with a 6-dec USDC
 * quote and an 18-dec base the human price is `e^x · 10^12`. `priceScale` is that factor, and the
 * default of 1 keeps every 18/18 caller exactly as it was.
 */

import { describe, expect, it } from "vitest";
import { priceOf, floorPrice, priceScale } from "../src/pools.js";
import { fPoolPriceOf } from "../src/fpool.js";

// ln(3000) + ln(1e-12), as the 6-dec devnet deploys the WETH/USDC market
const X_CHAIN = -19624653548278302576n;
const FLOOR_CHAIN = X_CHAIN - 2n * 10n ** 17n;

describe("price scale", () => {
  it("is 10^(base − quote) and 1 for 18/18", () => {
    expect(priceScale(18, 6)).toBe(1e12);
    expect(priceScale(18, 18)).toBe(1);
    expect(priceScale(6, 18)).toBe(1e-12);
  });
  it("priceOf recovers the human mark from the wei ratio", () => {
    expect(priceOf({ x: X_CHAIN }, priceScale(18, 6))).toBeCloseTo(3000, 6);
    expect(priceOf({ x: X_CHAIN })).toBeCloseTo(3000e-12, 18); // the default is the raw wei ratio
  });
  it("floorPrice and fPoolPriceOf take the same factor", () => {
    expect(floorPrice({ backstopFloor: FLOOR_CHAIN }, priceScale(18, 6))).toBeCloseTo(3000 * Math.exp(-0.2), 4);
    expect(fPoolPriceOf(X_CHAIN, priceScale(18, 6))).toBeCloseTo(3000, 6);
  });
});
