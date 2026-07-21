import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { getGridWindow } from "./ipc";
import type {
  CellCoordinate,
  DocumentSummary,
  EditCommand,
  GridWindow,
  SelectionMode,
  SelectionRange,
} from "./types";

const ROW_HEIGHT = 28;
const COLUMN_WIDTH = 160;
const ROW_HEADER_WIDTH = 52;
const COLUMN_HEADER_HEIGHT = 32;
const MIN_ROWS = 100;
const MIN_COLUMNS = 26;
const WINDOW_OVERSCAN = 12;

interface CsvGridProps {
  summary: DocumentSummary;
  onApplyEdit: (command: EditCommand) => Promise<void>;
  onSelectionChange: (selection: SelectionRange) => void;
  onError: (message: string) => void;
  reveal?: { viewRow: number; column: number; nonce: number } | null;
  onHeaderSort: (column: number) => void;
}

interface EditingCell {
  viewRow: number;
  sourceRow: number;
  column: number;
  header: boolean;
}

interface GridTarget extends CellCoordinate {
  mode: SelectionMode;
}

export function columnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

export function normalizeSelection(selection: SelectionRange) {
  return {
    startRow: Math.min(selection.anchor.row, selection.focus.row),
    endRow: Math.max(selection.anchor.row, selection.focus.row),
    startColumn: Math.min(selection.anchor.column, selection.focus.column),
    endColumn: Math.max(selection.anchor.column, selection.focus.column),
  };
}

export function encodeClipboardMatrix(matrix: string[][]): string {
  return matrix
    .map((row) => row.map((value) => {
      if (!/[\t\r\n"]/.test(value)) return value;
      return `"${value.replaceAll('"', '""')}"`;
    }).join("\t"))
    .join("\r\n");
}

export function parseClipboardMatrix(text: string): string[][] {
  const rows: string[][] = [[]];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "\t" && !quoted) {
      rows.at(-1)?.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      rows.at(-1)?.push(value);
      rows.push([]);
      value = "";
    } else {
      value += character;
    }
  }
  rows.at(-1)?.push(value);
  if (rows.length > 1 && rows.at(-1)?.length === 1 && rows.at(-1)?.[0] === "" && /[\r\n]$/.test(text)) {
    rows.pop();
  }
  return rows;
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard access is unavailable.");
}

