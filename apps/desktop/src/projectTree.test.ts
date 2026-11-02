import { expect, it } from "vitest";
import { entryAncestors, moveDestinations, projectEntries, projectItemPath, visibleProjectEntries, type ProjectEntry } from "./projectTree";
import type { ProjectSummary } from "./types";

const entries: ProjectEntry[] = [
  { id: "a", name: "Datos", kind: "folder", parentId: null },
  { id: "b", name: "Origen", kind: "folder", parentId: "a" },
  { id: "t", name: "Table", kind: "table", parentId: "b" },
  { id: "d", name: "Notas.md", kind: "markdown", parentId: "a" },
  { id: "s", name: "Clean.py", kind: "script", parentId: "a" },
  { id: "c", name: "Archivo", kind: "folder", parentId: null },
];
it("keeps mixed content in its actual parent and sorts folders first", () => {
  expect(visibleProjectEntries(entries, new Set()).map(e => e.id)).toEqual(["c", "a"]);
  const visible = visibleProjectEntries(entries, new Set(["a", "b"]));
  expect(visible.map(e => [e.id, e.depth])).toEqual([["c", 0], ["a", 0], ["b", 1], ["t", 2], ["s", 1], ["d", 1]]);
});
it("excludes the dragged folder and every descendant from possible move destinations", () => {
  expect(moveDestinations(entries, "a").map(e => e.id)).toEqual(["c"]);
  expect(moveDestinations(entries, "t").map(e => e.id)).toEqual(["a", "b", "c"]);
  expect(entryAncestors(entries, "t")).toEqual(["a", "b"]);
});
it("supports old projects with no organization and follows new paths without changing IDs", () => {
  const project: ProjectSummary = { projectId: 1, persistentId: "p", name: "Project", path: null, dirty: false, revision: "0", tables: [], scripts: [{ id: "s", name: "Clean.py", code: "", revision: 0, inputTableId: null }] };
  expect(projectItemPath(project, "s")).toBe("Clean.py");
  project.organization = { folders: [{ id: "a", name: "Procesos", parentId: null }], itemFolders: { s: "a" } };
  expect(projectItemPath(project, "s")).toBe("Procesos / Clean.py");
  expect(projectEntries(project).find(e => e.id === "s")?.kind).toBe("script");
});
