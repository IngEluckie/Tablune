import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import CsvGrid, { normalizeSelection } from "./CsvGrid";
import ExplorerPanel from "./ExplorerPanel";
import SearchBar from "./SearchBar";
import RibbonHeader from "./RibbonHeader";
import {
  applySessionEdit,
  discardRecovery,
  exitApplication,
  exportSessionView,
  getSessionSummary,
  newSession,
  openSession,
  recoveryAvailable,
  redoSession,
  renameSession,
  restoreRecovery,
  saveSession,
  setSessionColumnType,
  setSessionHeader,
  setSessionView,
  undoSession,
  writeSessionRecovery,
} from "./ipc";
import type {
  ColumnType,
  DocumentSummary,
  EditCommand,
  SearchMatch,
  SelectionRange,
  ViewState,
} from "./types";

const EMPTY_SUMMARY: DocumentSummary = {
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

export default function App() {
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [view, setView] = useState<ViewState>(EMPTY_VIEW);
  const [selection, setSelection] = useState<SelectionRange>({
    anchor: { row: 0, column: 0 },
    focus: { row: 0, column: 0 },
    mode: "cells",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [reveal, setReveal] = useState<{ viewRow: number; column: number; nonce: number } | null>(null);
  const closingInProgress = useRef(false);
  const lastRecovery = useRef(0);

  const handleError = useCallback((message: string) => setError(message), []);

  const saveDocument = useCallback(async (saveAs = false, suggestedName?: string): Promise<boolean> => {
    try {
      let destination = saveAs ? null : summary.path;
      if (!destination) {
        destination = await save({
          defaultPath: suggestedName ?? summary.displayName,
          filters: [{ name: "CSV", extensions: ["csv", "tsv", "txt"] }],
        });
      }
      if (!destination) return false;
      setBusy(true);
      setError(null);
      setSummary(await saveSession(destination));
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }, [summary.displayName, summary.path]);

  const protectChanges = useCallback(async (action: () => Promise<void>): Promise<boolean> => {
    if (!summary.dirty) {
      await action();
      return true;
    }
    const shouldSave = await ask("Save your changes before continuing?", {
      title: "Unsaved changes",
      kind: "warning",
    });
    if (shouldSave) {
      if (!await saveDocument(false)) return false;
      await action();
      return true;
    }
    const shouldDiscard = await ask("Discard the unsaved changes? This cannot be undone.", {
      title: "Discard changes",
      kind: "warning",
    });
    if (!shouldDiscard) return false;
    await discardRecovery();
    await action();
    return true;
  }, [saveDocument, summary.dirty]);

  useEffect(() => {
    let active = true;
    void getSessionSummary().then((current) => { if (active) setSummary(current); }).catch((reason) => setError(String(reason)));
    void recoveryAvailable().then(async (available) => {
      if (!active || !available) return;
      const restore = await ask("Tablune found unsaved work from the previous session. Restore it?", {
        title: "Recover document",
        kind: "info",
      });
      if (!active) return;
      if (restore) setSummary(await restoreRecovery()); else await discardRecovery();
    }).catch((reason) => setError(String(reason)));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!summary.dirty) return;
    const elapsed = Date.now() - lastRecovery.current;
    const delay = Math.max(2_000, 10_000 - elapsed);
    const timer = window.setTimeout(() => {
      void writeSessionRecovery().then(() => { lastRecovery.current = Date.now(); }).catch((reason) => setError(String(reason)));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [summary.dirty, summary.revision]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      if (closingInProgress.current) return;
      closingInProgress.current = true;
      try {
        const completed = await protectChanges(async () => {});
        if (!completed) {
          closingInProgress.current = false;
          return;
        }
        await exitApplication();
      } catch (reason) {
        closingInProgress.current = false;
        setError(String(reason));
      }
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, [protectChanges]);

  useEffect(() => {
    const handleShortcuts = (event: globalThis.KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) return;
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        const command = event.shiftKey ? redoSession : undoSession;
        void command().then(setSummary).catch((reason) => setError(String(reason)));
      }
      if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        void redoSession().then(setSummary).catch((reason) => setError(String(reason)));
      }
    };
    window.addEventListener("keydown", handleShortcuts);
    return () => window.removeEventListener("keydown", handleShortcuts);
  }, []);

  const createNew = () => void protectChanges(async () => {
    setBusy(true);
    try {
      setSummary(await newSession());
      setView(EMPTY_VIEW);
      setError(null);
    } finally {
      setBusy(false);
    }
  });

  const openDocument = () => void protectChanges(async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Delimited text", extensions: ["csv", "tsv", "txt"] }],
    });
    if (typeof selected !== "string") return;
    setBusy(true);
    setError(null);
    try {
      let opened = await openSession(selected);
      setView(EMPTY_VIEW);
      if (opened.headerSuggested) {
        const enabled = await ask("The first row looks like column headers. Use it as the header?", {
          title: "Column headers",
          kind: "info",
        });
        if (enabled) opened = await setSessionHeader(true);
      }
      setSummary(opened);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  });

  const renameDocument = async (nextName: string): Promise<boolean> => {
    const normalizedName = nextName.trim();
    if (!normalizedName || normalizedName === "." || normalizedName === ".." || /[\\/\0]/.test(normalizedName)) {
      setError("Enter a valid file name without folders.");
      return false;
    }
    if (!summary.path) return saveDocument(true, normalizedName);
    if (normalizedName === summary.displayName) return true;
    setBusy(true);
    try {
      setSummary(await renameSession(normalizedName));
      setError(null);
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const applyEdit = useCallback(async (command: EditCommand) => {
    try {
      setError(null);
      setSummary(await applySessionEdit(command, summary.revision));
    } catch (reason) {
      setError(String(reason));
      const current = await getSessionSummary();
      setSummary(current);
      throw reason;
    }
  }, [summary.revision]);

  const changeView = async (nextView: ViewState) => {
    setBusy(true);
    try {
      setSummary(await setSessionView(nextView));
      setView(nextView);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const runGridCommand = (command: "copy" | "cut" | "paste") => {
    document.dispatchEvent(new CustomEvent("tablune-grid-command", { detail: command }));
  };

  const runDimensionOperation = (kind: "insertRows" | "deleteRows" | "insertColumns" | "deleteColumns") => {
    const range = normalizeSelection(selection);
    const rows = kind.endsWith("Rows");
    if (rows && (summary.filtersActive || summary.sortCount > 0)) {
      setError("Clear sorting and filters before changing whole rows.");
      return;
    }
    const index = rows ? range.startRow + Number(summary.headerEnabled) : range.startColumn;
    const count = rows ? range.endRow - range.startRow + 1 : range.endColumn - range.startColumn + 1;
    void applyEdit({ kind, index, count } as EditCommand);
  };

  const exportView = async () => {
    const destination = await save({
      defaultPath: `filtered-${summary.displayName}`,
      filters: [{ name: "CSV", extensions: ["csv", "tsv", "txt"] }],
    });
    if (!destination) return;
    setBusy(true);
    try {
      await exportSessionView(destination);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="app-shell">
      <RibbonHeader
        documentName={summary.displayName}
        dirty={summary.dirty}
        busy={busy}
        error={error}
        delimiter={summary.delimiter}
        headerEnabled={summary.headerEnabled}
        canUndo={summary.canUndo}
        canRedo={summary.canRedo}
        canChangeRows={!summary.filtersActive && summary.sortCount === 0}
        hasView={summary.filtersActive || summary.sortCount > 0}
        onNew={createNew}
        onOpen={openDocument}
        onSave={() => void saveDocument(false)}
        onSaveAs={() => void saveDocument(true)}
        onExportView={() => void exportView()}
        onUndo={() => void undoSession().then(setSummary).catch((reason) => setError(String(reason)))}
        onRedo={() => void redoSession().then(setSummary).catch((reason) => setError(String(reason)))}
        onCut={() => runGridCommand("cut")}
        onCopy={() => runGridCommand("copy")}
        onPaste={() => runGridCommand("paste")}
        onInsertRow={() => runDimensionOperation("insertRows")}
        onDeleteRow={() => runDimensionOperation("deleteRows")}
        onInsertColumn={() => runDimensionOperation("insertColumns")}
        onDeleteColumn={() => runDimensionOperation("deleteColumns")}
        onFind={() => setSearchOpen(true)}
        onHeaderChange={(enabled) => void setSessionHeader(enabled).then(setSummary).catch((reason) => setError(String(reason)))}
        onToggleExplorer={() => setExplorerOpen((open) => !open)}
        onClearView={() => void changeView(EMPTY_VIEW)}
        onDelimiterChange={(delimiter) => void applyEdit({ kind: "setDelimiter", delimiter })}
        onDocumentNameCommit={renameDocument}
      />

      <section className="content-region">
        {searchOpen && (
          <SearchBar
            summary={summary}
            selection={selection}
            onSummary={setSummary}
            onNavigate={(match: SearchMatch) => {
              if (match.viewRow === null) {
                setError("This match is hidden by the current filters.");
                return;
              }
              setReveal({ viewRow: match.viewRow, column: match.column, nonce: Date.now() });
            }}
            onClose={() => setSearchOpen(false)}
            onError={handleError}
          />
        )}
        <div className={`workspace${explorerOpen ? " explorer-open" : ""}`}>
          <CsvGrid
            summary={summary}
            onApplyEdit={applyEdit}
            onSelectionChange={setSelection}
            onError={handleError}
            reveal={reveal}
            onHeaderSort={(column) => {
              const existing = view.sorts.find((sort) => sort.column === column);
              const sorts = view.sorts.filter((sort) => sort.column !== column);
              if (!existing) sorts.push({ column, direction: "ascending", columnType: "text" });
              else if (existing.direction === "ascending") sorts.push({ ...existing, direction: "descending" });
              void changeView({ ...view, sorts });
            }}
          />
          {explorerOpen && (
            <ExplorerPanel
              summary={summary}
              column={selection.focus.column}
              view={view}
              onViewChange={changeView}
              onColumnTypeChange={async (columnType: ColumnType) => {
                setSummary(await setSessionColumnType(selection.focus.column, columnType));
              }}
              onApplySort={async () => {
                await applyEdit({ kind: "applySort" });
                setView((current) => ({ ...current, sorts: [] }));
              }}
              onExport={exportView}
              onClose={() => setExplorerOpen(false)}
              onError={handleError}
            />
          )}
        </div>
      </section>

      <footer className="statusbar">
        <span>{summary.dirty ? "Unsaved changes" : "Saved"}</span>
        <span>{summary.visibleRowCount.toLocaleString()}{summary.filtersActive ? ` of ${Math.max(0, summary.rowCount - Number(summary.headerEnabled)).toLocaleString()}` : ""} rows</span>
        <span>{summary.columnCount.toLocaleString()} columns</span>
        {summary.sortCount > 0 && <span>{summary.sortCount} sort{summary.sortCount === 1 ? "" : "s"}</span>}
        {summary.filtersActive && <span>Filtered</span>}
        <span>{summary.lineEnding === "crlf" ? "CRLF" : "LF"}</span>
        <span>UTF-8</span>
      </footer>
    </main>
  );
}
