import { lazy, Suspense, useEffect, useState } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import * as ipc from "./ipc";
import type { ProjectSummary, PythonStatus, ScriptSummary } from "./types";
import type { ScriptDraft } from "./useWorkspace";
import { projectItemPath } from "./projectTree";
import { showPythonJobs } from "./pythonJobs";
import PythonJobOptions from "./PythonJobOptions";
const Editor = lazy(() => import("./PythonMacroEditor"));

export default function ProjectScriptEditor({ project, script, draft, disabled, onEdit, onFlush, onError }: {
  project: ProjectSummary; script: ScriptSummary; draft?: ScriptDraft; disabled: boolean;
  onEdit: (draft: ScriptDraft) => void; onFlush: () => Promise<void>; onError: (error: unknown) => void;
}) {
  const value = draft ?? script;
  const [python, setPython] = useState<PythonStatus | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [timeout, setTimeoutLimit] = useState<number | null>(600);
  const [error, setError] = useState("");
  const input = project.tables.find(t => t.id === value.inputTableId)?.document;
  useEffect(() => {
    void ipc.getPythonStatus().then(setPython).catch(e => setError(String(e)));
  }, []);
  const run = async () => {
    setStarting(true); setError("");
    try {
      if (!trusted) {
        if (!(await ask("Python scripts run with your normal user permissions and can access files or start programs. Run this code?", { title: "Trust Python script", kind: "warning" }))) return;
        setTrusted(true);
      }
      await onFlush();
      const job = await ipc.startProjectPythonJob(project.projectId, script.id, timeout);
      showPythonJobs(job.id);
    } catch (e) { setError(String(e)); }
    finally { setStarting(false); }
  };
  return <section className="project-script" aria-label={`Script ${script.name}`}>
    <div className="script-toolbar">
      <label>Input table{" "}<select aria-label="Input table" value={value.inputTableId ?? ""} disabled={disabled}
        onChange={e => onEdit({ ...value, inputTableId: e.target.value || null })}>
        <option value="">Choose a table…</option>
        {project.tables.map(t => <option key={t.id} value={t.id}>{projectItemPath(project, t.id)}</option>)}
      </select></label>
      <button disabled={disabled || starting} onClick={() => {
        void (async () => {
          const path = await open({ multiple: false, directory: false });
          if (typeof path === "string") setPython(await ipc.setPythonInterpreter(path));
        })().catch(onError);
      }}>Python interpreter…</button>
      <span>{python?.available ? python.version : (python?.error ?? "Checking Python…")}</span>
      <PythonJobOptions value={timeout} onChange={setTimeoutLimit} disabled={disabled || starting} />
      <button className="primary" disabled={disabled || starting || !input || !python?.available || !value.code.trim()}
        onClick={() => void run()}>{starting ? "Starting…" : "Run in background"}</button>
      <button onClick={() => showPythonJobs()}>View jobs</button>
    </div>
    {error && <p role="alert" className="shell-error">{error}</p>}
    <div className="project-code"><Suspense fallback={<p>Loading editor…</p>}>
      <Editor historyId={`script:${project.projectId}:${script.id}`} historyScope={`project:${project.projectId}`}
        value={value.code} disabled={disabled} onChange={code => onEdit({ ...value, code })} />
    </Suspense></div>
    <p className="functions-description">Each run captures the current code and input table. Keep editing or run another script while it works. Review its console and create a result table in Python jobs.</p>
  </section>;
}
