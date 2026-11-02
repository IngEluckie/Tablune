import { type ReactNode, useId, useRef, useState } from "react";

const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const WIDTH_KEY = "tablune.sidebarWidth";
const COLLAPSED_KEY = "tablune.sidebarCollapsed";
const clamp = (width: number) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));

function readWidth() {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return stored > 0 && Number.isFinite(stored) ? clamp(stored) : 230;
  } catch { return 230; }
}
function readCollapsed() {
  try { return localStorage.getItem(COLLAPSED_KEY) === "true"; }
  catch { return false; }
}
function persist(key: string, value: number | boolean) {
  try { localStorage.setItem(key, String(value)); }
  catch { /* Keep the preference for this session when storage is unavailable. */ }
}

export default function ProjectSidebar({ label, children, footer, editor, editorTitle, onCloseEditor }: {
  label: string;
  children: ReactNode;
  footer?: ReactNode;
  editor?: ReactNode;
  editorTitle?: string;
  onCloseEditor?: () => void;
}) {
  const [width, setWidth] = useState(readWidth);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const contentId = useId();
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const minWidth = editorTitle ? 360 : MIN_WIDTH;
  const displayWidth = Math.max(minWidth, width);
  const resize = (next: number) => {
    const value = Math.max(minWidth, clamp(next));
    setWidth(value);
    persist(WIDTH_KEY, value);
  };
  return (
    <div className={`project-sidebar${collapsed ? " collapsed" : ""}${editorTitle ? " editing-python" : ""}`} style={{ width: collapsed ? 30 : `min(${displayWidth}px, 45vw)` }}>
      <div className="sidebar-heading">
        {!collapsed && editorTitle && <>
          <button className="sidebar-back" onClick={onCloseEditor} title="Back to project items" aria-label="Back to project items">←</button>
          <strong className="sidebar-editor-title" title={editorTitle}>{editorTitle}</strong>
        </>}
        <button
          className="sidebar-toggle"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          aria-controls={contentId}
          onClick={() => {
            setCollapsed(!collapsed);
            persist(COLLAPSED_KEY, !collapsed);
          }}
        >{collapsed ? "›" : "‹"}</button>
      </div>
      <aside id={contentId} className="project-navigator" aria-label={label} hidden={collapsed}>
        <div className="project-navigator-content" hidden={Boolean(editorTitle)}>{children}</div>
        <div className="sidebar-editor" hidden={!editorTitle}>{editor}</div>
        {footer}
      </aside>
      {!collapsed && <div
        className="sidebar-resizer"
        role="separator"
        aria-label="Sidebar width"
        aria-orientation="vertical"
        aria-valuemin={minWidth}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={displayWidth}
        aria-controls={contentId}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          drag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            width: event.currentTarget.parentElement!.getBoundingClientRect().width,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current?.pointerId === event.pointerId) {
            resize(drag.current.width + event.clientX - drag.current.x);
          }
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { drag.current = null; }}
        onLostPointerCapture={() => { drag.current = null; }}
        onKeyDown={(event) => {
          const next = event.key === "ArrowLeft" ? displayWidth - 10
            : event.key === "ArrowRight" ? displayWidth + 10
            : event.key === "Home" ? minWidth
            : event.key === "End" ? MAX_WIDTH : null;
          if (next === null) return;
          event.preventDefault();
          resize(next);
        }}
      />}
    </div>
  );
}
