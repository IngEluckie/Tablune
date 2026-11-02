// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ProjectExplorer from "./ProjectExplorer";
import type { ComponentProps } from "react";
import type { ProjectSummary } from "./types";

const fixture = (): ProjectSummary => ({
  projectId: 1, persistentId: "p-1", name: "GenesysMI", path: null, dirty: false, revision: "0",
  tables: [{ id: "t1", document: { documentId: 10, displayName: "Table" } as ProjectSummary["tables"][number]["document"] }],
  markdown: [{ id: "d1", name: "Notas.md", content: "", revision: 0, path: null, dirty: false, images: {} }],
  scripts: [{ id: "s1", name: "Clean.py", code: "", revision: 0, inputTableId: "t1" }],
  organization: { folders: [{ id: "data", name: "Datos", parentId: null }, { id: "source", name: "Origen", parentId: "data" }, { id: "analysis", name: "Análisis", parentId: null }], itemFolders: { t1: "source", d1: "data", s1: "analysis" } },
});
beforeEach(() => localStorage.clear());
afterEach(cleanup);
function mount(overrides: Partial<ComponentProps<typeof ProjectExplorer>> = {}) {
  const project = fixture();
  const props = { project, active: { kind: "table" as const, id: "t1" }, disabled: false, onAction: vi.fn().mockResolvedValue(project), onOpen: vi.fn(), onCreate: vi.fn(), onImport: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onExport: vi.fn(), onDuplicate: vi.fn(), onFunctions: vi.fn(), ...overrides };
  return { ...render(<ProjectExplorer {...props} />), props };
}
function newMenu() { fireEvent.click(screen.getByRole("button", { name: "Nuevo elemento" })); }
function options(name: string) { fireEvent.click(screen.getByRole("button", { name: `Opciones de ${name}` })); }

