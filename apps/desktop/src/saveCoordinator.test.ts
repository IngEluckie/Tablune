import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SaveCoordinator, type SaveTarget } from "./saveCoordinator";

let saves: SaveCoordinator;
const target = (id = "project:1", overrides: Partial<SaveTarget> = {}): SaveTarget => ({
  id, preferenceKey: id, path: "/tmp/project.tablune", dirty: true, revision: "1", save: vi.fn().mockResolvedValue(undefined), ...overrides,
});
beforeEach(() => { vi.useFakeTimers(); saves = new SaveCoordinator(); });
afterEach(() => { saves.dispose(); vi.useRealTimers(); });

it("defaults to autosave, coalesces edits per destination and saves background targets", async () => {
  const first = target(); const second = target("markdown:other");
  saves.reconcile([first, second]);
  await vi.advanceTimersByTimeAsync(1500);
  saves.reconcile([{ ...first, revision: "2" }, second]);
  await vi.advanceTimersByTimeAsync(500);
  expect(second.save).toHaveBeenCalledTimes(1); expect(first.save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1500);
  expect(first.save).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(first.save).toHaveBeenCalledTimes(1);
});

it("bounds continuous edits to ten seconds", async () => {
  const doc = target(); saves.reconcile([doc]);
  for (let revision = 2; revision <= 10; revision++) {
    await vi.advanceTimersByTimeAsync(1000);
    saves.reconcile([{ ...doc, revision: String(revision) }]);
  }
  expect(doc.save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(doc.save).toHaveBeenCalledTimes(1);
});

it("serializes autosave and manual Save As and retains edits made while writing", async () => {
  let finish!: () => void;
  const write = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
  const doc = target("csv:1", { save: write }); saves.reconcile([doc]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(saves.status(doc.id)?.state).toBe("saving");
  saves.reconcile([{ ...doc, revision: "2" }]);
  const manual = vi.fn().mockResolvedValue(true);
  const savingAs = saves.run(doc.id, manual);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(manual).not.toHaveBeenCalled(); expect(write).toHaveBeenCalledTimes(1);
  finish(); await savingAs;
  await vi.advanceTimersByTimeAsync(2000);
  expect(manual).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(2);
});

it("never requests a destination for untitled documents and remembers the switch", async () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  saves = new SaveCoordinator(storage);
  const doc = target("markdown:1", { path: null }); saves.reconcile([doc]);
  expect(saves.status(doc.id)?.state).toBe("location");
  await vi.advanceTimersByTimeAsync(20_000); expect(doc.save).not.toHaveBeenCalled();
  saves.setEnabled(doc.id, false);
  saves.reconcile([{ ...doc, path: "/tmp/notes.md", preferenceKey: "markdown:/tmp/notes.md" }]);
  await vi.advanceTimersByTimeAsync(20_000); expect(doc.save).not.toHaveBeenCalled();
  const reopened = new SaveCoordinator(storage);
  reopened.reconcile([target("markdown:new", { preferenceKey: "markdown:/tmp/notes.md" })]);
  expect(reopened.status("markdown:new")?.enabled).toBe(false);
  reopened.dispose();
});

it("retains an error and retries with backoff without preventing other saves", async () => {
  const first = target("csv:1", { save: vi.fn().mockRejectedValueOnce(new Error("Disk full")).mockResolvedValue(undefined) });
  const second = target("csv:2"); saves.reconcile([first, second]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(saves.status(first.id)).toMatchObject({ state: "error", error: "Error: Disk full" });
  expect(second.save).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4999); expect(first.save).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(first.save).toHaveBeenCalledTimes(2);
  expect(saves.status(first.id)?.error).toBeUndefined();
});

it("suspends queued timers for close/discard and removes closed destinations", async () => {
  const doc = target(); saves.reconcile([doc]); saves.pause(doc.id);
  await vi.advanceTimersByTimeAsync(20_000); expect(doc.save).not.toHaveBeenCalled();
  saves.reconcile([]); saves.resume(doc.id);
  await vi.advanceTimersByTimeAsync(20_000); expect(doc.save).not.toHaveBeenCalled();
});
