export type LineEnding = "lf" | "crlf";

export interface CsvPayload {
  rows: string[][];
  delimiter: string;
  lineEnding: LineEnding;
}

export interface Selection {
  row: number;
  column: number;
}

export interface DocumentSummary {
  path: string | null;
  displayName: string;
  delimiter: string;
  lineEnding: LineEnding;
  revision: number;
  viewRevision: number;
  dirty: boolean;
  rowCount: number;
  columnCount: number;
  visibleRowCount: number;
  headerEnabled: boolean;
  headerSuggested: boolean;
  headerNames: string[];
  headerValues: string[];
  canUndo: boolean;
  canRedo: boolean;
  filtersActive: boolean;
  sortCount: number;
}

export interface GridRow {
  viewIndex: number;
  sourceRow: number;
  rowId: number;
  cells: string[];
}

export interface GridWindow {
  revision: number;
  viewRevision: number;
  rowStart: number;
  columnStart: number;
  rows: GridRow[];
}

export interface CellCoordinate {
  row: number;
  column: number;
}

export type SelectionMode = "cells" | "rows" | "columns";

export interface SelectionRange {
  anchor: CellCoordinate;
  focus: CellCoordinate;
  mode: SelectionMode;
}

export interface CellInput {
  row: number;
  column: number;
  value: string;
}

export type EditCommand =
  | { kind: "setCells"; cells: CellInput[] }
  | { kind: "insertRows"; index: number; count: number }
  | { kind: "deleteRows"; index: number; count: number }
  | { kind: "insertColumns"; index: number; count: number }
  | { kind: "deleteColumns"; index: number; count: number }
  | { kind: "setDelimiter"; delimiter: string }
  | { kind: "applySort" };

export type ColumnType = "text" | "number" | "date" | "boolean";
export type SortDirection = "ascending" | "descending";

export interface SortSpec {
  column: number;
  direction: SortDirection;
  columnType: ColumnType;
}

export interface FilterSpec {
  column: number;
  operator: "contains" | "equals" | "startsWith" | "endsWith" | "empty" | "notEmpty" | "values" | "greaterThan" | "lessThan" | "between";
  value: string;
  secondValue: string;
  values: string[];
  columnType: ColumnType;
  caseSensitive: boolean;
}

export interface ViewState {
  sorts: SortSpec[];
  filters: FilterSpec[];
}

export interface CellRange {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

export interface SearchRequest {
  query: string;
  caseSensitive: boolean;
  wholeCell: boolean;
  range: CellRange | null;
  limit: number;
}

export interface SearchMatch {
  sourceRow: number;
  viewRow: number | null;
  column: number;
  value: string;
}

export interface ColumnProfile {
  column: number;
  totalRows: number;
  visibleRows: number;
  emptyCount: number;
  uniqueCount: number;
  duplicateCount: number;
  invalidCount: number;
  min: string | null;
  max: string | null;
  minLength: number;
  maxLength: number;
  suggestedType: ColumnType;
  activeType: ColumnType;
  confidence: number;
  topValues: FacetValue[];
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface FacetPage {
  values: FacetValue[];
  totalDistinct: number;
  nextOffset: number | null;
}
