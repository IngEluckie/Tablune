export const MACRO_PANEL_STORAGE_KEY = "tablune.pythonMacroPanelWidth";
export const DEFAULT_MACRO_PANEL_WIDTH = 480;
export const MIN_MACRO_PANEL_WIDTH = 360;
export const MAX_MACRO_PANEL_WIDTH = 680;
export const MIN_GRID_WIDTH_WITH_MACRO = 360;

export function macroPanelMaximum(workspaceWidth?: number): number {
  if (!workspaceWidth || workspaceWidth <= 0) return MAX_MACRO_PANEL_WIDTH;
  return Math.max(
    MIN_MACRO_PANEL_WIDTH,
    Math.min(MAX_MACRO_PANEL_WIDTH, workspaceWidth - MIN_GRID_WIDTH_WITH_MACRO),
  );
}

export function clampMacroPanelWidth(width: number, workspaceWidth?: number): number {
  const normalized = Number.isFinite(width) ? Math.round(width) : DEFAULT_MACRO_PANEL_WIDTH;
  return Math.min(
    macroPanelMaximum(workspaceWidth),
    Math.max(MIN_MACRO_PANEL_WIDTH, normalized),
  );
}

export function readMacroPanelWidth(storage?: Pick<Storage, "getItem">): number {
  try {
    const stored = (storage ?? window.localStorage).getItem(MACRO_PANEL_STORAGE_KEY);
    return clampMacroPanelWidth(stored === null ? DEFAULT_MACRO_PANEL_WIDTH : Number(stored));
  } catch {
    return DEFAULT_MACRO_PANEL_WIDTH;
  }
}

export function writeMacroPanelWidth(width: number, storage?: Pick<Storage, "setItem">): void {
  try {
    (storage ?? window.localStorage).setItem(MACRO_PANEL_STORAGE_KEY, String(clampMacroPanelWidth(width)));
  } catch {
    // A restricted WebView may not expose persistent storage. The in-memory width still works.
  }
}
