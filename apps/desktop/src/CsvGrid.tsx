import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Selection } from "./types";

const ROW_HEIGHT = 28;
const COLUMN_WIDTH = 160;
const ROW_HEADER_WIDTH = 52;
const COLUMN_HEADER_HEIGHT = 32;
const MIN_ROWS = 100;
const MIN_COLUMNS = 26;

interface CsvGridProps {
  rows: string[][];
  onCellChange: (row: number, column: number, value: string) => void;
}

function columnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

export default function CsvGrid({ rows, onCellChange }: CsvGridProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selection, setSelection] = useState<Selection>({ row: 0, column: 0 });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const columnCount = Math.max(MIN_COLUMNS, ...rows.map((row) => row.length), 0);
  const rowCount = Math.max(MIN_ROWS, rows.length);
  const totalWidth = ROW_HEADER_WIDTH + columnCount * COLUMN_WIDTH;
  const totalHeight = COLUMN_HEADER_HEIGHT + rowCount * ROW_HEIGHT;

  const getCell = useCallback(
    (row: number, column: number) => rows[row]?.[column] ?? "",
    [rows],
  );

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
    const lastColumn = Math.min(
      columnCount - 1,
      Math.ceil((viewport.scrollLeft + width - ROW_HEADER_WIDTH) / COLUMN_WIDTH),
    );
    const firstRow = Math.max(0, Math.floor((viewport.scrollTop - COLUMN_HEADER_HEIGHT) / ROW_HEIGHT));
    const lastRow = Math.min(
      rowCount - 1,
      Math.ceil((viewport.scrollTop + height - COLUMN_HEADER_HEIGHT) / ROW_HEIGHT),
    );

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);

    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const x = ROW_HEADER_WIDTH + column * COLUMN_WIDTH - viewport.scrollLeft;
      context.fillStyle = column === selection.column ? "#e7f4ec" : "#f5f6f7";
      context.fillRect(x, 0, COLUMN_WIDTH, COLUMN_HEADER_HEIGHT);
      context.fillStyle = "#3b4148";
      context.textAlign = "center";
      context.fillText(columnName(column), x + COLUMN_WIDTH / 2, COLUMN_HEADER_HEIGHT / 2);
    }

    for (let row = firstRow; row <= lastRow; row += 1) {
      const y = COLUMN_HEADER_HEIGHT + row * ROW_HEIGHT - viewport.scrollTop;
      context.fillStyle = row === selection.row ? "#e7f4ec" : "#f7f8f9";
      context.fillRect(0, y, ROW_HEADER_WIDTH, ROW_HEIGHT);
      context.fillStyle = "#5a6169";
      context.textAlign = "center";
      context.fillText(String(row + 1), ROW_HEADER_WIDTH / 2, y + ROW_HEIGHT / 2);

      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const x = ROW_HEADER_WIDTH + column * COLUMN_WIDTH - viewport.scrollLeft;
        if (row === selection.row && column === selection.column) {
          context.fillStyle = "#eef8f2";
          context.fillRect(x, y, COLUMN_WIDTH, ROW_HEIGHT);
        }
        context.fillStyle = "#161a1f";
        context.textAlign = "left";
        const value = getCell(row, column);
        context.save();
        context.beginPath();
        context.rect(x + 6, y, COLUMN_WIDTH - 12, ROW_HEIGHT);
        context.clip();
        context.fillText(value, x + 8, y + ROW_HEIGHT / 2);
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

    const selectedX = ROW_HEADER_WIDTH + selection.column * COLUMN_WIDTH - viewport.scrollLeft;
    const selectedY = COLUMN_HEADER_HEIGHT + selection.row * ROW_HEIGHT - viewport.scrollTop;
    context.strokeStyle = "#0f8a50";
    context.lineWidth = 2;
    context.strokeRect(selectedX + 1, selectedY + 1, COLUMN_WIDTH - 2, ROW_HEIGHT - 2);
  }, [columnCount, getCell, rowCount, selection]);

  useLayoutEffect(() => {
    draw();
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(draw);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [draw]);

  const selectFromPointer = (event: MouseEvent<HTMLDivElement>): Selection | null => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    const rect = viewport.getBoundingClientRect();
    const x = event.clientX - rect.left + viewport.scrollLeft - ROW_HEADER_WIDTH;
    const y = event.clientY - rect.top + viewport.scrollTop - COLUMN_HEADER_HEIGHT;
    if (x < 0 || y < 0) return null;
    return {
      row: Math.min(rowCount - 1, Math.floor(y / ROW_HEIGHT)),
      column: Math.min(columnCount - 1, Math.floor(x / COLUMN_WIDTH)),
    };
  };

  const beginEditing = (target = selection) => {
    setSelection(target);
    setDraft(getCell(target.row, target.column));
    setEditing(true);
  };

  const commitEdit = () => {
    onCellChange(selection.row, selection.column, draft);
    setEditing(false);
    viewportRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const next = { ...selection };
    if (event.key === "ArrowUp") next.row = Math.max(0, next.row - 1);
    else if (event.key === "ArrowDown") next.row = Math.min(rowCount - 1, next.row + 1);
    else if (event.key === "ArrowLeft") next.column = Math.max(0, next.column - 1);
    else if (event.key === "ArrowRight" || event.key === "Tab") {
      next.column = Math.min(columnCount - 1, next.column + 1);
    } else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      beginEditing();
      return;
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onCellChange(selection.row, selection.column, "");
      return;
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      setDraft(event.key);
      setEditing(true);
      return;
    } else {
      return;
    }
    event.preventDefault();
    setSelection(next);
  };

  return (
    <div
      ref={viewportRef}
      className="grid-viewport"
      tabIndex={0}
      onScroll={draw}
      onKeyDown={handleKeyDown}
      onClick={(event) => {
        const target = selectFromPointer(event);
        if (target) setSelection(target);
      }}
      onDoubleClick={(event) => {
        const target = selectFromPointer(event);
        if (target) beginEditing(target);
      }}
    >
      <div style={{ width: totalWidth, height: totalHeight }} />
      <canvas ref={canvasRef} className="grid-canvas" aria-hidden="true" />
      {editing && (
        <input
          className="cell-editor"
          autoFocus
          value={draft}
          style={{
            left: ROW_HEADER_WIDTH + selection.column * COLUMN_WIDTH + 1,
            top: COLUMN_HEADER_HEIGHT + selection.row * ROW_HEIGHT + 1,
            width: COLUMN_WIDTH - 2,
            height: ROW_HEIGHT - 2,
          }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitEdit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitEdit();
            if (event.key === "Escape") {
              setEditing(false);
              viewportRef.current?.focus();
            }
          }}
        />
      )}
    </div>
  );
}
