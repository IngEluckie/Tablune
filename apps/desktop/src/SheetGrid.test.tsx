// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import CsvGrid, { flushCellEdits } from "./CsvGrid";
import * as ipc from "./ipc";
import { open } from "@tauri-apps/plugin-dialog";
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), ask: vi.fn() }));
import type { CellInfo, DocumentSummary, SelectionRange } from "./types";
vi.mock("./ipc", () => ({
  getSessionSummary: vi.fn(),
  importCellImage: vi.fn(),
  readCellImage: vi.fn(),
  copyImageAssets: vi.fn(),
  pasteImageAssets: vi.fn(),
  getGridWindow: vi.fn(),
  getSheetCell: vi.fn(),
  shiftSheetFormulas: vi.fn(),
  clipboardGeneration: vi.fn(),
  readNativeClipboard: vi.fn(async () => null),
  writeNativeClipboard: vi.fn(async () => false),
}));
const info: CellInfo = {
  row: 0,
  column: 0,
  style: { bold: true, background: "#fff0b3" },
  source: "=B1+C1",
  display: "35",
  formula: true,
  cellType: "auto",
  pending: false,
  error: null,
};
const summary: DocumentSummary = {
  documentId: 1,
  projectId: 2,
  path: null,
  displayName: "Sheet",
  delimiter: ",",
  lineEnding: "lf",
  revision: 1,
  calculationRevision: 1,
  viewRevision: 1,
  dirty: false,
  rowCount: 3,
  columnCount: 3,
  visibleRowCount: 3,
  headerEnabled: false,
  headerSuggested: false,
  headerNames: ["A", "B", "C"],
  headerValues: [],
  canUndo: true,
  canRedo: false,
  filtersActive: false,
  sortCount: 0,
  formulaCount: 1,
  pendingCells: 0,
};
let clipboard = "";
let generation = 0;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.getSessionSummary).mockResolvedValue(summary);
  vi.mocked(ipc.readNativeClipboard).mockResolvedValue(null);
  vi.mocked(ipc.writeNativeClipboard).mockResolvedValue(false);
  clipboard = "";
  generation++;
  const context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 20 })),
    save: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    restore: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async (text: string) => {
        clipboard = text;
        generation++;
      }),
      readText: vi.fn(async () => clipboard),
    },
  });
  vi.mocked(ipc.clipboardGeneration).mockImplementation(async () => generation);
  vi.mocked(ipc.getSheetCell).mockImplementation(async (_id, row, column) => ({
    ...info,
    row,
    column,
    ...(row ? { formula: false, source: "", display: "" } : {}),
  }));
  vi.mocked(ipc.getGridWindow).mockImplementation(
    async (_id, rowStart, rowCount, columnStart, columnCount) => ({
      documentId: 1,
      revision: 1,
      viewRevision: 1,
      rowStart,
      columnStart,
      rows: Array.from(
        { length: Math.max(0, Math.min(rowCount, 3 - rowStart)) },
        (_, i) => ({
          viewIndex: rowStart + i,
          sourceRow: rowStart + i,
          rowId: rowStart + i + 1,
          cells: Array.from({ length: columnCount }, (_, c) =>
            rowStart + i === 0 && c + columnStart === 0 ? "35" : "",
          ),
          inputs: Array.from({ length: columnCount }, (_, c) => ({
            ...info,
            row: rowStart + i,
            column: c + columnStart,
            ...(rowStart + i === 0 && c + columnStart === 0
              ? {}
              : { formula: false, source: "", display: "" }),
          })),
        }),
      ),
    }),
  );
  vi.mocked(ipc.shiftSheetFormulas).mockResolvedValue(["=B2+C2"]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount(onApplyEdit = vi.fn().mockResolvedValue(undefined)) {
  const props = {
    summary,
    theme: "light" as const,
    onApplyEdit,
    onSelectionChange: vi.fn(),
    onError: vi.fn(),
    onHeaderSort: vi.fn(),
  };
  return { ...render(<CsvGrid {...props} />), onApplyEdit };
}
it("uses the native clipboard without WebKit clipboard permission prompts", async () => {
  vi.mocked(ipc.readNativeClipboard).mockResolvedValue("00123\t=1+2");
  vi.mocked(ipc.writeNativeClipboard).mockResolvedValue(true);
  const { container, onApplyEdit } = mount();
  await waitFor(() =>
    expect(screen.getByLabelText("Formula bar")).toHaveProperty(
      "value",
      "=B1+C1",
    ),
  );
  const viewport = container.querySelector(".grid-viewport")!;
  fireEvent.keyDown(viewport, { key: "v", metaKey: true });
  await waitFor(() =>
    expect(onApplyEdit).toHaveBeenCalledWith({
      kind: "setSheetCells",
      cells: [
        {
          row: 0,
          column: 0,
          value: "00123",
          literal: true,
          cellType: undefined,
        },
        {
          row: 0,
          column: 1,
          value: "=1+2",
          literal: true,
          cellType: undefined,
        },
      ],
    }),
  );
  expect(navigator.clipboard.readText).not.toHaveBeenCalled();
  fireEvent.keyDown(viewport, { key: "c", metaKey: true });
  await waitFor(() =>
    expect(ipc.writeNativeClipboard).toHaveBeenCalledWith("35"),
  );
  expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
});
it("edits the formula source while the cell displays its result", async () => {
  const { onApplyEdit } = mount();
  const bar = await screen.findByLabelText("Formula bar");
  await waitFor(() => expect(bar).toHaveProperty("value", "=B1+C1"));
  fireEvent.focus(bar);
  fireEvent.change(bar, { target: { value: "=B1+C1+5" } });
  fireEvent.keyDown(bar, { key: "Enter" });
  await waitFor(() =>
    expect(onApplyEdit).toHaveBeenCalledWith({
      kind: "setSheetCells",
      cells: [{ row: 0, column: 0, value: "=B1+C1+5" }],
    }),
  );
});
it("keeps the editor and its text when the workspace remembers the selected cell", async () => {
  const onApplyEdit = vi.fn(async () => {});
  const onError = vi.fn();
  function Workspace() {
    const [selection, setSelection] = useState<SelectionRange>({
      anchor: { row: 0, column: 0 },
      focus: { row: 0, column: 0 },
      mode: "cells",
    });
    return <CsvGrid summary={summary} theme="light" initialSelection={selection}
      onSelectionChange={setSelection} onApplyEdit={onApplyEdit}
      onError={onError} onHeaderSort={vi.fn()} />;
  }
  const { container } = render(<Workspace />);
  await waitFor(() => expect(screen.getByLabelText("Formula bar")).toHaveProperty("value", "=B1+C1"));
  const viewport = container.querySelector(".grid-viewport")!;
  fireEvent.doubleClick(viewport, { clientX: 780, clientY: 75, button: 0 });
  const editor = await screen.findByLabelText("Edit cell");
  fireEvent.change(editor, { target: { value: "E2 text stays" } });
  fireEvent.keyDown(editor, { key: "Enter" });
  await waitFor(() => expect(onApplyEdit).toHaveBeenCalledWith({
    kind: "setSheetCells",
    cells: [{ row: 1, column: 4, value: "E2 text stays" }],
  }));
  expect(onError).not.toHaveBeenCalled();
});
it("does not interrupt typing in E2 when the previous cell finishes saving", async () => {
  let finish!: () => void;
  const onApplyEdit = vi.fn<() => Promise<void>>()
    .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
    .mockResolvedValue(undefined);
  const { container } = mount(onApplyEdit);
  const viewport = container.querySelector(".grid-viewport")!;
  await waitFor(() => expect(screen.getByLabelText("Formula bar")).toHaveProperty("value", "=B1+C1"));
  fireEvent.keyDown(viewport, { key: "a" });
  let editor = await screen.findByLabelText("Edit cell");
  fireEvent.change(editor, { target: { value: "First cell" } });
  fireEvent.keyDown(editor, { key: "Enter" });
  fireEvent.pointerDown(viewport, { clientX: 780, clientY: 75, button: 0 });
  fireEvent.keyDown(viewport, { key: "r" });
  editor = await screen.findByLabelText("Edit cell");
  fireEvent.change(editor, { target: { value: "rrrr" } });
  expect(document.activeElement).toBe(editor);
  await act(async () => { finish(); });
  expect(screen.getByLabelText("Edit cell")).toBe(editor);
  expect(document.activeElement).toBe(editor);
  expect(editor).toHaveProperty("value", "rrrr");
  expect(onApplyEdit).toHaveBeenCalledTimes(1);
});
it("saves both cells when the second edit is committed before the first one completes", async () => {
  let finish!: () => void;
  const onApplyEdit = vi.fn<() => Promise<void>>()
    .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
    .mockResolvedValue(undefined);
  const { container } = mount(onApplyEdit);
  const viewport = container.querySelector(".grid-viewport")!;
  await waitFor(() => expect(screen.getByLabelText("Formula bar")).toHaveProperty("value", "=B1+C1"));
  fireEvent.keyDown(viewport, { key: "d" });
  let editor = await screen.findByLabelText("Edit cell");
  fireEvent.change(editor, { target: { value: "First edit" } });
  fireEvent.keyDown(editor, { key: "Enter" });
  fireEvent.pointerDown(viewport, { clientX: 780, clientY: 75, button: 0 });
  fireEvent.keyDown(viewport, { key: "e" });
  editor = await screen.findByLabelText("Edit cell");
  fireEvent.change(editor, { target: { value: "Second edit" } });
  fireEvent.keyDown(editor, { key: "Enter" });
  expect(onApplyEdit).toHaveBeenCalledTimes(1);
  await act(async () => {
    const flush = flushCellEdits();
    finish();
    await flush;
  });
  expect(onApplyEdit.mock.calls).toEqual([
    [{ kind: "setSheetCells", cells: [{ row: 0, column: 0, value: "First edit" }] }],
    [{ kind: "setSheetCells", cells: [{ row: 1, column: 4, value: "Second edit" }] }],
  ]);
});
it("starts typing immediately in an empty cell beyond the used rows", async () => {
  const { container, onApplyEdit } = mount();
  const viewport = container.querySelector(".grid-viewport")!;
  await waitFor(() => expect(screen.getByLabelText("Formula bar")).toHaveProperty("value", "=B1+C1"));
  fireEvent.pointerDown(viewport, { clientX: 780, clientY: 330, button: 0 });
  fireEvent.keyDown(viewport, { key: "r" });
  // The editor must receive the very next keystroke without waiting for IPC.
  const editor = screen.getByLabelText("Edit cell");
  expect(editor).toHaveProperty("value", "r");
  fireEvent.change(editor, { target: { value: "rapid typing" } });
  fireEvent.keyDown(editor, { key: "Enter" });
  await waitFor(() => expect(onApplyEdit).toHaveBeenCalledWith({
    kind: "setSheetCells",
    cells: [{ row: 10, column: 4, value: "rapid typing" }],
  }));
});
it("inserts a grid reference without committing the formula prematurely", async () => {
  const { container, onApplyEdit } = mount();
  const bar = screen.getByLabelText("Formula bar");
  await waitFor(() => expect(bar).toHaveProperty("value", "=B1+C1"));
  fireEvent.focus(bar);
  fireEvent.change(bar, { target: { value: "=" } });
  (bar as HTMLInputElement).setSelectionRange(1, 1);
  const viewport = container.querySelector(".grid-viewport")!;
  fireEvent.pointerDown(viewport, {
    clientX: 200,
    clientY: 70,
    button: 0,
    buttons: 1,
  });
  fireEvent.pointerUp(viewport, { clientX: 200, clientY: 70, button: 0 });
  expect(onApplyEdit).not.toHaveBeenCalled();
  expect((bar as HTMLInputElement).value).toMatch(/^=[A-Z]+[1-9]/);
  fireEvent.keyDown(bar, { key: "Enter" });
  await waitFor(() => expect(onApplyEdit).toHaveBeenCalledTimes(1));
});
it("copies formulas within the sheet and supports paste values", async () => {
  const { container, onApplyEdit } = mount();
  await waitFor(() =>
    expect(screen.getByLabelText("Formula bar")).toHaveProperty(
      "value",
      "=B1+C1",
    ),
  );
  const viewport = container.querySelector(".grid-viewport")!;
  fireEvent.keyDown(viewport, { key: "c", metaKey: true });
  await waitFor(() => expect(clipboard).toBe("35"));
  await waitFor(() => expect(ipc.clipboardGeneration).toHaveBeenCalled());
  fireEvent.keyDown(viewport, { key: "ArrowDown" });
  fireEvent.keyDown(viewport, { key: "v", metaKey: true });
  await waitFor(() =>
    expect(onApplyEdit).toHaveBeenCalledWith({
      kind: "setSheetCells",
      cells: [
        {
          row: 1,
          column: 0,
          value: "=B2+C2",
          style: info.style,
          literal: false,
          cellType: "auto",
        },
      ],
    }),
  );
  fireEvent.click(screen.getByText("Paste values"));
  await waitFor(() =>
    expect(onApplyEdit).toHaveBeenLastCalledWith({
      kind: "setSheetCells",
      cells: [
        { row: 1, column: 0, value: "35", literal: true, cellType: undefined },
      ],
    }),
  );
});
it("does not reuse internal formulas after another application changes the clipboard", async () => {
  const { container, onApplyEdit } = mount();
  await waitFor(() =>
    expect(screen.getByLabelText("Formula bar")).toHaveProperty(
      "value",
      "=B1+C1",
    ),
  );
  const viewport = container.querySelector(".grid-viewport")!;
  fireEvent.keyDown(viewport, { key: "c", metaKey: true });
  await waitFor(() => expect(ipc.clipboardGeneration).toHaveBeenCalled());
  generation++;
  fireEvent.keyDown(viewport, { key: "v", metaKey: true });
  await waitFor(() => expect(onApplyEdit).toHaveBeenCalled());
  expect(ipc.shiftSheetFormulas).not.toHaveBeenCalled();
  expect(onApplyEdit.mock.calls[0][0].cells[0]).toMatchObject({
    value: "35",
    literal: true,
  });
});
it("flushes an unfinished formula before the workspace can save", async () => {
  let finish!: () => void;
  const onApplyEdit = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  mount(onApplyEdit);
  const bar = screen.getByLabelText("Formula bar");
  await waitFor(() => expect(bar).toHaveProperty("value", "=B1+C1"));
  fireEvent.focus(bar);
  fireEvent.change(bar, { target: { value: "=2+3" } });
  let completed = false;
  let flush!: Promise<void>;
  act(() => {
    flush = flushCellEdits().then(() => {
      completed = true;
    });
  });
  expect(completed).toBe(false);
  expect(onApplyEdit).toHaveBeenCalled();
  await act(async () => {
    finish();
    await flush;
  });
  expect(completed).toBe(true);
});
it("applies a type to the selected cell through an undoable edit", async () => {
  const { onApplyEdit } = mount();
  fireEvent.change(screen.getByLabelText("Cell type"), {
    target: { value: "text" },
  });
  await waitFor(() =>
    expect(onApplyEdit).toHaveBeenCalledWith({
      kind: "setCellTypes",
      cells: [{ row: 0, column: 0 }],
      cellType: "text",
    }),
  );
});

it("inserts a file image in the active cell with the captured document revision", async () => {
  const image = { assetId: "a".repeat(64), name: "photo.png", alt: "" };
  vi.mocked(open).mockResolvedValue("/tmp/photo.png");
  vi.mocked(ipc.importCellImage).mockResolvedValue(image);
  const onApplyEdit = vi.fn(async () => {});
  render(<CsvGrid summary={summary} theme="light" onApplyEdit={onApplyEdit} onSelectionChange={vi.fn()} onError={vi.fn()} onHeaderSort={vi.fn()} />);
  await waitFor(() => expect(ipc.getGridWindow).toHaveBeenCalled());
  act(() => document.dispatchEvent(new CustomEvent("tablune-grid-command", { detail: { command: "insertImage", documentId: 1 } })));
  await waitFor(() => expect(onApplyEdit).toHaveBeenCalledWith({ kind: "setSheetCells", cells: [{ row: 0, column: 0, value: "photo.png", image, literal: true }] }, { documentId: 1, revision: 1 }));
});
it("does not modify cells when an image fails validation", async () => {
  vi.mocked(open).mockResolvedValue("/tmp/invalid.png");
  vi.mocked(ipc.importCellImage).mockRejectedValue(new Error("Invalid image"));
  const onApplyEdit = vi.fn(async () => {}), onError = vi.fn();
  render(<CsvGrid summary={summary} theme="light" onApplyEdit={onApplyEdit} onSelectionChange={vi.fn()} onError={onError} onHeaderSort={vi.fn()} />);
  act(() => document.dispatchEvent(new CustomEvent("tablune-grid-command", { detail: { command: "insertImage", documentId: 1 } })));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("Error: Invalid image"));
  expect(onApplyEdit).not.toHaveBeenCalled();
});

