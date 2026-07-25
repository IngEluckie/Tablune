export const MACRO_PANEL_STORAGE_KEY = "tablune.pythonMacroPanelWidth";
export const DEFAULT_MACRO_PANEL_WIDTH = 480;
export const MIN_MACRO_PANEL_WIDTH = 360;
export const MAX_MACRO_PANEL_WIDTH = 680;
export const MIN_GRID_WIDTH_WITH_MACRO = 360;

export const MACRO_RESULTS_HEIGHT_STORAGE_KEY = "tablune.pythonMacroResultsHeight";
export const DEFAULT_MACRO_RESULTS_HEIGHT = 180;
export const DEFAULT_MACRO_RESULTS_RATIO = 0.3;
export const MAX_INITIAL_MACRO_RESULTS_HEIGHT = 240;
export const MIN_MACRO_RESULTS_HEIGHT = 120;
export const MIN_MACRO_EDITOR_HEIGHT = 90;
export const MACRO_RESULTS_RESIZER_SIZE = 8;

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

export function macroResultsMaximum(workAreaHeight?: number): number {
  if (!workAreaHeight || workAreaHeight <= 0) return MAX_INITIAL_MACRO_RESULTS_HEIGHT;
  return Math.max(
    MIN_MACRO_RESULTS_HEIGHT,
    Math.floor(workAreaHeight) - MIN_MACRO_EDITOR_HEIGHT - MACRO_RESULTS_RESIZER_SIZE,
  );
}

export function clampMacroResultsHeight(height: number, workAreaHeight?: number): number {
  const normalized = Number.isFinite(height) ? Math.round(height) : DEFAULT_MACRO_RESULTS_HEIGHT;
  return Math.min(
    macroResultsMaximum(workAreaHeight),
    Math.max(MIN_MACRO_RESULTS_HEIGHT, normalized),
  );
}

export function defaultMacroResultsHeight(workAreaHeight?: number): number {
  if (!workAreaHeight || workAreaHeight <= 0) return DEFAULT_MACRO_RESULTS_HEIGHT;
  const proportional = Math.min(
    MAX_INITIAL_MACRO_RESULTS_HEIGHT,
    Math.max(MIN_MACRO_RESULTS_HEIGHT, Math.round(workAreaHeight * DEFAULT_MACRO_RESULTS_RATIO)),
  );
  return clampMacroResultsHeight(proportional, workAreaHeight);
}

export function readMacroResultsHeight(
  storage?: Pick<Storage, "getItem">,
): number | null {
  try {
    const stored = (storage ?? window.localStorage).getItem(MACRO_RESULTS_HEIGHT_STORAGE_KEY);
    if (stored === null) return null;
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? Math.max(MIN_MACRO_RESULTS_HEIGHT, Math.round(parsed)) : null;
  } catch {
    return null;
  }
}

export function writeMacroResultsHeight(
  height: number,
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    const normalized = Number.isFinite(height)
      ? Math.max(MIN_MACRO_RESULTS_HEIGHT, Math.round(height))
      : DEFAULT_MACRO_RESULTS_HEIGHT;
    (storage ?? window.localStorage).setItem(
      MACRO_RESULTS_HEIGHT_STORAGE_KEY,
      String(normalized),
    );
  } catch {
    // A restricted WebView may not expose persistent storage. The in-memory height still works.
  }
}
