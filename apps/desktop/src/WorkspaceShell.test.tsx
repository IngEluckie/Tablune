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
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask, save } from "@tauri-apps/plugin-dialog";
import App from "./App";
import { useWorkspace } from "./useWorkspace";
import * as ipc from "./ipc";
import type { ProjectSummary, WorkspaceSummary } from "./types";
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
}));
vi.mock("./CsvWorkspace", () => ({ default: () => <div>Grid workspace</div> }));
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
afterEach(cleanup);
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
    act(() => result.current.setRunningProject(1));
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
});
