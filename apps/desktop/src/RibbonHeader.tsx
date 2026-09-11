import { clampSheetZoom, MIN_SHEET_ZOOM, MAX_SHEET_ZOOM } from "./sheetZoom";
import {
  type FocusEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ThemeMode } from "./theme";

type MenuSection = "file" | "edit" | "data" | "view";

const PIN_STORAGE_KEY = "tablune.ribbonPinned";
const CLOSE_DELAY_MS = 180;

const MENUS: Array<{ id: MenuSection; label: string }> = [
  { id: "file", label: "File" },
  { id: "edit", label: "Edit" },
  { id: "data", label: "Data" },
  { id: "view", label: "View" },
];

export interface RibbonHeaderProps {
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  navigation?: ReactNode;
  fileActions?: ReactNode;
  tableAvailable?: boolean;
  documentName: string;
  dirty: boolean;
  busy: boolean;
  mutationsLocked?: boolean;
  error: string | null;
  delimiter: string;
  headerEnabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canChangeRows: boolean;
  canDuplicate: boolean;
  hasView: boolean;
  hasCustomSizing: boolean;
  theme: ThemeMode;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onDuplicate: () => void;
  onExportView: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onInsertRow: () => void;
  onDeleteRow: () => void;
  onInsertImage?: () => void;
  onInsertColumn: () => void;
  onDeleteColumn: () => void;
  onFind: () => void;
  onHeaderChange: (enabled: boolean) => void;
  onToggleExplorer: () => void;
  onClearView: () => void;
  onResetCellSizing: () => void;
  onPythonMacro: () => void;
  onThemeChange: (theme: ThemeMode) => void;
  onDelimiterChange: (delimiter: string) => void;
  onDocumentNameCommit: (documentName: string) => Promise<boolean>;
}

