// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import ProjectFunctionsEditor from "./ProjectFunctionsEditor";
import * as ipc from "./ipc";
import type { ProjectSummary } from "./types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./PythonMacroEditor", () => ({ default: () => <div>Code editor</div> }));
vi.mock("./ipc", () => ({
  getPythonStatus: vi.fn(),
  getWorkspaceSummary: vi.fn(),
  applyFunctions: vi.fn(),
  setPythonInterpreter: vi.fn(),
}));

const project: ProjectSummary = {
  projectId: 1, persistentId: "project", name: "Example", path: null,
  dirty: true, revision: "1", tables: [], scripts: [],
  calculation: { running: false, paused: false, error: null },
  functions: { draft: "def f(x): return x*2", applied: "", revision: 0, draftRevision: 2 },
};
const available = { available: true, path: "/usr/bin/python3", version: "3.12", error: null };
const props = () => ({
  project, code: project.functions!.draft, disabled: false,
  onEdit: vi.fn(), onFlush: vi.fn().mockResolvedValue(undefined),
  onUpdate: vi.fn(), onError: vi.fn(),
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ipc.getPythonStatus).mockResolvedValue(available);
  vi.mocked(ipc.getWorkspaceSummary).mockResolvedValue({ documents: [], projects: [project] });
});
afterEach(cleanup);

it("applies functions directly without an activation step, after flushing the draft", async () => {
  const callbacks = props();
  const applied = { ...project, functions: { ...project.functions!, applied: project.functions!.draft, revision: 1 } };
  vi.mocked(ipc.applyFunctions).mockResolvedValue(applied);
  render(<ProjectFunctionsEditor {...callbacks} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Apply functions" })).toHaveProperty("disabled", false));
  expect(screen.queryByRole("button", { name: /Enable Python/i })).toBeNull();
  expect(ipc.applyFunctions).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply functions" }));
  await waitFor(() => expect(callbacks.onUpdate).toHaveBeenCalledWith(applied));
  expect(ipc.applyFunctions).toHaveBeenCalledWith(1, 2);
  expect(callbacks.onFlush.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(ipc.applyFunctions).mock.invocationCallOrder[0]);
});

it("offers interpreter configuration when Python is missing without executing functions", async () => {
  vi.mocked(ipc.getPythonStatus).mockResolvedValue({ available: false, path: null, version: null, error: "Python unavailable" });
  vi.mocked(open).mockResolvedValue("/chosen/python3");
  vi.mocked(ipc.setPythonInterpreter).mockResolvedValue(available);
  render(<ProjectFunctionsEditor {...props()} />);
  await screen.findByText("Python unavailable");
  expect(screen.getByRole("button", { name: "Apply functions" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Python interpreter…" }));
  await waitFor(() => expect(ipc.setPythonInterpreter).toHaveBeenCalledWith("/chosen/python3"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Apply functions" })).toHaveProperty("disabled", false));
  expect(ipc.applyFunctions).not.toHaveBeenCalled();
});
