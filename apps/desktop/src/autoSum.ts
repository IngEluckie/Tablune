import type { CellCoordinate, CellInfo, CellRange, SelectionRange } from "./types";

export interface AutoSumProposal {
  range: CellRange;
  target: CellCoordinate;
  formula: string;
}

export function cellAddress(cell: CellCoordinate): string {
  let column = cell.column + 1;
  let name = "";
  while (column > 0) { column--; name = String.fromCharCode(65 + column % 26) + name; column = Math.floor(column / 26); }
  return `${name}${cell.row + 1}`;
}

export function parseCellAddress(text: string): CellCoordinate | null {
  const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(text.trim().toUpperCase());
  if (!match) return null;
  let column = 0;
  for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
  const row = Number(match[2]);
  return row <= 10_000_000 && column <= 100_000 ? { row: row - 1, column: column - 1 } : null;
}

export function rangeContains(range: CellRange, cell: CellCoordinate) {
  return cell.row >= range.startRow && cell.row <= range.endRow && cell.column >= range.startColumn && cell.column <= range.endColumn;
}

export function numericCell(info: CellInfo) {
  if (info.image || info.pending || info.error || info.escaped || (!info.formula && (info.cellType === "text" || info.cellType === "boolean"))) return false;
  const value = info.formula ? info.display : info.source;
  if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value)) return false;
  if (!info.formula && info.cellType !== "number" && /^[+-]?0[0-9]/.test(value)) return false;
  return !/[.eE]/.test(value) || Number.isFinite(Number(value));
}

export async function proposeAutoSum(selection: SelectionRange, read: (cell: CellCoordinate) => Promise<CellInfo>): Promise<AutoSumProposal> {
  if (selection.mode !== "cells") throw new Error("Selecciona un rango de celdas para usar Autosuma.");
  let range: CellRange = {
    startRow: Math.min(selection.anchor.row, selection.focus.row), endRow: Math.max(selection.anchor.row, selection.focus.row),
    startColumn: Math.min(selection.anchor.column, selection.focus.column), endColumn: Math.max(selection.anchor.column, selection.focus.column),
  };
  let target: CellCoordinate;
  if (range.startRow !== range.endRow || range.startColumn !== range.endColumn) {
    target = range.startRow === range.endRow ? { row: range.startRow, column: range.endColumn + 1 } : { row: range.endRow + 1, column: range.startColumn };
  } else {
    target = { ...selection.focus };
    const active = await read(target);
    if (numericCell(active)) {
      return { range, target: { row: target.row + 1, column: target.column }, formula: `=sum(cells("${cellAddress(target)}"))` };
    }
    if (active.source || active.image) throw new Error("Selecciona los números que quieres sumar o una celda vacía debajo o a su derecha.");
    let found = false;
    // Prefer the column above, then the row to the left. Never truncate a total.
    for (const axis of ["row", "column"] as const) {
      const first = { ...target, [axis]: target[axis] - 1 };
      let cursor = first[axis];
      let count = 0;
      while (cursor >= 0 && numericCell(await read({ ...target, [axis]: cursor }))) {
        if (++count > 10_000) throw new Error("El rango es muy largo para inferirlo. Selecciónalo explícitamente y vuelve a pulsar Autosuma.");
        cursor--;
      }
      if (count) {
        range = axis === "row" ? { startRow: cursor + 1, endRow: first.row, startColumn: target.column, endColumn: target.column }
          : { startRow: target.row, endRow: target.row, startColumn: cursor + 1, endColumn: first.column };
        found = true;
        break;
      }
    }
    if (!found) throw new Error("No encontré números contiguos arriba ni a la izquierda. Selecciona el rango que quieres sumar.");
  }
  const start = cellAddress({ row: range.startRow, column: range.startColumn });
  const end = cellAddress({ row: range.endRow, column: range.endColumn });
  return { range, target, formula: `=sum(cells("${start}:${end}"))` };
}
