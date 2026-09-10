import { useEffect, useState } from "react";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import CsvWorkspace from "./CsvWorkspace";
import ProjectScriptEditor from "./ProjectScriptEditor";
import { useWorkspace, type ProjectTab } from "./useWorkspace";
import { readThemePreference, writeThemePreference } from "./theme";
import * as ipc from "./ipc";
import type { DocumentSummary, ProjectSummary } from "./types";

export default function App() {
  const w = useWorkspace();
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
  const newTable = (p: ProjectSummary) =>
    w.guard(async () => {
      const next = await w.perform(p.projectId, { kind: "newTable" });
      w.openTab(p.projectId, { kind: "table", id: next.tables.at(-1)!.id });
    });
  const newScript = (p: ProjectSummary) =>
    w.guard(async () => {
      const next = await w.perform(p.projectId, { kind: "newScript" });
      w.openTab(p.projectId, { kind: "script", id: next.scripts.at(-1)!.id });
    });
  const importTables = (p: ProjectSummary) =>
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
          });
          w.openTab(p.projectId, { kind: "table", id: next.tables.at(-1)!.id });
        } catch (e) {
          failures.push(`${path}: ${String(e)}`);
        }
      }
      if (failures.length) throw new Error(failures.join("\n"));
    });
  const importScript = (p: ProjectSummary) =>
    w.guard(async () => {
      const path = await open({
        multiple: false,
        filters: [{ name: "Python script", extensions: ["py"] }],
      });
      if (typeof path !== "string") return;
      const next = await w.perform(p.projectId, {
        kind: "importScript",
        name: path.split(/[\\/]/).at(-1) ?? "Script.py",
        code: await ipc.readMacroScript(path),
      });
      w.openTab(p.projectId, { kind: "script", id: next.scripts.at(-1)!.id });
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
    t.kind === "table"
      ? p.tables.find((x) => x.id === t.id)?.document.displayName
      : p.scripts.find((x) => x.id === t.id)?.name;
  const hasDrafts = (id: number) =>
    Object.keys(w.drafts).some((key) => key.startsWith(`${id}:`));
  const dirtyItems = [
    ...w.workspace.documents
      .filter((d) => d.dirty)
      .map((d) => ({ key: `csv-${d.documentId}`, name: d.displayName })),
    ...(w.workspace.projects ?? [])
      .filter((p) => p.dirty || hasDrafts(p.projectId))
      .map((p) => ({ key: `project-${p.projectId}`, name: p.name })),
  ];
  return (
    <main className="app-shell product-shell" data-theme={theme}>
      <header className="space-bar">
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
                e.target.value === "home" || e.target.value === "csv"
                  ? e.target.value
                  : Number(e.target.value),
              )
            }
          >
            <option value="home">Home</option>
            <option value="csv">
              CSV files ({w.workspace.documents.length})
            </option>
            {w.workspace.projects?.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.name}
                {p.dirty || hasDrafts(p.projectId) ? " •" : ""}
              </option>
            ))}
          </select>
        </label>
        {project && (
          <>
            <span className="space-title">
              {project.name}
              {project.dirty || hasDrafts(project.projectId) ? " •" : ""}
            </span>
            <button
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
        {w.runningProject !== null && (
          <button onClick={() => void ipc.cancelPythonMacro().catch(w.report)}>
            Python running · Cancel
          </button>
        )}
        <button
          className="theme-switch"
          aria-label="Toggle theme"
          onClick={() => changeTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? "Light" : "Dark"}
        </button>
      </header>
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
                <span>Keep your tables and Python scripts together</span>
              </button>
              <button
                disabled={!w.ready || w.busy}
                onClick={() => void w.guard(w.openFiles)}
              >
                <strong>Open…</strong>
                <span>CSV, TSV or a .tablune project</span>
              </button>
            </div>
            {(w.workspace.documents.length > 0 ||
              Boolean(w.workspace.projects?.length)) && (
              <section>
                <h2>Open workspaces</h2>
                <div className="open-spaces">
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
                              : "CSV file"}{" "}
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
              Tablune 0.4 · Stored on your computer
            </p>
          </section>
        )}
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
              theme={theme}
              active={w.space === "csv" && !w.busy && w.closeRequest === null}
              documents={w.workspace.documents}
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
          const table = p.tables.find(
            (t) => t.id === active?.id && active.kind === "table",
          );
          const visibleTabs = (w.tabs[p.projectId] ?? []).filter((t) =>
            tabName(p, t),
          );
          return (
            <section
              key={p.projectId}
              className="project-space space-pane"
              hidden={w.space !== p.projectId}
            >
              <aside
                className="project-navigator"
                aria-label={`${p.name} items`}
              >
                <h2>Tables</h2>
                <div className="navigator-actions">
                  <button disabled={locked} onClick={() => void newTable(p)}>
                    + Table
                  </button>
                  <button
                    disabled={locked}
                    onClick={() => void importTables(p)}
                  >
                    Import CSV…
                  </button>
                </div>
                {p.tables.map((t) => (
                  <button
                    key={t.id}
                    className="navigator-item"
                    aria-pressed={active?.id === t.id}
                    onClick={() =>
                      w.openTab(p.projectId, { kind: "table", id: t.id })
                    }
                  >
                    ▤ {t.document.displayName}
                  </button>
                ))}
                <h2>Scripts</h2>
                <div className="navigator-actions">
                  <button disabled={locked} onClick={() => void newScript(p)}>
                    + Script
                  </button>
                  <button
                    disabled={locked}
                    onClick={() => void importScript(p)}
                  >
                    Import .py…
                  </button>
                </div>
                {p.scripts.map((s) => (
                  <button
                    key={s.id}
                    className="navigator-item"
                    aria-pressed={active?.id === s.id}
                    onClick={() =>
                      w.openTab(p.projectId, { kind: "script", id: s.id })
                    }
                  >
                    ⌘ {s.name}
                  </button>
                ))}
                {active && (
                  <div className="item-actions">
                    <button
                      disabled={locked}
                      onClick={() => void renameItem(p, active)}
                    >
                      Rename…
                    </button>
                    <button
                      disabled={locked}
                      onClick={() => void exportItem(p, active)}
                    >
                      Export {active.kind === "table" ? "CSV" : ".py"}…
                    </button>
                    {table && (
                      <button
                        disabled={locked}
                        onClick={() =>
                          void w.guard(async () => {
                            const next = await w.perform(p.projectId, {
                              kind: "duplicateTable",
                              tableId: table.id,
                            });
                            w.openTab(p.projectId, {
                              kind: "table",
                              id: next.tables.at(-1)!.id,
                            });
                          })
                        }
                      >
                        Duplicate table
                      </button>
                    )}
                    <button
                      disabled={locked || w.runningProject === p.projectId}
                      className="danger"
                      onClick={() => void deleteItem(p, active)}
                    >
                      Delete {active.kind}…
                    </button>
                  </div>
                )}
              </aside>
              <div className="project-main">
                <div
                  className="project-tabs"
                  role="tablist"
                  aria-label="Project editors"
                >
                  {visibleTabs.map((t) => (
                    <div
                      key={`${t.kind}:${t.id}`}
                      className={active?.id === t.id ? "selected" : ""}
                    >
                      <button
                        role="tab"
                        aria-selected={active?.id === t.id}
                        onClick={() => w.openTab(p.projectId, t)}
                      >
                        {tabName(p, t)}
                      </button>
                      <button
                        aria-label={`Close ${tabName(p, t)} editor`}
                        onClick={() => w.closeTab(p.projectId, t)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                {!active && (
                  <div className="empty-workspace">
                    <h1>{p.name}</h1>
                    <p>
                      {p.tables.length || p.scripts.length
                        ? "Choose a table or script to continue."
                        : "Add your first table to get started."}
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
                <div className="grid-host" hidden={!table}>
                  <CsvWorkspace
                    managed
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
                {p.scripts.map((s) => (
                  <div
                    key={s.id}
                    className="script-host"
                    hidden={active?.kind !== "script" || active.id !== s.id}
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
                ))}
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
