import { useEffect, useSyncExternalStore } from "react";
import { useActiveEditorHistory, type EditorHistory } from "./editorHistory";
import type { SaveCoordinator } from "./saveCoordinator";

export function HistoryButtons({ history }: { history?: Pick<EditorHistory, "canUndo" | "canRedo" | "disabled" | "undo" | "redo"> }) {
  return <span className="history-actions">
    <button type="button" aria-label="Undo" title="Deshacer (Ctrl/Cmd+Z)" disabled={!history?.canUndo || history.disabled} onMouseDown={e => e.preventDefault()} onClick={() => history?.undo()}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12" transform="translate(0 -2)" /></svg>
    </button>
    <button type="button" aria-label="Redo" title="Rehacer (Ctrl/Cmd+Shift+Z · Ctrl+Y)" disabled={!history?.canRedo || history.disabled} onMouseDown={e => e.preventDefault()} onClick={() => history?.redo()}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12" transform="translate(0 -2)" /></svg>
    </button>
  </span>;
}

export default function DocumentActions({ coordinator, targetId, editorId, disabled }: { coordinator: SaveCoordinator; targetId: string; editorId?: string; disabled?: boolean }) {
  useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot);
  const history = useActiveEditorHistory(targetId, editorId);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || disabled || history?.disabled || !(event.ctrlKey || event.metaKey)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable=true]")) return;
      const key = event.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      const redo = key === "y" || event.shiftKey;
      if (!history || !(redo ? history.canRedo : history.canUndo)) return;
      event.preventDefault();
      if (redo) history.redo(); else history.undo();
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [history, disabled]);
  const status = coordinator.status(targetId);
  if (!status) return null;
  const label = { saved: "Guardado", pending: "Cambios pendientes", saving: "Guardando…", location: "Pendiente de ubicación", error: "Error al guardar" }[status.state];
  return <div className="document-actions" role="toolbar" aria-label="Guardado e historial">
    <HistoryButtons history={history && { ...history, disabled: disabled || history.disabled }} />
    <span className="toolbar-divider" />
    <label className="autosave-control" title="Se aplica al archivo completo, incluidos todos los documentos del proyecto">
      <input type="checkbox" role="switch" checked={status.enabled} disabled={disabled} onChange={e => coordinator.setEnabled(targetId, e.target.checked)} />
      Autoguardado
    </label>
    <span className={`save-status save-status-${status.state}`} role="status" title={status.error ?? (status.state === "location" ? "Elige una ubicación con Guardar. La recuperación local sigue disponible." : undefined)}>{label}</span>
    {status.state === "error" && <button disabled={disabled} title={status.error} onClick={() => coordinator.retry(targetId)}>Reintentar</button>}
  </div>;
}
