import { isPythonJobActive, showPythonJobs } from "./pythonJobs";
import type { CanvasContent } from "./canvasModel";
import { flushMarkdownEditors } from "./markdownPending";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import * as ipc from "./ipc";
import { flushCellEdits, waitForCellEdits } from "./CsvGrid";
import { SaveCoordinator, type SaveTarget } from "./saveCoordinator";
import type {
  MarkdownDocument,
  MarkdownAction,
  DocumentSummary,
  ProjectAction,
  ProjectSummary,
  RecentFile,
  ScriptSummary,
  WorkspaceSummary,
} from "./types";

export type Space = "home" | "csv" | "markdown" | number;
export type ProjectTab = { kind: "table" | "script" | "functions" | "markdown" | "canvas"; id: string };
export type ScriptDraft = Pick<ScriptSummary, "name" | "code" | "inputTableId">;
const basename = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
export function useWorkspace() {
  const [saves] = useState(() => {
    let storage: Storage | undefined;
    try { storage = window.localStorage; } catch { /* Preferences remain session-local. */ }
    return new SaveCoordinator(storage);
  });
  useEffect(() => () => saves.dispose(), [saves]);
  const [workspace, setWorkspace] = useState<WorkspaceSummary>({
    documents: [],
    projects: [],
  });
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const [space, setSpace] = useState<Space>("home");
  const [selectedCsv, setSelectedCsv] = useState(0);
  const [selectedMarkdown, setSelectedMarkdown] = useState<string | null>(null);
  const [markdownDrafts, setMarkdownDrafts] = useState<Record<string, string>>({});
  const markdownDraftsRef = useRef(markdownDrafts);
  const editMarkdown = (projectId: number | null, id: string, content: string) => {
    const next = { ...markdownDraftsRef.current, [`${projectId ?? "file"}:${id}`]: content };
    markdownDraftsRef.current = next; setMarkdownDrafts(next);
  };
  const [canvasDrafts, setCanvasDrafts] = useState<Record<string, CanvasContent>>({});
  const canvasDraftsRef = useRef(canvasDrafts);
  const editCanvas = (projectId: number, id: string, content: CanvasContent) => {
    const next = { ...canvasDraftsRef.current, [`${projectId}:${id}`]: content };
    canvasDraftsRef.current = next; setCanvasDrafts(next);
  };
  const [tabs, setTabs] = useState<Record<number, ProjectTab[]>>({});
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const [selected, setSelected] = useState<Record<number, ProjectTab | null>>(
    {},
  );
  const [pythonEditors, setPythonEditors] = useState<Record<number, ProjectTab | null>>({});
  const [recents, setRecents] = useState<RecentFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  readyRef.current = ready;
  const [savingProjects, setSavingProjects] = useState<number[]>([]);
  const savingRef = useRef(new Set<number>());
  const [closeRequest, setCloseRequest] = useState<"app" | number | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ScriptDraft>>({});
  const [functionDrafts, setFunctionDrafts] = useState<Record<number, string>>(
    {},
  );
  const functionDraftsRef = useRef(functionDrafts);
  functionDraftsRef.current = functionDrafts;
  const editFunctions = useCallback((id: number, code: string) => {
    const next = { ...functionDraftsRef.current, [id]: code };
    functionDraftsRef.current = next;
    setFunctionDrafts(next);
  }, []);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const flushChain = useRef<Promise<void>>(Promise.resolve());
  const closingRef = useRef(false);
  const commit = useCallback((next: WorkspaceSummary) => {
    workspaceRef.current = next;
    setWorkspace(next);
  }, []);
  const updateProject = useCallback(
    (project: ProjectSummary) => {
      const current = workspaceRef.current;
      const projects = current.projects ?? [];
      commit({
        ...current,
        projects: projects.some((p) => p.projectId === project.projectId)
          ? projects.map((p) =>
              p.projectId === project.projectId ? project : p,
            )
          : [...projects, project],
      });
    },
    [commit],
  );
  const refresh = useCallback(async () => {
    const next = await ipc.getWorkspaceSummary();
    commit(next);
    return next;
  }, [commit]);
  const refreshRecents = useCallback(async () => {
    setRecents(await ipc.getRecentFiles());
  }, []);
  const report = useCallback((e: unknown) => setError(String(e)), []);
  const guard = async (action: () => Promise<unknown>) => {
    // Capture the active cell synchronously, before a UI lock hides its editor.
    const cellEdits = flushCellEdits();
    setBusy(true);
    setError(null);
    try {
      await cellEdits;
      await action();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };
  const openTab = useCallback((projectId: number, tab: ProjectTab, placement?: "main") => {
    const inMain = placement === "main" || tabsRef.current[projectId]?.some(t => t.kind === tab.kind && t.id === tab.id);
    if ((tab.kind === "script" || tab.kind === "functions") && !inMain) {
      setPythonEditors((current) => ({ ...current, [projectId]: tab }));
      setSpace(projectId);
      return;
    }
    if (placement === "main" || tab.kind === "script") setPythonEditors(current => ({ ...current, [projectId]: null }));
    setTabs((current) => ({
      ...current,
      [projectId]: (current[projectId] ?? []).some(
        (t) => t.kind === tab.kind && t.id === tab.id,
      )
        ? current[projectId]
        : [...(current[projectId] ?? []), tab],
    }));
    setSelected((current) => ({ ...current, [projectId]: tab }));
    setSpace(projectId);
  }, []);
  const closePythonEditor = (projectId: number) => {
    setPythonEditors((current) => ({ ...current, [projectId]: null }));
  };
  const closeTab = (projectId: number, tab: ProjectTab) => {
    if ((tab.kind === "script" || tab.kind === "functions") && !tabs[projectId]?.some(t => t.kind === tab.kind && t.id === tab.id)) {
      setPythonEditors((current) => ({
        ...current,
        [projectId]: current[projectId]?.kind === tab.kind && current[projectId]?.id === tab.id
          ? null : current[projectId],
      }));
      return;
    }
    const remaining = (tabs[projectId] ?? []).filter(
      (t) => t.id !== tab.id || t.kind !== tab.kind,
    );
    setTabs((current) => ({ ...current, [projectId]: remaining }));
    setSelected((current) => ({
      ...current,
      [projectId]:
        current[projectId]?.id === tab.id
          ? (remaining.at(-1) ?? null)
          : current[projectId],
    }));
  };
  const editScript = useCallback(
    (projectId: number, scriptId: string, draft: ScriptDraft) => {
      const next = {
        ...draftsRef.current,
        [`${projectId}:${scriptId}`]: draft,
      };
      draftsRef.current = next;
      setDrafts(next);
    },
    [],
  );
  const updateMarkdown = useCallback((projectId: number | null, doc: MarkdownDocument) => {
    const current = workspaceRef.current;
    const merge = (docs: MarkdownDocument[] = []) => docs.some(d => d.id === doc.id) ? docs.map(d => d.id === doc.id ? doc : d) : [...docs, doc];
    if (projectId === null) commit({ ...current, markdown: merge(current.markdown) });
    else commit({ ...current, projects: current.projects?.map(p => p.projectId === projectId ? { ...p, markdown: merge(p.markdown), dirty: true, revision: `markdown-${doc.id}-${doc.revision}` } : p) });
  }, [commit]);
  const flushDrafts = useCallback((options?: { background?: boolean; targetId?: string }): Promise<void> => {
    const run = flushChain.current
      .catch(() => {})
      .then(async () => {
        if (options?.background) await waitForCellEdits(options.targetId);
        else await flushCellEdits();
        await flushMarkdownEditors(options?.targetId);
        for (const [key, content] of Object.entries(canvasDraftsRef.current)) {
          const [owner, id] = key.split(":"); const projectId = Number(owner);
          if (options?.targetId && options.targetId !== `project:${owner}`) continue;
          const doc = workspaceRef.current.projects?.find(p => p.projectId === projectId)?.canvases?.find(c => c.id === id);
          if (!doc) continue;
          updateProject(await ipc.projectAction(projectId, { kind: "updateCanvas", canvasId: id, content, expectedRevision: doc.revision }));
          if (canvasDraftsRef.current[key] === content) {
            const next = { ...canvasDraftsRef.current }; delete next[key]; canvasDraftsRef.current = next; setCanvasDrafts(next);
          }
        }
        for (const [key, content] of Object.entries(markdownDraftsRef.current)) {
          const [owner, id] = key.split(":");
          const projectId = owner === "file" ? null : Number(owner);
          if (options?.targetId && options.targetId !== (projectId === null ? `markdown:${id}` : `project:${projectId}`)) continue;
          const docs = projectId === null ? workspaceRef.current.markdown : workspaceRef.current.projects?.find(p => p.projectId === projectId)?.markdown;
          const doc = docs?.find(d => d.id === id);
          if (!doc) continue;
          if (content !== doc.content) updateMarkdown(projectId, await ipc.markdownAction(projectId, id, { kind: "update", content, expectedRevision: doc.revision }));
          if (markdownDraftsRef.current[key] === content) {
            const next = { ...markdownDraftsRef.current }; delete next[key]; markdownDraftsRef.current = next; setMarkdownDrafts(next);
          }
        }
        for (const [id, code] of Object.entries(functionDraftsRef.current)) {
          if (options?.targetId && options.targetId !== `project:${id}`) continue;
          const project = workspaceRef.current.projects?.find(
            (p) => p.projectId === Number(id),
          );
          if (!project) continue;
          updateProject(
            await ipc.projectAction(project.projectId, {
              kind: "updateFunctions",
              code,
              expectedRevision: project.functions?.draftRevision ?? 0,
            }),
          );
          if (functionDraftsRef.current[Number(id)] === code) {
            const next = { ...functionDraftsRef.current };
            delete next[Number(id)];
            functionDraftsRef.current = next;
            setFunctionDrafts(next);
          }
        }
        for (const [key, draft] of Object.entries(draftsRef.current)) {
          const separator = key.indexOf(":");
          const projectId = Number(key.slice(0, separator));
          const scriptId = key.slice(separator + 1);
          if (options?.targetId && options.targetId !== `project:${projectId}`) continue;
          const project = workspaceRef.current.projects?.find(
            (p) => p.projectId === projectId,
          );
          const script = project?.scripts.find((s) => s.id === scriptId);
          if (!script) continue;
          updateProject(
            await ipc.projectAction(projectId, {
              kind: "updateScript",
              scriptId,
              ...draft,
              expectedRevision: script.revision,
            }),
          );
          if (draftsRef.current[key] === draft) {
            const next = { ...draftsRef.current };
            delete next[key];
            draftsRef.current = next;
            setDrafts(next);
          }
        }
      });
    flushChain.current = run;
    return run;
  }, [updateProject, updateMarkdown]);
  const actMarkdown = async (projectId: number | null, id: string | null, action: MarkdownAction) => {
    await flushDrafts();
    const doc = await ipc.markdownAction(projectId, id, action);
    await refresh();
    await refreshRecents();
    return doc;
  };
  const newMarkdown = async (projectId: number | null = null) => {
    const doc = await actMarkdown(projectId, null, { kind: "new", name: "Untitled.md" });
    if (projectId === null) { setSelectedMarkdown(doc.id); setSpace("markdown"); }
    else openTab(projectId, { kind: "markdown", id: doc.id });
  };
  const saveMarkdown = async (id: string, saveAs = false, projectId: number | null = null): Promise<boolean> => {
    return saves.run(projectId === null ? `markdown:${id}` : `project:${projectId}`, async () => {
      await flushDrafts();
      const doc = (projectId === null ? workspaceRef.current.markdown : workspaceRef.current.projects?.find(p => p.projectId === projectId)?.markdown)?.find(d => d.id === id);
      if (!doc) return false;
      let path = !saveAs && projectId === null ? doc.path : null;
      path ??= await save({ defaultPath: doc.name, filters: [{ name: "Markdown", extensions: ["md", "markdown"] }] });
      if (!path) return false;
      if (!/\.(md|markdown)$/i.test(path)) path += ".md";
      await actMarkdown(projectId, id, { kind: "save", path });
      await ipc.writeWorkspaceRecovery();
      return true;
    });
  };
  const closeMarkdown = async (id: string) => {
    saves.pause(`markdown:${id}`);
    try {
      await saves.wait(`markdown:${id}`);
      await flushDrafts();
      try { await saves.flush(`markdown:${id}`); } catch (error) { report(error); }
      const doc = workspaceRef.current.markdown?.find(d => d.id === id);
      if (!doc) return;
      if (doc.dirty) {
        if (await ask(`Save changes to ${doc.name} before closing?`, { title: "Close document", kind: "info" })) {
          if (!(await saveMarkdown(id))) return;
        } else if (!(await ask(`Discard changes to ${doc.name}?`, { title: "Discard changes", kind: "warning" }))) return;
      }
      await actMarkdown(null, id, { kind: "delete", discard: true });
      await ipc.writeWorkspaceRecovery();
      const remaining = workspaceRef.current.markdown ?? [];
      if (selectedMarkdown === id) setSelectedMarkdown(remaining.at(-1)?.id ?? null);
      if (!remaining.length) setSpace("home");
    } finally { saves.resume(`markdown:${id}`); }
  };
  const perform = async (projectId: number, action: ProjectAction) => {
    await flushDrafts();
    const next = await ipc.projectAction(projectId, action);
    updateProject(next);
    return next;
  };
  const saveProjectById = async (
    projectId: number,
    saveAs = false,
  ): Promise<boolean> => {
    return saves.run(`project:${projectId}`, async () => {
      await flushDrafts();
      const project = workspaceRef.current.projects?.find(
        (p) => p.projectId === projectId,
      );
      if (!project) return false;
      const extension = project.standaloneCanvas ? "tlcanvas" : "tablune";
      let path = saveAs ? null : project.path;
      if (!path)
        path = await save({
          defaultPath: `${project.name}.${extension}`,
          filters: [{ name: project.standaloneCanvas ? "Tablune canvas" : "Tablune project", extensions: [extension] }],
        });
      if (!path) return false;
      if (!path.toLowerCase().endsWith(`.${extension}`)) path += `.${extension}`;
      if (savingRef.current.has(projectId)) return false;
      savingRef.current.add(projectId);
      setSavingProjects([...savingRef.current]);
      try {
        updateProject(await ipc.saveProject(projectId, path));
        await refreshRecents();
        return true;
      } finally {
        savingRef.current.delete(projectId);
        setSavingProjects([...savingRef.current]);
      }
    });
  };
  const saveCsv = async (documentId: number, saveAs = false, suggestedName?: string): Promise<boolean> =>
    saves.run(`csv:${documentId}`, async () => {
      await flushCellEdits();
      const doc = workspaceRef.current.documents.find(d => d.documentId === documentId);
      if (!doc) return false;
      const path = (!saveAs && doc.path) || await save({ defaultPath: suggestedName ?? doc.displayName, filters: [{ name: "CSV", extensions: ["csv", "tsv", "txt"] }] });
      if (!path) return false;
      const next = await ipc.saveSession(documentId, path);
      mergeSavedCsv(next);
      await refreshRecents();
      return true;
    });
  // Save acknowledgements must not replace newer edits or revive a closed document.
  const mergeSavedCsv = (next: DocumentSummary) => {
    const current = workspaceRef.current;
    commit({ ...current, documents: current.documents.map(d => d.documentId !== next.documentId ? d :
      d.revision > next.revision ? { ...d, path: next.path } : next) });
  };
  const autosaveTarget = async (targetId: string) => {
    await flushDrafts({ background: true, targetId });
    const current = workspaceRef.current;
    if (targetId.startsWith("project:")) {
      const id = Number(targetId.slice(8));
      const before = current.projects?.find(p => p.projectId === id);
      if (!before?.path || !before.dirty) return;
      const next = await ipc.saveProject(id, before.path);
      const latest = workspaceRef.current.projects?.find(p => p.projectId === id);
      if (latest === before) updateProject(next);
      else if (latest) {
        // Preserve drafts and confirmed edits received while the snapshot was written.
        updateProject({ ...latest, path: next.path, dirty: true,
          tables: latest.tables.map(t => {
            const saved = next.tables.find(s => s.id === t.id)?.document;
            return saved && saved.revision === t.document.revision ? { ...t, document: { ...t.document, dirty: saved.dirty } } : t;
          }) });
      }
    } else if (targetId.startsWith("csv:")) {
      const doc = current.documents.find(d => `csv:${d.documentId}` === targetId);
      if (doc?.path && doc.dirty) mergeSavedCsv(await ipc.saveSession(doc.documentId, doc.path));
    } else if (targetId.startsWith("markdown:")) {
      const doc = current.markdown?.find(d => `markdown:${d.id}` === targetId);
      if (!doc?.path || !doc.dirty) return;
      const next = await ipc.markdownAction(null, doc.id, { kind: "save", path: doc.path });
      const latest = workspaceRef.current;
      commit({ ...latest, markdown: latest.markdown?.map(d => d.id !== next.id ? d : d.revision > next.revision ? { ...d, path: next.path } : next) });
      await ipc.writeWorkspaceRecovery();
    }
  };
  const createProject = async (
    name: string,
    sourceDocumentId: number | null = null,
  ) => {
    const p = await ipc.newProject(name, sourceDocumentId);
    updateProject(p);
    setSpace(p.projectId);
    if (p.tables[0])
      openTab(p.projectId, { kind: "table", id: p.tables[0].id });
    return p;
  };
  const newCanvas = async () => {
    const p=await ipc.newStandaloneCanvas();updateProject(p);
    openTab(p.projectId,{kind:"canvas",id:p.canvases![0].id});
  };
  const newCsv = async () => {
    const d = await ipc.newSession();
    commit({
      ...workspaceRef.current,
      documents: [...workspaceRef.current.documents, d],
    });
    setSelectedCsv(d.documentId);
    setSpace("csv");
  };
  const openPath = async (path: string) => {
    if (/\.(md|markdown)$/i.test(path)) {
      const doc = await actMarkdown(null, null, { kind: "open", path });
      setSelectedMarkdown(doc.id); setSpace("markdown");
    } else if (/\.(tablune|tlcanvas)$/i.test(path)) {
      const p = await ipc.openProject(path);
      updateProject(p);
      setSpace(p.projectId);
      if (!selected[p.projectId] && p.tables[0])
        openTab(p.projectId, { kind: "table", id: p.tables[0].id });
      else if (!selected[p.projectId] && p.canvases?.[0]) openTab(p.projectId, { kind: "canvas", id: p.canvases[0].id });
      else if (!selected[p.projectId] && p.markdown?.[0]) openTab(p.projectId, { kind: "markdown", id: p.markdown[0].id });
    } else {
      let d = await ipc.openSession(path);
      if (
        d.headerSuggested &&
        !workspaceRef.current.documents.some(
          (c) => c.documentId === d.documentId,
        ) &&
        (await ask(
          `Use the first row in ${basename(path)} as column headers?`,
          { title: "Column headers", kind: "info" },
        ))
      )
        d = await ipc.setSessionHeader(d.documentId, true);
      const docs = workspaceRef.current.documents;
      commit({
        ...workspaceRef.current,
        documents: docs.some((c) => c.documentId === d.documentId)
          ? docs.map((c) => (c.documentId === d.documentId ? d : c))
          : [...docs, d],
      });
      setSelectedCsv(d.documentId);
      setSpace("csv");
    }
    await refreshRecents();
  };
  const openFiles = async () => {
    const paths = await open({
      multiple: true,
      filters: [
        {
          name: "Data files and projects",
          extensions: ["csv", "tsv", "txt", "md", "markdown", "tablune", "tlcanvas"],
        },
      ],
    });
    const errors: string[] = [];
    for (const path of typeof paths === "string" ? [paths] : (paths ?? [])) {
      try {
        await openPath(path);
      } catch (e) {
        errors.push(`${basename(path)}: ${String(e)}`);
      }
    }
    if (errors.length) throw new Error(errors.join("\n"));
  };
  const finishClose = async (request: "app" | number, discard: boolean) => {
    if (request === "app") {
      await ipc.discardRecovery();
      await ipc.exitApplication();
    } else {
      await ipc.closeProject(request, discard);
      commit({
        ...workspaceRef.current,
        projects: workspaceRef.current.projects?.filter(
          (p) => p.projectId !== request,
        ),
      });
      setSpace((current) => (current === request ? "home" : current));
      setTabs((current) => {
        const next = { ...current };
        delete next[request];
        return next;
      });
      setSelected((current) => {
        const next = { ...current };
        delete next[request];
        return next;
      });
      setPythonEditors((current) => {
        const next = { ...current };
        delete next[request];
        return next;
      });
    }
    setCloseRequest(null);
    closingRef.current = false;
    saves.resume(request === "app" ? undefined : `project:${request}`);
  };
  const requestClose = async (request: "app" | number) => {
    const targetId = request === "app" ? undefined : `project:${request}`;
    saves.pause(targetId);
    try {
      await saves.wait(targetId);
      if (!readyRef.current && request === "app") {
        await ipc.exitApplication();
        return;
      }
      if (
        request === "app"
          ? savingRef.current.size > 0
          : savingRef.current.has(request)
      )
        throw new Error("Wait for the project save to finish before closing.");
      if (
        workspaceRef.current.projects?.some(
          (p) =>
            p.calculation?.running &&
            (request === "app" || p.projectId === request),
        )
      )
        throw new Error("Cancel the calculation before closing.");
      const activeJobs = (await ipc.getPythonJobs()).filter(job => isPythonJobActive(job) && (request === "app" || job.projectId === request));
      if (activeJobs.length) {
        showPythonJobs(activeJobs[0].id);
        throw new Error("Cancel the active Python jobs before closing.");
      }
      await flushDrafts();
      try { await saves.flush(targetId); } catch (error) { report(error); }
      const current = await refresh();
      const dirty =
        request === "app"
          ? current.documents.some((d) => d.dirty) || current.markdown?.some(d => d.dirty) ||
            current.projects?.some((p) => p.dirty)
          : current.projects?.find((p) => p.projectId === request)?.dirty;
      if (dirty) setCloseRequest(request);
      else await finishClose(request, false);
    } catch (error) { saves.resume(targetId); throw error; }
  };
  const saveAndClose = async () => {
    const request = closeRequest;
    if (request === null) return;
    await flushDrafts();
    if (request === "app") {
      for (const d of workspaceRef.current.markdown?.filter(d => d.dirty) ?? []) if (!(await saveMarkdown(d.id))) return;
      for (const d of workspaceRef.current.documents.filter((d) => d.dirty)) {
        if (!(await saveCsv(d.documentId))) return;
      }
      for (const p of workspaceRef.current.projects?.filter((p) => p.dirty) ??
        [])
        if (!(await saveProjectById(p.projectId))) return;
    } else if (!(await saveProjectById(request))) return;
    await finishClose(request, false);
  };
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;
  const startup = useRef<Promise<WorkspaceSummary> | null>(null);
  useEffect(() => {
    let alive = true;
    startup.current ??= (async () => {
      let next = await ipc.getWorkspaceSummary();
      if (await ipc.recoveryAvailable()) {
        if (
          await ask("Tablune found unsaved work. Restore it?", {
            title: "Recover workspace",
            kind: "info",
          })
        )
          next = await ipc.restoreRecovery();
        else await ipc.discardRecovery();
      }
      return next;
    })();
    void startup.current
      .then(async (next) => {
        if (!alive) return;
        commit(next);
        if (next.projects?.length) {
          const p = next.projects[0];
          setSpace(p.projectId);
          if (p.tables[0])
            openTab(p.projectId, { kind: "table", id: p.tables[0].id });
          else if (p.canvases?.[0]) openTab(p.projectId, { kind: "canvas", id: p.canvases[0].id });
          else if (p.markdown?.[0]) openTab(p.projectId, { kind: "markdown", id: p.markdown[0].id });
        } else if (next.markdown?.length) {
          setSpace("markdown"); setSelectedMarkdown(next.markdown[0].id);
        } else if (next.documents.length) {
          setSpace("csv");
          setSelectedCsv(next.documents[0].documentId);
        }
        setReady(true);
        await refreshRecents();
      })
      .catch((e) => {
        if (alive) report(e);
      });
    return () => {
      alive = false;
    };
  }, [commit, openTab, refreshRecents, report]);
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let disposeQuit: (() => void) | undefined;
    let alive = true;
    void listen("tablune-request-exit", () => {
      if (closingRef.current) return;
      closingRef.current = true;
      void closeRef.current("app").catch((e) => {
        report(e);
        closingRef.current = false;
      });
    })
      .then((fn) => {
        if (alive) disposeQuit = fn;
        else fn();
      })
      .catch(report);
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        if (closingRef.current) return;
        closingRef.current = true;
        try {
          await closeRef.current("app");
        } catch (e) {
          report(e);
          closingRef.current = false;
        }
      })
      .then((fn) => {
        if (alive) dispose = fn;
        else fn();
      });
    return () => {
      alive = false;
      dispose?.();
      disposeQuit?.();
    };
  }, [report]);
  // Debounced durable drafts, including projects with no table edits.
  useEffect(() => {
    if (!Object.keys(canvasDrafts).length && !Object.keys(markdownDrafts).length && !Object.keys(drafts).length && !Object.keys(functionDrafts).length)
      return;
    const timer = window.setTimeout(() => {
      if (closingRef.current) return;
      void flushDrafts({ background: true })
        .then(() => ipc.writeWorkspaceRecovery())
        .catch(report);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [drafts, functionDrafts, markdownDrafts, canvasDrafts, flushDrafts, report]);
  const recoveryKey = JSON.stringify([
    workspace.markdown?.map(d => [d.id, d.revision, d.dirty]),
    workspace.documents.map((d) => [d.documentId, d.revision, d.dirty]),
    workspace.projects?.map((p) => [p.projectId, p.revision, p.dirty]),
  ]);
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      if (closingRef.current) return;
      void flushDrafts({ background: true })
        .then(() => ipc.writeWorkspaceRecovery())
        .catch(report);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [recoveryKey, ready, flushDrafts, report]);
  useEffect(() => {
    let alive = true;
    let dispose: (() => void) | undefined;
    void listen<ProjectSummary>("tablune-calculation", (event) => {
      if (
        alive &&
        workspaceRef.current.projects?.some(
          (p) => p.projectId === event.payload.projectId,
        )
      )
        updateProject(event.payload);
    })
      .then((fn) => {
        if (alive) dispose = fn;
        else fn();
      })
      .catch(report);
    return () => {
      alive = false;
      dispose?.();
    };
  }, [updateProject, report]);
  const calculationRequests = useRef(new Set<number>());
  const calculationKey = JSON.stringify(
    workspace.projects?.map((p) => [
      p.projectId,
      p.calculation,
      p.tables.map((t) => [t.document.revision, t.document.calculationRevision, t.document.pendingCells]),
    ]),
  );
  useEffect(() => {
    if (!ready || closingRef.current) return;
    const timer = window.setTimeout(() => {
      for (const p of workspaceRef.current.projects ?? []) {
        if (
          p.calculation?.running ||
          savingRef.current.has(p.projectId) ||
          calculationRequests.current.has(p.projectId) ||
          !p.tables.some((t) => (t.document.pendingCells ?? 0) > 0)
        )
          continue;
        // Rust ignores automatic requests until inputs change after opening or the last attempt.
        calculationRequests.current.add(p.projectId);
        void ipc
          .recalculateProject(p.projectId)
          .then((next) => {
            if (
              workspaceRef.current.projects?.some(
                (p) => p.projectId === next.projectId,
              )
            )
              updateProject(next);
          })
          .catch(report)
          .finally(() => calculationRequests.current.delete(p.projectId));
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [calculationKey, ready, savingProjects, updateProject, report]);
  // A destination is registered once, regardless of how many editors share it.
  useEffect(() => {
    const targets: SaveTarget[] = [
      ...workspace.documents.map(d => ({ id: `csv:${d.documentId}`, preferenceKey: `csv:${d.path ?? `session-${d.documentId}`}`, path: d.path, dirty: d.dirty, revision: String(d.revision) })),
      ...(workspace.markdown ?? []).map(d => ({ id: `markdown:${d.id}`, preferenceKey: `markdown:${d.path ?? d.id}`, path: d.path,
        dirty: d.dirty || markdownDrafts[`file:${d.id}`] !== undefined,
        revision: JSON.stringify([d.revision, markdownDrafts[`file:${d.id}`]]) })),
      ...(workspace.projects ?? []).map(p => {
        const scripts = Object.entries(drafts).filter(([key]) => key.startsWith(`${p.projectId}:`));
        const canvases = Object.entries(canvasDrafts).filter(([key]) => key.startsWith(`${p.projectId}:`));
        const documents = Object.entries(markdownDrafts).filter(([key]) => key.startsWith(`${p.projectId}:`));
        return { id: `project:${p.projectId}`, preferenceKey: `project:${p.path ?? p.persistentId}`, path: p.path,
          dirty: p.dirty || canvases.length > 0 || scripts.length > 0 || documents.length > 0 || functionDrafts[p.projectId] !== undefined,
          revision: JSON.stringify([p.revision, p.tables.map(t => [t.id, t.document.revision, t.document.calculationRevision]), scripts, documents, canvases, functionDrafts[p.projectId]]) };
      }),
    ].map(target => ({ ...target, save: () => autosaveTarget(target.id) }));
    saves.reconcile(targets, ready && !busy && closeRequest === null);
  });
  return {
    saves, saveCsv, canvasDrafts, editCanvas,
    selectedMarkdown, setSelectedMarkdown, markdownDrafts, editMarkdown, actMarkdown, newMarkdown, saveMarkdown, closeMarkdown,
    functionDrafts,
    editFunctions,
    workspace,
    workspaceRef,
    commit,
    updateProject,
    refresh,
    space,
    setSpace,
    selectedCsv,
    setSelectedCsv,
    tabs,
    selected,
    pythonEditors,
    closePythonEditor,
    openTab,
    closeTab,
    recents,
    refreshRecents,
    error,
    setError,
    report,
    busy,
    guard,
    ready,
    savingProjects,
    drafts,
    editScript,
    flushDrafts,
    perform,
    saveProjectById,
    createProject,
    newCsv, newCanvas,
    openPath,
    openFiles,
    closeRequest,
    setCloseRequest,
    requestClose,
    saveAndClose,
    finishClose,
    cancelClose: () => {
      saves.resume(typeof closeRequest === "number" ? `project:${closeRequest}` : undefined);
      setCloseRequest(null);
      closingRef.current = false;
    },
  };
}
