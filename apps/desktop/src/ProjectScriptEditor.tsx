import { lazy, Suspense, useEffect, useState } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import * as ipc from "./ipc";
import type {
  MacroPreview,
  ProjectSummary,
  PythonStatus,
  ScriptSummary,
} from "./types";
import type { ScriptDraft } from "./useWorkspace";
import MacroPreviewResults from "./MacroPreviewResults";
const Editor = lazy(() => import("./PythonMacroEditor"));
export default function ProjectScriptEditor({
  project,
  script,
  draft,
  disabled,
  runningProject,
  onEdit,
  onFlush,
  onRunning,
  onResult,
  onError,
}: {
  project: ProjectSummary;
  script: ScriptSummary;
  draft?: ScriptDraft;
  disabled: boolean;
  runningProject: number | null;
  onEdit: (draft: ScriptDraft) => void;
  onFlush: () => Promise<void>;
  onRunning: (id: number | null) => void;
  onResult: (project: ProjectSummary) => void;
  onError: (error: unknown) => void;
}) {
  const value = draft ?? script;
  const [python, setPython] = useState<PythonStatus | null>(null);
  const [preview, setPreview] = useState<MacroPreview | null>(null);
  const [previewScript, setPreviewScript] = useState<number | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [running, setRunning] = useState(false);
  const [outputTab, setOutputTab] = useState<"preview" | "console">("preview");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const input = project.tables.find(
    (t) => t.id === value.inputTableId,
  )?.document;
  const stale =
    Boolean(draft) ||
    previewScript !== script.revision ||
    !input ||
    preview?.baseRevision !== input.revision;
  useEffect(() => {
    void ipc
      .getPythonStatus()
      .then(setPython)
      .catch((e) => setError(String(e)));
  }, []);
  const run = async () => {
    if (!trusted) {
      if (
        !(await ask(
          "Python scripts run with your normal user permissions and can access files or start programs. Run this code?",
          { title: "Trust Python script", kind: "warning" },
        ))
      )
        return;
      setTrusted(true);
    }
    setPreview(null);
    setError("");
    setRunning(true);
    onRunning(project.projectId);
    try {
      await onFlush();
      const p = await ipc.previewProjectScript(project.projectId, script.id);
      setPreview(p);
      const next = await ipc.getWorkspaceSummary();
      const current = next.projects
        ?.find((p) => p.projectId === project.projectId)
        ?.scripts.find((s) => s.id === script.id);
      setPreviewScript(current?.revision ?? null);
      setOutputTab("preview");
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
      onRunning(null);
    }
  };
  const createResult = async () => {
    if (!preview) return;
    setWorking(true);
    try {
      await onFlush();
      const next = await ipc.createProjectResult(
        project.projectId,
        script.id,
        preview.id,
      );
      setPreview(null);
      onResult(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  };
  return (
    <section className="project-script" aria-label={`Script ${script.name}`}>
      <div className="script-toolbar">
        <label>
          Input table{" "}
          <select
            aria-label="Input table"
            value={value.inputTableId ?? ""}
            disabled={disabled || working}
            onChange={(e) =>
              onEdit({ ...value, inputTableId: e.target.value || null })
            }
          >
            <option value="">Choose a table…</option>
            {project.tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.document.displayName}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={disabled || runningProject !== null}
          onClick={() => {
            void (async () => {
              const path = await open({ multiple: false, directory: false });
              if (typeof path === "string")
                setPython(await ipc.setPythonInterpreter(path));
            })().catch(onError);
          }}
        >
          Python interpreter…
        </button>
        <span>
          {python?.available
            ? python.version
            : (python?.error ?? "Checking Python…")}
        </span>
        {running ? (
          <button onClick={() => void ipc.cancelPythonMacro().catch(onError)}>
            Cancel run
          </button>
        ) : (
          <button
            className="primary"
            disabled={
              disabled ||
              working ||
              runningProject !== null ||
              !input ||
              !python?.available ||
              !value.code.trim()
            }
            onClick={() => void run()}
          >
            Run Preview
          </button>
        )}
        <button
          className="primary"
          disabled={disabled || working || running || !preview || stale}
          onClick={() => void createResult()}
        >
          Create result table
        </button>
      </div>
      {error && (
        <p role="alert" className="shell-error">
          {error}
        </p>
      )}
      <div className="project-code">
        <Suspense fallback={<p>Loading editor…</p>}>
          <Editor
            value={value.code}
            disabled={disabled || working}
            onChange={(code) => onEdit({ ...value, code })}
          />
        </Suspense>
      </div>
      <section className="project-output">
        <div className="macro-result-tabs">
          <button
            aria-pressed={outputTab === "preview"}
            onClick={() => setOutputTab("preview")}
          >
            Preview
          </button>
          <button
            aria-pressed={outputTab === "console"}
            onClick={() => setOutputTab("console")}
          >
            Console
          </button>
        </div>
        {outputTab === "preview" ? (
          <div className="macro-preview-panel">
            {running && (
              <p>Running Python script… You can switch spaces while it runs.</p>
            )}
            {preview ? (
              <MacroPreviewResults
                preview={preview}
                stale={stale}
                showUndo={false}
              />
            ) : (
              <p>
                Run a preview, then create an independent editable table. Your
                input table is preserved.
              </p>
            )}
          </div>
        ) : (
          <pre className="macro-console-panel">
            {[preview?.stdout, preview?.stderr, error]
              .filter(Boolean)
              .join("\n") || "No output."}
          </pre>
        )}
      </section>
    </section>
  );
}
