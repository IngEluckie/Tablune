import { useEffect, useRef, useState } from "react";
import { flushCellEdits } from "./CsvGrid";
import * as ipc from "./ipc";
import type { DocumentSummary, ProjectSummary, PythonJob, PythonJobDetail, WorkspaceSummary } from "./types";
import MacroPreviewResults from "./MacroPreviewResults";
import { isPythonJobActive } from "./pythonJobs";
import "./pythonJobs.css";

const labels: Record<PythonJob["state"], string> = {
  queued: "Queued", running: "Running", cancelling: "Cancelling", succeeded: "Completed", failed: "Failed", cancelled: "Cancelled",
};
function elapsed(job: PythonJob) {
  if (!job.startedAt) return "Waiting";
  const seconds = Math.max(0, Math.floor(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export default function PythonJobsPanel({ workspace, disabled, onProject, onDocument }: {
  workspace: WorkspaceSummary; disabled: boolean;
  onProject: (project: ProjectSummary) => void; onDocument: (document: DocumentSummary) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [jobs, setJobs] = useState<PythonJob[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<PythonJobDetail | null>(null);
  const [tab, setTab] = useState<"console" | "preview">("console");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const consoleRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);
  useEffect(() => {
    const show = (event: Event) => {
      const id = (event as CustomEvent<number | undefined>).detail;
      if (id !== undefined) { setSelected(id); setDetail(null); setTab("console"); }
      setExpanded(true); setRefresh(n => n + 1);
    };
    window.addEventListener("tablune-show-python-jobs", show);
    return () => window.removeEventListener("tablune-show-python-jobs", show);
  }, []);
  // Poll snapshots sequentially: no overlapping requests or late publication after changing selection.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await ipc.getPythonJobs();
        if (!alive) return;
        setJobs(next);
        const id = next.some(j => j.id === selected) ? selected : next[0]?.id ?? null;
        if (id !== selected) { setSelected(id); setDetail(null); }
        if (expanded && id !== null) {
          const current = await ipc.getPythonJob(id);
          if (alive) setDetail(current);
        }
      } catch (e) { if (alive) setError(String(e)); }
      finally { if (alive) timer = setTimeout(() => void poll(), expanded ? 350 : 1000); }
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [selected, expanded, refresh]);
  useEffect(() => {
    if (followRef.current && consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [detail?.stdout, detail?.stderr, tab]);
  const job = detail?.summary.id === selected ? detail.summary : null;
  const project = job?.projectId == null ? null : workspace.projects?.find(p => p.projectId === job.projectId);
  const document = job?.projectId == null ? workspace.documents.find(d => d.documentId === job?.documentId)
    : project?.tables.find(t => t.document.documentId === job.documentId)?.document;
  const changed = !!job && (!document || document.revision !== job.inputRevision
    || (document.calculationRevision ?? 0) !== (detail?.preview?.baseCalculationRevision ?? 0));
  const destinationOpen = !!job && (job.projectId === null ? !!document : !!project);
  const canAccept = !!job?.resultAvailable && destinationOpen && !!detail?.preview?.canApply && (job.projectId !== null || !changed);
  const action = async (operation: () => Promise<void>) => {
    setWorking(true); setError("");
    try { await operation(); setRefresh(n => n + 1); }
    catch (e) { setError(String(e)); }
    finally { setWorking(false); }
  };
  const active = jobs.filter(isPythonJobActive).length;
  return <section className={`python-jobs ${expanded ? "expanded" : ""}`} aria-label="Python jobs">
    <div className="python-jobs-bar">
      <button aria-expanded={expanded} aria-controls="python-jobs-content" onClick={() => setExpanded(v => !v)}>
        {expanded ? "▾" : "▸"} Python jobs · {active} active · {jobs.length} total
      </button>
      {expanded && <span>2 scripts at a time · formulas run independently · jobs last for this app session</span>}
    </div>
    {expanded && <div id="python-jobs-content" className="python-jobs-content">
      <nav className="python-jobs-list" aria-label="Job executions">
        {!jobs.length && <p>No jobs yet. Run a script in the background to begin.</p>}
        {jobs.map(item => <button key={item.id} aria-pressed={selected === item.id} onClick={() => { setSelected(item.id); setDetail(null); setError(""); followRef.current = true; }}>
          <strong>#{item.id} · {item.scriptName}</strong>
          <span>{labels[item.state]} · {elapsed(item)}</span>
          <small>{item.inputName} · input v{item.inputRevision}</small>
        </button>)}
      </nav>
      <div className="python-job-detail">
        {error && <p role="alert" className="shell-error">{error}</p>}
        {job && detail ? <>
          <div className="python-job-heading">
            <strong>#{job.id} · {job.scriptName}</strong><span role="status">{labels[job.state]} · {elapsed(job)}</span>
            {isPythonJobActive(job) ? <button disabled={working || job.state === "cancelling"} onClick={() => void action(() => ipc.cancelPythonJob(job.id))}>Cancel job</button>
              : <button disabled={working} onClick={() => void action(async () => { await ipc.discardPythonJob(job.id); setDetail(null); })}>Discard job</button>}
            <button disabled={disabled || working || !canAccept} onClick={() => void action(async () => {
              await flushCellEdits();
              const result = await ipc.acceptPythonJob(job.id);
              if (result.project) onProject(result.project);
              if (result.document) onDocument(result.document);
            })}>{job.projectId === null ? "Apply to CSV" : "Create result table"}</button>
          </div>
          <p className="python-job-meta">{job.inputName} · input v{job.inputRevision}{job.scriptRevision !== null ? ` · script v${job.scriptRevision}` : ""} · {job.timeoutSeconds === null ? "No time limit" : `${job.timeoutSeconds / 60} min limit`}<br />{job.interpreter}</p>
          {job.resultAvailable && changed && <p className="macro-warning">{job.projectId !== null
            ? "This result uses the input captured at start. The current input has changed or was removed; you can still create an independent result table."
            : "The input changed after this job started. This result cannot overwrite newer edits."}</p>}
          {job.resultAvailable && !destinationOpen && <p className="macro-warning">The destination is closed. This job cannot be applied.</p>}
          {job.error && <p role="alert" className="shell-error">{job.error}</p>}
          <div className="python-job-tabs" role="tablist" aria-label="Job output">
            <button role="tab" id="job-console-tab" aria-controls="job-output" aria-selected={tab === "console"} onClick={() => setTab("console")}>Console</button>
            <button role="tab" id="job-preview-tab" aria-controls="job-output" aria-selected={tab === "preview"} onClick={() => setTab("preview")}>Result preview</button>
          </div>
          <div id="job-output" className="python-job-output" role="tabpanel" aria-labelledby={tab === "console" ? "job-console-tab" : "job-preview-tab"}>
            {tab === "console" ? <pre ref={consoleRef} aria-label="Live Python console" onScroll={e => {
              const el = e.currentTarget; followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}>{[detail.stdout, detail.stderr ? `stderr:\n${detail.stderr}` : ""].filter(Boolean).join("\n") || "No output yet."}</pre>
              : detail.preview ? <MacroPreviewResults preview={detail.preview} showUndo={job.projectId === null} /> : <p>The result preview will appear when the job completes.</p>}
          </div>
        </> : <p>{jobs.length ? "Select a job to view its output." : "Each execution keeps its own input, console and result."}</p>}
      </div>
    </div>}
  </section>;
}
