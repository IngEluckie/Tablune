import {
  type FocusEvent,
  useEffect,
  useRef,
  useState,
} from "react";

type MenuSection = "file" | "edit" | "data" | "view";

const PIN_STORAGE_KEY = "tablune.ribbonPinned";
const CLOSE_DELAY_MS = 180;

const MENUS: Array<{ id: MenuSection; label: string }> = [
  { id: "file", label: "File" },
  { id: "edit", label: "Edit" },
  { id: "data", label: "Data" },
  { id: "view", label: "View" },
];

interface RibbonHeaderProps {
  documentName: string;
  dirty: boolean;
  busy: boolean;
  error: string | null;
  delimiter: string;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onDelimiterChange: (delimiter: string) => void;
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
  documentName,
  dirty,
  busy,
  error,
  delimiter,
  onNew,
  onOpen,
  onSave,
  onSaveAs,
  onDelimiterChange,
}: RibbonHeaderProps) {
  const [activeMenu, setActiveMenu] = useState<MenuSection>("file");
  const [pointerOpen, setPointerOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [pinned, setPinned] = useState(readPinnedPreference);
  const closeTimer = useRef<number | null>(null);

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

  useEffect(() => () => cancelScheduledClose(), []);

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
          {MENUS.map((menu) => (
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
          <span className="header-document" title={documentName}>
            {dirty && <span className="dirty-dot" aria-label="Unsaved changes">●</span>}
            {documentName}
          </span>
          <span className="identity-divider" aria-hidden="true" />
          <span className="compact-brand-mark" aria-hidden="true">T</span>
          <span className="compact-brand-name"><strong>Tablune</strong> Sheets</span>
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
                <button onClick={onNew} disabled={busy}>New</button>
                <button onClick={onOpen} disabled={busy}>Open</button>
                <button onClick={onSave} disabled={busy}>Save</button>
                <button onClick={onSaveAs} disabled={busy}>Save As</button>
              </div>
            )}

            {activeMenu === "edit" && (
              <div className="ribbon-group" aria-label="Edit actions">
                <button disabled>Undo</button>
                <button disabled>Redo</button>
                <span className="ribbon-divider" aria-hidden="true" />
                <button disabled>Cut</button>
                <button disabled>Copy</button>
                <button disabled>Paste</button>
              </div>
            )}

            {activeMenu === "data" && (
              <div className="ribbon-group" aria-label="Data actions">
                <label className="delimiter-control">
                  Delimiter
                  <select
                    value={delimiter}
                    onChange={(event) => onDelimiterChange(event.target.value)}
                  >
                    <option value=",">Comma</option>
                    <option value=";">Semicolon</option>
                    <option value={"\t"}>Tab</option>
                    <option value="|">Pipe</option>
                  </select>
                </label>
                <span className="ribbon-divider" aria-hidden="true" />
                <button disabled>Insert Row</button>
                <button disabled>Delete Row</button>
                <button disabled>Insert Column</button>
                <button disabled>Delete Column</button>
              </div>
            )}

            {activeMenu === "view" && (
              <div className="ribbon-group" aria-label="View actions">
                <button disabled aria-label="Zoom out">−</button>
                <button disabled>100%</button>
                <button disabled aria-label="Zoom in">+</button>
                <span className="ribbon-divider" aria-hidden="true" />
                <button disabled>Fit Columns</button>
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
