import { useEffect } from "react";
import { documentTabLabels } from "./DocumentTabs";
import type { DocumentSummary } from "./types";

interface UnsavedChangesDialogProps {
  documents: DocumentSummary[];
  allDocuments?: DocumentSummary[];
  closingApplication: boolean;
  working?: boolean;
  error?: string | null;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export default function UnsavedChangesDialog({
  documents,
  allDocuments = documents,
  closingApplication,
  working = false,
  error,
  onSave,
  onDiscard,
  onCancel,
}: UnsavedChangesDialogProps) {
  const labels = documentTabLabels(allDocuments);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !working) onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, working]);

  const multiple = closingApplication;
  return (
    <div className="unsaved-backdrop">
      <section className="unsaved-dialog" role="dialog" aria-modal="true" aria-labelledby="unsaved-title">
        <h1 id="unsaved-title">{multiple ? "Save changes before closing?" : "Save changes before closing this tab?"}</h1>
        <p>{multiple
          ? "These documents contain changes that have not been saved."
          : `${labels.get(documents[0]?.documentId) ?? "This document"} contains changes that have not been saved.`}</p>
        {multiple && (
          <ul>
            {documents.map((document) => <li key={document.documentId}>{labels.get(document.documentId)}</li>)}
          </ul>
        )}
        {error && <p className="unsaved-error" role="alert">{error}</p>}
        <div className="unsaved-actions">
          <button type="button" disabled={working} onClick={onCancel}>Cancel</button>
          <button type="button" className="danger" disabled={working} onClick={onDiscard}>
            {multiple ? "Discard all" : "Discard"}
          </button>
          <button type="button" className="primary" autoFocus disabled={working} onClick={onSave}>
            {working ? "Saving…" : multiple ? "Save all" : "Save"}
          </button>
        </div>
      </section>
    </div>
  );
}
