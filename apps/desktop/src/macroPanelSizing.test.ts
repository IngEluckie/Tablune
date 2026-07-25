// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MACRO_PANEL_WIDTH,
  DEFAULT_MACRO_RESULTS_HEIGHT,
  MACRO_PANEL_STORAGE_KEY,
  MACRO_RESULTS_HEIGHT_STORAGE_KEY,
  clampMacroPanelWidth,
  clampMacroResultsHeight,
  defaultMacroResultsHeight,
  macroPanelMaximum,
  macroResultsMaximum,
  readMacroPanelWidth,
  readMacroResultsHeight,
  writeMacroPanelWidth,
  writeMacroResultsHeight,
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

  it("uses a 30% initial results height within the requested limits", () => {
    expect(defaultMacroResultsHeight()).toBe(DEFAULT_MACRO_RESULTS_HEIGHT);
    expect(defaultMacroResultsHeight(300)).toBe(120);
    expect(defaultMacroResultsHeight(600)).toBe(180);
    expect(defaultMacroResultsHeight(1_000)).toBe(240);
  });

  it("keeps room for the editor when clamping the results height", () => {
    expect(macroResultsMaximum(500)).toBe(402);
    expect(clampMacroResultsHeight(100, 500)).toBe(120);
    expect(clampMacroResultsHeight(500, 500)).toBe(402);
  });

  it("persists a global results preference and tolerates unavailable storage", () => {
    expect(readMacroResultsHeight()).toBeNull();
    writeMacroResultsHeight(268);
    expect(window.localStorage.getItem(MACRO_RESULTS_HEIGHT_STORAGE_KEY)).toBe("268");
    expect(readMacroResultsHeight()).toBe(268);

    window.localStorage.setItem(MACRO_RESULTS_HEIGHT_STORAGE_KEY, "not-a-number");
    expect(readMacroResultsHeight()).toBeNull();
    expect(readMacroResultsHeight({ getItem: () => { throw new Error("unavailable"); } })).toBeNull();
    expect(() => writeMacroResultsHeight(200, { setItem: () => { throw new Error("unavailable"); } })).not.toThrow();
  });
});
