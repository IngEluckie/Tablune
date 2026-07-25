import { invoke } from "@tauri-apps/api/core";
import type {
  ColumnProfile,
  ColumnType,
  CsvPayload,
  DocumentId,
  DocumentSummary,
  EditCommand,
  FacetPage,
  GridWindow,
  MacroPreview,
  PythonStatus,
  SearchMatch,
  SearchRequest,
  ViewState,
  WorkspaceSummary,
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

export const getWorkspaceSummary = () => invoke<WorkspaceSummary>("workspace_summary");
export const reorderWorkspace = (documentIds: DocumentId[]) =>
  invoke<WorkspaceSummary>("workspace_reorder", { documentIds });
export const getSessionSummary = (documentId: DocumentId) => invoke<DocumentSummary>("session_summary", { documentId });
export const newSession = () => invoke<DocumentSummary>("session_new");
export const openSession = (path: string) => invoke<DocumentSummary>("session_open", { path });
export const closeSession = (documentId: DocumentId, discardUnsaved: boolean) =>
  invoke<WorkspaceSummary>("session_close", { documentId, discardUnsaved });
export const saveSession = (documentId: DocumentId, path?: string | null) =>
  invoke<DocumentSummary>("session_save", { documentId, path: path ?? null });
export const duplicateSession = (documentId: DocumentId) =>
  invoke<WorkspaceSummary>("session_duplicate", { documentId });
export const renameSession = (documentId: DocumentId, newName: string) =>
  invoke<DocumentSummary>("session_rename", { documentId, newName });
export const getGridWindow = (documentId: DocumentId, rowStart: number, rowCount: number, columnStart: number, columnCount: number) =>
  invoke<GridWindow>("session_grid_window", { documentId, rowStart, rowCount, columnStart, columnCount });
export const applySessionEdit = (documentId: DocumentId, command: EditCommand, expectedRevision: number) =>
  invoke<DocumentSummary>("session_apply_edit", { documentId, command, expectedRevision });
export const undoSession = (documentId: DocumentId) => invoke<DocumentSummary>("session_undo", { documentId });
export const redoSession = (documentId: DocumentId) => invoke<DocumentSummary>("session_redo", { documentId });
export const setSessionView = (documentId: DocumentId, view: ViewState) =>
  invoke<DocumentSummary>("session_set_view", { documentId, view });
export const setSessionHeader = (documentId: DocumentId, enabled: boolean) =>
  invoke<DocumentSummary>("session_set_header", { documentId, enabled });
export const setSessionColumnType = (documentId: DocumentId, column: number, columnType: ColumnType) =>
  invoke<DocumentSummary>("session_set_column_type", { documentId, column, columnType });
export const searchSession = (documentId: DocumentId, request: SearchRequest) =>
  invoke<SearchMatch[]>("session_search", { documentId, request });
export const replaceSession = (documentId: DocumentId, request: {
  search: SearchRequest;
  replacement: string;
  replaceAll: boolean;
  expectedRevision: number;
}) => invoke<DocumentSummary>("session_replace", { documentId, request });
export const getColumnProfile = (documentId: DocumentId, column: number) =>
  invoke<ColumnProfile>("session_column_profile", { documentId, column });
export const getFacets = (documentId: DocumentId, column: number, query = "", offset = 0, limit = 100) =>
  invoke<FacetPage>("session_facets", { documentId, column, query, offset, limit });
export const exportSessionView = (documentId: DocumentId, path: string) =>
  invoke<void>("session_export_view", { documentId, path });
export const writeWorkspaceRecovery = () => invoke<void>("workspace_write_recovery");
export const recoveryAvailable = () => invoke<boolean>("workspace_recovery_available");
export const restoreRecovery = () => invoke<WorkspaceSummary>("workspace_restore_recovery");
export const discardRecovery = () => invoke<void>("workspace_discard_recovery");
export const exitApplication = () => invoke<void>("exit_application");
export const getPythonStatus = () => invoke<PythonStatus>("python_status");
export const setPythonInterpreter = (path: string) =>
  invoke<PythonStatus>("python_set_interpreter", { path });
export const getPythonMacroFolder = () => invoke<string | null>("python_macro_folder");
export const setPythonMacroFolder = (path: string) =>
  invoke<string>("python_set_macro_folder", { path });
export const readMacroScript = (path: string) => invoke<string>("macro_read_script", { path });
export const writeMacroScript = (path: string, code: string) =>
  invoke<void>("macro_write_script", { path, code });
export const previewPythonMacro = (documentId: DocumentId, code: string, sourcePath: string | null, expectedRevision: number) =>
  invoke<MacroPreview>("python_preview_macro", { documentId, code, sourcePath, expectedRevision });
export const cancelPythonMacro = () => invoke<boolean>("python_cancel_macro");
export const applyPythonPreview = (documentId: DocumentId, previewId: string, expectedRevision: number) =>
  invoke<DocumentSummary>("python_apply_preview", { documentId, previewId, expectedRevision });
