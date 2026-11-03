// @vitest-environment jsdom
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));
import { listen } from "@tauri-apps/api/event";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import App from "./App";
import { useWorkspace } from "./useWorkspace";
import * as ipc from "./ipc";
import type { DocumentSummary, ProjectSummary, WorkspaceSummary } from "./types";
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTheme: vi.fn().mockResolvedValue(undefined),
    onCloseRequested: vi.fn().mockResolvedValue(vi.fn()),
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock("./ipc", async (original) => ({
  ...(await original<typeof import("./ipc")>()),
  getPythonJobs: vi.fn().mockResolvedValue([]),
  getPythonJob: vi.fn(),
  startProjectPythonJob: vi.fn(),
  acceptPythonJob: vi.fn(),
  getWorkspaceSummary: vi.fn(),
  getRecentFiles: vi.fn(),
  recoveryAvailable: vi.fn(),
  restoreRecovery: vi.fn(),
  discardRecovery: vi.fn(),
  writeWorkspaceRecovery: vi.fn(),
  newProject: vi.fn(),
  openProject: vi.fn(),
  saveProject: vi.fn(),
  projectAction: vi.fn(),
  closeProject: vi.fn(),
  getPythonStatus: vi.fn(),
  exitApplication: vi.fn(),
  recalculateProject: vi.fn(),
  applyFunctions: vi.fn(),
  previewProjectScript: vi.fn(),
  createProjectResult: vi.fn(),
  readMacroScript: vi.fn(),
}));
vi.mock("./CsvWorkspace", () => ({
  default: ({ selectedId }: { selectedId: number }) => <div data-testid={`grid-${selectedId}`}>Grid workspace</div>,
}));
vi.mock("./MarkdownEditor", () => ({
  default: ({ linkTargets, onOpenLink }: { linkTargets: { id: string; name: string }[]; onOpenLink: (link: { kind: "project"; value: string }) => void }) => <div>
    {linkTargets.map(target => <button key={target.id} onClick={() => onOpenLink({ kind: "project", value: target.id })}>Referencia {target.name}</button>)}
  </div>,
}));
vi.mock("./PythonMacroEditor", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (s: string) => void;
  }) => (
    <textarea
      aria-label="Python code"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
const project = (id: number): ProjectSummary => ({
  projectId: id,
  persistentId: `p-${id}`,
  name: `Project ${id}`,
  path: null,
  dirty: true,
  revision: "0",
  tables: [],
  scripts: [],
});
let backend: WorkspaceSummary;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ipc.getPythonJobs).mockResolvedValue([]);
  localStorage.clear();
  vi.mocked(listen).mockResolvedValue(vi.fn());
  backend = { documents: [], projects: [] };
  vi.mocked(ipc.getWorkspaceSummary).mockImplementation(async () =>
    structuredClone(backend),
  );
  vi.mocked(ipc.getRecentFiles).mockResolvedValue([]);
  vi.mocked(ipc.recoveryAvailable).mockResolvedValue(false);
  vi.mocked(ipc.writeWorkspaceRecovery).mockResolvedValue(undefined);
  vi.mocked(ipc.discardRecovery).mockResolvedValue(undefined);
  vi.mocked(ipc.getPythonStatus).mockResolvedValue({
    available: false,
    path: null,
    version: null,
    error: "Python unavailable",
  });
  vi.mocked(ipc.newProject).mockImplementation(async (name) => {
    const p = { ...project((backend.projects?.length ?? 0) + 1), name };
    backend.projects!.push(p);
    return structuredClone(p);
  });
  vi.mocked(ipc.projectAction).mockImplementation(async (id, action) => {
    const p = backend.projects!.find((p) => p.projectId === id)!;
    if (action.kind === "newScript" || action.kind === "importScript") {
      p.scripts.push({
        id: `script-${p.scripts.length + 1}`,
        name: action.kind === "importScript" ? action.name : "Script.py",
        code: action.kind === "importScript" ? action.code : "def run(rows, context):\n    return rows\n",
        inputTableId: p.tables[0]?.id ?? null,
        revision: 0,
      });
    }
    if (action.kind === "deleteScript") {
      p.scripts = p.scripts.filter((s) => s.id !== action.scriptId);
    }
    if (action.kind === "updateFunctions") {
      p.functions ??= { draft: "", applied: "", revision: 0, draftRevision: 0 };
      p.functions.draft = action.code;
      p.functions.draftRevision++;
    }
    if (action.kind === "updateScript") {
      const s = p.scripts.find((s) => s.id === action.scriptId)!;
      expect(action.expectedRevision).toBe(s.revision);
      Object.assign(s, {
        name: action.name,
        code: action.code,
        inputTableId: action.inputTableId,
        revision: s.revision + 1,
      });
      p.revision = String(Number(p.revision) + 1);
      p.dirty = true;
    }
    return structuredClone(p);
  });
  vi.mocked(ipc.saveProject).mockImplementation(async (id, path) => {
    const p = backend.projects!.find((p) => p.projectId === id)!;
    p.path = path;
    p.dirty = false;
    return structuredClone(p);
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const sheet = (id: number, name: string) => ({
  id: `sheet-${id}`,
  document: {
    documentId: id, projectId: 1, path: null, displayName: name,
    delimiter: ",", lineEnding: "lf", revision: 0, viewRevision: 0,
    dirty: false, rowCount: 2, columnCount: 2, visibleRowCount: 2,
    headerEnabled: false, headerSuggested: false, headerNames: ["A", "B"],
    headerValues: [], canUndo: false, canRedo: false, filtersActive: false, sortCount: 0,
  } satisfies DocumentSummary,
});
const scriptProject = (): ProjectSummary => ({
  ...project(1),
  tables: [sheet(10, "Orders"), sheet(20, "Prices")],
  scripts: [
    { id: "clean", name: "Clean.py", code: "def run(rows, context):\n    return rows\n", revision: 0, inputTableId: "sheet-10" },
    { id: "totals", name: "Totals.py", code: "print('totals')", revision: 0, inputTableId: "sheet-20" },
  ],
});
describe("Python editing beside project tables", () => {
  it("opens referenced tables and scripts in tabs, retains the source, and only activates existing tabs", async () => {
    backend.projects = [{ ...scriptProject(), markdown: [{ id: "notes", name: "Notas.md", content: "", revision: 0, path: null, dirty: false, images: {} }] }];
    render(<App />);
    await screen.findByRole("tab", { name: "Orders" });
    fireEvent.click(screen.getByRole("treeitem", { name: "Documento Notas.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "Referencia Prices" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Prices" }).getAttribute("aria-selected")).toBe("true"));
    expect(screen.getByRole("tab", { name: "Notas.md" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Notas.md" }));
    fireEvent.click(screen.getByRole("button", { name: "Referencia Clean.py" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Clean.py" }).getAttribute("aria-selected")).toBe("true"));
    const code = await screen.findByRole("textbox", { name: "Python code" });
    expect(code.closest(".project-main")).toBeTruthy();
    fireEvent.change(code, { target: { value: "print('draft')" } });
    fireEvent.click(screen.getByRole("tab", { name: "Notas.md" }));
    fireEvent.click(screen.getByRole("button", { name: "Referencia Clean.py" }));
    await waitFor(() => expect(screen.getAllByRole("tab", { name: "Clean.py" })).toHaveLength(1));
    expect(screen.getByRole("textbox", { name: "Python code" })).toHaveProperty("value", "print('draft')");
    expect(ipc.previewProjectScript).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close Clean.py editor" }));
    expect(screen.queryByRole("tab", { name: "Clean.py" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Prices" }).getAttribute("aria-selected")).toBe("true");
  });
  it("edits scripts and Functions in the sidebar while retaining the table and drafts", async () => {
    backend.projects = [scriptProject()];
    render(<App />);
    await screen.findByRole("tab", { name: "Orders" });
    const grid = screen.getByTestId("grid-10");
    expect(screen.queryByRole("button", { name: "Delete table…" })).toBeNull();
    fireEvent.click(screen.getByRole("treeitem", { name: "Script Clean.py" }));
    const sidebar = screen.getByRole("complementary", { name: "Project 1 items" });
    expect(within(sidebar).getByRole("region", { name: "Script Clean.py" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Clean.py" })).toBeNull();
    expect(grid.closest(".grid-host")?.hasAttribute("hidden")).toBe(false);
    fireEvent.change(await screen.findByRole("textbox", { name: "Python code" }), { target: { value: "print('draft')" } });
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.queryByRole("textbox", { name: "Python code" })).toBeNull();
    expect(screen.getByTestId("grid-10")).toBe(grid);
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByRole("textbox", { name: "Python code" })).toHaveProperty("value", "print('draft')");
    fireEvent.click(screen.getByRole("button", { name: "Back to project items" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "Tabla Prices" }));
    fireEvent.click(screen.getByRole("button", { name: /ƒ Funciones del proyecto/ }));
    expect(within(sidebar).getByRole("region", { name: "Project functions" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Functions" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Prices" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Orders" }));
    expect(within(sidebar).getByRole("region", { name: "Project functions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to project items" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "Script Clean.py" }));
    expect(await screen.findByRole("textbox", { name: "Python code" })).toHaveProperty("value", "print('draft')");
    expect(screen.getByTestId("grid-10")).toBe(grid);
  });
  it("opens newly created and imported scripts in the sidebar without replacing the table", async () => {
    backend.projects = [scriptProject()];
    render(<App />);
    await screen.findByRole("tab", { name: "Orders" });
    fireEvent.click(screen.getByRole("treeitem", { name: "Tabla Prices" }));
    fireEvent.click(screen.getByRole("button", { name: "Nuevo elemento" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Nuevo script" }));
    expect(await screen.findByRole("region", { name: "Script Script.py" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Prices" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("combobox", { name: "Input table" })).toHaveProperty("value", "sheet-20");
    expect(screen.queryByRole("tab", { name: "Script.py" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to project items" }));
    vi.mocked(open).mockResolvedValue("/tmp/Imported.py");
    vi.mocked(ipc.readMacroScript).mockResolvedValue("print('imported')");
    fireEvent.click(screen.getByRole("button", { name: "Nuevo elemento" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Importar .py…" }));
    expect(await screen.findByRole("region", { name: "Script Imported.py" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Prices" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("combobox", { name: "Input table" })).toHaveProperty("value", "sheet-20");
    expect(screen.queryByRole("tab", { name: "Imported.py" })).toBeNull();
  });
  it("flushes the draft before starting a background job and creates its result from the panel", async () => {
    backend.projects = [scriptProject()];
    vi.mocked(ask).mockResolvedValue(true);
    vi.mocked(ipc.getPythonStatus).mockResolvedValue({ available: true, path: "/usr/bin/python3", version: "3.12", error: null });
    const job: import("./types").PythonJob = { id: 1, projectId: 1, documentId: 10, scriptId: "clean", scriptName: "Clean.py", scriptRevision: 1, inputName: "Orders", inputRevision: 0, interpreter: "/usr/bin/python3", timeoutSeconds: 600, state: "succeeded", createdAt: 0, startedAt: 0, finishedAt: 1, error: null, resultAvailable: true };
    vi.mocked(ipc.startProjectPythonJob).mockImplementation(async () => {
      expect(backend.projects![0].scripts[0].code).toBe("print('latest')");
      vi.mocked(ipc.getPythonJobs).mockResolvedValue([job]);
      return job;
    });
    vi.mocked(ipc.getPythonJob).mockResolvedValue({ summary: job, stdout: "latest", stderr: "", preview: { id: "preview", baseRevision: 0, rowsBefore: 2, rowsAfter: 2, columnsBefore: 2, columnsAfter: 2, changedCells: 1, headerChanged: false, estimatedUndoBytes: 0, canApply: true, blockedReason: null, stdout: "", stderr: "", samples: [] } });
    vi.mocked(ipc.acceptPythonJob).mockImplementation(async () => {
      backend.projects![0].tables.push(sheet(30, "Result"));
      return { project: structuredClone(backend.projects![0]), document: null };
    });
    render(<App />);
    await screen.findByRole("tab", { name: "Orders" });
    fireEvent.click(screen.getByRole("treeitem", { name: "Script Clean.py" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Python code" }), { target: { value: "print('latest')" } });
    fireEvent.click(screen.getByRole("button", { name: "Run in background" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create result table" }).hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("tab", { name: "Orders" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Create result table" }));
    expect(await screen.findByRole("tab", { name: "Result" })).toHaveProperty("ariaSelected", "true");
    expect(screen.getByRole("region", { name: "Script Clean.py" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Python code" })).toHaveProperty("value", "print('latest')");
    expect(ipc.acceptPythonJob).toHaveBeenCalledWith(1);
  });
  it("deletes the edited script without deleting or closing the visible table", async () => {
    backend.projects = [scriptProject()];
    vi.mocked(ask).mockResolvedValue(true);
    render(<App />);
    await screen.findByRole("tab", { name: "Orders" });
    fireEvent.click(screen.getByRole("treeitem", { name: "Script Clean.py" }));
    expect(screen.queryByRole("button", { name: "Duplicate table" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete script…" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Back to project items" })).toBeNull());
    expect(ipc.projectAction).toHaveBeenCalledWith(1, { kind: "deleteScript", scriptId: "clean" });
    expect(screen.getByRole("tab", { name: "Orders" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Opciones de Orders" }));
    expect(screen.getByRole("menuitem", { name: "Duplicar tabla" })).toBeTruthy();
  });
});
describe("Home and project lifecycle", () => {
  it("starts at Home without silently creating a CSV", async () => {
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Tablune Sheets" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /New project/ })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(
      screen.getByText("Files and projects you open or save will appear here."),
    ).toBeTruthy();
  });
  it("creates a named empty project and returns to it through Home", async () => {
    render(<App />);
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /New project/ })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: /New project/ }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), {
      target: { value: "Monthly sales" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("heading", { name: "Monthly sales" }),
    ).toBeTruthy();
    expect(ipc.newProject).toHaveBeenCalledWith("Monthly sales", null);
    fireEvent.click(screen.getByRole("button", { name: /Home/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Monthly sales · 0 tables/ }),
    );
    expect(screen.getByRole("heading", { name: "Monthly sales" })).toBeTruthy();
  });
  it("asks about recovery only once in StrictMode", async () => {
    vi.mocked(ipc.recoveryAvailable).mockResolvedValue(true);
    vi.mocked(ask).mockResolvedValue(true);
    vi.mocked(ipc.restoreRecovery).mockResolvedValue({
      documents: [],
      projects: [project(8)],
    });
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(
      await screen.findByRole("heading", { name: "Project 8" }),
    ).toBeTruthy();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ipc.restoreRecovery).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite recovery when initialization fails", async () => {
    vi.mocked(ipc.recoveryAvailable).mockResolvedValue(true);
    vi.mocked(ask).mockResolvedValue(true);
    vi.mocked(ipc.restoreRecovery).mockRejectedValue(
      new Error("Corrupt recovery"),
    );
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Corrupt recovery"),
    );
    expect(ipc.writeWorkspaceRecovery).not.toHaveBeenCalled();
    expect(ipc.discardRecovery).not.toHaveBeenCalled();
  });
  it("keeps edits in separate projects and flushes the latest script before save", async () => {
    backend.projects = [project(1), project(2)];
    for (const p of backend.projects)
      p.scripts = [
        {
          id: "script",
          name: "Clean.py",
          code: "old",
          revision: 0,
          inputTableId: null,
        },
      ];
    const { result } = renderHook(() => useWorkspace());
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => {
      result.current.editScript(1, "script", {
        name: "Clean.py",
        code: "one",
        inputTableId: null,
      });
      result.current.editScript(2, "script", {
        name: "Clean.py",
        code: "two",
        inputTableId: null,
      });
      result.current.setSpace("home");
    });
    vi.mocked(save).mockResolvedValue("/tmp/one.tablune");
    await act(async () => {
      expect(await result.current.saveProjectById(1)).toBe(true);
    });
    expect(backend.projects![0].scripts[0].code).toBe("one");
    expect(backend.projects![1].scripts[0].code).toBe("two");
    expect(backend.projects![0].dirty).toBe(false);
    expect(backend.projects![1].dirty).toBe(true);
    expect(Object.keys(result.current.drafts)).toHaveLength(0);
  });
  it("preserves drafts and blocks save after a failed script write", async () => {
    backend.projects = [
      {
        ...project(1),
        scripts: [
          {
            id: "s",
            name: "Code.py",
            code: "old",
            revision: 0,
            inputTableId: null,
          },
        ],
      },
    ];
    const { result } = renderHook(() => useWorkspace());
    await waitFor(() => expect(result.current.ready).toBe(true));
    vi.mocked(ipc.projectAction).mockRejectedValue(new Error("write failed"));
    act(() =>
      result.current.editScript(1, "s", {
        name: "Code.py",
        code: "new",
        inputTableId: null,
      }),
    );
    await act(async () => {
      await expect(result.current.saveProjectById(1)).rejects.toThrow(
        "write failed",
      );
    });
    expect(result.current.drafts["1:s"].code).toBe("new");
    expect(ipc.saveProject).not.toHaveBeenCalled();
  });
  it("treats a cancelled project save as a cancelled close", async () => {
    backend.projects = [project(1)];
    const { result } = renderHook(() => useWorkspace());
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(() => result.current.requestClose(1));
    expect(result.current.closeRequest).toBe(1);
    vi.mocked(save).mockResolvedValue(null);
    await act(() => result.current.saveAndClose());
    expect(ipc.closeProject).not.toHaveBeenCalled();
    expect(result.current.closeRequest).toBe(1);
  });
  it("requires cancelling a project's running script before closing", async () => {
    backend.projects = [project(1)];
    const { result } = renderHook(() => useWorkspace());
    await waitFor(() => expect(result.current.ready).toBe(true));
    vi.mocked(ipc.getPythonJobs).mockResolvedValue([{ id: 1, projectId: 1, state: "running" } as import("./types").PythonJob]);
    await expect(result.current.requestClose(1)).rejects.toThrow("Cancel");
    expect(ipc.closeProject).not.toHaveBeenCalled();
  });
  it("routes native Quit through the same unsaved-project dialog", async () => {
    backend.projects = [project(1)];
    const { result } = renderHook(() => useWorkspace());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const quit = vi
      .mocked(listen)
      .mock.calls.find((call) => call[0] === "tablune-request-exit")![1];
    await act(async () => {
      quit({ event: "tablune-request-exit", id: 1, payload: null });
    });
    await waitFor(() => expect(result.current.closeRequest).toBe("app"));
    expect(ipc.exitApplication).not.toHaveBeenCalled();
  });
  it("locks only the project being saved and permits navigation to another", async () => {
    backend.projects = [
      { ...project(1), path: "/tmp/one.tablune" },
      project(2),
    ];
    const { result } = renderHook(() => useWorkspace());
    await waitFor(() => expect(result.current.ready).toBe(true));
    let finish!: (p: ProjectSummary) => void;
    vi.mocked(ipc.saveProject).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let saving!: Promise<boolean>;
    act(() => {
      saving = result.current.saveProjectById(1);
    });
    await waitFor(() => expect(result.current.savingProjects).toEqual([1]));
    act(() => result.current.setSpace(2));
    expect(result.current.space).toBe(2);
    expect(result.current.busy).toBe(false);
    await act(async () => {
      finish({ ...project(1), dirty: false, path: "/tmp/one.tablune" });
      await saving;
    });
    expect(result.current.savingProjects).toEqual([]);
  });
  it("flushes Functions drafts before saving without activating them", async () => {
    backend.projects = [project(1)];
    backend.projects[0].functions = {
      draft: "",
      applied: "def old(): return 1",
      revision: 1,
      draftRevision: 0,
    };
    vi.mocked(save).mockResolvedValue("/tmp/functions.tablune");
    const { result } = renderHook(() => useWorkspace());
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.editFunctions(1, "def newer(): return 2"));
    await act(async () => {
      await result.current.saveProjectById(1);
    });
    expect(ipc.projectAction).toHaveBeenCalledWith(1, {
      kind: "updateFunctions",
      code: "def newer(): return 2",
      expectedRevision: 0,
    });
    expect(backend.projects[0].functions.applied).toBe("def old(): return 1");
    expect(ipc.applyFunctions).not.toHaveBeenCalled();
  });
  it("keeps editing available during autosave and preserves a newer script after an older acknowledgement", async () => {
    backend.projects = [{ ...scriptProject(), path: "/tmp/project.tablune", dirty: false }];
    const { result } = renderHook(useWorkspace);
    await waitFor(() => expect(result.current.ready).toBe(true));
    vi.useFakeTimers();
    let finish!: (project: ProjectSummary) => void;
    let snapshot!: ProjectSummary;
    vi.mocked(ipc.saveProject).mockImplementationOnce(async () => {
      snapshot = structuredClone(backend.projects![0]);
      snapshot.dirty = false;
      return new Promise(resolve => { finish = resolve; });
    });
    const script = backend.projects[0].scripts[0];
    act(() => result.current.editScript(1, script.id, { ...script, code: "before save" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(ipc.saveProject).toHaveBeenCalledTimes(1);
    expect(result.current.savingProjects).toEqual([]);
    expect(result.current.busy).toBe(false);
    act(() => result.current.editScript(1, script.id, { ...script, code: "while saving" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    await act(async () => { finish(snapshot); await result.current.saves.wait("project:1"); });
    expect(result.current.workspace.projects![0].scripts[0].code).toBe("while saving");
    expect(result.current.workspace.projects![0].dirty).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(ipc.saveProject).toHaveBeenCalledTimes(2);
    expect(result.current.workspace.projects![0].dirty).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
  it("automatically requests calculation after an edit without an activation dialog", async () => {
    backend.projects = [
      {
        ...project(1),
        calculation: {
          running: false,
          paused: false,
          error: null,
        },
        tables: [
          {
            id: "sheet",
            document: {
              documentId: 10,
              revision: 1,
              pendingCells: 0,
            } as import("./types").DocumentSummary,
          },
        ],
      },
    ];
    vi.mocked(ipc.recalculateProject).mockImplementation(async () => {
      backend.projects![0].tables[0].document.pendingCells = 0;
      return structuredClone(backend.projects![0]);
    });
    const { result } = renderHook(() => useWorkspace());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(ipc.recalculateProject).not.toHaveBeenCalled();
    await act(async () => {
      backend.projects![0].tables[0].document.pendingCells = 1;
      backend.projects![0].tables[0].document.revision += 1;
      result.current.updateProject(structuredClone(backend.projects![0]));
    });
    await waitFor(() => expect(ipc.recalculateProject).toHaveBeenCalledWith(1));
    expect(ask).not.toHaveBeenCalled();
  });
  it("requires cancelling calculations before closing their project", async () => {
    backend.projects = [
      {
        ...project(1),
        calculation: {
          running: true,
          paused: false,
          error: null,
        },
      },
    ];
    const { result } = renderHook(() => useWorkspace());
    await waitFor(() => expect(result.current.ready).toBe(true));
    await expect(result.current.requestClose(1)).rejects.toThrow(
      "Cancel the calculation",
    );
    expect(ipc.closeProject).not.toHaveBeenCalled();
  });
});