it("reveals active ancestors, opens mixed item types, and retains the tree when returning from a script", () => {
  const { props, rerender } = mount();
  expect(screen.getByRole("treeitem", { name: "Tabla Table" })).toBeTruthy();
  expect(screen.getByRole("treeitem", { name: "Documento Notas.md" })).toBeTruthy();
  fireEvent.click(screen.getByRole("treeitem", { name: "Carpeta Análisis" }));
  fireEvent.click(screen.getByRole("treeitem", { name: "Script Clean.py" }));
  expect(props.onOpen).toHaveBeenCalledWith({ kind: "script", id: "s1" });
  rerender(<ProjectExplorer {...props} editor={{ kind: "script", id: "s1" }} />);
  rerender(<ProjectExplorer {...props} editor={null} />);
  expect(screen.getByRole("treeitem", { name: "Script Clean.py" }).getAttribute("aria-selected")).toBe("true");
});
it("creates a folder in the selected folder and reveals it after success", async () => {
  const project = fixture();
  project.organization!.folders.push({ id: "new", name: "Mes", parentId: "data" });
  const onAction = vi.fn().mockResolvedValue(project);
  mount({ onAction });
  fireEvent.click(screen.getByRole("treeitem", { name: "Carpeta Datos" }));
  newMenu();fireEvent.click(screen.getByRole("menuitem", { name: "Nueva carpeta" }));
  const input = screen.getByRole("textbox", { name: "Nombre de carpeta" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "Mes" } });
  fireEvent.submit(screen.getByRole("form", { name: "Nueva carpeta" }));
  await waitFor(() => expect(onAction).toHaveBeenCalledWith({ kind: "createFolder", name: "Mes", parentId: "data" }));
  await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
});
it("creates and imports in the selected file's parent and allows choosing the project root", () => {
  const { props } = mount();
  newMenu();fireEvent.click(screen.getByRole("menuitem", { name: "Nuevo script" }));
  expect(props.onCreate).toHaveBeenCalledWith("script", "source");
  newMenu();fireEvent.click(screen.getByRole("menuitem", { name: "Importar Markdown…" }));
  expect(props.onImport).toHaveBeenCalledWith("markdown", "source");
  fireEvent.click(screen.getByRole("button", { name: "Raíz de GenesysMI" }));
  newMenu();fireEvent.click(screen.getByRole("menuitem", { name: "Nueva tabla" }));
  expect(props.onCreate).toHaveBeenCalledWith("table", null);
});
it("offers valid move destinations and dispatches a stable item ID", async () => {
  const { props } = mount();
  options("Datos");fireEvent.click(screen.getByRole("menuitem", { name: "Mover a…" }));
  const select = screen.getByRole("combobox", { name: "Carpeta de destino" });
  expect(within(select).queryByRole("option", { name: "Datos" })).toBeNull();
  expect(within(select).queryByRole("option", { name: /Origen/ })).toBeNull();
  fireEvent.change(select, { target: { value: "analysis" } });
  fireEvent.click(screen.getByRole("button", { name: "Mover" }));
  await waitFor(() => expect(props.onAction).toHaveBeenCalledWith({ kind: "moveItem", itemId: "data", folderId: "analysis" }));
});
it("renames folders, reports backend validation errors, and keeps the entered name for correction", async () => {
  const onAction = vi.fn().mockRejectedValue(new Error("Ya existe una carpeta con ese nombre"));
  mount({ onAction });
  options("Datos");fireEvent.click(screen.getByRole("menuitem", { name: "Renombrar" }));
  fireEvent.change(screen.getByLabelText("Nombre de carpeta"), { target: { value: "Análisis" } });
  fireEvent.submit(screen.getByRole("form", { name: "Renombrar carpeta" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Error: Ya existe una carpeta con ese nombre");
  expect(screen.getByLabelText("Nombre de carpeta")).toHaveProperty("value", "Análisis");
  expect(onAction).toHaveBeenCalledWith({ kind: "renameFolder", folderId: "data", name: "Análisis" });
});
it("removes the folder through the content-preserving action", async () => {
  const { props } = mount();
  options("Datos");fireEvent.click(screen.getByRole("menuitem", { name: "Quitar carpeta y conservar contenido" }));
  await waitFor(() => expect(props.onAction).toHaveBeenCalledWith({ kind: "removeFolder", folderId: "data" }));
  expect(props.onDelete).not.toHaveBeenCalled();
});
it("exports and duplicates the chosen item instead of acting on the currently open table", () => {
  const { props } = mount();
  options("Notas.md");fireEvent.click(screen.getByRole("menuitem", { name: "Exportar Markdown…" }));
  expect(props.onExport).toHaveBeenCalledWith({ kind: "markdown", id: "d1" });
  options("Table");fireEvent.click(screen.getByRole("menuitem", { name: "Duplicar tabla" }));
  expect(props.onDuplicate).toHaveBeenCalledWith("t1");
});
it("moves a dragged item and ignores drags from other projects", async () => {
  const { props } = mount();
  const values = new Map<string, string>();
  const transfer = { types: ["application/x-tablune-project-item"], setData: (type: string, value: string) => values.set(type, value), getData: (type: string) => values.get(type) ?? "", effectAllowed: "", dropEffect: "" };
  const source = screen.getByRole("treeitem", { name: "Tabla Table" });
  const target = screen.getByRole("treeitem", { name: "Carpeta Análisis" }).parentElement!;
  fireEvent.dragStart(source, { dataTransfer: transfer });
  fireEvent.dragOver(target, { dataTransfer: transfer });
  fireEvent.drop(target, { dataTransfer: transfer });
  await waitFor(() => expect(props.onAction).toHaveBeenCalledWith({ kind: "moveItem", itemId: "t1", folderId: "analysis" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Nuevo elemento" })).toHaveProperty("disabled", false));
  vi.mocked(props.onAction).mockClear();
  values.set(transfer.types[0], JSON.stringify({ projectId: 99, id: "t1" }));
  fireEvent.drop(target, { dataTransfer: transfer });
  expect(props.onAction).not.toHaveBeenCalled();
});
it("restores collapsed folders across remounts instead of reopening the active path", () => {
  const view = mount();
  fireEvent.click(screen.getByRole("button", { name: "Contraer todas las carpetas" }));
  expect(screen.queryByRole("treeitem", { name: "Tabla Table" })).toBeNull();
  view.unmount();mount();
  expect(screen.getByRole("treeitem", { name: "Carpeta Datos" }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("treeitem", { name: "Tabla Table" })).toBeNull();
});
it("supports tree keyboard navigation and locks mutations without blocking navigation", () => {
  const { props } = mount({ disabled: true });
  const folder = screen.getByRole("treeitem", { name: "Carpeta Análisis" });
  folder.focus();fireEvent.keyDown(folder, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "Carpeta Datos" }));
  fireEvent.keyDown(document.activeElement!, { key: "F2" });
  expect(screen.queryByRole("form")).toBeNull();
  expect(screen.getByRole("button", { name: "Nuevo elemento" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("treeitem", { name: "Tabla Table" }));
  expect(props.onOpen).toHaveBeenCalledWith({ kind: "table", id: "t1" });
});
