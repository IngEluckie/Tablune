import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import {
  applyPythonPreview,
  cancelPythonMacro,
  getPythonStatus,
  previewPythonMacro,
  readMacroScript,
  setPythonInterpreter,
  writeMacroScript,
} from "./ipc";
import type { DocumentSummary, MacroPreview, PythonStatus } from "./types";

const STARTER_MACRO = `def transform(rows, context):
    """Transform the document and return rows containing strings."""
    return rows
`;

interface PythonMacroDialogProps {
  summary: DocumentSummary;
  trustAcknowledged: boolean;
  onTrustAcknowledged: () => void;
  onApplied: (summary: DocumentSummary) => void;
  onClose: () => void;
}

function fileName(path: string | null): string {
  if (!path) return "Untitled macro.py";
  return path.split(/[\\/]/).pop() || path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export default function PythonMacroDialog({
  summary,
  trustAcknowledged,
  onTrustAcknowledged,
  onApplied,
  onClose,
}: PythonMacroDialogProps) {
  const [python, setPython] = useState<PythonStatus | null>(null);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [code, setCode] = useState(STARTER_MACRO);
  const [savedCode, setSavedCode] = useState(STARTER_MACRO);
  const [preview, setPreview] = useState<MacroPreview | null>(null);
  const [running, setRunning] = useState(false);
  const [working, setWorking] = useState(false);
  const [consoleError, setConsoleError] = useState("");
  const dirty = code !== savedCode;
  const previewStale = preview !== null && preview.baseRevision !== summary.revision;
  const canApply = preview !== null && preview.canApply && !previewStale && !running && !working;
  const consoleText = useMemo(() => {
    const parts = [];
    if (preview?.stdout) parts.push(`stdout\n${preview.stdout}`);
    if (preview?.stderr) parts.push(`stderr\n${preview.stderr}`);
    if (consoleError) parts.push(`error\n${consoleError}`);
    return parts.join("\n\n") || "No output.";
  }, [consoleError, preview]);

  const refreshPython = async () => {
    setWorking(true);
    try {
      setPython(await getPythonStatus());
      setConsoleError("");
    } catch (reason) {
      setConsoleError(String(reason));
    } finally {
      setWorking(false);
    }
  };

  useEffect(() => {
    void refreshPython();
  }, []);

  const saveCurrent = async (saveAs = false): Promise<boolean> => {
    let destination = saveAs ? null : sourcePath;
    if (!destination) {
      destination = await save({
        defaultPath: fileName(sourcePath),
        filters: [{ name: "Python macro", extensions: ["py"] }],
      });
    }
    if (!destination) return false;
    setWorking(true);
    try {
      await writeMacroScript(destination, code);
      setSourcePath(destination);
      setSavedCode(code);
      setConsoleError("");
      return true;
    } catch (reason) {
      setConsoleError(String(reason));
      return false;
    } finally {
      setWorking(false);
    }
  };

  const protectMacroChanges = async (): Promise<boolean> => {
    if (!dirty) return true;
    const shouldSave = await ask("Save changes to this Python macro?", {
      title: "Unsaved macro",
      kind: "warning",
    });
    if (shouldSave) return saveCurrent(false);
    return ask("Discard the unsaved macro changes?", {
      title: "Discard macro changes",
      kind: "warning",
    });
  };

  const newMacro = async () => {
    if (!await protectMacroChanges()) return;
    setSourcePath(null);
    setCode(STARTER_MACRO);
    setSavedCode(STARTER_MACRO);
    setPreview(null);
    setConsoleError("");
  };

  const openMacro = async () => {
    if (!await protectMacroChanges()) return;
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Python macro", extensions: ["py"] }],
    });
    if (typeof selected !== "string") return;
    setWorking(true);
    try {
      const contents = await readMacroScript(selected);
      setSourcePath(selected);
      setCode(contents);
      setSavedCode(contents);
      setPreview(null);
      setConsoleError("");
    } catch (reason) {
      setConsoleError(String(reason));
    } finally {
      setWorking(false);
    }
  };

  const chooseInterpreter = async () => {
    const selected = await open({ multiple: false, directory: false });
    if (typeof selected !== "string") return;
    setWorking(true);
    try {
      setPython(await setPythonInterpreter(selected));
      setConsoleError("");
    } catch (reason) {
      setConsoleError(String(reason));
    } finally {
      setWorking(false);
    }
  };

  const runPreview = async () => {
    if (!trustAcknowledged) {
      const accepted = await ask(
        "Python macros run with your normal user permissions and can access files or start programs. Run this code?",
        { title: "Trust Python macros", kind: "warning" },
      );
      if (!accepted) return;
      onTrustAcknowledged();
    }
    setPreview(null);
    setConsoleError("");
    setRunning(true);
    try {
      setPreview(await previewPythonMacro(summary.documentId, code, sourcePath, summary.revision));
    } catch (reason) {
      setConsoleError(String(reason));
    } finally {
      setRunning(false);
    }
  };

  const cancelRun = async () => {
    try {
      await cancelPythonMacro();
    } catch (reason) {
      setConsoleError(String(reason));
    }
  };

  const applyPreview = async () => {
    if (!preview) return;
    setWorking(true);
    try {
      const nextSummary = await applyPythonPreview(summary.documentId, preview.id, summary.revision);
      setPreview(null);
      setConsoleError("");
      onApplied(nextSummary);
    } catch (reason) {
      setConsoleError(String(reason));
    } finally {
      setWorking(false);
    }
  };

  const closeDialog = async () => {
    if (running || !await protectMacroChanges()) return;
    onClose();
  };

  return (
    <div className="macro-backdrop">
      <section className="macro-dialog" role="dialog" aria-modal="true" aria-labelledby="macro-title">
        <header className="macro-dialog-header">
          <div>
            <h1 id="macro-title">Python Macro</h1>
            <span>{dirty ? "● " : ""}{fileName(sourcePath)}</span>
          </div>
          <button onClick={() => void closeDialog()} disabled={running}>Close</button>
        </header>

        <section className="macro-python-status" aria-label="Python interpreter">
          <span className={python?.available ? "available" : "unavailable"}>
            {python?.available
              ? `Python ${python.version} — ${python.path}`
              : python?.error ?? "Detecting Python…"}
          </span>
          <button onClick={() => void refreshPython()} disabled={working || running}>Test</button>
          <button onClick={() => void chooseInterpreter()} disabled={working || running}>Choose…</button>
        </section>

        <div className="macro-toolbar">
          <button onClick={() => void newMacro()} disabled={working || running}>New</button>
          <button onClick={() => void openMacro()} disabled={working || running}>Open</button>
          <button onClick={() => void saveCurrent(false)} disabled={working || running || !dirty}>Save</button>
          <button onClick={() => void saveCurrent(true)} disabled={working || running}>Save As</button>
          <span className="macro-toolbar-spacer" />
          {running ? (
            <button className="danger" onClick={() => void cancelRun()}>Cancel</button>
          ) : (
            <button
              className="primary"
              onClick={() => void runPreview()}
              disabled={working || !python?.available || code.trim().length === 0}
            >
              Run Preview
            </button>
          )}
          <button className="primary" onClick={() => void applyPreview()} disabled={!canApply}>Apply</button>
        </div>

        <div className="macro-workspace">
          <label className="macro-editor-panel">
            <span>Macro code</span>
            <textarea
              aria-label="Macro code"
              value={code}
              spellCheck={false}
              disabled={running || working}
              onChange={(event) => {
                setCode(event.target.value);
                setPreview(null);
              }}
            />
          </label>

          <section className="macro-results" aria-label="Macro results">
            <div className="macro-preview-panel">
              <h2>Preview</h2>
              {running && <p>Running Python macro…</p>}
              {!running && !preview && <p>Run the macro to preview changes. The document will not be modified.</p>}
              {preview && (
                <>
                  <div className="macro-metrics">
                    <span>Rows <strong>{preview.rowsBefore.toLocaleString()} → {preview.rowsAfter.toLocaleString()}</strong></span>
                    <span>Columns <strong>{preview.columnsBefore} → {preview.columnsAfter}</strong></span>
                    <span>Changed cells <strong>{preview.changedCells.toLocaleString()}</strong></span>
                    <span>Undo <strong>{formatBytes(preview.estimatedUndoBytes)}</strong></span>
                    {preview.headerChanged && <span>Header changed</span>}
                  </div>
                  {(preview.blockedReason || previewStale) && (
                    <p className="macro-warning">{previewStale ? "The document changed; run Preview again." : preview.blockedReason}</p>
                  )}
                  {preview.samples.length > 0 && (
                    <div className="macro-samples-scroll">
                      <table className="macro-samples">
                        <thead><tr><th>Cell</th><th>Before</th><th>After</th></tr></thead>
                        <tbody>
                          {preview.samples.map((sample) => (
                            <tr key={`${sample.row}:${sample.column}`}>
                              <th>R{sample.row + 1} C{sample.column + 1}</th>
                              <td>{sample.before ?? "∅"}</td>
                              <td>{sample.after ?? "∅"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="macro-console-panel">
              <h2>Console</h2>
              <pre>{consoleText}</pre>
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
