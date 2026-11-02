import { type DragEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { entryAncestors, moveDestinations, projectEntries, projectEntryPaths, visibleProjectEntries, type ProjectEntry, type ProjectEntryKind } from "./projectTree";
import type { ProjectAction, ProjectSummary } from "./types";
import type { ProjectTab } from "./useWorkspace";

const DRAG_TYPE = "application/x-tablune-project-item";
const labels = { folder: "Carpeta", table: "Tabla", markdown: "Documento", script: "Script" };
type Dialog = { kind: "create" | "rename" | "move"; id: string | null; parentId: string | null };
function readState(key: string): { expanded: string[]; selected: string | null; restored: boolean } {
  try { const state = JSON.parse(localStorage.getItem(key) ?? "null"); if (Array.isArray(state?.expanded)) return { expanded: state.expanded.filter((id: unknown) => typeof id === "string"), selected: typeof state.selected === "string" ? state.selected : null, restored: true }; } catch { /* Use an empty explorer when storage is unavailable. */ }
  return { expanded: [], selected: null, restored: false };
}
function ItemIcon({ kind, open }: { kind: ProjectEntryKind; open?: boolean }) {
  return kind === "folder" ? <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d={open ? "M2 7V4.5h6l2 2h7v2M2 8.5h16l-2 7H3z" : "M2 5h6l2 2h7v9H2z"} /></svg> : <span aria-hidden="true">{kind === "table" ? "▤" : kind === "markdown" ? "▧" : "⌘"}</span>;
}
export default function ProjectExplorer({ project, active, editor, disabled, onAction, onOpen, onCreate, onImport, onRename, onDelete, onExport, onDuplicate, onFunctions }: {
  project: ProjectSummary;
  active?: ProjectTab | null;
  editor?: ProjectTab | null;
  disabled: boolean;
  onAction: (action: ProjectAction) => Promise<ProjectSummary>;
  onOpen: (tab: ProjectTab) => void;
  onCreate: (kind: Exclude<ProjectEntryKind, "folder">, parentId: string | null) => void;
  onImport: (kind: Exclude<ProjectEntryKind, "folder">, parentId: string | null) => void;
  onRename: (tab: ProjectTab) => void;
  onDelete: (tab: ProjectTab) => void;
  onExport: (tab: ProjectTab) => void;
  onDuplicate: (tableId: string) => void;
  onFunctions: () => void;
}) {
  const key = `tablune.explorer.${project.persistentId}`;
  const restoredState = useRef(readState(key));
  const previousOpening = useRef<{ initialized: boolean; active?: string; editor?: string }>({ initialized: false });
  const [expanded, setExpanded] = useState(() => new Set(readState(key).expanded));
  const [selected, setSelected] = useState<string | null>(() => readState(key).selected);
  const [menu, setMenu] = useState<{ id: string | null; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined);
  const treeRef = useRef<HTMLDivElement>(null), menuRef = useRef<HTMLDivElement>(null), fieldRef = useRef<HTMLInputElement>(null);
  const entries = useMemo(() => projectEntries(project), [project]);
  const paths = useMemo(() => projectEntryPaths(entries), [entries]);
  const path = (id: string) => paths.get(id) ?? "";
  const visible = visibleProjectEntries(entries, expanded);
  const selectedEntry = entries.find(e => e.id === selected);
  const parentId = selectedEntry?.kind === "folder" ? selectedEntry.id : selectedEntry?.parentId ?? null;
  const locked = disabled || working;
  const tabStop = visible.some(e => e.id === selected) ? selected : visible[0]?.id;
  useEffect(() => {
    const previous = previousOpening.current;
    const restoring = !previous.initialized && restoredState.current.restored;
    const opening = editor?.kind !== "functions" && editor?.id && editor.id !== previous.editor ? editor.id : active?.id !== previous.active ? active?.id : undefined;
    previousOpening.current = { initialized: true, active: active?.id, editor: editor?.id };
    if (!opening || restoring) return;
    setSelected(opening);
    setExpanded(current => new Set([...current, ...entryAncestors(projectEntries(project), opening)]));
    // Opening an editor reveals its ancestors; ordinary folder selection stays independent.
  }, [active?.id, editor?.id]);
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify({ expanded: [...expanded], selected })); } catch { /* Preserve the in-memory state. */ }
  }, [key, expanded, selected]);
  useEffect(() => { if (dialog) fieldRef.current?.focus(); }, [dialog]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);
  const toggle = (id: string, open?: boolean) => setExpanded(current => { const next = new Set(current); (open ?? !next.has(id)) ? next.add(id) : next.delete(id); return next; });
  const focusItem = (id: string) => treeRef.current?.querySelector<HTMLButtonElement>(`[data-entry-id="${id}"]`)?.focus();
  const openEntry = (entry: ProjectEntry) => { setSelected(entry.id); if (entry.kind === "folder") toggle(entry.id); else onOpen({ kind: entry.kind, id: entry.id }); };
  const startDialog = (kind: Dialog["kind"], entry: ProjectEntry | undefined) => {
    setError(""); setMenu(null); setValue(kind === "create" ? "Nueva carpeta" : kind === "rename" ? entry?.name ?? "" : entry?.parentId ?? "");
    setDialog({ kind, id: entry?.id ?? null, parentId });
  };
  const run = async (action: ProjectAction) => { setWorking(true); setError(""); try { return await onAction(action); } catch (e) { setError(String(e)); return null; } finally { setWorking(false); } };
  const move = async (id: string, destination: string | null) => {
    const next = await run({ kind: "moveItem", itemId: id, folderId: destination });
    if (next) { setSelected(id); setExpanded(current => new Set([...current, ...entryAncestors(projectEntries(next), id)])); setDialog(null); }
  };
  const drop = (event: DragEvent, destination: string | null) => {
    event.preventDefault(); event.stopPropagation(); setDropTarget(undefined);
    if (locked) return;
    try { const item = JSON.parse(event.dataTransfer.getData(DRAG_TYPE)); if (item.projectId === project.projectId && entries.some(e => e.id === item.id)) void move(item.id, destination); } catch { /* Ignore external files and drags from another application. */ }
  };
  const dragOver = (event: DragEvent, destination: string | null) => {
    if (locked || !Array.from(event.dataTransfer.types).includes(DRAG_TYPE)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setDropTarget(destination);
  };
  const keyboard = (event: KeyboardEvent, entry: ProjectEntry) => {
    const index = visible.findIndex(e => e.id === entry.id);
    let next: string | undefined;
    if (event.key === "ArrowDown") next = visible[Math.min(index + 1, visible.length - 1)]?.id;
    else if (event.key === "ArrowUp") next = visible[Math.max(0, index - 1)]?.id;
    else if (event.key === "Home") next = visible[0]?.id;
    else if (event.key === "End") next = visible.at(-1)?.id;
    else if (event.key === "ArrowRight" && entry.kind === "folder") { if (!expanded.has(entry.id)) toggle(entry.id, true); else next = visible[index + 1]?.parentId === entry.id ? visible[index + 1].id : undefined; }
    else if (event.key === "ArrowLeft") { if (entry.kind === "folder" && expanded.has(entry.id)) toggle(entry.id, false); else next = entry.parentId ?? undefined; }
    else if (event.key === "F2" && !locked) { entry.kind === "folder" ? startDialog("rename", entry) : onRename({ kind: entry.kind, id: entry.id }); }
    else return;
    event.preventDefault(); event.stopPropagation(); if (next) { setSelected(next); focusItem(next); }
  };
  const menuEntry = entries.find(e => e.id === menu?.id);
  const current = entries.find(e => e.id === dialog?.id);
  const destinations = moveDestinations(entries, current?.id ?? "");
  return <div className="project-explorer">
    <div className="project-explorer-heading"><strong>EXPLORADOR</strong><div>
      <button disabled={locked} aria-label="Nuevo elemento" aria-haspopup="menu" onClick={event => { const r = event.currentTarget.getBoundingClientRect(); setMenu({ id: null, x: r.left, y: r.bottom }); }}>＋</button>
      <button aria-label="Contraer todas las carpetas" onClick={() => setExpanded(new Set())}>⊟</button>
    </div></div>
    <button className={`project-explorer-root${dropTarget === null ? " drop-target" : ""}`} aria-label={`Raíz de ${project.name}`} onClick={() => setSelected(null)} onDragOver={event => dragOver(event, null)} onDragLeave={() => setDropTarget(undefined)} onDrop={event => drop(event, null)}><ItemIcon kind="folder" open />{project.name}</button>
    {dialog && <form className="explorer-dialog" aria-label={dialog.kind === "create" ? "Nueva carpeta" : dialog.kind === "rename" ? "Renombrar carpeta" : "Mover elemento"} onSubmit={async event => {
      event.preventDefault(); if (locked) return;
      if (dialog.kind === "move" && current) { await move(current.id, value || null); return; }
      const next = await run(dialog.kind === "create" ? { kind: "createFolder", name: value, parentId: dialog.parentId } : { kind: "renameFolder", folderId: dialog.id!, name: value });
      if (next) { if (dialog.kind === "create") { const folder = next.organization?.folders.at(-1); if (folder) { setSelected(folder.id); setExpanded(current => new Set([...current, ...entryAncestors(projectEntries(next), folder.id), folder.id])); } } setDialog(null); }
    }} onKeyDown={event => { if (event.key === "Escape") { setDialog(null); event.stopPropagation(); } }}>
      <strong>{dialog.kind === "create" ? "Nueva carpeta" : dialog.kind === "rename" ? "Renombrar carpeta" : `Mover ${current?.name ?? "elemento"}`}</strong>
      {dialog.kind === "move" ? <label>Destino<select aria-label="Carpeta de destino" value={value} disabled={locked} onChange={e => setValue(e.target.value)}><option value="">{project.name} (raíz)</option>{destinations.map(f => <option key={f.id} value={f.id}>{path(f.id)}</option>)}</select></label>
        : <label>Nombre<input ref={fieldRef} aria-label="Nombre de carpeta" maxLength={240} required disabled={locked} value={value} onChange={e => setValue(e.target.value)} /></label>}
      {dialog.kind === "create" && <p>Dentro de: {dialog.parentId ? path(dialog.parentId) : project.name}</p>}
      <div><button disabled={locked} type="submit">{working ? "Guardando…" : dialog.kind === "move" ? "Mover" : "Guardar"}</button><button disabled={working} type="button" onClick={() => setDialog(null)}>Cancelar</button></div>
    </form>}
    {error && <p className="explorer-error" role="alert">{error}</p>}
    <div className="project-explorer-tree" ref={treeRef} role="tree" aria-label="Elementos del proyecto" onDragOver={event => { if (event.target === event.currentTarget) dragOver(event, null); }} onDrop={event => { if (event.target === event.currentTarget) drop(event, null); }}>
      {visible.map(entry => <div className={`project-tree-row${selected === entry.id ? " selected" : ""}${dropTarget === entry.id ? " drop-target" : ""}`} key={entry.id} style={{ paddingLeft: entry.depth * 14 }}
        onDragOver={event => { if (entry.kind === "folder") dragOver(event, entry.id); }} onDragLeave={() => setDropTarget(undefined)} onDrop={event => { if (entry.kind === "folder") drop(event, entry.id); }}
        onContextMenu={event => { event.preventDefault(); if (locked) return; setSelected(entry.id); setMenu({ id: entry.id, x: event.clientX, y: event.clientY }); }}>
        <button role="treeitem" data-entry-id={entry.id} aria-level={entry.depth + 1} aria-selected={selected === entry.id} aria-expanded={entry.kind === "folder" ? expanded.has(entry.id) : undefined}
          tabIndex={tabStop === entry.id ? 0 : -1} title={path(entry.id)} aria-label={`${labels[entry.kind]} ${entry.name}`} draggable={!locked}
          onDragStart={event => { if (locked) { event.preventDefault(); return; } event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ projectId: project.projectId, id: entry.id })); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDropTarget(undefined)}
          onClick={() => openEntry(entry)} onKeyDown={event => keyboard(event, entry)}>
          <span className="project-tree-chevron" aria-hidden="true">{entry.kind === "folder" ? expanded.has(entry.id) ? "⌄" : "›" : ""}</span><ItemIcon kind={entry.kind} open={expanded.has(entry.id)} /><span className="project-tree-name">{entry.name}</span>
        </button>
        <button className="project-tree-options" aria-label={`Opciones de ${entry.name}`} aria-haspopup="menu" disabled={locked} onClick={event => { const r = event.currentTarget.getBoundingClientRect(); setSelected(entry.id); setMenu({ id: entry.id, x: r.left, y: r.bottom }); }}>⋯</button>
      </div>)}
      {!entries.length && <p className="explorer-empty">Crea tu primera carpeta, tabla, documento o script con ＋.</p>}
    </div>
    <div className="project-explorer-tools"><button disabled={disabled} onClick={onFunctions}>ƒ Funciones del proyecto</button><span>{project.calculation?.running ? "Calculando…" : project.calculation?.paused ? "Cálculo en pausa" : project.tables.some(t => (t.document.pendingCells ?? 0) > 0) ? "Cálculo pendiente" : "Resultados al día"}</span></div>
    {menu && createPortal(<div ref={menuRef} className="project-explorer-menu" role="menu" aria-label={menuEntry ? `Opciones de ${menuEntry.name}` : "Crear en el proyecto"} style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 270)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 340)) }} onKeyDown={event => {
      if (event.key === "Escape") { setMenu(null); if (selected) focusItem(selected); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
    }}>
      <span>{menuEntry?.name ?? (parentId ? path(parentId) : project.name)}</span>
      {!menuEntry && <><button role="menuitem" disabled={locked} onClick={() => startDialog("create", undefined)}>Nueva carpeta</button>
        {(["table", "markdown", "script"] as const).map(kind => <button role="menuitem" disabled={locked} key={kind} onClick={() => { setMenu(null); onCreate(kind, parentId); }}>{kind === "table" ? "Nueva tabla" : kind === "markdown" ? "Nuevo documento" : "Nuevo script"}</button>)}
        <hr />{(["table", "markdown", "script"] as const).map(kind => <button role="menuitem" disabled={locked} key={kind} onClick={() => { setMenu(null); onImport(kind, parentId); }}>{kind === "table" ? "Importar CSV…" : kind === "markdown" ? "Importar Markdown…" : "Importar .py…"}</button>)}</>}
      {menuEntry && <><button role="menuitem" disabled={locked} onClick={() => startDialog("move", menuEntry)}>Mover a…</button><button role="menuitem" disabled={locked} onClick={() => { if (menuEntry.kind === "folder") startDialog("rename", menuEntry); else { setMenu(null); onRename({ kind: menuEntry.kind, id: menuEntry.id }); } }}>Renombrar</button>
        {menuEntry.kind !== "folder" && <button role="menuitem" disabled={locked} onClick={() => { setMenu(null); onExport({ kind: menuEntry.kind as "table" | "markdown" | "script", id: menuEntry.id }); }}>Exportar {menuEntry.kind === "table" ? "CSV" : menuEntry.kind === "markdown" ? "Markdown" : ".py"}…</button>}
        {menuEntry.kind === "table" && <button role="menuitem" disabled={locked} onClick={() => { setMenu(null); onDuplicate(menuEntry.id); }}>Duplicar tabla</button>}
        {menuEntry.kind === "folder" ? <button role="menuitem" disabled={locked} onClick={() => { setMenu(null); void run({ kind: "removeFolder", folderId: menuEntry.id }).then(next => { if (next) setSelected(menuEntry.parentId); }); }}>Quitar carpeta y conservar contenido</button>
          : <button role="menuitem" disabled={locked} onClick={() => { setMenu(null); onDelete({ kind: menuEntry.kind as "table" | "markdown" | "script", id: menuEntry.id }); }}>Eliminar elemento…</button>}</>}
    </div>, treeRef.current?.closest(".product-shell") ?? document.body)}
  </div>;
}