it("keeps pointer selection and cell editing aligned at 200% zoom", async () => {
  const onSelectionChange = vi.fn();
  const { container } = render(<CsvGrid summary={summary} theme="light" zoom={2} onApplyEdit={vi.fn(async () => {})} onSelectionChange={onSelectionChange} onError={vi.fn()} onHeaderSort={vi.fn()} />);
  await waitFor(() => expect(ipc.getGridWindow).toHaveBeenCalled());
  const viewport = container.querySelector(".grid-viewport")!;
  fireEvent.pointerDown(viewport, { clientX: 440, clientY: 130, button: 0 });
  expect(onSelectionChange).toHaveBeenLastCalledWith({ anchor: { row: 1, column: 1 }, focus: { row: 1, column: 1 }, mode: "cells" });
  fireEvent.keyDown(viewport, { key: "x" });
  const input = await screen.findByLabelText("Edit cell");
  expect(input.style.left).toBe("425px");
  expect(input.style.top).toBe("121px");
  expect(input.style.width).toBe("318px");
  expect(input.style.fontSize).toBe("26px");
});

it("selects fixed column headers correctly after scrolling a zoomed sheet", async () => {
  const onSelectionChange = vi.fn();
  const { container } = render(<CsvGrid summary={summary} theme="light" zoom={2} onApplyEdit={vi.fn(async () => {})} onSelectionChange={onSelectionChange} onError={vi.fn()} onHeaderSort={vi.fn()} />);
  await waitFor(() => expect(ipc.getGridWindow).toHaveBeenCalled());
  const viewport = container.querySelector<HTMLDivElement>(".grid-viewport")!;
  viewport.scrollLeft = 320;
  viewport.scrollTop = 200;
  fireEvent.pointerDown(viewport, { clientX: 120, clientY: 20, button: 0 });
  expect(onSelectionChange.mock.lastCall?.[0]).toMatchObject({ mode: "columns", focus: { column: 1 } });
});

