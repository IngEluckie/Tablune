import { ask } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type {
  ColumnProfile,
  ColumnType,
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

export const getWorkspaceSummary = () =>
  invoke<WorkspaceSummary>("workspace_summary");
export const reorderWorkspace = (documentIds: DocumentId[]) =>
  invoke<WorkspaceSummary>("workspace_reorder", { documentIds });
export const getSessionSummary = (documentId: DocumentId) =>
  invoke<DocumentSummary>("session_summary", { documentId });
export const newSession = () => invoke<DocumentSummary>("session_new");
export const openSession = (path: string) =>
  invoke<DocumentSummary>("session_open", { path });
export const closeSession = (documentId: DocumentId, discardUnsaved: boolean) =>
  invoke<WorkspaceSummary>("session_close", { documentId, discardUnsaved });
export const saveSession = (documentId: DocumentId, path?: string | null) =>
  invoke<DocumentSummary>("session_save", { documentId, path: path ?? null });
export const duplicateSession = (documentId: DocumentId) =>
  invoke<WorkspaceSummary>("session_duplicate", { documentId });
export const renameSession = (documentId: DocumentId, newName: string) =>
  invoke<DocumentSummary>("session_rename", { documentId, newName });
export const getGridWindow = (
  documentId: DocumentId,
  rowStart: number,
  rowCount: number,
  columnStart: number,
  columnCount: number,
) =>
  invoke<GridWindow>("session_grid_window", {
    documentId,
    rowStart,
    rowCount,
    columnStart,
    columnCount,
  });
export const applySessionEdit = (
  documentId: DocumentId,
  command: EditCommand,
  expectedRevision: number,
) =>
  invoke<DocumentSummary>("session_apply_edit", {
    documentId,
    command,
    expectedRevision,
  });
export const undoSession = (documentId: DocumentId) =>
  invoke<DocumentSummary>("session_undo", { documentId });
export const redoSession = (documentId: DocumentId) =>
  invoke<DocumentSummary>("session_redo", { documentId });
export const setSessionView = (documentId: DocumentId, view: ViewState) =>
  invoke<DocumentSummary>("session_set_view", { documentId, view });
export const setSessionHeader = (documentId: DocumentId, enabled: boolean) =>
  invoke<DocumentSummary>("session_set_header", { documentId, enabled });
export const setSessionColumnType = (
  documentId: DocumentId,
  column: number,
  columnType: ColumnType,
) =>
  invoke<DocumentSummary>("session_set_column_type", {
    documentId,
    column,
    columnType,
  });
export const searchSession = (documentId: DocumentId, request: SearchRequest) =>
  invoke<SearchMatch[]>("session_search", { documentId, request });
export const replaceSession = (
  documentId: DocumentId,
  request: {
    search: SearchRequest;
    replacement: string;
    replaceAll: boolean;
    expectedRevision: number;
    target: { sourceRow: number; column: number } | null;
  },
) => invoke<DocumentSummary>("session_replace", { documentId, request });
export const getColumnProfile = (documentId: DocumentId, column: number) =>
  invoke<ColumnProfile>("session_column_profile", { documentId, column });
export const getFacets = (
  documentId: DocumentId,
  column: number,
  query = "",
  offset = 0,
  limit = 100,
) =>
  invoke<FacetPage>("session_facets", {
    documentId,
    column,
    query,
    offset,
    limit,
  });
export const exportSessionView = (documentId: DocumentId, path: string) =>
  exportWithImages("session_export_view", documentId, path);
export const writeWorkspaceRecovery = () =>
  invoke<void>("workspace_write_recovery");
export const recoveryAvailable = () =>
  invoke<boolean>("workspace_recovery_available");
export const restoreRecovery = () =>
  invoke<WorkspaceSummary>("workspace_restore_recovery");
export const discardRecovery = () => invoke<void>("workspace_discard_recovery");
export const exitApplication = () => invoke<void>("exit_application");
export const getPythonStatus = () => invoke<PythonStatus>("python_status");
export const setPythonInterpreter = (path: string) =>
  invoke<PythonStatus>("python_set_interpreter", { path });
export const getPythonMacroFolder = () =>
  invoke<string | null>("python_macro_folder");
export const setPythonMacroFolder = (path: string) =>
  invoke<string>("python_set_macro_folder", { path });
export const readMacroScript = (path: string) =>
  invoke<string>("macro_read_script", { path });
export const writeMacroScript = (path: string, code: string) =>
  invoke<void>("macro_write_script", { path, code });
export const previewPythonMacro = (
  documentId: DocumentId,
  code: string,
  sourcePath: string | null,
  expectedRevision: number,
) =>
  invoke<MacroPreview>("python_preview_macro", {
    documentId,
    code,
    sourcePath,
    expectedRevision,
  });
export const cancelPythonMacro = () => invoke<boolean>("python_cancel_macro");
export const applyPythonPreview = (
  documentId: DocumentId,
  previewId: string,
  expectedRevision: number,
) =>
  invoke<DocumentSummary>("python_apply_preview", {
    documentId,
    previewId,
    expectedRevision,
  });

export const newProject = (
  name: string,
  sourceDocumentId: number | null = null,
) =>
  invoke<import("./types").ProjectSummary>("project_new", {
    name,
    sourceDocumentId,
  });
export const openProject = (path: string) =>
  invoke<import("./types").ProjectSummary>("project_open", { path });
export const saveProject = (projectId: number, path: string) =>
  invoke<import("./types").ProjectSummary>("project_save", { projectId, path });
export const projectAction = (
  projectId: number,
  action: import("./types").ProjectAction,
) =>
  invoke<import("./types").ProjectSummary>("project_action", {
    projectId,
    action,
  });
export const closeProject = (projectId: number, discardUnsaved: boolean) =>
  invoke<void>("project_close", { projectId, discardUnsaved });
export const exportProjectTable = (documentId: number, path: string) =>
  exportWithImages("project_export_table", documentId, path);
export const getRecentFiles = () =>
  invoke<import("./types").RecentFile[]>("recent_files");
export const removeRecentFile = (path: string) =>
  invoke<void>("recent_remove", { path });
export const previewProjectScript = (projectId: number, scriptId: string) =>
  invoke<MacroPreview>("project_python_preview", { projectId, scriptId });
export const createProjectResult = (
  projectId: number,
  scriptId: string,
  previewId: string,
) =>
  invoke<import("./types").ProjectSummary>("project_python_result", {
    projectId,
    scriptId,
    previewId,
  });

export const getSheetCell = (documentId: number, row: number, column: number) =>
  invoke<import("./types").CellInfo>("sheet_cell", { documentId, row, column });
export const shiftSheetFormulas = (
  cells: { source: string; rowDelta: number; columnDelta: number }[],
) => invoke<string[]>("sheet_shift_formulas", { cells });
export const enableCalculation = (projectId: number) =>
  invoke<import("./types").ProjectSummary>("project_enable_calculation", {
    projectId,
  });
export const recalculateProject = (projectId: number, force = false) =>
  invoke<import("./types").ProjectSummary>("project_recalculate", {
    projectId,
    force,
  });
export const applyFunctions = (projectId: number, expectedRevision: number) =>
  invoke<import("./types").ProjectSummary>("project_apply_functions", {
    projectId,
    expectedRevision,
  });
export const cancelCalculation = (projectId: number) =>
  invoke<import("./types").ProjectSummary>("project_cancel_calculation", {
    projectId,
  });
export const clipboardGeneration = () =>
  invoke<number | null>("clipboard_generation");
export const readNativeClipboard = () =>
  invoke<string | null>("clipboard_read_text");
export const writeNativeClipboard = (text: string) =>
  invoke<boolean>("clipboard_write_text", { text });

export const importCellImage = (documentId: number, path: string) =>
  invoke<import("./types").CellImage>("image_import", { documentId, path });
export const readCellImage = (documentId: number, assetId: string, thumbnail: boolean) =>
  invoke<ArrayBuffer | number[]>("image_read", { documentId, assetId, thumbnail });
export const copyImageAssets = (documentId: number, assetIds: string[]) =>
  invoke<void>("image_clipboard_copy", { documentId, assetIds });
export const pasteImageAssets = (documentId: number, assetIds: string[]) =>
  invoke<void>("image_clipboard_paste", { documentId, assetIds });

async function exportWithImages(command: string, documentId: number, path: string) {
  const summary = await getSessionSummary(documentId);
  const hasImages = (summary.imageCount ?? 0) > 0;
  if (hasImages && !await ask("CSV cannot contain images. Export their file names as text? The images will remain in your project.", { title: "Export CSV", kind: "warning" })) return;
  await invoke<void>(command, { documentId, path, allowImages: hasImages });
}
