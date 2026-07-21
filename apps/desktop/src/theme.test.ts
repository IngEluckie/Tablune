// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  GRID_PALETTES,
  readThemePreference,
  THEME_STORAGE_KEY,
  writeThemePreference,
} from "./theme";

describe("theme preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults to light for missing or invalid preferences", () => {
    expect(readThemePreference()).toBe("light");
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");
    expect(readThemePreference()).toBe("light");
  });

  it("persists and restores a supported theme", () => {
    writeThemePreference("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(readThemePreference()).toBe("dark");
  });

  it("falls back safely when storage is unavailable", () => {
    expect(readThemePreference({ getItem: () => { throw new Error("unavailable"); } })).toBe("light");
    expect(() => writeThemePreference("dark", { setItem: () => { throw new Error("unavailable"); } })).not.toThrow();
  });
});

describe("grid palettes", () => {
  it("provides distinct canvas colors for dark mode", () => {
    expect(GRID_PALETTES.dark.background).toBe("#171c23");
    expect(GRID_PALETTES.dark.selectionStroke).toBe("#45c982");
    expect(GRID_PALETTES.dark).not.toEqual(GRID_PALETTES.light);
  });
});
