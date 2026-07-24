// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CsvGrid from "./CsvGrid";
import { getGridWindow } from "./ipc";
import type { DocumentSummary } from "./types";

vi.mock("./ipc", () => ({
  getGridWindow: vi.fn().mockResolvedValue({
    documentId: 1,
    revision: 0,
    viewRevision: 0,
    rowStart: 0,
    columnStart: 0,
    rows: [],
  }),
}));

const summary: DocumentSummary = {
  documentId: 1,
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
    vi.mocked(getGridWindow).mockResolvedValue({
      documentId: 1,
      revision: 0,
      viewRevision: 0,
      rowStart: 0,
      columnStart: 0,
      rows: [],
    });
    fillStyles.length = 0;
    strokeStyles.length = 0;
    clearRect.mockClear();
    context.fillText.mockClear();
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

  it("ignores a grid response belonging to another document", async () => {
    vi.mocked(getGridWindow).mockResolvedValue({
      documentId: 99,
      revision: 0,
      viewRevision: 0,
      rowStart: 0,
      columnStart: 0,
      rows: [{ viewIndex: 0, sourceRow: 0, rowId: 1, cells: ["stale value"] }],
    });
    render(<CsvGrid
      summary={summary}
      theme="light"
      onApplyEdit={vi.fn().mockResolvedValue(undefined)}
      onSelectionChange={vi.fn()}
      onError={vi.fn()}
      onHeaderSort={vi.fn()}
    />);

    await waitFor(() => expect(getGridWindow).toHaveBeenCalled());
    expect(context.fillText).not.toHaveBeenCalledWith("stale value", expect.any(Number), expect.any(Number));
  });

  it("restores and reports the document viewport", async () => {
    const onViewportChange = vi.fn();
    const { container } = render(<CsvGrid
      summary={summary}
      theme="light"
      initialViewport={{ scrollTop: 140, scrollLeft: 75 }}
      onViewportChange={onViewportChange}
      onApplyEdit={vi.fn().mockResolvedValue(undefined)}
      onSelectionChange={vi.fn()}
      onError={vi.fn()}
      onHeaderSort={vi.fn()}
    />);
    const viewport = container.querySelector(".grid-viewport") as HTMLDivElement;
    expect(viewport.scrollTop).toBe(140);
    expect(viewport.scrollLeft).toBe(75);

    viewport.scrollTop = 210;
    viewport.scrollLeft = 95;
    fireEvent.scroll(viewport);
    await waitFor(() => expect(onViewportChange).toHaveBeenCalledWith({ scrollTop: 210, scrollLeft: 95 }));
  });
});
