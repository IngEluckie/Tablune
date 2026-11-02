// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ask, save } from "@tauri-apps/plugin-dialog";
import { useWorkspace } from "./useWorkspace";
import * as ipc from "./ipc";
import type { MarkdownDocument, WorkspaceSummary } from "./types";
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: vi.fn().mockResolvedValue(() => {}) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), save: vi.fn(), open: vi.fn() }));
vi.mock("./ipc");
let backend: WorkspaceSummary;
const doc = (id: string): MarkdownDocument => ({ id, name: `${id}.md`, content: "# Original", revision: 0, path: null, dirty: true, images: {} });
beforeEach(() => {
  vi.clearAllMocks();
  backend = { documents: [], markdown: [doc("a")], projects: [{ projectId: 1, persistentId: "p", name: "Research", path: "/tmp/research.tablune", dirty: false, revision: "0", tables: [], scripts: [], markdown: [doc("b")] }] };
  vi.mocked(ipc.getWorkspaceSummary).mockImplementation(async () => structuredClone(backend));
  vi.mocked(ipc.getRecentFiles).mockResolvedValue([]);
  vi.mocked(ipc.recoveryAvailable).mockResolvedValue(false);
  vi.mocked(ipc.markdownAction).mockImplementation(async (pid, id, action) => {
    const docs = pid === null ? backend.markdown! : backend.projects![0].markdown!;
    if (action.kind === "open") { const d = { ...doc("opened"), path: action.path, dirty: false }; docs.push(d); return structuredClone(d); }
    const d = docs.find(d => d.id === id)!;
    if (action.kind === "update") { expect(action.expectedRevision).toBe(d.revision); d.content = action.content; d.revision++; d.dirty = true; if (pid !== null) backend.projects![0].dirty = true; }
    if (action.kind === "save" && pid === null) { d.dirty = false; d.path = action.path; }
    if (action.kind === "delete") docs.splice(docs.indexOf(d), 1);
    return structuredClone(d);
  });
  vi.mocked(ipc.saveProject).mockImplementation(async () => { backend.projects![0].dirty = false; return structuredClone(backend.projects![0]); });
});
afterEach(cleanup);
it("opens md files through Markdown sessions rather than the CSV parser", async () => {
  const { result } = renderHook(useWorkspace); await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => { await result.current.openPath("/tmp/notes.md"); });
  expect(result.current.space).toBe("markdown"); expect(result.current.selectedMarkdown).toBe("opened");
  expect(ipc.openSession).not.toHaveBeenCalled();
});
it("flushes the latest source before save and leaves the draft intact on failure", async () => {
  const { result } = renderHook(useWorkspace); await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.editMarkdown(null, "a", "# Última edición"));
  vi.mocked(save).mockResolvedValue("/tmp/a.md");
  await act(async () => { await result.current.saveMarkdown("a"); });
  expect(backend.markdown![0].content).toBe("# Última edición"); expect(backend.markdown![0].dirty).toBe(false);
  act(() => result.current.editMarkdown(null, "a", "keep draft"));
  vi.mocked(ipc.markdownAction).mockRejectedValueOnce(new Error("disk unavailable"));
  await act(async () => { await expect(result.current.saveMarkdown("a")).rejects.toThrow("disk unavailable"); });
  expect(result.current.markdownDrafts["file:a"]).toBe("keep draft");
});
it("keeps document tabs in the main area and flushes document-only project changes", async () => {
  const { result } = renderHook(useWorkspace); await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => { result.current.openTab(1, { kind: "markdown", id: "b" }); result.current.editMarkdown(1, "b", "project notes"); });
  expect(result.current.selected[1]).toEqual({ kind: "markdown", id: "b" }); expect(result.current.pythonEditors[1]).toBeUndefined();
  await act(async () => { await result.current.saveProjectById(1); });
  expect(backend.projects![0].markdown![0].content).toBe("project notes"); expect(backend.projects![0].dirty).toBe(false);
});
it("exporting Markdown does not mark its containing project as saved", async () => {
  const { result } = renderHook(useWorkspace); await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.editMarkdown(1, "b", "unsaved notes"));
  vi.mocked(save).mockResolvedValue("/tmp/export.md");
  await act(async () => { await result.current.saveMarkdown("b", true, 1); });
  expect(backend.projects![0].dirty).toBe(true); expect(ipc.saveProject).not.toHaveBeenCalled();
});
it("cancelled save and cancelled discard leave the standalone document open", async () => {
  const { result } = renderHook(useWorkspace); await waitFor(() => expect(result.current.ready).toBe(true));
  vi.mocked(ask).mockResolvedValueOnce(true); vi.mocked(save).mockResolvedValue(null);
  await act(async () => { await result.current.closeMarkdown("a"); });
  expect(backend.markdown).toHaveLength(1);
  vi.mocked(ask).mockResolvedValue(false);
  await act(async () => { await result.current.closeMarkdown("a"); });
  expect(backend.markdown).toHaveLength(1);
});
it("application exit includes standalone documents in unsaved-change protection", async () => {
  const { result } = renderHook(useWorkspace); await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => { await result.current.requestClose("app"); });
  expect(result.current.closeRequest).toBe("app"); expect(ipc.exitApplication).not.toHaveBeenCalled();
});
