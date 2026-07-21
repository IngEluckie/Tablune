import { invoke } from "@tauri-apps/api/core";
import type {
  ColumnProfile,
  ColumnType,
  CsvPayload,
  DocumentSummary,
  EditCommand,
  FacetPage,
  GridWindow,
  SearchMatch,
  SearchRequest,
  ViewState,
} from "./types";

export function readCsvDocument(path: string): Promise<CsvPayload> {
  return invoke<CsvPayload>("read_csv_document", { path });
}

export function writeCsvDocument(path: string, payload: CsvPayload): Promise<void> {
  return invoke<void>("write_csv_document", { path, payload });
}

export function renameCsvDocument(path: string, newName: string): Promise<string> {
  return invoke<string>("rename_csv_document", { path, newName });
}

export const getSessionSummary = () => invoke<DocumentSummary>("session_summary");
export const newSession = () => invoke<DocumentSummary>("session_new");
export const openSession = (path: string) => invoke<DocumentSummary>("session_open", { path });
export const saveSession = (path?: string | null) => invoke<DocumentSummary>("session_save", { path: path ?? null });
export const renameSession = (newName: string) => invoke<DocumentSummary>("session_rename", { newName });
export const getGridWindow = (rowStart: number, rowCount: number, columnStart: number, columnCount: number) =>
  invoke<GridWindow>("session_grid_window", { rowStart, rowCount, columnStart, columnCount });
export const applySessionEdit = (command: EditCommand, expectedRevision: number) =>
  invoke<DocumentSummary>("session_apply_edit", { command, expectedRevision });
export const undoSession = () => invoke<DocumentSummary>("session_undo");
export const redoSession = () => invoke<DocumentSummary>("session_redo");
export const setSessionView = (view: ViewState) => invoke<DocumentSummary>("session_set_view", { view });
export const setSessionHeader = (enabled: boolean) => invoke<DocumentSummary>("session_set_header", { enabled });
export const setSessionColumnType = (column: number, columnType: ColumnType) =>
  invoke<DocumentSummary>("session_set_column_type", { column, columnType });
export const searchSession = (request: SearchRequest) => invoke<SearchMatch[]>("session_search", { request });
export const replaceSession = (request: {
  search: SearchRequest;
  replacement: string;
  replaceAll: boolean;
  expectedRevision: number;
}) => invoke<DocumentSummary>("session_replace", { request });
export const getColumnProfile = (column: number) => invoke<ColumnProfile>("session_column_profile", { column });
export const getFacets = (column: number, query = "", offset = 0, limit = 100) =>
  invoke<FacetPage>("session_facets", { column, query, offset, limit });
export const exportSessionView = (path: string) => invoke<void>("session_export_view", { path });
export const writeSessionRecovery = () => invoke<void>("session_write_recovery");
export const recoveryAvailable = () => invoke<boolean>("session_recovery_available");
export const restoreRecovery = () => invoke<DocumentSummary>("session_restore_recovery");
export const discardRecovery = () => invoke<void>("session_discard_recovery");