function readPinnedPreference(): boolean {
  try {
    return window.localStorage.getItem(PIN_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writePinnedPreference(pinned: boolean): void {
  try {
    window.localStorage.setItem(PIN_STORAGE_KEY, String(pinned));
  } catch {
    // A restricted WebView may not expose persistent storage. The session state still works.
  }
}

export default function RibbonHeader({
  zoom = 1,
  onZoomChange,
  navigation,
  fileActions,
  tableAvailable = true,
  documentName = "",
  dirty,
  busy,
  mutationsLocked = false,
  error,
  delimiter,
  headerEnabled,
  canUndo,
  canRedo,
  canChangeRows,
  canDuplicate,
  hasView,
  hasCustomSizing,
  theme,
  onNew,
  onOpen,
  onSave,
  onSaveAs,
  onDuplicate,
  onExportView,
  onUndo,
  onRedo,
  onCut,
  onCopy,
  onPaste,
  onInsertRow,
  onDeleteRow,
  onInsertImage,
  onInsertColumn,
  onDeleteColumn,
  onFind,
  onHeaderChange,
  onToggleExplorer,
  onClearView,
  onResetCellSizing,
  onPythonMacro,
  onThemeChange,
  onDelimiterChange,
  onDocumentNameCommit = async () => false,
}: RibbonHeaderProps | (Partial<RibbonHeaderProps> & { tableAvailable: false; theme: ThemeMode; onThemeChange: (theme: ThemeMode) => void })) {
  const [activeMenu, setActiveMenu] = useState<MenuSection>("file");
  const [pointerOpen, setPointerOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [pinned, setPinned] = useState(readPinnedPreference);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(documentName);
  const closeTimer = useRef<number | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const nameCommitInProgress = useRef(false);

  const ribbonOpen = pinned || pointerOpen || focusOpen;

  const cancelScheduledClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const revealMenu = (menu: MenuSection) => {
    cancelScheduledClose();
    setActiveMenu(menu);
    setPointerOpen(true);
  };

  const revealActiveMenu = () => {
    cancelScheduledClose();
    setPointerOpen(true);
  };

  const schedulePointerClose = () => {
    cancelScheduledClose();
    closeTimer.current = window.setTimeout(() => {
      setPointerOpen(false);
      closeTimer.current = null;
    }, CLOSE_DELAY_MS);
  };

  const handleBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocusOpen(false);
  };

  const handlePinChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextPinned = event.target.checked;
    setPinned(nextPinned);
    writePinnedPreference(nextPinned);
  };

  const beginNameEdit = () => {
    if (busy || mutationsLocked) return;
    setNameDraft(documentName);
    setEditingName(true);
  };

  const cancelNameEdit = () => {
    nameCommitInProgress.current = false;
    setNameDraft(documentName);
    setEditingName(false);
  };

  const commitNameEdit = async () => {
    if (busy || nameCommitInProgress.current) return;
    nameCommitInProgress.current = true;
    try {
      const committed = await onDocumentNameCommit(nameDraft);
      if (committed) {
        setEditingName(false);
        return;
      }
    } finally {
      nameCommitInProgress.current = false;
    }
    if (nameInput.current) {
      window.setTimeout(() => nameInput.current?.focus(), 0);
    }
  };

  useEffect(() => () => cancelScheduledClose(), []);
  useEffect(() => {
    if (!editingName) setNameDraft(documentName);
  }, [documentName, editingName]);
  useEffect(() => {
    if (editingName) nameInput.current?.select();
  }, [editingName]);
  useEffect(() => {
    if (mutationsLocked && editingName) cancelNameEdit();
  }, [editingName, mutationsLocked]);

  return (
    <section
      className={`top-region${ribbonOpen ? " ribbon-open" : ""}`}
      data-testid="top-region"
      onMouseEnter={revealActiveMenu}
      onMouseLeave={schedulePointerClose}
      onFocusCapture={() => setFocusOpen(true)}
      onBlurCapture={handleBlur}
    >
      <header className="compact-header">
        <nav className="header-menus" aria-label="Application sections">
          {navigation}
          {MENUS.filter((menu) => tableAvailable || menu.id === "file" || menu.id === "view").map((menu) => (
            <button
              key={menu.id}
              className={`header-menu${activeMenu === menu.id ? " active" : ""}`}
              aria-controls="ribbon-panel"
              aria-expanded={ribbonOpen && activeMenu === menu.id}
              onMouseEnter={() => revealMenu(menu.id)}
              onFocus={() => {
                setActiveMenu(menu.id);
                setFocusOpen(true);
              }}
              onClick={() => revealMenu(menu.id)}
            >
              {menu.label}
            </button>
          ))}
        </nav>

        <div className="header-identity">
          {tableAvailable && (editingName ? (
            <span className="header-document-editor">
              {dirty && <span className="dirty-dot" aria-label="Unsaved changes">●</span>}
              <input
                ref={nameInput}
                aria-label="Document name"
                value={nameDraft}
                disabled={busy}
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={() => {
                  if (!nameCommitInProgress.current) cancelNameEdit();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void commitNameEdit();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    cancelNameEdit();
                  }
                }}
              />
            </span>
          ) : (
            <button
              className="header-document"
              title={documentName}
              aria-label={`Rename ${documentName}`}
              disabled={busy || mutationsLocked}
              onDoubleClick={beginNameEdit}
            >
              {dirty && <span className="dirty-dot" aria-label="Unsaved changes">●</span>}
              {documentName}
            </button>
          ))}
          <span className="identity-divider" aria-hidden="true" />
          <span className="compact-brand-lockup" role="img" aria-label="Tablune Sheets">
            <img
              className="compact-brand-icon"
              src="/brand/tablune-icon.png"
              alt=""
              draggable={false}
            />
            <span className="compact-brand-wordmark-frame" aria-hidden="true">
              <img
                className="compact-brand-wordmark"
                src="/brand/tablune-wordmark.png"
                alt=""
                draggable={false}
              />
            </span>
          </span>
        </div>
      </header>

      <div className="ribbon-shell">
        <section
          id="ribbon-panel"
          className="ribbon-panel"
          aria-label={`${activeMenu[0].toUpperCase()}${activeMenu.slice(1)} options`}
          aria-hidden={!ribbonOpen}
          inert={ribbonOpen ? undefined : true}
        >
          <div className="ribbon-content">
            {activeMenu === "file" && (
              <div className="ribbon-group" aria-label="File actions">
                {fileActions}
                {tableAvailable && <>
                <button onClick={onNew} disabled={busy || mutationsLocked}>New</button>
                <button onClick={onOpen} disabled={busy || mutationsLocked}>Open</button>
                <button onClick={onSave} disabled={busy || mutationsLocked}>Save</button>
                <button onClick={onSaveAs} disabled={busy || mutationsLocked}>Save As</button>
                <button onClick={onDuplicate} disabled={busy || mutationsLocked || !canDuplicate}>Duplicar</button>
                <button onClick={onExportView} disabled={busy || mutationsLocked}>Export View</button>
                </>}
              </div>
            )}

            {activeMenu === "edit" && (
              <div className="ribbon-group" aria-label="Edit actions">
                <button onClick={onUndo} disabled={busy || mutationsLocked || !canUndo}>Undo</button>
                <button onClick={onRedo} disabled={busy || mutationsLocked || !canRedo}>Redo</button>
                <span className="ribbon-divider" aria-hidden="true" />
                <button onClick={onCut} disabled={busy || mutationsLocked}>Cut</button>
                <button onClick={onCopy} disabled={busy}>Copy</button>
                <button onClick={onPaste} disabled={busy || mutationsLocked}>Paste</button>
                <button onClick={onInsertImage} disabled={busy || mutationsLocked || !onInsertImage}>Insert image…</button>
                <span className="ribbon-divider" aria-hidden="true" />
                <button onClick={onFind}>Find</button>
              </div>
            )}

            {activeMenu === "data" && (
              <div className="ribbon-group" aria-label="Data actions">
                <label className="delimiter-control">
                  Delimiter
                  <select
                    value={delimiter}
                    disabled={busy || mutationsLocked}
                    onChange={(event) => onDelimiterChange?.(event.target.value)}
                  >
                    <option value=",">Comma</option>
                    <option value=";">Semicolon</option>
                    <option value={"\t"}>Tab</option>
                    <option value="|">Pipe</option>
                  </select>
                </label>
                <span className="ribbon-divider" aria-hidden="true" />
                <button onClick={onInsertRow} disabled={busy || mutationsLocked || !canChangeRows}>Insert Row</button>
                <button onClick={onDeleteRow} disabled={busy || mutationsLocked || !canChangeRows}>Delete Row</button>
                <button onClick={onInsertColumn} disabled={busy || mutationsLocked}>Insert Column</button>
                <button onClick={onDeleteColumn} disabled={busy || mutationsLocked}>Delete Column</button>
                <span className="ribbon-divider" aria-hidden="true" />
                <button onClick={onToggleExplorer} disabled={mutationsLocked}>Explore</button>
                <button onClick={onClearView} disabled={mutationsLocked || !hasView}>Clear View</button>
                <span className="ribbon-divider" aria-hidden="true" />
                <button onClick={onPythonMacro} disabled={busy || mutationsLocked}>Python Macro</button>
              </div>
            )}

            {activeMenu === "view" && (
              <div className="ribbon-group" aria-label="View actions">
                {tableAvailable && <><label className="ribbon-check"><input type="checkbox" checked={headerEnabled} disabled={busy || mutationsLocked} onChange={(event) => onHeaderChange?.(event.target.checked)} /> First row is header</label></>}
                <span className="ribbon-divider" aria-hidden="true" />
                <label className="ribbon-check"><input type="checkbox" checked={theme === "dark"} onChange={(event) => onThemeChange?.(event.target.checked ? "dark" : "light")} /> Dark mode</label>
                <span className="ribbon-divider" aria-hidden="true" />
                {tableAvailable && <>
                <button onClick={onFind}>Find</button>
                <button onClick={onToggleExplorer} disabled={mutationsLocked}>Data Explorer</button>
                <button onClick={onResetCellSizing} disabled={busy || !hasCustomSizing}>Reset Cell Size</button>
                {onZoomChange && <div className="sheet-zoom-controls" role="group" aria-label="Sheet zoom">
                  <button aria-label="Zoom out" disabled={zoom <= MIN_SHEET_ZOOM} onClick={() => onZoomChange(clampSheetZoom(zoom - 0.1))}>−</button>
                  <label>Zoom <select aria-label="Sheet zoom level" value={Math.round(zoom * 100)} onChange={event => onZoomChange(Number(event.target.value) / 100)}>
                    {[...new Set([25, 50, 75, 100, 125, 150, 175, 200, 250, 300, Math.round(zoom * 100)])].sort((a, b) => a - b).map(value => <option key={value} value={value}>{value}%</option>)}
                  </select></label>
                  <button aria-label="Zoom in" disabled={zoom >= MAX_SHEET_ZOOM} onClick={() => onZoomChange(clampSheetZoom(zoom + 0.1))}>+</button>
                  <button disabled={zoom === 1} onClick={() => onZoomChange(1)}>Reset Zoom</button>
                </div>}

                </>}
              </div>
            )}

            <span className={`ribbon-status${error ? " error" : ""}`} role="status">
              {busy ? "Working…" : error ?? "Ready"}
            </span>
          </div>

          <label className="pin-control">
            <input type="checkbox" checked={pinned} onChange={handlePinChange} />
            Pin
          </label>
        </section>
      </div>
    </section>
  );
}
