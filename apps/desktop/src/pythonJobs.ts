import type { PythonJob } from "./types";
export const isPythonJobActive = (job: PythonJob) =>
  job.state === "queued" || job.state === "running" || job.state === "cancelling";
export function showPythonJobs(jobId?: number) {
  window.dispatchEvent(new CustomEvent("tablune-show-python-jobs", { detail: jobId }));
}