export default function CsvGrid({ summary, onApplyEdit, onSelectionChange, onError, reveal, onHeaderSort }: CsvGridProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragAnchor = useRef<GridTarget | null>(null);
  const requestId = useRef(0);
  const selectAllStage = useRef(0);
  const [windowData, setWindowData] = useState<GridWindow | null>(null);
  const [selection, setSelection] = useState<SelectionRange>({
    anchor: { row: 0, column: 0 },
    focus: { row: 0, column: 0 },
    mode: "cells",
  });
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [draft, setDraft] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const columnCount = Math.max(MIN_COLUMNS, summary.columnCount);
  const rowCount = Math.max(MIN_ROWS, summary.visibleRowCount || 1);
  const totalWidth = ROW_HEADER_WIDTH + columnCount * COLUMN_WIDTH;
  const totalHeight = COLUMN_HEADER_HEIGHT + rowCount * ROW_HEIGHT;

  const publishSelection = useCallback((next: SelectionRange) => {
    setSelection(next);
    onSelectionChange(next);
  }, [onSelectionChange]);

  const loadVisibleWindow = useCallback(async () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const firstRow = Math.max(0, Math.floor((viewport.scrollTop - COLUMN_HEADER_HEIGHT) / ROW_HEIGHT) - WINDOW_OVERSCAN);
    const rowAmount = Math.ceil(viewport.clientHeight / ROW_HEIGHT) + WINDOW_OVERSCAN * 2;
    const firstColumn = Math.max(0, Math.floor((viewport.scrollLeft - ROW_HEADER_WIDTH) / COLUMN_WIDTH) - 2);
    const columnAmount = Math.ceil(viewport.clientWidth / COLUMN_WIDTH) + 5;
    const currentRequest = ++requestId.current;
    try {
      const data = await getGridWindow(firstRow, rowAmount, firstColumn, columnAmount);
      if (currentRequest === requestId.current) setWindowData(data);
    } catch (reason) {
      onError(String(reason));
    }
  }, [onError]);

  useEffect(() => {
    void loadVisibleWindow();
  }, [loadVisibleWindow, summary.revision, summary.viewRevision]);

  const cachedRow = useCallback((viewRow: number) => {
    return windowData?.rows.find((row) => row.viewIndex === viewRow);
  }, [windowData]);

  const getCell = useCallback((viewRow: number, column: number): string => {
    const row = cachedRow(viewRow);
    if (!row || !windowData) return "";
    return row.cells[column - windowData.columnStart] ?? "";
  }, [cachedRow, windowData]);

  const draw = useCallback(() => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!viewport || !canvas) return;
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * scale);
    canvas.height = Math.floor(height * scale);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.style.transform = `translate(${viewport.scrollLeft}px, ${viewport.scrollTop}px)`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    context.font = "13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    context.textBaseline = "middle";
    const firstColumn = Math.max(0, Math.floor((viewport.scrollLeft - ROW_HEADER_WIDTH) / COLUMN_WIDTH));
    const lastColumn = Math.min(columnCount - 1, Math.ceil((viewport.scrollLeft + width - ROW_HEADER_WIDTH) / COLUMN_WIDTH));
    const firstRow = Math.max(0, Math.floor((viewport.scrollTop - COLUMN_HEADER_HEIGHT) / ROW_HEIGHT));
    const lastRow = Math.min(rowCount - 1, Math.ceil((viewport.scrollTop + height - COLUMN_HEADER_HEIGHT) / ROW_HEIGHT));
    const range = normalizeSelection(selection);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);

    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const x = ROW_HEADER_WIDTH + column * COLUMN_WIDTH - viewport.scrollLeft;
      const selected = selection.mode === "columns" && column >= range.startColumn && column <= range.endColumn;
      context.fillStyle = selected || column === selection.focus.column ? "#e7f4ec" : "#f5f6f7";
      context.fillRect(x, 0, COLUMN_WIDTH, COLUMN_HEADER_HEIGHT);
      context.fillStyle = "#3b4148";
      context.textAlign = "center";
      const label = summary.headerEnabled ? summary.headerNames[column] ?? columnName(column) : columnName(column);
      context.fillText(label, x + COLUMN_WIDTH / 2, COLUMN_HEADER_HEIGHT / 2);
      if (column < summary.headerNames.length) {
        context.fillStyle = "#6d7a72";
        context.textAlign = "right";
        context.fillText("↕", x + COLUMN_WIDTH - 9, COLUMN_HEADER_HEIGHT / 2);
      }
    }

    for (let row = firstRow; row <= lastRow; row += 1) {
      const y = COLUMN_HEADER_HEIGHT + row * ROW_HEIGHT - viewport.scrollTop;
      const rowSelected = selection.mode === "rows" && row >= range.startRow && row <= range.endRow;
      context.fillStyle = rowSelected || row === selection.focus.row ? "#e7f4ec" : "#f7f8f9";
      context.fillRect(0, y, ROW_HEADER_WIDTH, ROW_HEIGHT);
      context.fillStyle = "#5a6169";
      context.textAlign = "center";
      const sourceRow = cachedRow(row)?.sourceRow;
      context.fillText(String((sourceRow ?? row) + 1), ROW_HEADER_WIDTH / 2, y + ROW_HEIGHT / 2);
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const x = ROW_HEADER_WIDTH + column * COLUMN_WIDTH - viewport.scrollLeft;
        const selected = row >= range.startRow && row <= range.endRow
          && column >= range.startColumn && column <= range.endColumn;
        if (selected) {
          context.fillStyle = "#eef8f2";
          context.fillRect(x, y, COLUMN_WIDTH, ROW_HEIGHT);
        }
        context.fillStyle = "#161a1f";
        context.textAlign = "left";
        context.save();
        context.beginPath();
        context.rect(x + 6, y, COLUMN_WIDTH - 12, ROW_HEIGHT);
        context.clip();
        context.fillText(getCell(row, column), x + 8, y + ROW_HEIGHT / 2);
        context.restore();
      }
    }

    context.strokeStyle = "#dfe3e7";
    context.lineWidth = 1;
    context.beginPath();
    for (let column = firstColumn; column <= lastColumn + 1; column += 1) {
      const x = ROW_HEADER_WIDTH + column * COLUMN_WIDTH - viewport.scrollLeft + 0.5;
      context.moveTo(x, 0);
      context.lineTo(x, height);
    }
    for (let row = firstRow; row <= lastRow + 1; row += 1) {
      const y = COLUMN_HEADER_HEIGHT + row * ROW_HEIGHT - viewport.scrollTop + 0.5;
      context.moveTo(0, y);
      context.lineTo(width, y);
    }
    context.moveTo(ROW_HEADER_WIDTH + 0.5, 0);
    context.lineTo(ROW_HEADER_WIDTH + 0.5, height);
    context.moveTo(0, COLUMN_HEADER_HEIGHT + 0.5);
    context.lineTo(width, COLUMN_HEADER_HEIGHT + 0.5);
    context.stroke();

    const selectedX = ROW_HEADER_WIDTH + range.startColumn * COLUMN_WIDTH - viewport.scrollLeft;
    const selectedY = COLUMN_HEADER_HEIGHT + range.startRow * ROW_HEIGHT - viewport.scrollTop;
    context.strokeStyle = "#0f8a50";
    context.lineWidth = 2;
    context.strokeRect(
      selectedX + 1,
      selectedY + 1,
      (range.endColumn - range.startColumn + 1) * COLUMN_WIDTH - 2,
      (range.endRow - range.startRow + 1) * ROW_HEIGHT - 2,
    );
  }, [cachedRow, columnCount, getCell, rowCount, selection, summary.headerEnabled, summary.headerNames]);

  useLayoutEffect(() => {
    draw();
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      draw();
      void loadVisibleWindow();
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [draw, loadVisibleWindow]);

  const targetFromPointer = (event: MouseEvent<HTMLDivElement>): GridTarget | null => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    const rect = viewport.getBoundingClientRect();
    const absoluteX = event.clientX - rect.left + viewport.scrollLeft;
    const absoluteY = event.clientY - rect.top + viewport.scrollTop;
    if (absoluteX < ROW_HEADER_WIDTH && absoluteY < COLUMN_HEADER_HEIGHT) {
      return { row: 0, column: 0, mode: "cells" };
    }
    if (absoluteY < COLUMN_HEADER_HEIGHT) {
      return {
        row: 0,
        column: Math.min(columnCount - 1, Math.max(0, Math.floor((absoluteX - ROW_HEADER_WIDTH) / COLUMN_WIDTH))),
        mode: "columns",
      };
    }
    if (absoluteX < ROW_HEADER_WIDTH) {
      return {
        row: Math.min(rowCount - 1, Math.max(0, Math.floor((absoluteY - COLUMN_HEADER_HEIGHT) / ROW_HEIGHT))),
        column: 0,
        mode: "rows",
      };
    }
    return {
      row: Math.min(rowCount - 1, Math.floor((absoluteY - COLUMN_HEADER_HEIGHT) / ROW_HEIGHT)),
      column: Math.min(columnCount - 1, Math.floor((absoluteX - ROW_HEADER_WIDTH) / COLUMN_WIDTH)),
      mode: "cells",
    };
  };

  const rangeForTarget = (target: GridTarget, extend: boolean): SelectionRange => {
    const anchor = extend ? selection.anchor : { row: target.row, column: target.column };
    if (target.mode === "rows") {
      return { anchor: { row: anchor.row, column: 0 }, focus: { row: target.row, column: Math.max(0, summary.columnCount - 1) }, mode: "rows" };
    }
    if (target.mode === "columns") {
      return { anchor: { row: 0, column: anchor.column }, focus: { row: Math.max(0, summary.visibleRowCount - 1), column: target.column }, mode: "columns" };
    }
    return { anchor, focus: { row: target.row, column: target.column }, mode: "cells" };
  };

  const sourceRowForView = async (viewRow: number): Promise<number | null> => {
    const cached = cachedRow(viewRow);
    if (cached) return cached.sourceRow;
    const data = await getGridWindow(viewRow, 1, 0, 1);
    if (data.rows[0]) return data.rows[0].sourceRow;
    if (!summary.filtersActive && summary.sortCount === 0) {
      return viewRow + Number(summary.headerEnabled);
    }
    return null;
  };

  const beginEditing = async (target: GridTarget) => {
    if (target.mode === "columns" && summary.headerEnabled) {
      setDraft(summary.headerValues[target.column] ?? "");
      setEditing({ viewRow: -1, sourceRow: 0, column: target.column, header: true });
      return;
    }
    if (target.mode !== "cells") return;
    const sourceRow = await sourceRowForView(target.row);
    if (sourceRow === null) return;
    publishSelection(rangeForTarget(target, false));
    setDraft(getCell(target.row, target.column));
    setEditing({ viewRow: target.row, sourceRow, column: target.column, header: false });
  };

  const commitEdit = async () => {
    const target = editing;
    if (!target) return;
    setEditing(null);
    await onApplyEdit({ kind: "setCells", cells: [{ row: target.sourceRow, column: target.column, value: draft }] });
    viewportRef.current?.focus();
  };

  const fetchSelectionMatrix = async (): Promise<{ matrix: string[][]; sourceRows: number[] }> => {
    const range = normalizeSelection(selection);
    const rowAmount = range.endRow - range.startRow + 1;
    const columnAmount = range.endColumn - range.startColumn + 1;
    const matrix: string[][] = [];
    const sourceRows: number[] = [];
    for (let offset = 0; offset < rowAmount; offset += 400) {
      const data = await getGridWindow(range.startRow + offset, Math.min(400, rowAmount - offset), range.startColumn, columnAmount);
      for (const row of data.rows) {
        matrix.push(row.cells);
        sourceRows.push(row.sourceRow);
      }
    }
    return { matrix, sourceRows };
  };

  const copySelection = async () => {
    const { matrix } = await fetchSelectionMatrix();
    await writeClipboard(encodeClipboardMatrix(matrix));
  };

  const clearSelection = async () => {
    const range = normalizeSelection(selection);
    const { sourceRows } = await fetchSelectionMatrix();
    const cells = sourceRows.flatMap((row) => (
      Array.from({ length: range.endColumn - range.startColumn + 1 }, (_, offset) => ({
        row,
        column: range.startColumn + offset,
        value: "",
      }))
    ));
    if (cells.length) await onApplyEdit({ kind: "setCells", cells });
  };

  const cutSelection = async () => {
    await copySelection();
    await clearSelection();
  };

  const pasteSelection = async () => {
    if (!navigator.clipboard?.readText) throw new Error("Clipboard reading is unavailable.");
    const text = await navigator.clipboard.readText();
    const matrix = parseClipboardMatrix(text);
    if (!matrix.length) return;
    const range = normalizeSelection(selection);
    const scalarFill = matrix.length === 1 && matrix[0].length === 1;
    const rowAmount = scalarFill ? range.endRow - range.startRow + 1 : matrix.length;
    const columnAmount = scalarFill ? range.endColumn - range.startColumn + 1 : Math.max(...matrix.map((row) => row.length));
    const cells = [];
    for (let rowOffset = 0; rowOffset < rowAmount; rowOffset += 1) {
      const sourceRow = await sourceRowForView(range.startRow + rowOffset);
      if (sourceRow === null) continue;
      for (let columnOffset = 0; columnOffset < columnAmount; columnOffset += 1) {
        cells.push({
          row: sourceRow,
          column: range.startColumn + columnOffset,
          value: scalarFill ? matrix[0][0] : matrix[rowOffset]?.[columnOffset] ?? "",
        });
      }
    }
    if (cells.length) await onApplyEdit({ kind: "setCells", cells });
  };

  useEffect(() => {
    const handleCommand = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      const operation = command === "copy" ? copySelection : command === "cut" ? cutSelection : pasteSelection;
      void operation().catch((reason) => onError(String(reason)));
    };
    document.addEventListener("tablune-grid-command", handleCommand);
    return () => document.removeEventListener("tablune-grid-command", handleCommand);
  });

  useEffect(() => {
    if (!reveal) return;
    const next = { row: Math.max(0, reveal.viewRow), column: reveal.column };
    publishSelection({ anchor: next, focus: next, mode: "cells" });
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollTo({
        top: Math.max(0, COLUMN_HEADER_HEIGHT + next.row * ROW_HEIGHT - viewport.clientHeight / 2),
        left: Math.max(0, ROW_HEADER_WIDTH + next.column * COLUMN_WIDTH - viewport.clientWidth / 2),
        behavior: "smooth",
      });
      window.setTimeout(() => void loadVisibleWindow(), 180);
    }
  }, [loadVisibleWindow, publishSelection, reveal]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void copySelection().catch((reason) => onError(String(reason)));
      return;
    }
    if (modifier && event.key.toLowerCase() === "x") {
      event.preventDefault();
      void cutSelection().catch((reason) => onError(String(reason)));
      return;
    }
    if (modifier && event.key.toLowerCase() === "v") {
      event.preventDefault();
      void pasteSelection().catch((reason) => onError(String(reason)));
      return;
    }
    if (modifier && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAllStage.current = (selectAllStage.current + 1) % 2;
      publishSelection({
        anchor: { row: 0, column: 0 },
        focus: {
          row: Math.max(0, (selectAllStage.current ? summary.visibleRowCount : rowCount) - 1),
          column: Math.max(0, (selectAllStage.current ? summary.columnCount : columnCount) - 1),
        },
        mode: "cells",
      });
      return;
    }
    const next = { ...selection.focus };
    if (event.key === "ArrowUp") next.row = Math.max(0, next.row - 1);
    else if (event.key === "ArrowDown") next.row = Math.min(rowCount - 1, next.row + 1);
    else if (event.key === "ArrowLeft") next.column = Math.max(0, next.column - 1);
    else if (event.key === "ArrowRight" || event.key === "Tab") next.column = Math.min(columnCount - 1, next.column + 1);
    else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      void beginEditing({ ...selection.focus, mode: "cells" });
      return;
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      void clearSelection().catch((reason) => onError(String(reason)));
      return;
    } else if (event.key.length === 1 && !modifier && !event.altKey) {
      event.preventDefault();
      void sourceRowForView(selection.focus.row).then((sourceRow) => {
        if (sourceRow === null) return;
        setDraft(event.key);
        setEditing({ viewRow: selection.focus.row, sourceRow, column: selection.focus.column, header: false });
      });
      return;
    } else return;
    event.preventDefault();
    publishSelection({
      anchor: event.shiftKey ? selection.anchor : next,
      focus: next,
      mode: "cells",
    });
  };

  const runContextOperation = async (operation: "insertRow" | "deleteRow" | "insertColumn" | "deleteColumn") => {
    const range = normalizeSelection(selection);
    setContextMenu(null);
    if ((summary.filtersActive || summary.sortCount > 0) && operation.includes("Row")) {
      onError("Clear sorting and filters before changing whole rows.");
      return;
    }
    const headerOffset = Number(summary.headerEnabled);
    if (operation === "insertRow") await onApplyEdit({ kind: "insertRows", index: range.startRow + headerOffset, count: range.endRow - range.startRow + 1 });
    if (operation === "deleteRow") await onApplyEdit({ kind: "deleteRows", index: range.startRow + headerOffset, count: range.endRow - range.startRow + 1 });
    if (operation === "insertColumn") await onApplyEdit({ kind: "insertColumns", index: range.startColumn, count: range.endColumn - range.startColumn + 1 });
    if (operation === "deleteColumn") await onApplyEdit({ kind: "deleteColumns", index: range.startColumn, count: range.endColumn - range.startColumn + 1 });
  };

  return (
    <div
      ref={viewportRef}
      className="grid-viewport"
      tabIndex={0}
      onScroll={() => {
        draw();
        void loadVisibleWindow();
        setContextMenu(null);
      }}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        setContextMenu(null);
        const viewport = viewportRef.current;
        if (viewport) {
          const rect = viewport.getBoundingClientRect();
          const absoluteX = event.clientX - rect.left + viewport.scrollLeft;
          const absoluteY = event.clientY - rect.top + viewport.scrollTop;
          const withinColumn = (absoluteX - ROW_HEADER_WIDTH) % COLUMN_WIDTH;
          if (absoluteY < COLUMN_HEADER_HEIGHT && absoluteX >= ROW_HEADER_WIDTH && withinColumn >= COLUMN_WIDTH - 24) {
            onHeaderSort(Math.floor((absoluteX - ROW_HEADER_WIDTH) / COLUMN_WIDTH));
            return;
          }
        }
        const target = targetFromPointer(event);
        if (!target) return;
        dragAnchor.current = target;
        publishSelection(rangeForTarget(target, event.shiftKey));
      }}
      onMouseMove={(event) => {
        if (!dragAnchor.current || event.buttons !== 1) return;
        const target = targetFromPointer(event);
        if (!target) return;
        const anchor = dragAnchor.current;
        publishSelection(rangeForTarget({ ...target, mode: anchor.mode }, true));
      }}
      onMouseUp={() => { dragAnchor.current = null; }}
      onDoubleClick={(event) => {
        const target = targetFromPointer(event);
        if (target) void beginEditing(target);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        const target = targetFromPointer(event);
        if (target) publishSelection(rangeForTarget(target, false));
        const rect = event.currentTarget.getBoundingClientRect();
        setContextMenu({ x: event.clientX - rect.left + event.currentTarget.scrollLeft, y: event.clientY - rect.top + event.currentTarget.scrollTop });
      }}
    >
      <div style={{ width: totalWidth, height: totalHeight }} />
      <canvas ref={canvasRef} className="grid-canvas" aria-hidden="true" />
      {editing && (
        <input
          className="cell-editor"
          autoFocus
          value={draft}
          aria-label={editing.header ? "Edit column header" : "Edit cell"}
          style={{
            left: ROW_HEADER_WIDTH + editing.column * COLUMN_WIDTH + 1,
            top: editing.header ? 1 : COLUMN_HEADER_HEIGHT + editing.viewRow * ROW_HEIGHT + 1,
            width: COLUMN_WIDTH - 2,
            height: (editing.header ? COLUMN_HEADER_HEIGHT : ROW_HEIGHT) - 2,
          }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commitEdit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") void commitEdit();
            if (event.key === "Escape") {
              setEditing(null);
              viewportRef.current?.focus();
            }
          }}
        />
      )}
      {contextMenu && (
        <div className="grid-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu">
          <button onClick={() => void runContextOperation("insertRow")}>Insert row</button>
          <button onClick={() => void runContextOperation("deleteRow")}>Delete row</button>
          <span />
          <button onClick={() => void runContextOperation("insertColumn")}>Insert column</button>
          <button onClick={() => void runContextOperation("deleteColumn")}>Delete column</button>
        </div>
      )}
    </div>
  );
}
