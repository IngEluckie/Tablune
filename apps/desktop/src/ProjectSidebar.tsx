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

export default function ProjectSidebar({ label, children }: { label: string; children: ReactNode }) {
  const [width, setWidth] = useState(readWidth);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const contentId = useId();
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const resize = (next: number) => {
    const value = clamp(next);
    setWidth(value);
    persist(WIDTH_KEY, value);
  };
  return (
    <div className={`project-sidebar${collapsed ? " collapsed" : ""}`} style={{ width: collapsed ? 30 : `min(${width}px, 45vw)` }}>
      <div className="sidebar-heading">
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
        {children}
      </aside>
      {!collapsed && <div
        className="sidebar-resizer"
        role="separator"
        aria-label="Sidebar width"
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={width}
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
          const next = event.key === "ArrowLeft" ? width - 10
            : event.key === "ArrowRight" ? width + 10
            : event.key === "Home" ? MIN_WIDTH
            : event.key === "End" ? MAX_WIDTH : null;
          if (next === null) return;
          event.preventDefault();
          resize(next);
        }}
      />}
    </div>
  );
}
