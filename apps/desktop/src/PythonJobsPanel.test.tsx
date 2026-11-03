// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PythonJobsPanel from "./PythonJobsPanel";
import ProjectScriptEditor from "./ProjectScriptEditor";
import { showPythonJobs } from "./pythonJobs";
import * as ipc from "./ipc";
import { ask } from "@tauri-apps/plugin-dialog";
import type { PythonJob, PythonJobDetail, WorkspaceSummary, ProjectSummary, DocumentSummary } from "./types";
vi.mock("./ipc");
vi.mock("./CsvGrid", () => ({ flushCellEdits: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("./PythonMacroEditor", () => ({ default: ({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) =>
  <textarea aria-label="Python code" value={value} disabled={disabled} onChange={e => onChange(e.target.value)} /> }));
const job = (id: number, overrides: Partial<PythonJob> = {}): PythonJob => ({
  id, projectId: 1, documentId: 7, scriptId: "script", scriptName: `Script ${id}.py`, scriptRevision: 3,
  inputName: "Input", inputRevision: 4, interpreter: "/venv/bin/python", timeoutSeconds: 600,
  state: "running", createdAt: Date.now(), startedAt: Date.now(), finishedAt: null, error: null,
  resultAvailable: false, ...overrides,
});
const detail = (summary: PythonJob, stdout = ""): PythonJobDetail => ({ summary, stdout, stderr: "", preview: summary.resultAvailable ? {
  id: "preview", baseRevision: 4, baseCalculationRevision: 0, rowsBefore: 1, rowsAfter: 1, columnsBefore: 1, columnsAfter: 1,
  changedCells: 1, headerChanged: false, estimatedUndoBytes: 2, canApply: true, blockedReason: null, stdout: "", stderr: "", samples: [],
} : null });
const project: ProjectSummary = { projectId: 1, persistentId: "p", name: "Project", path: null, dirty: false, revision: "1", tables: [],
  scripts: [{ id: "script", name: "script.py", code: "def run(rows, context): return rows", revision: 3, inputTableId: "input" }] };
const workspace: WorkspaceSummary = { documents: [], projects: [project] };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ipc.getPythonJobs).mockResolvedValue([]);
  vi.mocked(ask).mockResolvedValue(true);
});
afterEach(cleanup);
it("streams output while running, selects another job and cancels only that job", async () => {
  const jobs = [job(2), job(1)];
  let output = "first line";
  vi.mocked(ipc.getPythonJobs).mockResolvedValue(jobs);
  vi.mocked(ipc.getPythonJob).mockImplementation(async id => detail(jobs.find(j => j.id === id)!, id === 1 ? output : "second job"));
  render(<PythonJobsPanel workspace={workspace} disabled={false} onProject={vi.fn()} onDocument={vi.fn()} />);
  act(() => showPythonJobs(1));
  await screen.findByText("first line");
  output += "\nprogress before completion";
  await screen.findByText(/progress before completion/);
  expect(screen.getByRole("status").textContent).toContain("Running");
  fireEvent.click(screen.getByRole("button", { name: /#2 · Script 2.py/ }));
  await screen.findByText("second job");
  fireEvent.click(screen.getByRole("button", { name: "Cancel job" }));
  await waitFor(() => expect(ipc.cancelPythonJob).toHaveBeenCalledWith(2));
  expect(ipc.cancelPythonJob).toHaveBeenCalledTimes(1);
});
it("keeps results from an older or deleted project input available and consumes the selected result", async () => {
  const finished = job(3, { state: "succeeded", resultAvailable: true, finishedAt: Date.now() });
  vi.mocked(ipc.getPythonJobs).mockResolvedValue([finished]);
  vi.mocked(ipc.getPythonJob).mockResolvedValue(detail(finished));
  vi.mocked(ipc.acceptPythonJob).mockResolvedValue({ project, document: null });
  const onProject = vi.fn();
  render(<PythonJobsPanel workspace={workspace} disabled={false} onProject={onProject} onDocument={vi.fn()} />);
  act(() => showPythonJobs(3));
  await screen.findByText(/current input has changed or was removed/);
  const create = screen.getByRole("button", { name: "Create result table" });
  expect(create).toHaveProperty("disabled", false);
  fireEvent.click(create);
  await waitFor(() => expect(onProject).toHaveBeenCalledWith(project));
  expect(ipc.acceptPythonJob).toHaveBeenCalledWith(3);
});
it("disables applying a CSV result after newer edits and keeps it visible across workspace changes", async () => {
  const finished = job(4, { projectId: null, state: "succeeded", resultAvailable: true, finishedAt: Date.now() });
  vi.mocked(ipc.getPythonJobs).mockResolvedValue([finished]);
  vi.mocked(ipc.getPythonJob).mockResolvedValue(detail(finished, "finished"));
  const props = { disabled: false, onProject: vi.fn(), onDocument: vi.fn() };
  const { rerender } = render(<PythonJobsPanel {...props} workspace={{ documents: [{ documentId: 7, revision: 5 } as DocumentSummary], projects: [] }} />);
  act(() => showPythonJobs(4));
  await screen.findByText(/cannot overwrite newer edits/);
  expect(screen.getByRole("button", { name: "Apply to CSV" })).toHaveProperty("disabled", true);
  rerender(<PythonJobsPanel {...props} workspace={workspace} />);
  expect(screen.getByLabelText("Live Python console").textContent).toBe("finished");
  expect(screen.getByRole("button", { name: "Apply to CSV" })).toHaveProperty("disabled", true);
});
it("lets the same script be edited and submitted again while previous jobs run", async () => {
  vi.mocked(ipc.getPythonStatus).mockResolvedValue({ available: true, path: "/venv/bin/python", version: "3.14", error: null });
  vi.mocked(ipc.startProjectPythonJob).mockResolvedValue(job(1));
  const onEdit = vi.fn(), onFlush = vi.fn().mockResolvedValue(undefined);
  const current = { ...project, tables: [{ id: "input", document: { documentId: 7 } as DocumentSummary }] };
  render(<ProjectScriptEditor project={current} script={project.scripts[0]} disabled={false} onEdit={onEdit} onFlush={onFlush} onError={vi.fn()} />);
  await screen.findByText("3.14");
  fireEvent.click(screen.getByRole("button", { name: "Run in background" }));
  await waitFor(() => expect(ipc.startProjectPythonJob).toHaveBeenCalledTimes(1));
  const editor = await screen.findByRole("textbox", { name: "Python code" });
  expect(editor).toHaveProperty("disabled", false);
  fireEvent.change(editor, { target: { value: "def run(rows, context): print('second')" } });
  expect(onEdit).toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Python job time limit"), { target: { value: "none" } });
  fireEvent.click(screen.getByRole("button", { name: "Run in background" }));
  await waitFor(() => expect(ipc.startProjectPythonJob).toHaveBeenCalledTimes(2));
  expect(ipc.startProjectPythonJob).toHaveBeenLastCalledWith(1, "script", null);
  expect(onFlush).toHaveBeenCalledTimes(2);
});
