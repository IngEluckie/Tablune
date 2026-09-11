// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CsvGrid from "./CsvGrid";
import { getGridWindow } from "./ipc";
import type { DocumentSummary } from "./types";

vi.mock("./ipc", () => ({
  readNativeClipboard: vi.fn(async () => null),
  writeNativeClipboard: vi.fn(async () => false),
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
    measureText: vi.fn((value: string) => ({ width: value.length * 10 })),
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
    globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
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

  it("resizes a column with pointer capture without editing the CSV", () => {
    const onSizingChange = vi.fn();
    const onApplyEdit = vi.fn().mockResolvedValue(undefined);
    const { container, getByTestId } = render(<CsvGrid
      summary={summary}
      theme="light"
      onSizingChange={onSizingChange}
      onApplyEdit={onApplyEdit}
      onSelectionChange={vi.fn()}
      onError={vi.fn()}
      onHeaderSort={vi.fn()}
    />);
    const viewport = container.querySelector(".grid-viewport") as HTMLDivElement;

    fireEvent.pointerDown(viewport, { clientX: 212, clientY: 10, button: 0, pointerId: 7 });
    fireEvent.pointerMove(viewport, { clientX: 272, clientY: 10, buttons: 1, pointerId: 7 });
    expect(getByTestId("grid-spacer").style.width).toBe("4272px");
    fireEvent.pointerUp(viewport, { clientX: 272, clientY: 10, button: 0, pointerId: 7 });

    expect(onSizingChange).toHaveBeenCalledWith({ columnWidths: { 0: 220 }, rowHeights: {} });
    expect(onApplyEdit).not.toHaveBeenCalled();
  });

  it("clamps row resizing and exposes the row resize cursor", () => {
    const onSizingChange = vi.fn();
    const { container } = render(<CsvGrid
      summary={summary}
      theme="light"
      onSizingChange={onSizingChange}
      onApplyEdit={vi.fn().mockResolvedValue(undefined)}
      onSelectionChange={vi.fn()}
      onError={vi.fn()}
      onHeaderSort={vi.fn()}
    />);
    const viewport = container.querySelector(".grid-viewport") as HTMLDivElement;

    fireEvent.pointerMove(viewport, { clientX: 10, clientY: 60, buttons: 0 });
    expect(viewport.style.cursor).toBe("row-resize");
    fireEvent.pointerDown(viewport, { clientX: 10, clientY: 60, button: 0, pointerId: 3 });
    fireEvent.pointerMove(viewport, { clientX: 10, clientY: -100, buttons: 1, pointerId: 3 });
    fireEvent.pointerUp(viewport, { clientX: 10, clientY: -100, button: 0, pointerId: 3 });

    expect(onSizingChange).toHaveBeenCalledWith({ columnWidths: {}, rowHeights: { 0: 20 } });
  });

  it("prioritizes resizing at a boundary and retains sorting inside the header", () => {
    const onHeaderSort = vi.fn();
    const { container } = render(<CsvGrid
      summary={summary}
      theme="light"
      onApplyEdit={vi.fn().mockResolvedValue(undefined)}
      onSelectionChange={vi.fn()}
      onError={vi.fn()}
      onHeaderSort={onHeaderSort}
    />);
    const viewport = container.querySelector(".grid-viewport") as HTMLDivElement;

    fireEvent.pointerDown(viewport, { clientX: 212, clientY: 10, button: 0, pointerId: 1 });
    expect(onHeaderSort).not.toHaveBeenCalled();
    fireEvent.pointerCancel(viewport, { pointerId: 1 });
    fireEvent.pointerDown(viewport, { clientX: 200, clientY: 10, button: 0, pointerId: 2 });
    expect(onHeaderSort).toHaveBeenCalledWith(0);
  });

  it("auto-fits a column from loaded content and restores a row default", async () => {
    vi.mocked(getGridWindow).mockResolvedValue({
      documentId: 1,
      revision: 0,
      viewRevision: 0,
      rowStart: 0,
      columnStart: 0,
      rows: [{ viewIndex: 0, sourceRow: 0, rowId: 1, cells: ["1234567890"] }],
    });
    const onSizingChange = vi.fn();
    const { container } = render(<CsvGrid
      summary={summary}
      theme="light"
      initialSizing={{ columnWidths: {}, rowHeights: { 0: 60 } }}
      onSizingChange={onSizingChange}
      onApplyEdit={vi.fn().mockResolvedValue(undefined)}
      onSelectionChange={vi.fn()}
      onError={vi.fn()}
      onHeaderSort={vi.fn()}
    />);
    await waitFor(() => expect(getGridWindow).toHaveBeenCalled());
    const viewport = container.querySelector(".grid-viewport") as HTMLDivElement;

    fireEvent.doubleClick(viewport, { clientX: 212, clientY: 10, button: 0 });
    expect(onSizingChange).toHaveBeenLastCalledWith({ columnWidths: { 0: 116 }, rowHeights: { 0: 60 } });
    fireEvent.doubleClick(viewport, { clientX: 10, clientY: 92, button: 0 });
    expect(onSizingChange).toHaveBeenLastCalledWith({ columnWidths: {}, rowHeights: {} });
  });

  it("keeps navigation, sizing and copy available in read-only mode while blocking mutations", async () => {
    vi.mocked(getGridWindow).mockResolvedValue({
      documentId: 1,
      revision: 0,
      viewRevision: 0,
      rowStart: 0,
      columnStart: 0,
      rows: [{ viewIndex: 0, sourceRow: 0, rowId: 1, cells: ["copy me"] }],
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const onApplyEdit = vi.fn().mockResolvedValue(undefined);
    const onSelectionChange = vi.fn();
    const onSizingChange = vi.fn();
    const onHeaderSort = vi.fn();
    const { container, queryByRole } = render(<CsvGrid
      summary={{ ...summary, rowCount: 1, columnCount: 1, visibleRowCount: 1 }}
      theme="light"
      readOnly
      onSizingChange={onSizingChange}
      onApplyEdit={onApplyEdit}
      onSelectionChange={onSelectionChange}
      onError={vi.fn()}
      onHeaderSort={onHeaderSort}
    />);
    await waitFor(() => expect(getGridWindow).toHaveBeenCalled());
    const viewport = container.querySelector(".grid-viewport") as HTMLDivElement;

    fireEvent.pointerDown(viewport, { clientX: 80, clientY: 50, button: 0, pointerId: 1 });
    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    expect(onSelectionChange).toHaveBeenCalled();

    fireEvent.keyDown(viewport, { key: "x", metaKey: true });
    fireEvent.keyDown(viewport, { key: "v", metaKey: true });
    fireEvent.keyDown(viewport, { key: "Delete" });
    fireEvent.keyDown(viewport, { key: "z" });
    fireEvent.doubleClick(viewport, { clientX: 80, clientY: 50, button: 0 });
    fireEvent.pointerDown(viewport, { clientX: 200, clientY: 10, button: 0, pointerId: 2 });
    fireEvent.contextMenu(viewport, { clientX: 80, clientY: 50 });

    expect(onApplyEdit).not.toHaveBeenCalled();
    expect(onHeaderSort).not.toHaveBeenCalled();
    expect(queryByRole("menu")).toBeNull();
    expect(container.querySelector(".cell-editor")).toBeNull();

    fireEvent.keyDown(viewport, { key: "c", metaKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("copy me"));

    fireEvent.pointerDown(viewport, { clientX: 212, clientY: 10, button: 0, pointerId: 3 });
    fireEvent.pointerMove(viewport, { clientX: 232, clientY: 10, buttons: 1, pointerId: 3 });
    fireEvent.pointerUp(viewport, { clientX: 232, clientY: 10, button: 0, pointerId: 3 });
    expect(onSizingChange).toHaveBeenCalled();
  });
});
