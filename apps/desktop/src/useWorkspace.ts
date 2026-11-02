import { flushMarkdownEditors } from "./markdownPending";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import * as ipc from "./ipc";
import { flushCellEdits } from "./CsvGrid";
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
export type ProjectTab = { kind: "table" | "script" | "functions" | "markdown"; id: string };
export type ScriptDraft = Pick<ScriptSummary, "name" | "code" | "inputTableId">;
const basename = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
export function useWorkspace() {
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
  const [runningProject, setRunningProject] = useState<number | null>(null);
  const runningRef = useRef<number | null>(null);
  runningRef.current = runningProject;
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
    setBusy(true);
    setError(null);
    try {
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
  const flushDrafts = useCallback((): Promise<void> => {
    const run = flushChain.current
      .catch(() => {})
      .then(async () => {
        await flushCellEdits();
        await flushMarkdownEditors();
        for (const [key, content] of Object.entries(markdownDraftsRef.current)) {
          const [owner, id] = key.split(":");
          const projectId = owner === "file" ? null : Number(owner);
          const docs = projectId === null ? workspaceRef.current.markdown : workspaceRef.current.projects?.find(p => p.projectId === projectId)?.markdown;
          const doc = docs?.find(d => d.id === id);
          if (!doc) continue;
          if (content !== doc.content) updateMarkdown(projectId, await ipc.markdownAction(projectId, id, { kind: "update", content, expectedRevision: doc.revision }));
          if (markdownDraftsRef.current[key] === content) {
            const next = { ...markdownDraftsRef.current }; delete next[key]; markdownDraftsRef.current = next; setMarkdownDrafts(next);
          }
        }
        for (const [id, code] of Object.entries(functionDraftsRef.current)) {
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
  };
  const closeMarkdown = async (id: string) => {
    await flushDrafts();
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
    await flushDrafts();
    const project = workspaceRef.current.projects?.find(
      (p) => p.projectId === projectId,
    );
    if (!project) return false;
    let path = saveAs ? null : project.path;
    if (!path)
      path = await save({
        defaultPath: `${project.name}.tablune`,
        filters: [{ name: "Tablune project", extensions: ["tablune"] }],
      });
    if (!path) return false;
    if (!path.toLowerCase().endsWith(".tablune")) path += ".tablune";
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
    } else if (path.toLowerCase().endsWith(".tablune")) {
      const p = await ipc.openProject(path);
      updateProject(p);
      setSpace(p.projectId);
      if (!selected[p.projectId] && p.tables[0])
        openTab(p.projectId, { kind: "table", id: p.tables[0].id });
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
          extensions: ["csv", "tsv", "txt", "md", "markdown", "tablune"],
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
  };
  const requestClose = async (request: "app" | number) => {
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
    if (
      runningRef.current !== null &&
      (request === "app" || request === runningRef.current)
    ) {
      throw new Error("Cancel the running Python script before closing.");
    }
    await flushDrafts();
    const current = await refresh();
    const dirty =
      request === "app"
        ? current.documents.some((d) => d.dirty) || current.markdown?.some(d => d.dirty) ||
          current.projects?.some((p) => p.dirty)
        : current.projects?.find((p) => p.projectId === request)?.dirty;
    if (dirty) setCloseRequest(request);
    else await finishClose(request, false);
  };
  const saveAndClose = async () => {
    const request = closeRequest;
    if (request === null) return;
    await flushDrafts();
    if (request === "app") {
      for (const d of workspaceRef.current.markdown?.filter(d => d.dirty) ?? []) if (!(await saveMarkdown(d.id))) return;
      for (const d of workspaceRef.current.documents.filter((d) => d.dirty)) {
        const path =
          d.path ??
          (await save({
            defaultPath: d.displayName,
            filters: [{ name: "CSV", extensions: ["csv", "tsv", "txt"] }],
          }));
        if (!path) return;
        const next = await ipc.saveSession(d.documentId, path);
        commit({
          ...workspaceRef.current,
          documents: workspaceRef.current.documents.map((c) =>
            c.documentId === d.documentId ? next : c,
          ),
        });
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
    if (!Object.keys(markdownDrafts).length && !Object.keys(drafts).length && !Object.keys(functionDrafts).length)
      return;
    const timer = window.setTimeout(() => {
      if (closingRef.current) return;
      void flushDrafts()
        .then(() => ipc.writeWorkspaceRecovery())
        .catch(report);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [drafts, functionDrafts, markdownDrafts, flushDrafts, report]);
  const recoveryKey = JSON.stringify([
    workspace.markdown?.map(d => [d.id, d.revision, d.dirty]),
    workspace.documents.map((d) => [d.documentId, d.revision, d.dirty]),
    workspace.projects?.map((p) => [p.projectId, p.revision, p.dirty]),
  ]);
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      if (closingRef.current) return;
      void flushDrafts()
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
  return {
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
    runningProject,
    setRunningProject,
    drafts,
    editScript,
    flushDrafts,
    perform,
    saveProjectById,
    createProject,
    newCsv,
    openPath,
    openFiles,
    closeRequest,
    setCloseRequest,
    requestClose,
    saveAndClose,
    finishClose,
    cancelClose: () => {
      setCloseRequest(null);
      closingRef.current = false;
    },
  };
}
