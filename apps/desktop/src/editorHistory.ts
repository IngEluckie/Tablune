import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

export interface EditorHistory {
  id: string;
  scope: string;
  canUndo: boolean;
  canRedo: boolean;
  disabled?: boolean;
  undo: () => void;
  redo: () => void;
}
type Entry = EditorHistory & { visible: () => boolean };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let active: string | undefined;
let version = 0;
const emit = () => { version++; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => version;

/** A type-specific history engine registers commands; the shared bar routes by focus. */
export function useEditorHistory(history: EditorHistory) {
  const root = useRef<HTMLElement | null>(null);
  const latest = useRef(history); latest.current = history;
  useLayoutEffect(() => {
    if (!history.id) return;
    const entry: Entry = {
      ...history,
      undo: () => latest.current.undo(), redo: () => latest.current.redo(),
      visible: () => !!root.current && !root.current.closest("[hidden]"),
    };
    entries.set(history.id, entry); emit();
    return () => { if (entries.get(history.id) === entry) { entries.delete(history.id); emit(); } };
  }, [history.id, history.scope, history.canUndo, history.canRedo, history.disabled]);
  return {
    ref: (element: HTMLElement | null) => { root.current = element; },
    onFocusCapture: () => { if (active !== history.id) { active = history.id; emit(); } },
    onPointerDownCapture: () => { if (active !== history.id) { active = history.id; emit(); } },
  };
}

export function useActiveEditorHistory(scope: string, fallback?: string) {
  useSyncExternalStore(subscribe, snapshot);
  const resolve = () => {
    const eligible = (entry?: Entry) => entry?.scope === scope && entry.visible();
    const focused = active ? entries.get(active) : undefined;
    if (eligible(focused)) return focused;
    const preferred = fallback ? entries.get(fallback) : undefined;
    return eligible(preferred) ? preferred : [...entries.values()].find(entry => eligible(entry));
  };
  const selected = resolve();
  // Visibility changes are committed after render (tabs keep their editors mounted).
  useLayoutEffect(() => { if (resolve()?.id !== selected?.id) emit(); });
  return selected;
}
