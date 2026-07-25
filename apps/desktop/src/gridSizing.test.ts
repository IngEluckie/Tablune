import { describe, expect, it } from "vitest";
import {
  clampGridSize,
  createAxisMetrics,
  DEFAULT_ROW_HEIGHT,
  withSizeOverride,
} from "./gridSizing";

describe("grid sizing geometry", () => {
  it("calculates sparse sizes, offsets, ranges, and total extent", () => {
    const metrics = createAxisMetrics(5, 100, { 1: 150, 3: 50 });

    expect(metrics.sizeAt(0)).toBe(100);
    expect(metrics.sizeAt(1)).toBe(150);
    expect(metrics.offsetAt(0)).toBe(0);
    expect(metrics.offsetAt(2)).toBe(250);
    expect(metrics.offsetAt(4)).toBe(400);
    expect(metrics.rangeSize(1, 4)).toBe(300);
    expect(metrics.totalSize).toBe(500);
  });

  it("finds indices on both sides of variable boundaries", () => {
    const metrics = createAxisMetrics(4, 100, { 1: 150 });

    expect(metrics.indexAt(-20)).toBe(0);
    expect(metrics.indexAt(99)).toBe(0);
    expect(metrics.indexAt(100)).toBe(1);
    expect(metrics.indexAt(249)).toBe(1);
    expect(metrics.indexAt(250)).toBe(2);
    expect(metrics.indexAt(10_000)).toBe(3);
  });

  it("keeps lookup bounded for a 100,000-row axis", () => {
    const metrics = createAxisMetrics(100_000, DEFAULT_ROW_HEIGHT, { 50_000: 80 });

    expect(metrics.indexAt(metrics.offsetAt(99_999))).toBe(99_999);
    expect(metrics.totalSize).toBe(100_000 * DEFAULT_ROW_HEIGHT + 52);
  });

  it("clamps sizes and removes overrides restored to the default", () => {
    expect(clampGridSize(10, 20, 200)).toBe(20);
    expect(clampGridSize(250, 20, 200)).toBe(200);
    expect(withSizeOverride({ 2: 60 }, 2, DEFAULT_ROW_HEIGHT, DEFAULT_ROW_HEIGHT)).toEqual({});
  });
});
