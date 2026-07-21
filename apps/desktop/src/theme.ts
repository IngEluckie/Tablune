export type ThemeMode = "light" | "dark";

export const THEME_STORAGE_KEY = "tablune.theme";

export interface GridPalette {
  background: string;
  header: string;
  activeHeader: string;
  headerText: string;
  headerIcon: string;
  rowHeaderText: string;
  selectionFill: string;
  cellText: string;
  gridLine: string;
  selectionStroke: string;
}

export const GRID_PALETTES: Record<ThemeMode, GridPalette> = {
  light: {
    background: "#ffffff",
    header: "#f5f6f7",
    activeHeader: "#e7f4ec",
    headerText: "#3b4148",
    headerIcon: "#6d7a72",
    rowHeaderText: "#5a6169",
    selectionFill: "#eef8f2",
    cellText: "#161a1f",
    gridLine: "#dfe3e7",
    selectionStroke: "#0f8a50",
  },
  dark: {
    background: "#171c23",
    header: "#232a34",
    activeHeader: "#173d2b",
    headerText: "#e7ebf0",
    headerIcon: "#9da7b3",
    rowHeaderText: "#9da7b3",
    selectionFill: "#173d2b",
    cellText: "#e7ebf0",
    gridLine: "#303844",
    selectionStroke: "#45c982",
  },
};

export function readThemePreference(storage?: Pick<Storage, "getItem">): ThemeMode {
  try {
    const stored = (storage ?? window.localStorage).getItem(THEME_STORAGE_KEY);
    return stored === "dark" || stored === "light" ? stored : "light";
  } catch {
    return "light";
  }
}

export function writeThemePreference(theme: ThemeMode, storage?: Pick<Storage, "setItem">): void {
  try {
    (storage ?? window.localStorage).setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // A restricted WebView may not expose persistent storage. The session state still works.
  }
}
