import { lazy, Suspense, useEffect, useState } from "react";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import CsvWorkspace from "./CsvWorkspace";
import { flushCellEdits } from "./CsvGrid";
import { newFunctionDraft } from "./formulaCatalog";
import RibbonHeader from "./RibbonHeader";
import ProjectSidebar from "./ProjectSidebar";
import ProjectExplorer from "./ProjectExplorer";
import { projectEntries, projectItemPath } from "./projectTree";
import ProjectTabs from "./ProjectTabs";
import ProjectFunctionsEditor from "./ProjectFunctionsEditor";
import ProjectScriptEditor from "./ProjectScriptEditor";
import { useWorkspace, type ProjectTab } from "./useWorkspace";
import { readThemePreference, writeThemePreference } from "./theme";
import * as ipc from "./ipc";
import type { DocumentSummary, MarkdownDocument, ProjectSummary } from "./types";

const MarkdownEditor = lazy(() => import("./MarkdownEditor"));

export default function App() {
  const w = useWorkspace();
  const [ribbonTarget, setRibbonTarget] = useState<HTMLDivElement | null>(null);
  const [theme, setTheme] = useState(readThemePreference);
  const [nameRequest, setNameRequest] = useState<{
    title: string;
    value: string;
    resolve: (value: string | null) => void;
  } | null>(null);
  const requestName = (title: string, value: string) =>
    new Promise<string | null>((resolve) =>
      setNameRequest({ title, value, resolve }),
    );
  const project = w.workspace.projects?.find((p) => p.projectId === w.space);
  const changeTheme = (next: typeof theme) => {
    setTheme(next);
    writeThemePreference(next);
  };
  useEffect(() => {
    document.documentElement.style.colorScheme = theme;
  }, [theme]);
  const createProject = () =>
    w.guard(async () => {
      const name = await requestName("New project", "Untitled project");
      if (name) await w.createProject(name);
    });
  const updateDocuments = (documents: DocumentSummary[]) => {
    w.commit({ ...w.workspaceRef.current, documents });
    if (!documents.length && w.space === "csv") w.setSpace("home");
    void w.refreshRecents().catch(w.report);
  };
  const projectDocuments = (
    p: ProjectSummary,
    documents: DocumentSummary[],
  ) => {
    const current = w.workspaceRef.current.projects?.find(
      (c) => c.projectId === p.projectId,
    );
    if (!current) return;
    w.updateProject({
      ...current,
      dirty: true,
      revision: `local-${Date.now()}`,
      tables: current.tables.map((t) => ({
        ...t,
        document:
          documents.find((d) => d.documentId === t.document.documentId) ??
          t.document,
      })),
    });
  };
  const newTable = (p: ProjectSummary, folderId?: string | null) =>
    w.guard(async () => {
      const next = await w.perform(p.projectId, { kind: "newTable", ...(folderId !== undefined ? { folderId } : {}) });
      w.openTab(p.projectId, { kind: "table", id: next.tables.at(-1)!.id });
    });
  const newScript = (p: ProjectSummary, folderId?: string | null) =>
    w.guard(async () => {
      const next = await w.perform(p.projectId, { kind: "newScript", ...(folderId !== undefined ? { folderId } : {}) });
      openNewScript(next);
    });
  const openNewScript = (p: ProjectSummary) => {
    const script = p.scripts.at(-1)!;
    const selected = w.selected[p.projectId];
    const inputTableId = selected?.kind === "table"
      ? p.tables.find((t) => t.id === selected.id)?.id ?? script.inputTableId
      : script.inputTableId;
    if (inputTableId !== script.inputTableId)
      w.editScript(p.projectId, script.id, { ...script, inputTableId });
    w.openTab(p.projectId, { kind: "script", id: script.id });
  };
  const importTables = (p: ProjectSummary, folderId?: string | null) =>
    w.guard(async () => {
      const paths = await open({
        multiple: true,
        filters: [
          { name: "Delimited text", extensions: ["csv", "tsv", "txt"] },
        ],
      });
      const failures: string[] = [];
      for (const path of typeof paths === "string" ? [paths] : (paths ?? [])) {
        try {
          const next = await w.perform(p.projectId, {
            kind: "importTable",
            path,
            ...(folderId !== undefined ? { folderId } : {}),
          });
          w.openTab(p.projectId, { kind: "table", id: next.tables.at(-1)!.id });
        } catch (e) {
          failures.push(`${path}: ${String(e)}`);
        }
      }
      if (failures.length) throw new Error(failures.join("\n"));
    });
  const importScript = (p: ProjectSummary, folderId?: string | null) =>
    w.guard(async () => {
      const path = await open({
        multiple: false,
        filters: [{ name: "Python script", extensions: ["py"] }],
      });
      if (typeof path !== "string") return;
      const next = await w.perform(p.projectId, {
        kind: "importScript",
        ...(folderId !== undefined ? { folderId } : {}),
        name: path.split(/[\\/]/).at(-1) ?? "Script.py",
        code: await ipc.readMacroScript(path),
      });
      openNewScript(next);
    });
  const renameTable = async (
    p: ProjectSummary,
    documentId: number,
    name: string,
  ): Promise<boolean> => {
    try {
      const table = p.tables.find((t) => t.document.documentId === documentId);
      if (!table) return false;
      await w.perform(p.projectId, {
        kind: "renameTable",
        tableId: table.id,
        name,
      });
      return true;
    } catch (e) {
      w.report(e);
      return false;
    }
  };
  const saveProject = async (p: ProjectSummary, saveAs = false) => {
    try {
      return await w.saveProjectById(p.projectId, saveAs);
    } catch (e) {
      w.report(e);
      return false;
    }
  };
  const renameItem = (p: ProjectSummary, tab: ProjectTab) =>
    w.guard(async () => {
      const table = p.tables.find((t) => t.id === tab.id);
      const script = p.scripts.find((s) => s.id === tab.id);
      if (tab.kind === "markdown") {
        const doc = p.markdown?.find(d => d.id === tab.id);
        const name = await requestName("Rename document", doc?.name ?? "");
        if (name) await w.actMarkdown(p.projectId, tab.id, { kind: "rename", name });
        return;
      }
      const name = await requestName(
        tab.kind === "table" ? "Rename table" : "Rename script",
        table?.document.displayName ?? script?.name ?? "",
      );
      if (!name) return;
      if (table)
        await w.perform(p.projectId, {
          kind: "renameTable",
          tableId: table.id,
          name,
        });
      else if (script) {
        w.editScript(p.projectId, script.id, {
          ...(w.drafts[`${p.projectId}:${script.id}`] ?? script),
          name,
        });
        await w.flushDrafts();
      }
    });
  const deleteItem = (p: ProjectSummary, tab: ProjectTab) =>
    w.guard(async () => {
      if (
        !(await ask(
          `Delete this ${tab.kind} from the project? This takes effect in the file when you save.`,
          { title: `Delete ${tab.kind}`, kind: "warning" },
        ))
      )
        return;
      if (tab.kind === "markdown") {
        await w.actMarkdown(p.projectId, tab.id, { kind: "delete", discard: true });
        w.closeTab(p.projectId, tab); return;
      }
      await w.perform(
        p.projectId,
        tab.kind === "table"
          ? { kind: "deleteTable", tableId: tab.id }
          : { kind: "deleteScript", scriptId: tab.id },
      );
      w.closeTab(p.projectId, tab);
    });
  const exportItem = (p: ProjectSummary, tab: ProjectTab) =>
    w.guard(async () => {
      if (tab.kind === "markdown") { await w.saveMarkdown(tab.id, true, p.projectId); return; }
      await w.flushDrafts();
      const current = w.workspaceRef.current.projects?.find(
        (c) => c.projectId === p.projectId,
      );
      if (!current) return;
      const table = current.tables.find((t) => t.id === tab.id);
      const script = current.scripts.find((s) => s.id === tab.id);
      const path = await save({
        defaultPath: table
          ? `${table.document.displayName.replace(/\.(csv|tsv|txt)$/i, "")}.csv`
          : script?.name,
        filters: [
          {
            name: table ? "CSV" : "Python script",
            extensions: [table ? "csv" : "py"],
          },
        ],
      });
      if (!path) return;
      if (table) await ipc.exportProjectTable(table.document.documentId, path);
      else if (script) await ipc.writeMacroScript(path, script.code);
    });
  const tabName = (p: ProjectSummary, t: ProjectTab) =>
    t.kind === "markdown" ? p.markdown?.find(d => d.id === t.id)?.name : t.kind === "functions"
      ? "Functions"
      : t.kind === "table"
        ? p.tables.find((x) => x.id === t.id)?.document.displayName
        : p.scripts.find((x) => x.id === t.id)?.name;
  const hasDrafts = (id: number) =>
    Object.keys(w.drafts).some((key) => key.startsWith(`${id}:`)) ||
    w.functionDrafts[id] !== undefined || Object.keys(w.markdownDrafts).some(key => key.startsWith(`${id}:`));
  const dirtyItems = [
    ...(w.workspace.markdown ?? []).filter(d => d.dirty || w.markdownDrafts[`file:${d.id}`] !== undefined).map(d => ({ key: `md-${d.id}`, name: d.name })),
    ...w.workspace.documents
      .filter((d) => d.dirty)
      .map((d) => ({ key: `csv-${d.documentId}`, name: d.displayName })),
    ...(w.workspace.projects ?? [])
      .filter((p) => p.dirty || hasDrafts(p.projectId))
      .map((p) => ({ key: `project-${p.projectId}`, name: p.name })),
  ];
  const tableRibbonVisible = w.space === "csv"
    ? w.workspace.documents.length > 0
    : Boolean(project?.tables.some((t) => w.selected[project.projectId]?.kind === "table" && w.selected[project.projectId]?.id === t.id));
  const navigation = (<>
        <button
          className="home-button"
          aria-current={w.space === "home" ? "page" : undefined}
          disabled={w.busy}
          onClick={() => w.setSpace("home")}
        >
          ⌂ Home
        </button>
        <label className="space-selector">
          Workspace{" "}
          <select
            aria-label="Workspace"
            disabled={w.busy}
            value={String(w.space)}
            onChange={(e) =>
              w.setSpace(
                e.target.value === "home" || e.target.value === "csv" || e.target.value === "markdown"
                  ? e.target.value
                  : Number(e.target.value),
              )
            }
          >
            <option value="home">Home</option>
            <option value="csv">
              CSV files ({w.workspace.documents.length})
            </option>
            <option value="markdown">Documents ({w.workspace.markdown?.length ?? 0})</option>
            {w.workspace.projects?.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.name}
                {p.dirty || hasDrafts(p.projectId) ? " •" : ""}
              </option>
            ))}
          </select>
        </label>
        {w.runningProject !== null && (
          <button onClick={() => void ipc.cancelPythonMacro().catch(w.report)}>
            Python running · Cancel
          </button>
        )}
      </>);
  const fileActions = (<>
        {project && (
          <>
            {!tableRibbonVisible && <><button
              disabled={w.busy || w.savingProjects.includes(project.projectId)}
              onClick={() => void saveProject(project)}
            >
              Save project
            </button>
            <button
              disabled={w.busy || w.savingProjects.includes(project.projectId)}
              onClick={() => void saveProject(project, true)}
            >
              Save as…
            </button>
            </>}
            <button
              disabled={w.busy || w.savingProjects.includes(project.projectId)}
              onClick={() =>
                void w.guard(() => w.requestClose(project.projectId))
              }
            >
              Close project
            </button>
          </>
        )}
      </>);
  const importMarkdown = (projectId: number, folderId: string | null) => w.guard(async () => {
    const path = await open({ filters: [{ name: "Markdown", extensions: ["md", "markdown"] }] });
    if (typeof path !== "string") return;
    const next = await w.perform(projectId, { kind: "importDocument", path, folderId });
    w.openTab(projectId, { kind: "markdown", id: next.markdown!.at(-1)!.id });
  });
  const markdownPane = (doc: MarkdownDocument, projectId: number | null, active: boolean) => {
    const key = `${projectId ?? "file"}:${doc.id}`;
    const locked = w.busy || w.closeRequest !== null || (projectId !== null && w.savingProjects.includes(projectId));
    return <div key={key} className="markdown-workspace" hidden={!active}>
      {projectId === null && <div className="markdown-file-actions">
        <strong>{doc.name}{doc.dirty && projectId === null || w.markdownDrafts[key] !== undefined ? " •" : ""}</strong>
        <button disabled={locked} onClick={() => void w.guard(() => projectId === null ? w.saveMarkdown(doc.id) : w.saveProjectById(projectId))}>{projectId === null ? "Save" : "Save project"}</button>
        <button disabled={locked} onClick={() => void w.guard(() => w.saveMarkdown(doc.id, true, projectId))}>{projectId === null ? "Save as…" : "Export Markdown…"}</button>
        {projectId === null && <>
          <button disabled={locked} onClick={() => void w.guard(async () => {
            const name = await requestName("Create project from document", doc.name.replace(/\.(md|markdown)$/i, ""));
            if (!name) return;
            const p = await w.createProject(name);
            const copy = await w.actMarkdown(null, doc.id, { kind: "copyToProject", targetProjectId: p.projectId });
            w.openTab(p.projectId, { kind: "markdown", id: copy.id });
          })}>Create project…</button>
          {!!w.workspace.projects?.length && <select aria-label="Copy document to project" value="" disabled={locked} onChange={event => {
            const targetProjectId = Number(event.target.value);
            void w.guard(async () => { const copy = await w.actMarkdown(null, doc.id, { kind: "copyToProject", targetProjectId }); w.openTab(targetProjectId, { kind: "markdown", id: copy.id }); });
          }}><option value="" disabled>Add to project…</option>{w.workspace.projects.map(p => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}</select>}
          <button disabled={locked} onClick={() => void w.guard(() => w.closeMarkdown(doc.id))}>Close document</button>
        </>}
      </div>}
      <Suspense fallback={<p>Loading document editor…</p>}><MarkdownEditor documentId={doc.id} projectId={projectId}
        value={w.markdownDrafts[key] ?? doc.content} disabled={locked}
        linkTargets={projectId === null ? [] : (() => {
          const current = w.workspace.projects?.find(p => p.projectId === projectId);
          return current ? projectEntries(current).filter((entry): entry is typeof entry & { kind: "markdown" | "table" | "script" } => entry.kind !== "folder" && entry.id !== doc.id).map(entry => ({ ...entry, path: projectItemPath(current, entry.id) })) : [];
        })()}
        onOpenLink={link => void w.guard(async () => {
          if (link.kind === "file") { await w.openPath(link.value); return; }
          const current = w.workspaceRef.current.projects?.find(p => p.projectId === projectId);
          const entry = current && projectEntries(current).find(item => item.id === link.value && item.kind !== "folder");
          if (!current || !entry || entry.kind === "folder") throw new Error("El documento vinculado ya no existe en este proyecto.");
          w.openTab(current.projectId, { kind: entry.kind, id: entry.id }, "main");
          w.setSpace(current.projectId);
        })}
        onChange={content => w.editMarkdown(projectId, doc.id, content)} onError={w.report}
        onSave={() => { if (!locked) void w.guard(() => projectId === null ? w.saveMarkdown(doc.id) : w.saveProjectById(projectId)); }} /></Suspense>
    </div>;
  };
  return (
    <main className="app-shell product-shell" data-theme={theme}>
      <div className="application-ribbon" ref={setRibbonTarget} hidden={w.space === "home"}>
        {w.space !== "home" && !tableRibbonVisible && <RibbonHeader
          tableAvailable={false}
          navigation={navigation}
          fileActions={fileActions}
          theme={theme}
          onThemeChange={changeTheme}
        />}
      </div>
      {w.error && (
        <div className="shell-error" role="alert">
          {w.error}
          <button aria-label="Dismiss error" onClick={() => w.setError(null)}>
            ×
          </button>
        </div>
      )}
      <div className="space-content" aria-busy={w.busy}>
        {w.space === "home" && (
          <section className="home-screen">
            <div className="home-heading">
              <img src="/brand/tablune-icon.png" alt="" />
              <div>
                <p className="eyebrow">YOUR LOCAL DATA WORKSPACE</p>
                <h1>Tablune Sheets</h1>
                <p>Start with a file. Build a project you can return to.</p>
              </div>
            </div>
            <div className="home-start">
              <button disabled={!w.ready || w.busy} onClick={() => void w.guard(() => w.newMarkdown())}><strong>New document</strong><span>Write a Markdown document with images</span></button>
              <button
                disabled={!w.ready || w.busy}
                onClick={() => void w.guard(w.newCsv)}
              >
                <strong>New CSV</strong>
                <span>A blank table, ready to edit</span>
              </button>
              <button
                disabled={!w.ready || w.busy}
                onClick={() => void createProject()}
              >
                <strong>New project</strong>
                <span>Keep tables, documents and Python scripts together</span>
              </button>
              <button
                disabled={!w.ready || w.busy}
                onClick={() => void w.guard(w.openFiles)}
              >
                <strong>Open…</strong>
                <span>CSV, TSV, Markdown or a .tablune project</span>
              </button>
            </div>
            {(w.workspace.documents.length > 0 ||
              Boolean(w.workspace.projects?.length) || Boolean(w.workspace.markdown?.length)) && (
              <section>
                <h2>Open workspaces</h2>
                <div className="open-spaces">
                  {!!w.workspace.markdown?.length && <button onClick={() => w.setSpace("markdown")}>Documents · {w.workspace.markdown.length} open</button>}
                  {w.workspace.documents.length > 0 && (
                    <button onClick={() => w.setSpace("csv")}>
                      CSV files · {w.workspace.documents.length} open
                    </button>
                  )}
                  {w.workspace.projects?.map((p) => (
                    <button
                      key={p.projectId}
                      onClick={() => w.setSpace(p.projectId)}
                    >
                      {p.name} · {p.tables.length} tables
                      {p.dirty || hasDrafts(p.projectId) ? " · Unsaved" : ""}
                    </button>
                  ))}
                </div>
              </section>
            )}
            <section className="recent-section">
              <h2>Recent files</h2>
              {w.recents.length === 0 ? (
                <p className="empty-hint">
                  Files and projects you open or save will appear here.
                </p>
              ) : (
                <ul className="recent-list">
                  {w.recents.map((r) => (
                    <li key={r.path}>
                      <button
                        disabled={w.busy}
                        onClick={() => void w.guard(() => w.openPath(r.path))}
                      >
                        <span className="recent-kind">
                          {r.kind === "project" ? "◆" : "▤"}
                        </span>
                        <span>
                          <strong>{r.path.split(/[\\/]/).at(-1)}</strong>
                          <small>
                            {r.kind === "project"
                              ? "Tablune project"
                              : r.kind === "markdown" ? "Markdown document" : "CSV file"}{" "}
                            · {r.path}
                          </small>
                        </span>
                      </button>
                      <button
                        aria-label={`Remove ${r.path} from recent files`}
                        onClick={() =>
                          void w.guard(async () => {
                            await ipc.removeRecentFile(r.path);
                            await w.refreshRecents();
                          })
                        }
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <p className="home-version">
              Tablune 0.5 · Stored on your computer
            </p>
          </section>
        )}
        <section className="markdown-workspace space-pane" hidden={w.space !== "markdown"}>
          <nav className="document-tabs" aria-label="Markdown documents">
            {w.workspace.markdown?.map(doc => <button key={doc.id} aria-pressed={w.selectedMarkdown === doc.id} onClick={() => w.setSelectedMarkdown(doc.id)}>{doc.name}{doc.dirty || w.markdownDrafts[`file:${doc.id}`] !== undefined ? " •" : ""}</button>)}
            <button disabled={w.busy} onClick={() => void w.guard(() => w.newMarkdown())}>New document</button>
            <button disabled={w.busy} onClick={() => void w.guard(w.openFiles)}>Open…</button>
          </nav>
          {w.workspace.markdown?.map(doc => markdownPane(doc, null, doc.id === w.selectedMarkdown))}
        </section>
        <div className="csv-space space-pane" hidden={w.space !== "csv"}>
          {w.workspace.documents.length > 0 ? (
            <>
              <div className="csv-project-action">
                <button
                  disabled={w.busy}
                  onClick={() =>
                    void w.guard(async () => {
                      const d = w.workspace.documents.find(
                        (d) => d.documentId === w.selectedCsv,
                      );
                      if (!d) return;
                      const name = await requestName(
                        "Create project from CSV",
                        d.displayName.replace(/\.[^.]+$/, ""),
                      );
                      if (name) await w.createProject(name, d.documentId);
                    })
                  }
                >
                  Create project from this CSV…
                </button>
              </div>
            </>
          ) : (
            <div className="empty-workspace">
              <h2>No CSV files open</h2>
              <button onClick={() => void w.guard(w.newCsv)}>New CSV</button>
              <button onClick={() => void w.guard(w.openFiles)}>Open…</button>
            </div>
          )}
          <div className="grid-host" hidden={!w.workspace.documents.length}>
            <CsvWorkspace
              managed
              ribbonTarget={ribbonTarget}
              ribbonVisible={w.space === "csv" && tableRibbonVisible}
              ribbonControls={{ navigation, fileActions }}
              theme={theme}
              active={w.space === "csv" && !w.busy && w.closeRequest === null}
              documents={w.workspace.documents}
              onCreateFormatProject={() => void w.guard(async () => {
                await flushCellEdits();
                const source = w.workspaceRef.current.documents.find(d => d.documentId === w.selectedCsv);
                if (!source) return;
                const name = await requestName("Crear proyecto desde CSV", source.displayName.replace(/\.[^.]+$/, ""));
                if (name) await w.createProject(name, source.documentId);
              })}
              onCreateImageProject={async (row, column) => {
                try {
                const source = w.workspace.documents.find(d => d.documentId === w.selectedCsv);
                if (!source) return;
                const name = await requestName("Create project from CSV", source.displayName.replace(/\.[^.]+$/, ""));
                if (!name) return;
                const project = await w.createProject(name, source.documentId);
                const table = project.tables[0]?.document;
                if (!table) return;
                const path = await open({ title: "Insert image", multiple: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }] });
                if (typeof path !== "string") return;
                const image = await ipc.importCellImage(table.documentId, path);
                await ipc.applySessionEdit(table.documentId, { kind: "setSheetCells", cells: [{ row, column, value: image.name, image, literal: true }] }, table.revision);
                w.commit(await ipc.getWorkspaceSummary());
                } catch (reason) { w.report(reason); throw reason; }
              }}
              selectedId={w.selectedCsv}
              onDocuments={updateDocuments}
              onActivate={w.setSelectedCsv}
              onOpen={() => void w.guard(w.openFiles)}
              onTheme={changeTheme}
            />
          </div>
        </div>
        {w.workspace.projects?.map((p) => {
          const locked = w.busy || w.savingProjects.includes(p.projectId);
          const active = w.selected[p.projectId];
          const pythonEditor = w.pythonEditors[p.projectId];
          const actionItem = pythonEditor ?? active;
          const table = p.tables.find(
            (t) => t.id === active?.id && active.kind === "table",
          );
          const visibleTabs = (w.tabs[p.projectId] ?? []).filter((t) =>
            tabName(p, t),
          );
          const mainScriptIds = new Set(visibleTabs.filter(tab => tab.kind === "script").map(tab => tab.id));
          const scriptPanes = p.scripts.map((s) => (
                      <div
                        key={s.id}
                        className="script-host"
                        hidden={mainScriptIds.has(s.id) ? active?.kind !== "script" || active.id !== s.id : pythonEditor?.kind !== "script" || pythonEditor.id !== s.id}
                      >
                        <ProjectScriptEditor
                          project={p}
                          script={s}
                          draft={w.drafts[`${p.projectId}:${s.id}`]}
                          disabled={locked || w.closeRequest !== null}
                          runningProject={w.runningProject}
                          onEdit={(draft) => w.editScript(p.projectId, s.id, draft)}
                          onFlush={w.flushDrafts}
                          onRunning={w.setRunningProject}
                          onError={w.report}
                          onResult={(next) => {
                            w.updateProject(next);
                            w.openTab(p.projectId, {
                              kind: "table",
                              id: next.tables.at(-1)!.id,
                            });
                          }}
                        />
                      </div>
                    ));
          return (
            <section
              key={p.projectId}
              className="project-space space-pane"
              hidden={w.space !== p.projectId}
            >
              <ProjectSidebar
                label={`${p.name} items`}
                editorTitle={pythonEditor ? pythonEditor.kind === "functions" ? tabName(p, pythonEditor) : projectItemPath(p, pythonEditor.id) : undefined}
                onCloseEditor={() => w.closePythonEditor(p.projectId)}
                editor={
                  <>
                    <div
                      className="script-host"
                      hidden={pythonEditor?.kind !== "functions"}
                    >
                      <ProjectFunctionsEditor
                        project={p}
                        code={
                          w.functionDrafts[p.projectId] ?? p.functions?.draft ?? ""
                        }
                        disabled={locked || w.closeRequest !== null}
                        onEdit={(code) => w.editFunctions(p.projectId, code)}
                        onFlush={w.flushDrafts}
                        onUpdate={w.updateProject}
                        onError={w.report}
                      />
                    </div>
                    {scriptPanes.filter((_, index) => !mainScriptIds.has(p.scripts[index].id))}
                  </>
                }
                footer={
                  pythonEditor && actionItem && actionItem.kind !== "functions" && (
                    <div className="item-actions">
                      <button
                        disabled={locked}
                        title="Rename…"
                        aria-label="Rename…"
                        onClick={() => void renameItem(p, actionItem)}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z" /></svg>
                      </button>
                      <button
                        disabled={locked}
                        title={`Export ${actionItem.kind === "table" ? "CSV" : actionItem.kind === "markdown" ? "Markdown" : ".py"}…`}
                        aria-label={`Export ${actionItem.kind === "table" ? "CSV" : actionItem.kind === "markdown" ? "Markdown" : ".py"}…`}
                        onClick={() => void exportItem(p, actionItem)}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5" /></svg>
                      </button>
                      <button
                        disabled={locked || w.runningProject === p.projectId}
                        className="danger"
                        title={`Delete ${actionItem.kind}…`}
                        aria-label={`Delete ${actionItem.kind}…`}
                        onClick={() => void deleteItem(p, actionItem)}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></svg>
                      </button>
                    </div>
                  )
                }
              >
                <ProjectExplorer
                  project={p}
                  active={active}
                  editor={pythonEditor}
                  disabled={locked || w.closeRequest !== null}
                  onAction={async action => { await flushCellEdits(); await w.flushDrafts(); return w.perform(p.projectId, action); }}
                  onOpen={tab => w.openTab(p.projectId, tab)}
                  onCreate={(kind, folderId) => {
                    if (kind === "table") void newTable(p, folderId);
                    else if (kind === "script") void newScript(p, folderId);
                    else void w.guard(async () => {
                      const next = await w.perform(p.projectId, { kind: "newDocument", name: "Untitled.md", folderId });
                      w.openTab(p.projectId, { kind: "markdown", id: next.markdown!.at(-1)!.id });
                    });
                  }}
                  onImport={(kind, folderId) => {
                    if (kind === "table") void importTables(p, folderId);
                    else if (kind === "script") void importScript(p, folderId);
                    else void importMarkdown(p.projectId, folderId);
                  }}
                  onRename={tab => void renameItem(p, tab)}
                  onDelete={tab => void deleteItem(p, tab)}
                  onExport={tab => void exportItem(p, tab)}
                  onDuplicate={tableId => void w.guard(async () => {
                    const next = await w.perform(p.projectId, { kind: "duplicateTable", tableId });
                    w.openTab(p.projectId, { kind: "table", id: next.tables.at(-1)!.id });
                  })}
                  onFunctions={() => w.openTab(p.projectId, { kind: "functions", id: "functions" })}
                />
              </ProjectSidebar>
              <div className="project-main">
                <ProjectTabs
                  tabs={visibleTabs.map((tab) => ({ ...tab, name: tabName(p, tab)! }))}
                  active={active}
                  disabled={locked}
                  onActivate={(tab) => w.openTab(p.projectId, tab)}
                  onClose={(tab) => w.closeTab(p.projectId, tab)}
                  onNew={() => void newTable(p)}
                />
                {active && <div className="project-breadcrumb" aria-label="Ruta del elemento" title={`${p.name} / ${projectItemPath(p, active.id)}`}>{p.name} / {projectItemPath(p, active.id)}</div>}
                {!active && (
                  <div className="empty-workspace">
                    <h1>{p.name}</h1>
                    <p>
                      Selecciona una tabla o un documento en el explorador, o crea un elemento con ＋.
                    </p>
                    <div>
                      <button
                        disabled={locked}
                        onClick={() => void newTable(p)}
                      >
                        Create a table
                      </button>
                      <button
                        disabled={locked}
                        onClick={() => void importTables(p)}
                      >
                        Import CSV…
                      </button>
                    </div>
                  </div>
                )}
                {p.markdown?.map(doc => markdownPane(doc, p.projectId, active?.kind === "markdown" && active.id === doc.id))}
                {scriptPanes.filter((_, index) => mainScriptIds.has(p.scripts[index].id))}
                <div className="grid-host" hidden={!table}>
                  <CsvWorkspace
                    managed
                    projectDirty={p.dirty || hasDrafts(p.projectId)}
                    appliedFunctions={p.functions?.applied ?? ""}
                    formulaControls={{
                      running: p.calculation?.running ?? false,
                      status: p.calculation?.error ?? (p.calculation?.running ? "Calculando…" : p.calculation?.paused ? "Cálculo en pausa" : p.tables.some(t => (t.document.pendingCells ?? 0) > 0) ? "Cálculo pendiente" : "Resultados al día"),
                      draftCode: w.functionDrafts[p.projectId] ?? p.functions?.draft ?? "",
                      onManage: create => {
                        if (create) w.editFunctions(p.projectId, newFunctionDraft(w.functionDrafts[p.projectId] ?? p.functions?.draft ?? ""));
                        w.openTab(p.projectId, { kind: "functions", id: "functions" });
                      },
                      onRecalculate: () => void (async () => { await flushCellEdits(); await w.flushDrafts(); w.updateProject(await ipc.recalculateProject(p.projectId, true)); })().catch(w.report),
                      onCancel: () => void ipc.cancelCalculation(p.projectId).then(w.updateProject).catch(w.report),
                    }}
                    ribbonTarget={ribbonTarget}
                    ribbonVisible={w.space === p.projectId && Boolean(table)}
                    ribbonControls={{ navigation, fileActions }}
                    theme={theme}
                    active={
                      w.space === p.projectId &&
                      Boolean(table) &&
                      !locked &&
                      w.closeRequest === null
                    }
                    documents={p.tables.map((t) => t.document)}
                    selectedId={table?.document.documentId ?? 0}
                    onDocuments={(docs) => projectDocuments(p, docs)}
                    onTheme={changeTheme}
                    onActivate={(id) => {
                      const t = p.tables.find(
                        (t) => t.document.documentId === id,
                      );
                      if (t)
                        w.openTab(p.projectId, { kind: "table", id: t.id });
                    }}
                    project={{
                      onNew: () => void newTable(p),
                      onImport: () => void importTables(p),
                      onSave: (saveAs) => saveProject(p, saveAs),
                      onRename: (id, name) => renameTable(p, id, name),
                      onDuplicate: (id) => {
                        const t = p.tables.find(
                          (t) => t.document.documentId === id,
                        );
                        if (t)
                          void w.guard(() =>
                            w.perform(p.projectId, {
                              kind: "duplicateTable",
                              tableId: t.id,
                            }),
                          );
                      },
                      onCloseTab: (id) => {
                        const t = p.tables.find(
                          (t) => t.document.documentId === id,
                        );
                        if (t)
                          w.closeTab(p.projectId, { kind: "table", id: t.id });
                      },
                      onScript: () => void newScript(p),
                    }}
                  />
                </div>
              </div>
            </section>
          );
        })}
      </div>
      {nameRequest && (
        <div className="unsaved-backdrop">
          <form
            className="unsaved-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="name-title"
            onSubmit={(e) => {
              e.preventDefault();
              const name = nameRequest.value.trim();
              if (name) {
                nameRequest.resolve(name);
                setNameRequest(null);
              }
            }}
          >
            <h1 id="name-title">{nameRequest.title}</h1>
            <input
              aria-label="Name"
              autoFocus
              required
              maxLength={240}
              value={nameRequest.value}
              onChange={(e) =>
                setNameRequest({ ...nameRequest, value: e.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  nameRequest.resolve(null);
                  setNameRequest(null);
                }
              }}
            />
            <div className="unsaved-actions">
              <button
                type="button"
                onClick={() => {
                  nameRequest.resolve(null);
                  setNameRequest(null);
                }}
              >
                Cancel
              </button>
              <button type="submit" className="primary">
                Continue
              </button>
            </div>
          </form>
        </div>
      )}
      {w.closeRequest !== null && (
        <div className="unsaved-backdrop">
          <section
            className="unsaved-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-title"
          >
            <h1 id="close-title">Save changes before closing?</h1>
            <ul>
              {(w.closeRequest === "app"
                ? dirtyItems
                : dirtyItems.filter(
                    (i) => i.key === `project-${w.closeRequest}`,
                  )
              ).map((i) => (
                <li key={i.key}>{i.name}</li>
              ))}
            </ul>
            {w.error && <p role="alert">{w.error}</p>}
            <div className="unsaved-actions">
              <button disabled={w.busy} onClick={w.cancelClose}>
                Cancel
              </button>
              <button
                disabled={w.busy}
                className="danger"
                onClick={() =>
                  void w.guard(() => w.finishClose(w.closeRequest!, true))
                }
              >
                Discard
              </button>
              <button
                disabled={w.busy}
                className="primary"
                autoFocus
                onClick={() => void w.guard(w.saveAndClose)}
              >
                Save
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
