import { lazy, Suspense, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import * as ipc from "./ipc";
import type { ProjectSummary, PythonStatus } from "./types";
const Editor = lazy(() => import("./PythonMacroEditor"));
export default function ProjectFunctionsEditor({
  project,
  code,
  disabled,
  onEdit,
  onFlush,
  onUpdate,
  onEnable,
  onError,
}: {
  project: ProjectSummary;
  code: string;
  disabled: boolean;
  onEdit: (code: string) => void;
  onFlush: () => Promise<void>;
  onUpdate: (project: ProjectSummary) => void;
  onEnable: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [python, setPython] = useState<PythonStatus | null>(null);
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    void ipc.getPythonStatus().then(setPython).catch(onError);
  }, [onError]);
  const apply = async () => {
    setApplying(true);
    try {
      await onFlush();
      const current = (await ipc.getWorkspaceSummary()).projects?.find(
        (p) => p.projectId === project.projectId,
      );
      if (current)
        onUpdate(
          await ipc.applyFunctions(
            project.projectId,
            current.functions?.draftRevision ?? 0,
          ),
        );
    } catch (e) {
      onError(e);
    } finally {
      setApplying(false);
    }
  };
  const interpreter = async () => {
    try {
      const path = await open({
        multiple: false,
        title: "Choose a Python 3.10+ interpreter",
      });
      if (typeof path === "string")
        setPython(await ipc.setPythonInterpreter(path));
    } catch (e) {
      onError(e);
    }
  };
  return (
    <section
      className="project-script functions-editor"
      aria-label="Project functions"
    >
      <div className="script-toolbar">
        <strong>Functions</strong>
        <button
          disabled={disabled || applying}
          onClick={() => void interpreter()}
        >
          Python interpreter…
        </button>
        <span>
          {python?.available
            ? `Python ${python.version}`
            : (python?.error ?? "Checking Python…")}
        </span>
        {!project.calculation?.enabled ? (
          <button
            className="primary"
            disabled={disabled}
            onClick={() => void onEnable().catch(onError)}
          >
            Enable Python calculation
          </button>
        ) : (
          <button
            className="primary"
            disabled={
              disabled ||
              applying ||
              project.calculation.running ||
              !python?.available
            }
            onClick={() => void apply()}
          >
            {applying ? "Applying…" : "Apply functions"}
          </button>
        )}
      </div>
      <p className="functions-description">
        Define functions here and call them from a cell, for example{" "}
        <code>=precio_final(B2, C2)</code>. Drafts are saved with the project.
        Apply functions activates your changes.
      </p>
      <div className="project-code">
        <Suspense fallback={<p>Loading editor…</p>}>
          <Editor
            label="Functions code"
            value={code}
            disabled={disabled}
            onChange={onEdit}
          />
        </Suspense>
      </div>
      <div className="functions-status" role="status">
        {code === (project.functions?.applied ?? "")
          ? `Applied version ${project.functions?.revision ?? 0}`
          : "Unapplied draft · cells still use the applied version"}
      </div>
      {project.calculation?.error && (
        <p role="alert" className="shell-error">
          {project.calculation.error}
        </p>
      )}
      {!code && (
        <div className="functions-example">
          <p>Start with a function that returns one value:</p>
          <pre>
            {
              "def precio_final(base, impuesto):\n    return round(base * (1 + impuesto), 2)"
            }
          </pre>
          <button
            disabled={disabled}
            onClick={() =>
              onEdit(
                "def precio_final(base, impuesto):\n    return round(base * (1 + impuesto), 2)\n",
              )
            }
          >
            Insert example
          </button>
        </div>
      )}
    </section>
  );
}
