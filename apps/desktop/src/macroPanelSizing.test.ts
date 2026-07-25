// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MACRO_PANEL_WIDTH,
  MACRO_PANEL_STORAGE_KEY,
  clampMacroPanelWidth,
  macroPanelMaximum,
  readMacroPanelWidth,
  writeMacroPanelWidth,
} from "./macroPanelSizing";

describe("Python macro panel sizing", () => {
  beforeEach(() => window.localStorage.clear());

  it("clamps the panel while preserving room for the grid", () => {
    expect(clampMacroPanelWidth(200)).toBe(360);
    expect(clampMacroPanelWidth(900)).toBe(680);
    expect(macroPanelMaximum(900)).toBe(540);
    expect(clampMacroPanelWidth(680, 900)).toBe(540);
  });

  it("persists a valid global width", () => {
    writeMacroPanelWidth(524);
    expect(window.localStorage.getItem(MACRO_PANEL_STORAGE_KEY)).toBe("524");
    expect(readMacroPanelWidth()).toBe(524);
  });

  it("uses safe defaults for invalid or unavailable storage", () => {
    window.localStorage.setItem(MACRO_PANEL_STORAGE_KEY, "not-a-number");
    expect(readMacroPanelWidth()).toBe(DEFAULT_MACRO_PANEL_WIDTH);
    expect(readMacroPanelWidth({ getItem: () => { throw new Error("unavailable"); } })).toBe(DEFAULT_MACRO_PANEL_WIDTH);
    expect(() => writeMacroPanelWidth(500, { setItem: () => { throw new Error("unavailable"); } })).not.toThrow();
  });
});
