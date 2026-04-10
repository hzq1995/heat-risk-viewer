import { describe, expect, it } from "vitest";

import { hazardDaysForThreshold, insideRaster, rowColFromLngLat } from "./lib";

describe("raster utilities", () => {
  it("computes hazard days by summing bins from threshold upward", () => {
    expect(hazardDaysForThreshold([1, 3, 5, 7], 0)).toBe(16);
    expect(hazardDaysForThreshold([1, 3, 5, 7], 2)).toBe(12);
    expect(hazardDaysForThreshold([1, 3, 5, 7], 4)).toBe(0);
  });

  it("maps lng lat into raster row col", () => {
    const transform: [number, number, number, number, number, number] = [0.5, 0, 10, 0, -0.25, 20];
    expect(rowColFromLngLat(10.99, 19.51, transform)).toEqual({ row: 1, col: 1 });
  });

  it("checks raster boundaries", () => {
    expect(insideRaster(0, 0, 10, 10)).toBe(true);
    expect(insideRaster(9, 9, 10, 10)).toBe(true);
    expect(insideRaster(10, 0, 10, 10)).toBe(false);
    expect(insideRaster(-1, 0, 10, 10)).toBe(false);
  });
});
