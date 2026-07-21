// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CsvGrid from "./CsvGrid";
import type { DocumentSummary } from "./types";

vi.mock("./ipc", () => ({
  getGridWindow: vi.fn().mockResolvedValue({
    revision: 0,
    viewRevision: 0,
    rowStart: 0,
    columnStart: 0,
    rows: [],
  }),
}));

const summary: DocumentSummary = {
  path: null,
  displayName: "Untitled.csv",
  delimiter: ",",
  lineEnding: "lf",
  revision: 0,
  viewRevision: 0,
  dirty: false,
  rowCount: 0,
  columnCount: 0,
  visibleRowCount: 0,
  headerEnabled: false,
  headerSuggested: false,
  headerNames: [],
  headerValues: [],
  canUndo: false,
  canRedo: false,
  filtersActive: false,
  sortCount: 0,
};

describe("CsvGrid theming", () => {
  const clearRect = vi.fn();
  const fillStyles: string[] = [];
  const strokeStyles: string[] = [];
  const context = {
    setTransform: vi.fn(),
    clearRect,
    fillRect: vi.fn(),
    fillText: vi.fn(),
    save: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    restore: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    set fillStyle(value: string) { fillStyles.push(value); },
    get fillStyle() { return fillStyles.at(-1) ?? ""; },
    set strokeStyle(value: string) { strokeStyles.push(value); },
    get strokeStyle() { return strokeStyles.at(-1) ?? ""; },
    lineWidth: 1,
    font: "",
    textBaseline: "alphabetic",
    textAlign: "start",
  };

  beforeEach(() => {
    fillStyles.length = 0;
    strokeStyles.length = 0;
    clearRect.mockClear();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => context) as unknown as typeof HTMLCanvasElement.prototype.getContext);
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("redraws the canvas with the dark palette when the theme changes", () => {
    const props = {
      summary,
      onApplyEdit: vi.fn().mockResolvedValue(undefined),
      onSelectionChange: vi.fn(),
      onError: vi.fn(),
      onHeaderSort: vi.fn(),
    };
    const { rerender } = render(<CsvGrid {...props} theme="light" />);
    expect(fillStyles).toContain("#ffffff");

    fillStyles.length = 0;
    strokeStyles.length = 0;
    clearRect.mockClear();
    rerender(<CsvGrid {...props} theme="dark" />);

    expect(clearRect).toHaveBeenCalled();
    expect(fillStyles).toContain("#171c23");
    expect(strokeStyles).toContain("#45c982");
  });
});
