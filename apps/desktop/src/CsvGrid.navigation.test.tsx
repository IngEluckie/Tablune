// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CsvGrid from "./CsvGrid";
import type { ComponentProps } from "react";
import type { DocumentSummary } from "./types";

vi.mock("./ipc", () => ({
  getGridWindow: vi.fn(async (documentId, rowStart, _rows, columnStart) => ({
    documentId, revision: 0, viewRevision: 0, rowStart, columnStart, rows: [],
  })),
  getSheetCell: vi.fn(async (_id, row, column) => ({
    row, column, source: "", display: "", formula: false,
    cellType: "auto", pending: false, error: null,
  })),
}));

const summary: DocumentSummary = {
  documentId: 1, path: null, displayName: "Table", delimiter: ",", lineEnding: "lf",
  revision: 0, viewRevision: 0, dirty: false, rowCount: 100, columnCount: 26,
  visibleRowCount: 100, headerEnabled: false, headerSuggested: false,
  headerNames: [], headerValues: [], canUndo: false, canRedo: false,
  filtersActive: false, sortCount: 0,
};

beforeEach(() => {
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe.each([false, true])("keyboard navigation (project: %s)", (project) => {
  function mount(overrides: Partial<ComponentProps<typeof CsvGrid>> = {}) {
    const onSelectionChange = vi.fn();
    const onApplyEdit = vi.fn().mockResolvedValue(undefined);
    const result = render(<CsvGrid
      summary={{ ...summary, ...(project ? { projectId: 2 } : {}) }}
      theme="light"
      onApplyEdit={onApplyEdit}
      onSelectionChange={onSelectionChange}
      onError={vi.fn()}
      onHeaderSort={vi.fn()}
      {...overrides}
    />);
    const viewport = result.container.querySelector(".grid-viewport") as HTMLDivElement;
    return { ...result, viewport, onSelectionChange, onApplyEdit };
  }

  it("focuses the grid after a cell click and uses all four arrows without scrolling", () => {
    const { getByTestId, viewport, onSelectionChange, onApplyEdit } = mount();
    // Dispatch keys to the actual focused element, as the browser does.
    fireEvent.pointerDown(getByTestId("grid-spacer"), {
      clientX: 250, clientY: 80, button: 0,
    });
    expect(document.activeElement).toBe(viewport);
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      anchor: { row: 1, column: 1 }, focus: { row: 1, column: 1 }, mode: "cells",
    });
    for (const [key, row, column] of [
      ["ArrowRight", 1, 2], ["ArrowDown", 2, 2],
      ["ArrowLeft", 2, 1], ["ArrowUp", 1, 1],
    ] as const) {
      expect(fireEvent.keyDown(document.activeElement!, { key })).toBe(false);
      expect(onSelectionChange).toHaveBeenLastCalledWith({
        anchor: { row, column }, focus: { row, column }, mode: "cells",
      });
      expect(viewport.scrollLeft).toBe(0);
      expect(viewport.scrollTop).toBe(0);
    }
    expect(onApplyEdit).not.toHaveBeenCalled();
  });

  it("scrolls only enough to reveal a cell crossing an edge, accounting for fixed headers", () => {
    const cell = { row: 19, column: 3 };
    const { viewport, onSelectionChange } = mount({
      initialSelection: { anchor: cell, focus: cell, mode: "cells" },
    });
    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    expect(viewport.scrollLeft).toBe(52); // Five 160px columns, plus the 52px row header.
    expect(viewport.scrollTop).toBe(0);
    fireEvent.keyDown(viewport, { key: "ArrowDown" });
    expect(viewport.scrollLeft).toBe(52);
    expect(viewport.scrollTop).toBe(20); // 21 * 28px, plus the 32px column header.
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      anchor: { row: 20, column: 4 }, focus: { row: 20, column: 4 }, mode: "cells",
    });
  });

  it("reveals a selection hidden behind the top and left headers after manual scrolling", () => {
    const { viewport } = mount({ initialViewport: { scrollLeft: 200, scrollTop: 100 } });
    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    expect(viewport.scrollLeft).toBe(160);
    expect(viewport.scrollTop).toBe(0);
    fireEvent.keyDown(viewport, { key: "ArrowLeft" });
    expect(viewport.scrollLeft).toBe(0);
  });

  it("keeps Shift+arrow anchored and moves backwards with Shift+Tab", () => {
    const cell = { row: 1, column: 1 };
    const { viewport, onSelectionChange } = mount({
      initialSelection: { anchor: cell, focus: cell, mode: "cells" },
    });
    fireEvent.keyDown(viewport, { key: "ArrowRight", shiftKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      anchor: cell, focus: { row: 1, column: 2 }, mode: "cells",
    });
    fireEvent.keyDown(viewport, { key: "Tab", shiftKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      anchor: cell, focus: cell, mode: "cells",
    });
  });

  it("uses zoomed, resized cell bounds to reveal the next cell", () => {
    const { viewport } = mount({
      zoom: 2,
      initialSizing: { columnWidths: { 0: 200 }, rowHeights: { 0: 96 } },
    });
    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    expect(viewport.scrollLeft).toBe(24); // (200 + 160) * 2 - (800 - 104).
    expect(viewport.scrollTop).toBe(0);
    for (let i = 0; i < 7; i++) fireEvent.keyDown(viewport, { key: "ArrowDown" });
    expect(viewport.scrollTop).toBe(48); // (96 + 7 * 28) * 2 - (600 - 64).
  });

  it("keeps arrows in the cell editor and returns keyboard navigation after committing", async () => {
    const { viewport, getByLabelText, onApplyEdit, onSelectionChange } = mount();
    fireEvent.keyDown(viewport, { key: "F2" });
    const editor = await waitFor(() => getByLabelText("Edit cell"));
    fireEvent.change(editor, { target: { value: "text" } });
    fireEvent.pointerDown(editor, { clientX: 80, clientY: 50, button: 0 });
    expect(document.activeElement).toBe(editor);
    onSelectionChange.mockClear();
    expect(fireEvent.keyDown(editor, { key: "ArrowLeft" })).toBe(true);
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onApplyEdit).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(document.activeElement).toBe(viewport));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      anchor: { row: 0, column: 1 }, focus: { row: 0, column: 1 }, mode: "cells",
    });
    expect(onApplyEdit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ArrowRight", 1, 2], ["ArrowDown", 2, 1],
    ["ArrowLeft", 1, 0], ["ArrowUp", 0, 1],
  ] as const)("accepts a typed value and moves to the next cell with %s", async (key, row, column) => {
    const cell = { row: 1, column: 1 };
    const { viewport, getByLabelText, onSelectionChange, onApplyEdit } = mount({
      initialSelection: { anchor: cell, focus: cell, mode: "cells" },
    });
    viewport.focus();
    fireEvent.keyDown(viewport, { key: "5" });
    const editor = await waitFor(() => getByLabelText("Edit cell"));
    expect(editor).toHaveProperty("value", "5");
    expect(fireEvent.keyDown(editor, { key })).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(viewport));
    expect(onApplyEdit).toHaveBeenCalledExactlyOnceWith({
      kind: project ? "setSheetCells" : "setCells",
      cells: [{ row: 1, column: 1, value: "5" }],
    });
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      anchor: { row, column }, focus: { row, column }, mode: "cells",
    });
  });

  it.each(["F2", "double-click"])("allows text-cursor editing after typing via %s", async (method) => {
    const { viewport, getByLabelText, onSelectionChange, onApplyEdit } = mount();
    fireEvent.keyDown(viewport, { key: "5" });
    const editor = await waitFor(() => getByLabelText("Edit cell"));
    if (method === "F2") fireEvent.keyDown(editor, { key: "F2" });
    else fireEvent.doubleClick(editor);
    onSelectionChange.mockClear();
    expect(fireEvent.keyDown(editor, { key: "ArrowLeft" })).toBe(true);
    expect(editor).toHaveProperty("value", "5");
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onApplyEdit).not.toHaveBeenCalled();
  });

  it("lets the user type in the next cell while the previous edit finishes", async () => {
    let finish!: () => void;
    const onApplyEdit = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { viewport, getByLabelText } = mount({ onApplyEdit });
    viewport.focus();
    fireEvent.keyDown(viewport, { key: "5" });
    const firstEditor = await waitFor(() => getByLabelText("Edit cell"));
    fireEvent.keyDown(firstEditor, { key: "ArrowRight" });
    expect(document.activeElement).toBe(viewport);
    fireEvent.keyDown(viewport, { key: "6" });
    const nextEditor = await waitFor(() => getByLabelText("Edit cell"));
    expect(nextEditor).toHaveProperty("value", "6");
    await act(async () => { finish(); });
    expect(document.activeElement).toBe(nextEditor);
    expect(nextEditor).toHaveProperty("value", "6");
  });
});
