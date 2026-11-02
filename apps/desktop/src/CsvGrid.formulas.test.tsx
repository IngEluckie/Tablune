// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CsvGrid from "./CsvGrid";
import type { CellInfo, DocumentSummary, SelectionRange } from "./types";
import type { ComponentProps } from "react";
import { getGridWindow, getSheetCell } from "./ipc";
vi.mock("./ipc", () => ({ getGridWindow: vi.fn(), getSheetCell: vi.fn() }));
const summary: DocumentSummary = { projectId: 2, documentId: 1, path: null, displayName: "Table", delimiter: ",", lineEnding: "lf", revision: 0, viewRevision: 0, dirty: false, rowCount: 3, columnCount: 4, visibleRowCount: 3, headerEnabled: false, headerSuggested: false, headerNames: [], headerValues: [], canUndo: false, canRedo: false, filtersActive: false, sortCount: 0 };
const range: SelectionRange = { anchor: { row: 0, column: 0 }, focus: { row: 0, column: 2 }, mode: "cells" };
let cells: Map<string, string>;
function cell(row: number, column: number): CellInfo { const source = cells.get(`${row},${column}`) ?? ""; return { row, column, source, display: source, cellType: "auto", formula: false, pending: false, error: null }; }
beforeEach(() => {
  cells = new Map([["0,0", "2"], ["0,1", "2"], ["0,2", "2"]]);
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.mocked(getSheetCell).mockImplementation(async (_id, r, c) => cell(r, c));
  vi.mocked(getGridWindow).mockImplementation(async (documentId, rowStart, rowCount, columnStart, columnCount) => ({ documentId, revision: 0, viewRevision: 0, rowStart, columnStart, rows: Array.from({ length: Math.max(0, Math.min(3 - rowStart, rowCount)) }, (_, offset) => {
    const row = rowStart + offset, inputs = Array.from({ length: columnCount }, (_, c) => cell(row, columnStart + c));
    return { sourceRow: row, viewIndex: row, rowId: row, inputs, cells: inputs.map(c => c.display) };
  }) }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function mount(props: Partial<ComponentProps<typeof CsvGrid>> = {}) {
  const onApplyEdit = vi.fn().mockResolvedValue(undefined), onError = vi.fn(), onSelectionChange = vi.fn();
  const result = render(<CsvGrid summary={summary} theme="light" initialSelection={range} onApplyEdit={onApplyEdit} onError={onError} onSelectionChange={onSelectionChange} onHeaderSort={vi.fn()} {...props} />);
  return { ...result, onApplyEdit, onError, onSelectionChange };
}
async function command(command: string, functionName?: string, documentId = 1) {
  await act(async () => { document.dispatchEvent(new CustomEvent("tablune-grid-command", { detail: { command, documentId, functionName } })); });
}
it("previews a selected range and inserts one undoable formula only after confirmation", async () => {
  const { onApplyEdit } = mount();
  await command("autoSum");
  expect(await screen.findByRole("region", { name: "Propuesta de Autosuma" })).toBeTruthy();
  expect(screen.getByLabelText("Destino de Autosuma")).toHaveProperty("value", "D1");
  expect(onApplyEdit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Insertar suma" }));
  await waitFor(() => expect(onApplyEdit).toHaveBeenCalledExactlyOnceWith({ kind: "setSheetCells", cells: [{ row: 0, column: 3, value: '=sum(cells("A1:C1"))' }] }, { documentId: 1, revision: 0 }));
});
it("refuses occupied destinations and cycles, and allows choosing another blank cell", async () => {
  cells.set("0,3", "Keep me");
  const { onApplyEdit } = mount();
  await command("autoSum");
  fireEvent.click(screen.getByRole("button", { name: "Insertar suma" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "D1 ya tiene contenido. Elige una celda vacía.");
  fireEvent.change(screen.getByLabelText("Destino de Autosuma"), { target: { value: "B1" } });
  fireEvent.click(screen.getByRole("button", { name: "Insertar suma" }));
  expect(screen.getByRole("alert").textContent).toContain("referencia circular");
  expect(onApplyEdit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Destino de Autosuma"), { target: { value: "E1" } });
  fireEvent.click(screen.getByRole("button", { name: "Insertar suma" }));
  await waitFor(() => expect(onApplyEdit).toHaveBeenCalledWith(expect.objectContaining({ cells: [{ row: 0, column: 4, value: '=sum(cells("A1:C1"))' }] }), expect.anything()));
});
it("infers numbers to the left of an empty cell and supports cancelling without edits", async () => {
  const target = { row: 0, column: 3 };
  const { onApplyEdit, onSelectionChange } = mount({ initialSelection: { anchor: target, focus: target, mode: "cells" } });
  await command("autoSum");
  expect(await screen.findByText('=sum(cells("A1:C1"))')).toBeTruthy();
  expect(onSelectionChange).toHaveBeenCalledWith(range);
  fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
  expect(screen.queryByRole("region", { name: "Propuesta de Autosuma" })).toBeNull();
  expect(onApplyEdit).not.toHaveBeenCalled();
});
it("inserts a function in the formula bar, accepts a dragged range, and commits its formula", async () => {
  const target = { row: 0, column: 3 };
  const { container, onApplyEdit } = mount({ initialSelection: { anchor: target, focus: target, mode: "cells" } });
  await command("insertFunction", "sum");
  const bar = screen.getByRole("combobox", { name: "Formula bar" });
  expect(bar).toHaveProperty("value", "=sum()");
  expect(document.activeElement).toBe(bar);
  expect(bar).toHaveProperty("selectionStart", 5);
  const viewport = container.querySelector(".grid-viewport")!;
  fireEvent.pointerDown(viewport, { clientX: 80, clientY: 45, button: 0, buttons: 1 });
  fireEvent.pointerMove(viewport, { clientX: 440, clientY: 45, buttons: 1 });
  fireEvent.pointerUp(viewport, { clientX: 440, clientY: 45, button: 0 });
  expect(bar).toHaveProperty("value", '=sum(cells("A1:C1"))');
  expect(onApplyEdit).not.toHaveBeenCalled();
  fireEvent.keyDown(bar, { key: "Enter" });
  await waitFor(() => expect(onApplyEdit).toHaveBeenCalledWith({ kind: "setSheetCells", cells: [{ row: 0, column: 3, value: '=sum(cells("A1:C1"))' }] }));
});
it("ignores commands for read-only grids", async () => {
  const { onApplyEdit } = mount({ readOnly: true });
  await command("insertFunction", "sum"); await command("autoSum");
  expect(screen.queryByRole("region", { name: "Propuesta de Autosuma" })).toBeNull();
  expect(onApplyEdit).not.toHaveBeenCalled();
});
it("ignores commands for other documents", async () => {
  mount();
  await command("autoSum", undefined, 99);
  expect(screen.queryByRole("region", { name: "Propuesta de Autosuma" })).toBeNull();
});
it("preserves the active formula when using the catalog to insert a nested function", async () => {
  const { onApplyEdit } = mount();
  await command("insertFunction", "round");
  const bar = screen.getByRole("combobox", { name: "Formula bar" }) as HTMLInputElement;
  bar.setSelectionRange(7, 7);
  const tool = document.createElement("button"); tool.setAttribute("data-formula-tools", ""); document.body.append(tool);
  try {
    fireEvent.blur(bar, { relatedTarget: tool });
    await command("insertFunction", "sum");
    expect(bar).toHaveProperty("value", "=round(sum())");
    expect(onApplyEdit).not.toHaveBeenCalled();
  } finally { tool.remove(); }
});
it("rejects Autosuma in a sorted or filtered view", async () => {
  const { onError, onApplyEdit } = mount({ summary: { ...summary, filtersActive: true } });
  await command("autoSum");
  expect(onError).toHaveBeenCalledWith(expect.stringContaining("Quita los filtros"));
  expect(onApplyEdit).not.toHaveBeenCalled();
});
it("discards a proposal when source data changes", async () => {
  const props = { summary, theme: "light" as const, initialSelection: range, onApplyEdit: vi.fn(), onError: vi.fn(), onSelectionChange: vi.fn(), onHeaderSort: vi.fn() };
  const { rerender } = render(<CsvGrid {...props} />);
  await command("autoSum");
  expect(await screen.findByRole("region", { name: "Propuesta de Autosuma" })).toBeTruthy();
  rerender(<CsvGrid {...props} summary={{ ...summary, revision: 1 }} />);
  expect(screen.queryByRole("region", { name: "Propuesta de Autosuma" })).toBeNull();
});
