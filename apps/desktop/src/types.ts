export type LineEnding = "lf" | "crlf";
export type DocumentId = number;

export interface Selection {
  row: number;
  column: number;
}

export interface DocumentSummary {
  styledRowCount?: number;
  styledColumnCount?: number;
  imageCount?: number;
  imageRows?: number[];
  calculationRevision?: number;
  formulaCount?: number;
  pendingCells?: number;
  projectId?: number | null;
  view?: ViewState;
  documentId: DocumentId;
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

export interface WorkspaceSummary {
  markdown?: MarkdownDocument[];
  projects?: ProjectSummary[];
  documents: DocumentSummary[];
}

export interface GridRow {
  viewIndex: number;
  sourceRow: number;
  rowId: number;
  cells: string[];
  inputs?: CellInfo[] | null;
}

export interface GridWindow {
  documentId: DocumentId;
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

export interface GridViewportState {
  scrollTop: number;
  scrollLeft: number;
}

export interface GridSizingState {
  columnWidths: Record<number, number>;
  rowHeights: Record<number, number>;
}

export interface CellInput {
  row: number;
  column: number;
  value: string;
}

export type EditCommand =
  | { kind: "formatCells"; range: CellRange; patch: StylePatch }
  | { kind: "setSheetCells"; cells: SheetCellInput[] }
  | { kind: "setCellTypes"; cells: CellCoordinate[]; cellType: CellType }
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
  operator:
    | "contains"
    | "equals"
    | "startsWith"
    | "endsWith"
    | "empty"
    | "notEmpty"
    | "values"
    | "greaterThan"
    | "lessThan"
    | "between";
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
  viewRange: CellRange | null;
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

export interface PythonStatus {
  path: string | null;
  version: string | null;
  available: boolean;
  error: string | null;
}

export interface MacroChangeSample {
  row: number;
  column: number;
  before: string | null;
  after: string | null;
}

export interface MacroPreview {
  id: string;
  baseRevision: number;
  baseCalculationRevision?: number;
  rowsBefore: number;
  rowsAfter: number;
  columnsBefore: number;
  columnsAfter: number;
  changedCells: number;
  headerChanged: boolean;
  estimatedUndoBytes: number;
  canApply: boolean;
  blockedReason: string | null;
  stdout: string;
  stderr: string;
  samples: MacroChangeSample[];
}

export interface ScriptSummary {
  id: string;
  name: string;
  code: string;
  revision: number;
  inputTableId: string | null;
}
export interface ProjectTableSummary {
  id: string;
  document: DocumentSummary;
}
export interface ProjectSummary {
  organization?: ProjectOrganization;
  markdown?: MarkdownDocument[];
  functions?: FunctionsData;
  calculation?: CalculationSummary;
  projectId: number;
  persistentId: string;
  name: string;
  path: string | null;
  dirty: boolean;
  revision: string;
  tables: ProjectTableSummary[];
  scripts: ScriptSummary[];
}
export interface ProjectFolder { id: string; name: string; parentId: string | null; }
export interface ProjectOrganization { folders: ProjectFolder[]; itemFolders: Record<string, string>; }
export interface RecentFile {
  path: string;
  kind: "csv" | "project" | "markdown";
}
export type ProjectAction =
  | { kind: "createFolder"; name: string; parentId: string | null }
  | { kind: "renameFolder"; folderId: string; name: string }
  | { kind: "moveItem"; itemId: string; folderId: string | null }
  | { kind: "removeFolder"; folderId: string }
  | { kind: "newDocument"; name: string; folderId?: string | null }
  | { kind: "importDocument"; path: string; folderId?: string | null }
  | { kind: "updateFunctions"; code: string; expectedRevision: number }
  | { kind: "newTable" | "newScript"; folderId?: string | null }
  | { kind: "importTable"; path: string; folderId?: string | null }
  | { kind: "renameTable"; tableId: string; name: string }
  | { kind: "duplicateTable" | "deleteTable"; tableId: string }
  | { kind: "importScript"; name: string; code: string; folderId?: string | null }
  | {
      kind: "updateScript";
      scriptId: string;
      name: string;
      code: string;
      inputTableId: string | null;
      expectedRevision: number;
    }
  | { kind: "deleteScript"; scriptId: string };

export type CellType = "auto" | "text" | "number" | "boolean";
export interface CellImage { assetId: string; name: string; alt: string; }
export interface CellInfo {
  style?: CellStyle;
  image?: CellImage | null;
  row: number;
  column: number;
  source: string;
  display: string;
  formula: boolean;
  escaped?: boolean;
  cellType: CellType;
  pending: boolean;
  error: { code: string; message: string } | null;
}
export interface SheetCellInput {
  style?: CellStyle;
  image?: CellImage | null;
  row: number;
  column: number;
  value: string;
  literal?: boolean;
  cellType?: CellType;
}
export interface FunctionsData {
  draft: string;
  applied: string;
  revision: number;
  draftRevision: number;
}
export interface CalculationSummary {
  running: boolean;
  paused: boolean;
  error: string | null;
}

export interface MarkdownDocument {
  id: string;
  name: string;
  content: string;
  revision: number;
  path: string | null;
  dirty: boolean;
  images: Record<string, string>;
}
export type MarkdownAction =
  | { kind: "new"; name: string }
  | { kind: "open" | "save"; path: string }
  | { kind: "update"; content: string; expectedRevision: number }
  | { kind: "rename"; name: string }
  | { kind: "delete"; discard: boolean }
  | { kind: "copyToProject"; targetProjectId: number };

export interface CellRange { startRow: number; endRow: number; startColumn: number; endColumn: number; }
export interface CellBorder { color: string; width: 1 | 2 | 3; line: "solid" | "dashed"; }
export interface CellStyle {
  bold?: boolean; italic?: boolean; underline?: boolean;
  textColor?: string; background?: string; alignment?: "left" | "center" | "right";
  top?: CellBorder | null; right?: CellBorder | null; bottom?: CellBorder | null; left?: CellBorder | null;
}
export interface StylePatch {
  reset?: boolean; bold?: boolean; italic?: boolean; underline?: boolean;
  textColor?: string; background?: string; alignment?: "left" | "center" | "right";
  borders?: { preset: "all" | "outer" | "inner" | "top" | "right" | "bottom" | "left" | "none"; border: CellBorder | null };
}
export interface StyleSummary { bold: boolean | null; italic: boolean | null; underline: boolean | null; textColor: string | null; background: string | null; alignment: "left" | "center" | "right" | null; }
