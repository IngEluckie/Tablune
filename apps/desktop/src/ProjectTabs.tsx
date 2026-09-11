import { useEffect, useRef, useState } from "react";
import type { ProjectTab } from "./useWorkspace";

const tabKey = (tab: ProjectTab) => `${tab.kind}:${tab.id}`;
interface Props {
  tabs: Array<ProjectTab & { name: string }>;
  active: ProjectTab | null | undefined;
  disabled?: boolean;
  onActivate: (tab: ProjectTab) => void;
  onClose: (tab: ProjectTab) => void;
  onNew: () => void;
}

export default function ProjectTabs({ tabs, active, disabled, onActivate, onClose, onNew }: Props) {
  const scroll = useRef<HTMLDivElement>(null);
  const selected = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [listOpen, setListOpen] = useState(false);
  const activeKey = active ? tabKey(active) : null;
  const keys = tabs.map(tabKey).join("|");
  useEffect(() => {
    selected.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeKey, keys]);
  useEffect(() => {
    if (!listOpen) return;
    const close = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setListOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [listOpen]);
  return (
    <nav className="document-tabs project-editor-tabs" aria-label="Project editors">
      <button className="tab-scroll-button" aria-label="Scroll tabs left" onClick={() => scroll.current?.scrollBy({ left: -240, behavior: "smooth" })}>‹</button>
      <div className="document-tabs-scroll" role="tablist" aria-label="Project editors" ref={scroll}>
        {tabs.map((tab) => {
          const current = tabKey(tab) === activeKey;
          return <div className={`document-tab${current ? " active" : ""}`} key={tabKey(tab)}>
            <button className="document-tab-main" role="tab" aria-selected={current} title={tab.name}
              ref={current ? selected : undefined} onClick={() => onActivate(tab)}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const index = tabs.indexOf(tab);
                const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
                  : (index + (event.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length;
                onActivate(tabs[next]);
                const buttons = scroll.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
                buttons?.[next]?.focus();
              }}>
              <span className="document-tab-label">{tab.name}</span>
            </button>
            <button className="document-tab-close" aria-label={`Close ${tab.name} editor`} onClick={() => onClose(tab)}>×</button>
          </div>;
        })}
      </div>
      <button className="tab-scroll-button" aria-label="Scroll tabs right" onClick={() => scroll.current?.scrollBy({ left: 240, behavior: "smooth" })}>›</button>
      <button className="tab-action-button" aria-label="New table" title="New table" disabled={disabled} onClick={onNew}>＋</button>
      <div className="document-tabs-menu" ref={menu} onKeyDown={(event) => {
        if (event.key === "Escape") { setListOpen(false); menuButton.current?.focus(); }
      }}>
        <button className="tab-action-button" ref={menuButton} aria-label="List all project tabs" title="List all project tabs" aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>☰</button>
        {listOpen && <div className="document-tabs-list" role="menu" aria-label="Project tabs">
          {tabs.map((tab) => <button role="menuitem" key={tabKey(tab)} title={tab.name}
            className={tabKey(tab) === activeKey ? "active" : ""}
            onClick={() => { setListOpen(false); onActivate(tab); }}><span>{tab.name}</span></button>)}
        </div>}
      </div>
    </nav>
  );
}
