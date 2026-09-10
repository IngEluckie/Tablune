import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createAxisMetrics,
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_ROW_HEIGHT,
  MAX_COLUMN_WIDTH,
  MAX_ROW_HEIGHT,
  MIN_COLUMN_WIDTH,
  MIN_ROW_HEIGHT,
  clampGridSize,
  withSizeOverride,
  type AxisMetrics,
} from "./gridSizing";
import { getGridWindow } from "./ipc";
import { GRID_PALETTES, type ThemeMode } from "./theme";
import type {
  CellCoordinate,
  DocumentSummary,
  EditCommand,
  GridSizingState,
  GridViewportState,
  GridWindow,
  SelectionMode,
  SelectionRange,
} from "./types";

const ROW_HEADER_WIDTH = 52;
const COLUMN_HEADER_HEIGHT = 32;
const MIN_ROWS = 100;
const MIN_COLUMNS = 26;
const WINDOW_OVERSCAN = 12;
const RESIZE_HIT_RADIUS = 5;
const SELECTION_ROW_CHUNK = 400;
export const GRID_WINDOW_COLUMN_LIMIT = 200;

interface CsvGridProps {
  summary: DocumentSummary;
  theme: ThemeMode;
  readOnly?: boolean;
  onApplyEdit: (command: EditCommand) => Promise<void>;
  onSelectionChange: (selection: SelectionRange) => void;
  onError: (message: string) => void;
  initialSelection?: SelectionRange;
  initialViewport?: GridViewportState;
  onViewportChange?: (viewport: GridViewportState) => void;
  initialSizing?: GridSizingState;
  onSizingChange?: (sizing: GridSizingState) => void;
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

interface ResizeTarget {
  axis: "column" | "row";
  index: number;
}

interface ResizeState extends ResizeTarget {
  pointerId: number;
  startClientPosition: number;
  startSize: number;
  currentSize: number;
}

const EMPTY_SIZING: GridSizingState = { columnWidths: {}, rowHeights: {} };

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

type GridWindowLoader = (
  documentId: number,
  rowStart: number,
  rowCount: number,
  columnStart: number,
  columnCount: number,
) => Promise<GridWindow>;

export async function fetchGridSelectionMatrix(
  documentId: number,
  range: ReturnType<typeof normalizeSelection>,
  loadWindow: GridWindowLoader = getGridWindow,
): Promise<{ matrix: string[][]; sourceRows: number[] }> {
  const rowAmount = range.endRow - range.startRow + 1;
  const columnAmount = range.endColumn - range.startColumn + 1;
  const matrix: string[][] = [];
  const sourceRows: number[] = [];
  let expectedRevision: number | null = null;
  let expectedViewRevision: number | null = null;

  for (let rowOffset = 0; rowOffset < rowAmount; rowOffset += SELECTION_ROW_CHUNK) {
    const chunkMatrix: string[][] = [];
    const chunkSourceRows: number[] = [];
    for (let columnOffset = 0; columnOffset < columnAmount; columnOffset += GRID_WINDOW_COLUMN_LIMIT) {
      const data = await loadWindow(
        documentId,
        range.startRow + rowOffset,
        Math.min(SELECTION_ROW_CHUNK, rowAmount - rowOffset),
        range.startColumn + columnOffset,
        Math.min(GRID_WINDOW_COLUMN_LIMIT, columnAmount - columnOffset),
      );
      if (data.documentId !== documentId) {
        throw new Error("The document changed while reading the selection.");
      }
      if (expectedRevision === null) {
        expectedRevision = data.revision;
        expectedViewRevision = data.viewRevision;
      } else if (data.revision !== expectedRevision || data.viewRevision !== expectedViewRevision) {
        throw new Error("The document view changed while reading the selection.");
      }
      if (columnOffset === 0) {
        for (const row of data.rows) {
          chunkMatrix.push([...row.cells]);
          chunkSourceRows.push(row.sourceRow);
        }
      } else {
        if (data.rows.length !== chunkMatrix.length
          || data.rows.some((row, index) => row.sourceRow !== chunkSourceRows[index])) {
          throw new Error("The document view changed while reading the selection.");
        }
        for (let index = 0; index < data.rows.length; index += 1) {
          chunkMatrix[index].push(...data.rows[index].cells);
        }
      }
    }
    matrix.push(...chunkMatrix);
    sourceRows.push(...chunkSourceRows);
  }
  return { matrix, sourceRows };
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

const DEFAULT_SELECTION: SelectionRange = {
  anchor: { row: 0, column: 0 },
  focus: { row: 0, column: 0 },
  mode: "cells",
};

export default function CsvGrid({
  summary,
  theme,
  readOnly = false,
  onApplyEdit,
  onSelectionChange,
  onError,
  initialSelection = DEFAULT_SELECTION,
  initialViewport = { scrollTop: 0, scrollLeft: 0 },
  onViewportChange,
  initialSizing = EMPTY_SIZING,
  onSizingChange,
  reveal,
  onHeaderSort,
}: CsvGridProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragAnchor = useRef<GridTarget | null>(null);
  const requestId = useRef(0);
  const viewportFrame = useRef<number | null>(null);
  const selectAllStage = useRef(0);
  const [windowData, setWindowData] = useState<GridWindow | null>(null);
  const [selection, setSelection] = useState<SelectionRange>(initialSelection);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [draft, setDraft] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const [resizeHover, setResizeHover] = useState<ResizeTarget["axis"] | null>(null);

  const columnCount = Math.max(MIN_COLUMNS, summary.columnCount);
  const rowCount = Math.max(MIN_ROWS, summary.visibleRowCount || 1);
  const activeSizing = useMemo<GridSizingState>(() => {
    if (!resizeState) return initialSizing;
    if (resizeState.axis === "column") {
      return {
        ...initialSizing,
        columnWidths: withSizeOverride(
          initialSizing.columnWidths,
          resizeState.index,
          resizeState.currentSize,
          DEFAULT_COLUMN_WIDTH,
        ),
      };
    }
    return {
      ...initialSizing,
      rowHeights: withSizeOverride(
        initialSizing.rowHeights,
        resizeState.index,
        resizeState.currentSize,
        DEFAULT_ROW_HEIGHT,
      ),
    };
  }, [initialSizing, resizeState]);
  const columnMetrics = useMemo(
    () => createAxisMetrics(columnCount, DEFAULT_COLUMN_WIDTH, activeSizing.columnWidths),
    [activeSizing.columnWidths, columnCount],
  );
  const rowMetrics = useMemo(
    () => createAxisMetrics(rowCount, DEFAULT_ROW_HEIGHT, activeSizing.rowHeights),
    [activeSizing.rowHeights, rowCount],
  );
  const totalWidth = ROW_HEADER_WIDTH + columnMetrics.totalSize;
  const totalHeight = COLUMN_HEADER_HEIGHT + rowMetrics.totalSize;

  const publishSelection = useCallback((next: SelectionRange) => {
    setSelection(next);
    onSelectionChange(next);
  }, [onSelectionChange]);

  const loadVisibleWindow = useCallback(async () => {
    const viewport = viewportRef.current;
    if (!viewport || resizeState) return;
    const visibleFirstRow = rowMetrics.indexAt(viewport.scrollTop - COLUMN_HEADER_HEIGHT);
    const visibleLastRow = rowMetrics.indexAt(viewport.scrollTop + viewport.clientHeight - COLUMN_HEADER_HEIGHT);
    const firstRow = Math.max(0, visibleFirstRow - WINDOW_OVERSCAN);
    const rowAmount = Math.min(rowCount - firstRow, visibleLastRow - firstRow + 1 + WINDOW_OVERSCAN);
    const visibleFirstColumn = columnMetrics.indexAt(viewport.scrollLeft - ROW_HEADER_WIDTH);
    const visibleLastColumn = columnMetrics.indexAt(viewport.scrollLeft + viewport.clientWidth - ROW_HEADER_WIDTH);
    const firstColumn = Math.max(0, visibleFirstColumn - 2);
    const columnAmount = Math.min(columnCount - firstColumn, visibleLastColumn - firstColumn + 4);
    const currentRequest = ++requestId.current;
    try {
      const data = await getGridWindow(summary.documentId, firstRow, rowAmount, firstColumn, columnAmount);
      if (currentRequest === requestId.current && data.documentId === summary.documentId) setWindowData(data);
    } catch (reason) {
      onError(String(reason));
    }
  }, [columnCount, columnMetrics, onError, resizeState, rowCount, rowMetrics, summary.documentId]);

  useEffect(() => {
    requestId.current += 1;
    setWindowData(null);
    setEditing(null);
    setContextMenu(null);
    setSelection(initialSelection);
  }, [initialSelection, summary.documentId]);

  useEffect(() => {
    if (readOnly) {
      setEditing(null);
      setContextMenu(null);
    }
  }, [readOnly]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = initialViewport.scrollTop;
    viewport.scrollLeft = initialViewport.scrollLeft;
    draw();
    void loadVisibleWindow();
  // Initial values belong to the mounted document. Subsequent scroll updates are reported upward.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary.documentId]);

  useEffect(() => () => {
    if (viewportFrame.current !== null) window.cancelAnimationFrame(viewportFrame.current);
  }, []);

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
    const firstColumn = columnMetrics.indexAt(viewport.scrollLeft - ROW_HEADER_WIDTH);
    const lastColumn = columnMetrics.indexAt(viewport.scrollLeft + width - ROW_HEADER_WIDTH);
    const firstRow = rowMetrics.indexAt(viewport.scrollTop - COLUMN_HEADER_HEIGHT);
    const lastRow = rowMetrics.indexAt(viewport.scrollTop + height - COLUMN_HEADER_HEIGHT);
    const range = normalizeSelection(selection);
    const palette = GRID_PALETTES[theme];
    context.fillStyle = palette.background;
    context.fillRect(0, 0, width, height);

    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const columnWidth = columnMetrics.sizeAt(column);
      const x = ROW_HEADER_WIDTH + columnMetrics.offsetAt(column) - viewport.scrollLeft;
      const selected = selection.mode === "columns" && column >= range.startColumn && column <= range.endColumn;
      context.fillStyle = selected || column === selection.focus.column ? palette.activeHeader : palette.header;
      context.fillRect(x, 0, columnWidth, COLUMN_HEADER_HEIGHT);
      context.fillStyle = palette.headerText;
      context.textAlign = "center";
      const label = summary.headerEnabled ? summary.headerNames[column] ?? columnName(column) : columnName(column);
      context.save();
      context.beginPath();
      context.rect(x + 4, 0, Math.max(0, columnWidth - 8), COLUMN_HEADER_HEIGHT);
      context.clip();
      context.fillText(label, x + columnWidth / 2, COLUMN_HEADER_HEIGHT / 2);
      if (column < summary.headerNames.length) {
        context.fillStyle = palette.headerIcon;
        context.textAlign = "right";
        context.fillText("↕", x + columnWidth - 9, COLUMN_HEADER_HEIGHT / 2);
      }
      context.restore();
    }

    for (let row = firstRow; row <= lastRow; row += 1) {
      const rowHeight = rowMetrics.sizeAt(row);
      const y = COLUMN_HEADER_HEIGHT + rowMetrics.offsetAt(row) - viewport.scrollTop;
      const rowSelected = selection.mode === "rows" && row >= range.startRow && row <= range.endRow;
      context.fillStyle = rowSelected || row === selection.focus.row ? palette.activeHeader : palette.header;
      context.fillRect(0, y, ROW_HEADER_WIDTH, rowHeight);
      context.fillStyle = palette.rowHeaderText;
      context.textAlign = "center";
      const sourceRow = cachedRow(row)?.sourceRow;
      context.fillText(String((sourceRow ?? row) + 1), ROW_HEADER_WIDTH / 2, y + rowHeight / 2);
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const columnWidth = columnMetrics.sizeAt(column);
        const x = ROW_HEADER_WIDTH + columnMetrics.offsetAt(column) - viewport.scrollLeft;
        const selected = row >= range.startRow && row <= range.endRow
          && column >= range.startColumn && column <= range.endColumn;
        if (selected) {
          context.fillStyle = palette.selectionFill;
          context.fillRect(x, y, columnWidth, rowHeight);
        }
        context.fillStyle = palette.cellText;
        context.textAlign = "left";
        context.save();
        context.beginPath();
        context.rect(x + 6, y, Math.max(0, columnWidth - 12), rowHeight);
        context.clip();
        context.fillText(getCell(row, column), x + 8, y + rowHeight / 2);
        context.restore();
      }
    }

    context.strokeStyle = palette.gridLine;
    context.lineWidth = 1;
    context.beginPath();
    for (let column = firstColumn; column <= lastColumn + 1; column += 1) {
      const x = ROW_HEADER_WIDTH + columnMetrics.offsetAt(column) - viewport.scrollLeft + 0.5;
      context.moveTo(x, 0);
      context.lineTo(x, height);
    }
    for (let row = firstRow; row <= lastRow + 1; row += 1) {
      const y = COLUMN_HEADER_HEIGHT + rowMetrics.offsetAt(row) - viewport.scrollTop + 0.5;
      context.moveTo(0, y);
      context.lineTo(width, y);
    }
    context.moveTo(ROW_HEADER_WIDTH + 0.5, 0);
    context.lineTo(ROW_HEADER_WIDTH + 0.5, height);
    context.moveTo(0, COLUMN_HEADER_HEIGHT + 0.5);
    context.lineTo(width, COLUMN_HEADER_HEIGHT + 0.5);
    context.stroke();

    const selectedX = ROW_HEADER_WIDTH + columnMetrics.offsetAt(range.startColumn) - viewport.scrollLeft;
    const selectedY = COLUMN_HEADER_HEIGHT + rowMetrics.offsetAt(range.startRow) - viewport.scrollTop;
    context.strokeStyle = palette.selectionStroke;
    context.lineWidth = 2;
    context.strokeRect(
      selectedX + 1,
      selectedY + 1,
      columnMetrics.rangeSize(range.startColumn, range.endColumn + 1) - 2,
      rowMetrics.rangeSize(range.startRow, range.endRow + 1) - 2,
    );
  }, [cachedRow, columnMetrics, getCell, rowMetrics, selection, summary.headerEnabled, summary.headerNames, theme]);

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

  const boundaryAt = (metrics: AxisMetrics, offset: number): number | null => {
    if (offset < 0 || offset > metrics.totalSize) return null;
    const index = metrics.indexAt(offset);
    if (index > 0 && Math.abs(offset - metrics.offsetAt(index)) <= RESIZE_HIT_RADIUS) return index - 1;
    if (Math.abs(offset - metrics.offsetAt(index + 1)) <= RESIZE_HIT_RADIUS) return index;
    return null;
  };

  const resizeTargetFromPointer = (event: { clientX: number; clientY: number }): ResizeTarget | null => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    const rect = viewport.getBoundingClientRect();
    const absoluteX = event.clientX - rect.left + viewport.scrollLeft;
    const absoluteY = event.clientY - rect.top + viewport.scrollTop;
    if (absoluteY < COLUMN_HEADER_HEIGHT && absoluteX >= ROW_HEADER_WIDTH) {
      const index = boundaryAt(columnMetrics, absoluteX - ROW_HEADER_WIDTH);
      if (index !== null) return { axis: "column", index };
    }
    if (absoluteX < ROW_HEADER_WIDTH && absoluteY >= COLUMN_HEADER_HEIGHT) {
      const index = boundaryAt(rowMetrics, absoluteY - COLUMN_HEADER_HEIGHT);
      if (index !== null) return { axis: "row", index };
    }
    return null;
  };

  const targetFromPointer = (event: { clientX: number; clientY: number }): GridTarget | null => {
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
        column: columnMetrics.indexAt(absoluteX - ROW_HEADER_WIDTH),
        mode: "columns",
      };
    }
    if (absoluteX < ROW_HEADER_WIDTH) {
      return {
        row: rowMetrics.indexAt(absoluteY - COLUMN_HEADER_HEIGHT),
        column: 0,
        mode: "rows",
      };
    }
    return {
      row: rowMetrics.indexAt(absoluteY - COLUMN_HEADER_HEIGHT),
      column: columnMetrics.indexAt(absoluteX - ROW_HEADER_WIDTH),
      mode: "cells",
    };
  };

  const publishSizing = (next: GridSizingState) => {
    onSizingChange?.(next);
  };

  const autoFit = (target: ResizeTarget) => {
    if (target.axis === "row") {
      publishSizing({
        ...initialSizing,
        rowHeights: withSizeOverride(initialSizing.rowHeights, target.index, DEFAULT_ROW_HEIGHT, DEFAULT_ROW_HEIGHT),
      });
      return;
    }
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (context) context.font = "13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    const label = summary.headerEnabled
      ? summary.headerNames[target.index] ?? columnName(target.index)
      : columnName(target.index);
    const values = [label];
    if (windowData
      && target.index >= windowData.columnStart
      && windowData.rows.some((row) => target.index - windowData.columnStart < row.cells.length)) {
      for (const row of windowData.rows) values.push(row.cells[target.index - windowData.columnStart] ?? "");
    }
    const measured = Math.max(...values.map((value) => context?.measureText?.(value).width ?? value.length * 7));
    const iconAllowance = target.index < summary.headerNames.length ? 28 : 0;
    const width = clampGridSize(measured + 16 + iconAllowance, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
    publishSizing({
      ...initialSizing,
      columnWidths: withSizeOverride(initialSizing.columnWidths, target.index, width, DEFAULT_COLUMN_WIDTH),
    });
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
    const data = await getGridWindow(summary.documentId, viewRow, 1, 0, 1);
    if (data.documentId !== summary.documentId) return null;
    if (data.rows[0]) return data.rows[0].sourceRow;
    if (!summary.filtersActive && summary.sortCount === 0) {
      return viewRow + Number(summary.headerEnabled);
    }
    return null;
  };

  const beginEditing = async (target: GridTarget) => {
    if (readOnly) return;
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
    if (readOnly) return;
    await onApplyEdit({ kind: "setCells", cells: [{ row: target.sourceRow, column: target.column, value: draft }] });
    viewportRef.current?.focus();
  };

  const fetchSelectionMatrix = async (): Promise<{ matrix: string[][]; sourceRows: number[] }> => {
    const range = normalizeSelection(selection);
    return fetchGridSelectionMatrix(summary.documentId, range);
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
      const detail = (event as CustomEvent<string | { command: string; documentId: number }>).detail;
      if (typeof detail !== "string" && detail.documentId !== summary.documentId) return;
      const command = typeof detail === "string" ? detail : detail.command;
      if (readOnly && command !== "copy") return;
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
        top: Math.max(0, COLUMN_HEADER_HEIGHT + rowMetrics.offsetAt(next.row) - viewport.clientHeight / 2),
        left: Math.max(0, ROW_HEADER_WIDTH + columnMetrics.offsetAt(next.column) - viewport.clientWidth / 2),
        behavior: "smooth",
      });
      window.setTimeout(() => void loadVisibleWindow(), 180);
    }
  }, [columnMetrics, loadVisibleWindow, publishSelection, reveal, rowMetrics]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void copySelection().catch((reason) => onError(String(reason)));
      return;
    }
    if (readOnly && (
      (modifier && ["x", "v"].includes(event.key.toLowerCase()))
      || ["Enter", "F2", "Delete", "Backspace"].includes(event.key)
      || (event.key.length === 1 && !modifier && !event.altKey)
    )) {
      event.preventDefault();
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
    if (readOnly) return;
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
      aria-readonly={readOnly}
      tabIndex={0}
      onScroll={() => {
        draw();
        void loadVisibleWindow();
        setContextMenu(null);
        if (onViewportChange && viewportFrame.current === null) {
          viewportFrame.current = window.requestAnimationFrame(() => {
            viewportFrame.current = null;
            const viewport = viewportRef.current;
            if (viewport) onViewportChange({ scrollTop: viewport.scrollTop, scrollLeft: viewport.scrollLeft });
          });
        }
      }}
      onKeyDown={handleKeyDown}
      style={{ cursor: resizeState?.axis === "column" || resizeHover === "column" ? "col-resize" : resizeState?.axis === "row" || resizeHover === "row" ? "row-resize" : undefined }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        setContextMenu(null);
        const resizeTarget = resizeTargetFromPointer(event);
        if (resizeTarget) {
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          const metrics = resizeTarget.axis === "column" ? columnMetrics : rowMetrics;
          const startClientPosition = resizeTarget.axis === "column" ? event.clientX : event.clientY;
          setResizeState({
            ...resizeTarget,
            pointerId: event.pointerId,
            startClientPosition,
            startSize: metrics.sizeAt(resizeTarget.index),
            currentSize: metrics.sizeAt(resizeTarget.index),
          });
          setResizeHover(resizeTarget.axis);
          return;
        }
        const viewport = viewportRef.current;
        if (viewport) {
          const rect = viewport.getBoundingClientRect();
          const absoluteX = event.clientX - rect.left + viewport.scrollLeft;
          const absoluteY = event.clientY - rect.top + viewport.scrollTop;
          const columnOffset = absoluteX - ROW_HEADER_WIDTH;
          const column = columnMetrics.indexAt(columnOffset);
          const withinColumn = columnOffset - columnMetrics.offsetAt(column);
          if (absoluteY < COLUMN_HEADER_HEIGHT
            && absoluteX >= ROW_HEADER_WIDTH
            && withinColumn >= columnMetrics.sizeAt(column) - 24) {
            if (!readOnly) onHeaderSort(column);
            return;
          }
        }
        const target = targetFromPointer(event);
        if (!target) return;
        dragAnchor.current = target;
        publishSelection(rangeForTarget(target, event.shiftKey));
      }}
      onPointerMove={(event) => {
        if (resizeState) {
          const clientPosition = resizeState.axis === "column" ? event.clientX : event.clientY;
          const minimum = resizeState.axis === "column" ? MIN_COLUMN_WIDTH : MIN_ROW_HEIGHT;
          const maximum = resizeState.axis === "column" ? MAX_COLUMN_WIDTH : MAX_ROW_HEIGHT;
          setResizeState({
            ...resizeState,
            currentSize: clampGridSize(
              resizeState.startSize + clientPosition - resizeState.startClientPosition,
              minimum,
              maximum,
            ),
          });
          return;
        }
        if (event.buttons !== 1) {
          setResizeHover(resizeTargetFromPointer(event)?.axis ?? null);
          return;
        }
        if (!dragAnchor.current || event.buttons !== 1) return;
        const target = targetFromPointer(event);
        if (!target) return;
        const anchor = dragAnchor.current;
        publishSelection(rangeForTarget({ ...target, mode: anchor.mode }, true));
      }}
      onPointerUp={(event) => {
        dragAnchor.current = null;
        if (!resizeState) return;
        if (event.currentTarget.hasPointerCapture?.(resizeState.pointerId)) {
          event.currentTarget.releasePointerCapture(resizeState.pointerId);
        }
        const next = resizeState.axis === "column"
          ? {
            ...initialSizing,
            columnWidths: withSizeOverride(
              initialSizing.columnWidths,
              resizeState.index,
              resizeState.currentSize,
              DEFAULT_COLUMN_WIDTH,
            ),
          }
          : {
            ...initialSizing,
            rowHeights: withSizeOverride(
              initialSizing.rowHeights,
              resizeState.index,
              resizeState.currentSize,
              DEFAULT_ROW_HEIGHT,
            ),
          };
        publishSizing(next);
        setResizeState(null);
        setResizeHover(resizeTargetFromPointer(event)?.axis ?? null);
      }}
      onPointerCancel={() => {
        dragAnchor.current = null;
        setResizeState(null);
        setResizeHover(null);
      }}
      onPointerLeave={() => { if (!resizeState) setResizeHover(null); }}
      onDoubleClick={(event) => {
        const resizeTarget = resizeTargetFromPointer(event);
        if (resizeTarget) {
          event.preventDefault();
          autoFit(resizeTarget);
          return;
        }
        const target = targetFromPointer(event);
        if (target && !readOnly) void beginEditing(target);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        const target = targetFromPointer(event);
        if (target) publishSelection(rangeForTarget(target, false));
        if (readOnly) {
          setContextMenu(null);
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        setContextMenu({ x: event.clientX - rect.left + event.currentTarget.scrollLeft, y: event.clientY - rect.top + event.currentTarget.scrollTop });
      }}
    >
      <div data-testid="grid-spacer" style={{ width: totalWidth, height: totalHeight }} />
      <canvas ref={canvasRef} className="grid-canvas" aria-hidden="true" />
      {editing && (
        <input
          className="cell-editor"
          autoFocus
          value={draft}
          aria-label={editing.header ? "Edit column header" : "Edit cell"}
          style={{
            left: ROW_HEADER_WIDTH + columnMetrics.offsetAt(editing.column) + 1,
            top: editing.header ? 1 : COLUMN_HEADER_HEIGHT + rowMetrics.offsetAt(editing.viewRow) + 1,
            width: columnMetrics.sizeAt(editing.column) - 2,
            height: (editing.header ? COLUMN_HEADER_HEIGHT : rowMetrics.sizeAt(editing.viewRow)) - 2,
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
