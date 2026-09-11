import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CsvGrid, { normalizeSelection } from "./CsvGrid";
import DocumentTabs from "./DocumentTabs";
import ExplorerPanel from "./ExplorerPanel";
import PythonMacroPanel from "./PythonMacroDialog";
import SearchBar from "./SearchBar";
import RibbonHeader, { type RibbonHeaderProps } from "./RibbonHeader";
import { createPortal } from "react-dom";
import UnsavedChangesDialog from "./UnsavedChangesDialog";
import {
  readThemePreference,
  writeThemePreference,
  type ThemeMode,
} from "./theme";
import {
  applySessionEdit,
  closeSession,
  discardRecovery,
  duplicateSession,
  exitApplication,
  exportSessionView,
  getSessionSummary,
  getWorkspaceSummary,
  newSession,
  openSession,
  recoveryAvailable,
  redoSession,
  renameSession,
  reorderWorkspace,
  restoreRecovery,
  saveSession,
  setSessionColumnType,
  setSessionHeader,
  setSessionView,
  undoSession,
  writeWorkspaceRecovery,
} from "./ipc";
import type {
  ColumnType,
  DocumentId,
  DocumentSummary,
  EditCommand,
  GridSizingState,
  GridViewportState,
  SearchMatch,
  SelectionRange,
  ViewState,
} from "./types";

const EMPTY_SUMMARY: DocumentSummary = {
  documentId: 0,
  path: null,
  displayName: "Untitled.csv",
  delimiter: ",",
  lineEnding: "lf",
  revision: 0,
  viewRevision: 0,
  dirty: false,
  rowCount: 0,
  columnCount: 0,
  visibleRowCount: 0,
  headerEnabled: false,
  headerSuggested: false,
  headerNames: [],
  headerValues: [],
  canUndo: false,
  canRedo: false,
  filtersActive: false,
  sortCount: 0,
};

const EMPTY_VIEW: ViewState = { sorts: [], filters: [] };
const EMPTY_SELECTION: SelectionRange = {
  anchor: { row: 0, column: 0 },
  focus: { row: 0, column: 0 },
  mode: "cells",
};
const EMPTY_VIEWPORT: GridViewportState = { scrollTop: 0, scrollLeft: 0 };

interface TabUiState {
  view: ViewState;
  selection: SelectionRange;
  viewport: GridViewportState;
  sizing: GridSizingState;
}

type UnsavedRequest =
  | { kind: "document"; documentId: DocumentId }
  | { kind: "application" };

function emptyTabUiState(): TabUiState {
  return {
    view: { sorts: [], filters: [] },
    selection: {
      anchor: { ...EMPTY_SELECTION.anchor },
      focus: { ...EMPTY_SELECTION.focus },
      mode: "cells",
    },
    viewport: { ...EMPTY_VIEWPORT },
    sizing: { columnWidths: {}, rowHeights: {} },
  };
}

function selectedPaths(value: string | string[] | null): string[] {
  if (typeof value === "string") return [value];
  return value ?? [];
}

function shortPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export interface CsvWorkspaceProps {
  managed?: boolean;
  appliedFunctions?: string;
  ribbonTarget?: HTMLElement | null;
  ribbonVisible?: boolean;
  ribbonControls?: Pick<RibbonHeaderProps, "navigation" | "fileActions">;
  theme?: ThemeMode;
  active?: boolean;
  documents?: DocumentSummary[];
  selectedId?: number;
  onDocuments?: (documents: DocumentSummary[]) => void;
  onActivate?: (id: number) => void;
  onOpen?: () => void;
  onTheme?: (theme: ThemeMode) => void;
  project?: {
    onNew: () => void;
    onImport: () => void;
    onSave: (saveAs: boolean) => Promise<boolean>;
    onRename: (id: number, name: string) => Promise<boolean>;
    onDuplicate: (id: number) => void;
    onCloseTab: (id: number) => void;
    onScript: () => void;
  };
}
export default function CsvWorkspace(props: CsvWorkspaceProps = {}) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<DocumentId>(0);
  const [tabUiStates, setTabUiStates] = useState<
    Record<DocumentId, TabUiState>
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [macroOpen, setMacroOpen] = useState(false);
  const [macroTrustAcknowledged, setMacroTrustAcknowledged] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(readThemePreference);
  const [reveal, setReveal] = useState<{
    viewRow: number;
    column: number;
    nonce: number;
  } | null>(null);
  const [unsavedRequest, setUnsavedRequest] = useState<UnsavedRequest | null>(
    null,
  );
  const [unsavedWorking, setUnsavedWorking] = useState(false);
  const [unsavedError, setUnsavedError] = useState<string | null>(null);
  const documentsRef = useRef<DocumentSummary[]>([]);
  const activeDocumentIdRef = useRef<DocumentId>(0);
  const closingInProgress = useRef(false);
  const lastRecovery = useRef(0);
  const restoreExplorerAfterMacro = useRef(false);

  const summary =
    documents.find((document) => document.documentId === activeDocumentId) ??
    EMPTY_SUMMARY;
  const tabUi = tabUiStates[activeDocumentId] ?? emptyTabUiState();
  const hasCustomSizing =
    Object.keys(tabUi.sizing.columnWidths).length > 0 ||
    Object.keys(tabUi.sizing.rowHeights).length > 0;
  const interactionsLocked =
    busy || macroOpen || unsavedRequest !== null || props.active === false;

  useEffect(() => {
    if (props.theme) setTheme(props.theme);
  }, [props.theme]);
  const commitDocuments = useCallback((next: DocumentSummary[]) => {
    documentsRef.current = next;
    setDocuments(next);
    propsRef.current.onDocuments?.(next);
    setTabUiStates((current) => {
      const updated = { ...current };
      for (const document of next)
        updated[document.documentId] ??= {
          ...emptyTabUiState(),
          view: document.view ?? EMPTY_VIEW,
        };
      return updated;
    });
  }, []);

  useEffect(() => {
    if (!props.managed || !props.documents) return;
    documentsRef.current = props.documents;
    setDocuments(props.documents);
    setTabUiStates((current) => {
      const updated = { ...current };
      for (const d of props.documents!)
        updated[d.documentId] ??= {
          ...emptyTabUiState(),
          view: d.view ?? EMPTY_VIEW,
        };
      return updated;
    });
    const id = props.selectedId ?? props.documents[0]?.documentId ?? 0;
    if (activeDocumentIdRef.current !== id) {
      activeDocumentIdRef.current = id;
      setActiveDocumentId(id);
      setSearchOpen(false);
      setExplorerOpen(false);
      setMacroOpen(false);
      setReveal(null);
    }
  }, [props.managed, props.documents, props.selectedId]);

  const updateDocument = useCallback(
    (next: DocumentSummary) => {
      const current = documentsRef.current;
      const index = current.findIndex(
        (document) => document.documentId === next.documentId,
      );
      if (index < 0) return;
      const updated = [...current];
      updated[index] = next;
      commitDocuments(updated);
    },
    [commitDocuments],
  );

  const registerDocument = useCallback(
    (next: DocumentSummary) => {
      const current = documentsRef.current;
      const index = current.findIndex(
        (document) => document.documentId === next.documentId,
      );
      if (index < 0) commitDocuments([...current, next]);
      else {
        const updated = [...current];
        updated[index] = next;
        commitDocuments(updated);
      }
    },
    [commitDocuments],
  );

  const updateTabUi = useCallback(
    (documentId: DocumentId, update: (current: TabUiState) => TabUiState) => {
      setTabUiStates((current) => ({
        ...current,
        [documentId]: update(current[documentId] ?? emptyTabUiState()),
      }));
    },
    [],
  );

  const clearSizing = useCallback(
    (documentId: DocumentId, axis: "rows" | "columns" | "both") => {
      updateTabUi(documentId, (current) => ({
        ...current,
        sizing: {
          columnWidths:
            axis === "columns" || axis === "both"
              ? {}
              : current.sizing.columnWidths,
          rowHeights:
            axis === "rows" || axis === "both" ? {} : current.sizing.rowHeights,
        },
      }));
    },
    [updateTabUi],
  );

  const runHistoryCommand = useCallback(
    async (
      documentId: DocumentId,
      command: typeof undoSession | typeof redoSession,
    ) => {
      try {
        updateDocument(await command(documentId));
        clearSizing(documentId, "both");
      } catch (reason) {
        if (activeDocumentIdRef.current === documentId)
          setError(String(reason));
      }
    },
    [clearSizing, updateDocument],
  );

  const activateDocument = useCallback((documentId: DocumentId) => {
    if (
      documentId !== 0 &&
      !documentsRef.current.some(
        (document) => document.documentId === documentId,
      )
    )
      return;
    propsRef.current.onActivate?.(documentId);
    activeDocumentIdRef.current = documentId;
    setActiveDocumentId(documentId);
    setSearchOpen(false);
    setExplorerOpen(false);
    setMacroOpen(false);
    setReveal(null);
  }, []);

  const handleActiveDocumentError = useCallback(
    (documentId: DocumentId, message: string) => {
      if (activeDocumentIdRef.current === documentId) setError(message);
    },
    [],
  );

  const changeTheme = useCallback((nextTheme: ThemeMode) => {
    setTheme(nextTheme);
    writeThemePreference(nextTheme);
    propsRef.current.onTheme?.(nextTheme);
  }, []);

  useEffect(() => {
    document.documentElement.style.colorScheme = theme;
    void getCurrentWindow()
      .setTheme(theme)
      .catch(() => {
        // CSS theming remains available if native window theming is unsupported.
      });
  }, [theme]);

  const saveDocumentById = useCallback(
    async (
      documentId: DocumentId,
      saveAs = false,
      suggestedName?: string,
    ): Promise<boolean> => {
      if (propsRef.current.project)
        return propsRef.current.project.onSave(saveAs);
      const document = documentsRef.current.find(
        (candidate) => candidate.documentId === documentId,
      );
      if (!document) return false;
      try {
        let destination = saveAs ? null : document.path;
        if (!destination) {
          destination = await save({
            defaultPath: suggestedName ?? document.displayName,
            filters: [{ name: "CSV", extensions: ["csv", "tsv", "txt"] }],
          });
        }
        if (!destination) return false;
        setBusy(true);
        setError(null);
        updateDocument(await saveSession(documentId, destination));
        return true;
      } catch (reason) {
        const message = String(reason);
        setError(message);
        setUnsavedError(message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [updateDocument],
  );

  const createNew = useCallback(async () => {
    if (propsRef.current.project) {
      propsRef.current.project.onNew();
      return;
    }
    if (busy || macroOpen || unsavedRequest) return;
    setBusy(true);
    setError(null);
    try {
      const created = await newSession();
      registerDocument(created);
      activateDocument(created.documentId);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }, [activateDocument, busy, macroOpen, registerDocument, unsavedRequest]);

  const openDocuments = useCallback(async () => {
    if (propsRef.current.project) {
      propsRef.current.project.onImport();
      return;
    }
    if (propsRef.current.onOpen) {
      propsRef.current.onOpen();
      return;
    }
    if (busy || macroOpen || unsavedRequest) return;
    const paths = selectedPaths(
      await open({
        multiple: true,
        directory: false,
        filters: [
          { name: "Delimited text", extensions: ["csv", "tsv", "txt"] },
        ],
      }),
    );
    if (!paths.length) return;

    setBusy(true);
    setError(null);
    const failures: string[] = [];
    let firstOpenedId: DocumentId | null = null;
    for (const path of paths) {
      try {
        const alreadyOpenIds = new Set(
          documentsRef.current.map((document) => document.documentId),
        );
        let opened = await openSession(path);
        const wasAlreadyOpen = alreadyOpenIds.has(opened.documentId);
        registerDocument(opened);
        if (!wasAlreadyOpen && opened.headerSuggested) {
          const enabled = await ask(
            `The first row in ${shortPath(path)} looks like column headers. Use it as the header?`,
            {
              title: "Column headers",
              kind: "info",
            },
          );
          if (enabled) {
            opened = await setSessionHeader(opened.documentId, true);
            updateDocument(opened);
          }
        }
        firstOpenedId ??= opened.documentId;
      } catch (reason) {
        failures.push(`${shortPath(path)}: ${String(reason)}`);
      }
    }
    if (firstOpenedId !== null) activateDocument(firstOpenedId);
    if (failures.length)
      setError(`Some files could not be opened:\n${failures.join("\n")}`);
    setBusy(false);
  }, [
    activateDocument,
    busy,
    macroOpen,
    registerDocument,
    unsavedRequest,
    updateDocument,
  ]);

  const closeDocumentNow = useCallback(
    async (documentId: DocumentId, discardUnsaved: boolean) => {
      const current = documentsRef.current;
      const index = current.findIndex(
        (document) => document.documentId === documentId,
      );
      if (index < 0) return;
      const wasActive = activeDocumentIdRef.current === documentId;
      const nextActiveId = wasActive
        ? (current[index + 1]?.documentId ??
          current[index - 1]?.documentId ??
          0)
        : activeDocumentIdRef.current;

      const workspace = await closeSession(documentId, discardUnsaved);
      commitDocuments(workspace.documents);
      setTabUiStates((states) => {
        const updated = { ...states };
        delete updated[documentId];
        return updated;
      });
      if (wasActive) activateDocument(nextActiveId);
    },
    [activateDocument, commitDocuments],
  );

  const requestCloseDocument = useCallback(
    (documentId: DocumentId) => {
      if (propsRef.current.project) {
        propsRef.current.project.onCloseTab(documentId);
        return;
      }
      if (busy || macroOpen || unsavedRequest) return;
      const document = documentsRef.current.find(
        (candidate) => candidate.documentId === documentId,
      );
      if (!document) return;
      if (document.dirty) {
        setUnsavedError(null);
        setUnsavedRequest({ kind: "document", documentId });
        return;
      }
      setBusy(true);
      void closeDocumentNow(documentId, false)
        .catch((reason) => setError(String(reason)))
        .finally(() => setBusy(false));
    },
    [busy, closeDocumentNow, macroOpen, unsavedRequest],
  );

  const reorderDocuments = useCallback(
    (documentIds: DocumentId[]) => {
      if (propsRef.current.project) {
        const byId = new Map(
          documentsRef.current.map((d) => [d.documentId, d]),
        );
        commitDocuments(documentIds.map((id) => byId.get(id)!).filter(Boolean));
        return;
      }
      if (busy || macroOpen || unsavedRequest) return;
      setBusy(true);
      void reorderWorkspace(documentIds)
        .then((workspace) => {
          commitDocuments(workspace.documents);
          setError(null);
        })
        .catch((reason) => setError(String(reason)))
        .finally(() => setBusy(false));
    },
    [busy, commitDocuments, macroOpen, unsavedRequest],
  );

  const cancelUnsaved = useCallback(() => {
    if (unsavedWorking) return;
    setUnsavedRequest(null);
    setUnsavedError(null);
    closingInProgress.current = false;
  }, [unsavedWorking]);

  const saveUnsaved = useCallback(async () => {
    const request = unsavedRequest;
    if (!request) return;
    setUnsavedWorking(true);
    setUnsavedError(null);
    if (request.kind === "document") {
      const saved = await saveDocumentById(request.documentId);
      if (saved) {
        try {
          await closeDocumentNow(request.documentId, false);
          setUnsavedRequest(null);
        } catch (reason) {
          setUnsavedError(String(reason));
        }
      }
      setUnsavedWorking(false);
      return;
    }

    for (const document of documentsRef.current) {
      const latest = documentsRef.current.find(
        (candidate) => candidate.documentId === document.documentId,
      );
      if (latest?.dirty && !(await saveDocumentById(document.documentId))) {
        setUnsavedWorking(false);
        return;
      }
    }
    try {
      await exitApplication();
    } catch (reason) {
      closingInProgress.current = false;
      setUnsavedError(String(reason));
      setUnsavedWorking(false);
    }
  }, [closeDocumentNow, saveDocumentById, unsavedRequest]);

  const discardUnsaved = useCallback(async () => {
    const request = unsavedRequest;
    if (!request) return;
    setUnsavedWorking(true);
    setUnsavedError(null);
    try {
      if (request.kind === "document") {
        await closeDocumentNow(request.documentId, true);
        setUnsavedRequest(null);
        closingInProgress.current = false;
      } else {
        await discardRecovery();
        await exitApplication();
      }
    } catch (reason) {
      closingInProgress.current = false;
      setUnsavedError(String(reason));
    } finally {
      setUnsavedWorking(false);
    }
  }, [closeDocumentNow, unsavedRequest]);

  useEffect(() => {
    if (propsRef.current.managed) return;
    let active = true;
    void (async () => {
      try {
        let workspace = await getWorkspaceSummary();
        if (await recoveryAvailable()) {
          const restore = await ask(
            "Tablune Sheets found unsaved work from the previous session. Restore it?",
            {
              title: "Recover documents",
              kind: "info",
            },
          );
          if (!active) return;
          if (restore) workspace = await restoreRecovery();
          else await discardRecovery();
        }
        if (!active) return;
        commitDocuments(workspace.documents);
        const firstId = workspace.documents[0]?.documentId ?? 0;
        activeDocumentIdRef.current = firstId;
        setActiveDocumentId(firstId);
      } catch (reason) {
        if (active) setError(String(reason));
      }
    })();
    return () => {
      active = false;
    };
  }, [commitDocuments]);

  const recoveryKey = useMemo(
    () =>
      documents
        .filter((document) => document.dirty)
        .map((document) => `${document.documentId}:${document.revision}`)
        .join("|"),
    [documents],
  );

  useEffect(() => {
    if (propsRef.current.managed || !recoveryKey) return;
    const elapsed = Date.now() - lastRecovery.current;
    const delay = Math.max(2_000, 10_000 - elapsed);
    const timer = window.setTimeout(() => {
      void writeWorkspaceRecovery()
        .then(() => {
          lastRecovery.current = Date.now();
        })
        .catch((reason) => setError(String(reason)));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [recoveryKey]);

  useEffect(() => {
    if (propsRef.current.managed) return;
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void appWindow
      .onCloseRequested(async (event) => {
        event.preventDefault();
        if (closingInProgress.current) return;
        const dirtyDocuments = documentsRef.current.filter(
          (document) => document.dirty,
        );
        if (!dirtyDocuments.length) {
          closingInProgress.current = true;
          try {
            await exitApplication();
          } catch (reason) {
            closingInProgress.current = false;
            setError(String(reason));
          }
          return;
        }
        closingInProgress.current = true;
        setUnsavedError(null);
        setUnsavedRequest({ kind: "application" });
      })
      .then((dispose) => {
        unlisten = dispose;
      });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const handleShortcuts = (event: globalThis.KeyboardEvent) => {
      if (
        propsRef.current.active === false ||
        macroOpen ||
        unsavedRequest ||
        busy
      )
        return;
      if (event.ctrlKey && event.key === "Tab") {
        event.preventDefault();
        const current = documentsRef.current;
        if (!current.length) return;
        const index = current.findIndex(
          (document) => document.documentId === activeDocumentIdRef.current,
        );
        const offset = event.shiftKey ? -1 : 1;
        activateDocument(
          current[(index + offset + current.length) % current.length]
            .documentId,
        );
        return;
      }
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) return;
      const key = event.key.toLowerCase();
      if (key === "t") {
        event.preventDefault();
        void createNew();
      } else if (key === "w") {
        event.preventDefault();
        if (activeDocumentIdRef.current)
          requestCloseDocument(activeDocumentIdRef.current);
      } else if (key === "f") {
        event.preventDefault();
        setSearchOpen(true);
      } else if (key === "z" || key === "y") {
        event.preventDefault();
        const documentId = activeDocumentIdRef.current;
        if (!documentId) return;
        const command =
          key === "y" || event.shiftKey ? redoSession : undoSession;
        void runHistoryCommand(documentId, command);
      }
    };
    window.addEventListener("keydown", handleShortcuts);
    return () => window.removeEventListener("keydown", handleShortcuts);
  }, [
    activateDocument,
    busy,
    createNew,
    macroOpen,
    requestCloseDocument,
    runHistoryCommand,
    unsavedRequest,
  ]);

  const renameDocument = async (nextName: string): Promise<boolean> => {
    if (propsRef.current.project)
      return propsRef.current.project.onRename(summary.documentId, nextName);
    if (macroOpen) return false;
    const normalizedName = nextName.trim();
    if (
      !normalizedName ||
      normalizedName === "." ||
      normalizedName === ".." ||
      /[\\/\0]/.test(normalizedName)
    ) {
      setError("Enter a valid file name without folders.");
      return false;
    }
    if (!summary.path)
      return saveDocumentById(summary.documentId, true, normalizedName);
    if (normalizedName === summary.displayName) return true;
    setBusy(true);
    try {
      updateDocument(await renameSession(summary.documentId, normalizedName));
      setError(null);
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const duplicateDocument = async () => {
    const documentId = summary.documentId;
    if (propsRef.current.project) {
      propsRef.current.project.onDuplicate(documentId);
      return;
    }
    if (!documentId || !summary.path || busy || macroOpen || unsavedRequest)
      return;
    setBusy(true);
    setError(null);
    try {
      const workspace = await duplicateSession(documentId);
      commitDocuments(workspace.documents);
    } catch (reason) {
      if (activeDocumentIdRef.current === documentId) setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const applyEdit = useCallback(
    async (command: EditCommand) => {
      if (macroOpen) return;
      const documentId = activeDocumentIdRef.current;
      const document = documentsRef.current.find(
        (candidate) => candidate.documentId === documentId,
      );
      if (!document) return;
      try {
        setError(null);
        updateDocument(
          await applySessionEdit(documentId, command, document.revision),
        );
        if (
          command.kind === "insertRows" ||
          command.kind === "deleteRows" ||
          command.kind === "applySort"
        ) {
          clearSizing(documentId, "rows");
        } else if (
          command.kind === "insertColumns" ||
          command.kind === "deleteColumns"
        ) {
          clearSizing(documentId, "columns");
        } else if (
          (command.kind === "setCells" || command.kind === "setSheetCells") &&
          (document.filtersActive || document.sortCount > 0)
        ) {
          clearSizing(documentId, "rows");
        }
      } catch (reason) {
        if (activeDocumentIdRef.current === documentId)
          setError(String(reason));
        const current = await getSessionSummary(documentId);
        updateDocument(current);
        throw reason;
      }
    },
    [clearSizing, macroOpen, updateDocument],
  );

  const changeView = async (nextView: ViewState) => {
    if (macroOpen) return;
    const documentId = summary.documentId;
    if (!documentId) return;
    setBusy(true);
    try {
      updateDocument(await setSessionView(documentId, nextView));
      updateTabUi(documentId, (current) => ({
        ...current,
        view: nextView,
        sizing: { ...current.sizing, rowHeights: {} },
      }));
      if (activeDocumentIdRef.current === documentId) setError(null);
    } catch (reason) {
      if (activeDocumentIdRef.current === documentId) setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const runGridCommand = (command: "copy" | "cut" | "paste") => {
    if (macroOpen && command !== "copy") return;
    document.dispatchEvent(
      new CustomEvent("tablune-grid-command", {
        detail: { command, documentId: summary.documentId },
      }),
    );
  };

  const runDimensionOperation = (
    kind: "insertRows" | "deleteRows" | "insertColumns" | "deleteColumns",
  ) => {
    if (macroOpen) return;
    const range = normalizeSelection(tabUi.selection);
    const rows = kind.endsWith("Rows");
    if (rows && (summary.filtersActive || summary.sortCount > 0)) {
      setError("Clear sorting and filters before changing whole rows.");
      return;
    }
    const index = rows
      ? range.startRow + Number(summary.headerEnabled)
      : range.startColumn;
    const count = rows
      ? range.endRow - range.startRow + 1
      : range.endColumn - range.startColumn + 1;
    void applyEdit({ kind, index, count } as EditCommand);
  };

  const exportView = async () => {
    if (macroOpen) return;
    const documentId = summary.documentId;
    const destination = await save({
      defaultPath: `filtered-${summary.displayName}`,
      filters: [{ name: "CSV", extensions: ["csv", "tsv", "txt"] }],
    });
    if (!destination) return;
    setBusy(true);
    try {
      await exportSessionView(documentId, destination);
      if (activeDocumentIdRef.current === documentId) setError(null);
    } catch (reason) {
      if (activeDocumentIdRef.current === documentId) setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const dialogDocuments =
    unsavedRequest?.kind === "document"
      ? documents.filter(
          (document) => document.documentId === unsavedRequest.documentId,
        )
      : documents.filter((document) => document.dirty);

  const openPythonMacro = () => {
    if (propsRef.current.project) {
      propsRef.current.project.onScript();
      return;
    }
    if (busy || macroOpen || unsavedRequest || summary.documentId === 0) return;
    restoreExplorerAfterMacro.current = explorerOpen;
    setExplorerOpen(false);
    setMacroOpen(true);
  };

  const closePythonMacro = () => {
    setMacroOpen(false);
    if (restoreExplorerAfterMacro.current) setExplorerOpen(true);
    restoreExplorerAfterMacro.current = false;
  };

  const ribbon = <RibbonHeader
        {...props.ribbonControls}
        documentName={summary.displayName}
        dirty={summary.dirty}
        busy={busy || props.active === false}
        mutationsLocked={macroOpen}
        error={error}
        delimiter={summary.delimiter}
        headerEnabled={summary.headerEnabled}
        canUndo={summary.canUndo}
        canRedo={summary.canRedo}
        canChangeRows={!summary.filtersActive && summary.sortCount === 0}
        canDuplicate={Boolean(props.project) || summary.path !== null}
        hasView={summary.filtersActive || summary.sortCount > 0}
        hasCustomSizing={hasCustomSizing}
        theme={theme}
        onNew={() => void createNew()}
        onOpen={() => void openDocuments()}
        onSave={() => void saveDocumentById(summary.documentId)}
        onSaveAs={() => void saveDocumentById(summary.documentId, true)}
        onDuplicate={() => void duplicateDocument()}
        onExportView={() => void exportView()}
        onUndo={() => void runHistoryCommand(summary.documentId, undoSession)}
        onRedo={() => void runHistoryCommand(summary.documentId, redoSession)}
        onCut={() => runGridCommand("cut")}
        onCopy={() => runGridCommand("copy")}
        onPaste={() => runGridCommand("paste")}
        onInsertRow={() => runDimensionOperation("insertRows")}
        onDeleteRow={() => runDimensionOperation("deleteRows")}
        onInsertColumn={() => runDimensionOperation("insertColumns")}
        onDeleteColumn={() => runDimensionOperation("deleteColumns")}
        onFind={() => setSearchOpen(true)}
        onHeaderChange={(enabled) => {
          if (macroOpen) return;
          void setSessionHeader(summary.documentId, enabled)
            .then((next) => {
              updateDocument(next);
              clearSizing(next.documentId, "both");
            })
            .catch((reason) => setError(String(reason)));
        }}
        onToggleExplorer={() => {
          if (!macroOpen) setExplorerOpen((open) => !open);
        }}
        onClearView={() => void changeView(EMPTY_VIEW)}
        onResetCellSizing={() => clearSizing(summary.documentId, "both")}
        onPythonMacro={openPythonMacro}
        onThemeChange={changeTheme}
        onDelimiterChange={(delimiter) =>
          void applyEdit({ kind: "setDelimiter", delimiter })
        }
        onDocumentNameCommit={renameDocument}
      />;

  return (
    <main className={`app-shell${props.managed ? " managed-grid" : ""}`} data-theme={theme}>
      {props.managed
        ? props.ribbonVisible && props.ribbonTarget && createPortal(ribbon, props.ribbonTarget)
        : ribbon}
      <section className="content-region">
        {searchOpen && summary.documentId !== 0 && (
          <SearchBar
            key={summary.documentId}
            summary={summary}
            selection={tabUi.selection}
            readOnly={macroOpen || props.active === false}
            onSummary={updateDocument}
            onNavigate={(match: SearchMatch) => {
              if (activeDocumentIdRef.current !== summary.documentId) return;
              if (match.viewRow === null) {
                setError("This match is hidden by the current filters.");
                return;
              }
              setReveal({
                viewRow: match.viewRow,
                column: match.column,
                nonce: Date.now(),
              });
            }}
            onClose={() => setSearchOpen(false)}
            onError={(message) =>
              handleActiveDocumentError(summary.documentId, message)
            }
          />
        )}
        <div
          className={`workspace${explorerOpen && !macroOpen ? " explorer-open" : ""}${macroOpen ? " macro-open" : ""}`}
        >
          {summary.documentId !== 0 && (
            <CsvGrid
              appliedFunctions={props.appliedFunctions}
              key={`grid-${summary.documentId}`}
              summary={summary}
              theme={theme}
              readOnly={macroOpen || props.active === false}
              initialSelection={tabUi.selection}
              initialViewport={tabUi.viewport}
              initialSizing={tabUi.sizing}
              onApplyEdit={applyEdit}
              onSelectionChange={(selection) =>
                updateTabUi(summary.documentId, (current) => ({
                  ...current,
                  selection,
                }))
              }
              onViewportChange={(viewport) =>
                updateTabUi(summary.documentId, (current) => ({
                  ...current,
                  viewport,
                }))
              }
              onSizingChange={(sizing) =>
                updateTabUi(summary.documentId, (current) => ({
                  ...current,
                  sizing,
                }))
              }
              onError={(message) =>
                handleActiveDocumentError(summary.documentId, message)
              }
              reveal={reveal}
              onHeaderSort={(column) => {
                const existing = tabUi.view.sorts.find(
                  (sort) => sort.column === column,
                );
                const sorts = tabUi.view.sorts.filter(
                  (sort) => sort.column !== column,
                );
                if (!existing)
                  sorts.push({
                    column,
                    direction: "ascending",
                    columnType: "text",
                  });
                else if (existing.direction === "ascending")
                  sorts.push({ ...existing, direction: "descending" });
                void changeView({ ...tabUi.view, sorts });
              }}
            />
          )}
          {explorerOpen && !macroOpen && summary.documentId !== 0 && (
            <ExplorerPanel
              key={`explorer-${summary.documentId}`}
              summary={summary}
              column={tabUi.selection.focus.column}
              view={tabUi.view}
              onViewChange={changeView}
              onColumnTypeChange={async (columnType: ColumnType) => {
                updateDocument(
                  await setSessionColumnType(
                    summary.documentId,
                    tabUi.selection.focus.column,
                    columnType,
                  ),
                );
              }}
              onApplySort={async () => {
                await applyEdit({ kind: "applySort" });
                updateTabUi(summary.documentId, (current) => ({
                  ...current,
                  view: { ...current.view, sorts: [] },
                }));
              }}
              onExport={exportView}
              onClose={() => setExplorerOpen(false)}
              onError={(message) =>
                handleActiveDocumentError(summary.documentId, message)
              }
            />
          )}
          {macroOpen && summary.documentId !== 0 && (
            <PythonMacroPanel
              key={`macro-${summary.documentId}`}
              summary={summary}
              trustAcknowledged={macroTrustAcknowledged}
              onTrustAcknowledged={() => setMacroTrustAcknowledged(true)}
              onApplied={(nextSummary) => {
                updateDocument(nextSummary);
                updateTabUi(nextSummary.documentId, (current) => ({
                  ...current,
                  view: EMPTY_VIEW,
                  sizing: { columnWidths: {}, rowHeights: {} },
                }));
              }}
              onClose={closePythonMacro}
            />
          )}
        </div>
      </section>

      <DocumentTabs
        documents={documents}
        activeDocumentId={activeDocumentId}
        disabled={interactionsLocked}
        onActivate={(documentId) => {
          if (!interactionsLocked) activateDocument(documentId);
        }}
        onClose={requestCloseDocument}
        onNew={() => void createNew()}
        onReorder={reorderDocuments}
      />

      <footer className="statusbar">
        <span>{summary.dirty ? "Unsaved changes" : "Saved"}</span>
        <span>
          {summary.visibleRowCount.toLocaleString()}
          {summary.filtersActive
            ? ` of ${Math.max(0, summary.rowCount - Number(summary.headerEnabled)).toLocaleString()}`
            : ""}{" "}
          rows
        </span>
        <span>{summary.columnCount.toLocaleString()} columns</span>
        {summary.sortCount > 0 && (
          <span>
            {summary.sortCount} sort{summary.sortCount === 1 ? "" : "s"}
          </span>
        )}
        {summary.filtersActive && <span>Filtered</span>}
        <span>{summary.lineEnding === "crlf" ? "CRLF" : "LF"}</span>
        <span>UTF-8</span>
      </footer>

      {unsavedRequest && dialogDocuments.length > 0 && (
        <UnsavedChangesDialog
          documents={dialogDocuments}
          allDocuments={documents}
          closingApplication={unsavedRequest.kind === "application"}
          working={unsavedWorking}
          error={unsavedError}
          onSave={() => void saveUnsaved()}
          onDiscard={() => void discardUnsaved()}
          onCancel={cancelUnsaved}
        />
      )}
    </main>
  );
}
