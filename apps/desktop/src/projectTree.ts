import type { ProjectSummary } from "./types";

export type ProjectEntryKind = "folder" | "table" | "markdown" | "script";
export interface ProjectEntry { id: string; name: string; kind: ProjectEntryKind; parentId: string | null; }
export function projectEntries(project: ProjectSummary): ProjectEntry[] {
  const organization = project.organization;
  const parent = (id: string) => organization?.itemFolders[id] ?? null;
  return [
    ...(organization?.folders ?? []).map(f => ({ ...f, kind: "folder" as const })),
    ...project.tables.map(t => ({ id: t.id, name: t.document.displayName, kind: "table" as const, parentId: parent(t.id) })),
    ...(project.markdown ?? []).map(d => ({ id: d.id, name: d.name, kind: "markdown" as const, parentId: parent(d.id) })),
    ...project.scripts.map(s => ({ id: s.id, name: s.name, kind: "script" as const, parentId: parent(s.id) })),
  ];
}
export function entryAncestors(entries: ProjectEntry[], id: string): string[] {
  const byId = new Map(entries.map(e => [e.id, e]));
  const result: string[] = [], seen = new Set([id]);
  let parent = byId.get(id)?.parentId;
  while (parent && !seen.has(parent) && result.length < 64) {
    seen.add(parent); result.unshift(parent); parent = byId.get(parent)?.parentId;
  }
  return result;
}
export function projectItemPath(project: ProjectSummary, id: string): string {
  const entries = projectEntries(project), byId = new Map(entries.map(e => [e.id, e]));
  return [...entryAncestors(entries, id), id].map(id => byId.get(id)?.name).filter(Boolean).join(" / ");
}
export function moveDestinations(entries: ProjectEntry[], id: string) {
  const children = new Map<string, string[]>();
  for (const entry of entries) if (entry.parentId) { const group = children.get(entry.parentId) ?? []; group.push(entry.id); children.set(entry.parentId, group); }
  const excluded = new Set<string>(), pending = [id];
  while (pending.length) { const next = pending.pop()!; if (excluded.has(next)) continue; excluded.add(next); pending.push(...children.get(next) ?? []); }
  return entries.filter(e => e.kind === "folder" && !excluded.has(e.id));
}
export function projectEntryPaths(entries: ProjectEntry[]) {
  const byId = new Map(entries.map(e => [e.id, e]));
  const paths = new Map<string, string>();
  for (const entry of entries) {
    const names = [entry.name], seen = new Set([entry.id]);
    let parent = entry.parentId;
    while (parent && !seen.has(parent) && names.length <= 64) { seen.add(parent); const folder = byId.get(parent); if (!folder) break; names.unshift(folder.name); parent = folder.parentId; }
    paths.set(entry.id, names.join(" / "));
  }
  return paths;
}
export function visibleProjectEntries(entries: ProjectEntry[], expanded: Set<string>) {
  const children = new Map<string | null, ProjectEntry[]>();
  for (const entry of entries) { const group = children.get(entry.parentId) ?? []; group.push(entry); children.set(entry.parentId, group); }
  const result: Array<ProjectEntry & { depth: number }> = [], seen = new Set<string>();
  const visit = (parent: string | null, depth: number) => {
    if (depth > 64) return;
    const group = children.get(parent) ?? [];
    group.sort((a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const entry of group) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id); result.push({ ...entry, depth });
      if (entry.kind === "folder" && expanded.has(entry.id)) visit(entry.id, depth + 1);
    }
  };
  visit(null, 0); return result;
}
