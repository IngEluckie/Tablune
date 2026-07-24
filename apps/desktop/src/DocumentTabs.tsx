import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { DocumentId, DocumentSummary } from "./types";

interface DocumentTabsProps {
  documents: DocumentSummary[];
  activeDocumentId: DocumentId;
  disabled?: boolean;
  onActivate: (documentId: DocumentId) => void;
  onClose: (documentId: DocumentId) => void;
  onNew: () => void;
  onReorder: (documentIds: DocumentId[]) => void;
}

function pathParts(path: string): string[] {
  return path.split(/[\\/]/).filter(Boolean);
}

function numberedName(name: string, number: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? `${name.slice(0, dot)} (${number})${name.slice(dot)}`
    : `${name} (${number})`;
}

export function documentTabLabels(documents: DocumentSummary[]): Map<DocumentId, string> {
  const labels = new Map<DocumentId, string>();
  const groups = new Map<string, DocumentSummary[]>();
  for (const document of documents) {
    const key = document.displayName.toLocaleLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), document]);
  }

  for (const group of groups.values()) {
    if (group.length === 1) {
      labels.set(group[0].documentId, group[0].displayName);
      continue;
    }
    const unsaved = group.filter((document) => !document.path);
    unsaved.forEach((document, index) => {
      labels.set(document.documentId, index === 0
        ? document.displayName
        : numberedName(document.displayName, index + 1));
    });

    const saved = group.filter((document) => document.path);
    const candidates = saved.map((document) => {
      const parts = pathParts(document.path ?? "");
      const parent = parts.at(-2) ?? document.path ?? "";
      return { document, parent, path: document.path ?? "" };
    });
    candidates.forEach(({ document, parent, path }) => {
      const parentIsUnique = candidates.filter((candidate) => candidate.parent === parent).length === 1;
      labels.set(document.documentId, parentIsUnique
        ? `${document.displayName} — ${parent}`
        : `${document.displayName} — ${path}`);
    });
  }
  return labels;
}

function movedOrder(documents: DocumentSummary[], documentId: DocumentId, targetIndex: number): DocumentId[] {
  const ids = documents.map((document) => document.documentId);
  const sourceIndex = ids.indexOf(documentId);
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= ids.length || sourceIndex === targetIndex) return ids;
  ids.splice(sourceIndex, 1);
  ids.splice(targetIndex, 0, documentId);
  return ids;
}

export default function DocumentTabs({
  documents,
  activeDocumentId,
  disabled = false,
  onActivate,
  onClose,
  onNew,
  onReorder,
}: DocumentTabsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<DocumentId, HTMLButtonElement>());
  const [listOpen, setListOpen] = useState(false);
  const [draggedId, setDraggedId] = useState<DocumentId | null>(null);
  const labels = useMemo(() => documentTabLabels(documents), [documents]);

  useEffect(() => {
    tabRefs.current.get(activeDocumentId)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeDocumentId, documents]);

  useEffect(() => {
    if (!listOpen) return;
    const close = (event: globalThis.MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".document-tabs-menu")) setListOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [listOpen]);

  const handleDrop = (event: DragEvent, targetIndex: number) => {
    event.preventDefault();
    const documentId = draggedId ?? Number(event.dataTransfer.getData("text/plain"));
    setDraggedId(null);
    const next = movedOrder(documents, documentId, targetIndex);
    if (next.some((id, index) => id !== documents[index].documentId)) onReorder(next);
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, documentId: DocumentId) => {
    if (disabled || !event.altKey || !event.shiftKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const index = documents.findIndex((document) => document.documentId === documentId);
    const target = event.key === "ArrowLeft" ? index - 1 : index + 1;
    const next = movedOrder(documents, documentId, target);
    if (next.some((id, position) => id !== documents[position].documentId)) onReorder(next);
  };

  return (
    <nav className="document-tabs" aria-label="Open documents">
      <button
        type="button"
        className="tab-scroll-button"
        aria-label="Scroll tabs left"
        disabled={disabled}
        onClick={() => scrollRef.current?.scrollBy({ left: -240, behavior: "smooth" })}
      >‹</button>
      <div className="document-tabs-scroll" ref={scrollRef} role="tablist">
        {documents.map((document, index) => (
          <div
            key={document.documentId}
            className={`document-tab${document.documentId === activeDocumentId ? " active" : ""}${draggedId === document.documentId ? " dragging" : ""}`}
            draggable={!disabled}
            onDragStart={(event) => {
              setDraggedId(document.documentId);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", String(document.documentId));
            }}
            onDragEnd={() => setDraggedId(null)}
            onDragOver={(event) => { if (!disabled) event.preventDefault(); }}
            onDrop={(event) => { if (!disabled) handleDrop(event, index); }}
          >
            <button
              ref={(node) => {
                if (node) tabRefs.current.set(document.documentId, node);
                else tabRefs.current.delete(document.documentId);
              }}
              type="button"
              role="tab"
              aria-selected={document.documentId === activeDocumentId}
              className="document-tab-main"
              title={document.path ?? "Unsaved document"}
              disabled={disabled}
              onClick={() => onActivate(document.documentId)}
              onAuxClick={(event) => { if (event.button === 1) onClose(document.documentId); }}
              onKeyDown={(event) => handleTabKeyDown(event, document.documentId)}
            >
              <span className="document-tab-label">{labels.get(document.documentId)}</span>
              {document.dirty && <span className="document-tab-dirty" aria-label="Unsaved changes">●</span>}
            </button>
            <button
              type="button"
              className="document-tab-close"
              aria-label={`Close ${labels.get(document.documentId)}`}
              disabled={disabled}
              onClick={() => onClose(document.documentId)}
            >×</button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="tab-scroll-button"
        aria-label="Scroll tabs right"
        disabled={disabled}
        onClick={() => scrollRef.current?.scrollBy({ left: 240, behavior: "smooth" })}
      >›</button>
      <button type="button" className="tab-action-button" aria-label="New document" disabled={disabled} onClick={onNew}>＋</button>
      <div className="document-tabs-menu">
        <button
          type="button"
          className="tab-action-button"
          aria-label="List all documents"
          aria-expanded={listOpen}
          disabled={disabled}
          onClick={() => setListOpen((open) => !open)}
        >☰</button>
        {listOpen && (
          <div className="document-tabs-list" role="menu">
            {documents.map((document) => (
              <button
                key={document.documentId}
                type="button"
                role="menuitem"
                className={document.documentId === activeDocumentId ? "active" : ""}
                title={document.path ?? "Unsaved document"}
                onClick={() => {
                  setListOpen(false);
                  onActivate(document.documentId);
                }}
              >
                <span>{labels.get(document.documentId)}</span>
                {document.dirty && <span aria-label="Unsaved changes">●</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}