it("serializes formatting commands for the target document and flushes them before save", async () => {
  let finish!: () => void;
  const onApplyEdit = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
  mount(onApplyEdit);
  await waitFor(() => expect(screen.getByLabelText("Formula bar")).toHaveProperty("value", "=B1+C1"));
  act(() => {
    document.dispatchEvent(new CustomEvent("tablune-grid-command", { detail: { command: "format", documentId: 99, patch: { bold: true } } }));
    document.dispatchEvent(new CustomEvent("tablune-grid-command", { detail: { command: "format", documentId: 1, patch: { bold: true } } }));
    document.dispatchEvent(new CustomEvent("tablune-grid-command", { detail: { command: "format", documentId: 1, patch: { background: "#fff0b3" } } }));
  });
  await waitFor(() => expect(onApplyEdit).toHaveBeenCalledTimes(1));
  expect(onApplyEdit).toHaveBeenCalledWith({kind:"formatCells",range:{startRow:0,endRow:0,startColumn:0,endColumn:0},patch:{bold:true}},{documentId:1,revision:1});
  let flushed = false;
  const flush = flushCellEdits().then(() => { flushed = true; });
  await Promise.resolve(); expect(flushed).toBe(false);
  await act(async () => { finish(); await flush; });
  expect(onApplyEdit).toHaveBeenCalledTimes(2);
  expect(onApplyEdit).toHaveBeenLastCalledWith({kind:"formatCells",range:{startRow:0,endRow:0,startColumn:0,endColumn:0},patch:{background:"#fff0b3"}},{documentId:1,revision:1});
});
