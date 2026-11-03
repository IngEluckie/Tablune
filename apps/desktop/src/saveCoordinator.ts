/** Editors share a destination (for example, every item in a .tablune project).
 * New document types register a target rather than owning autosave timers. */
export interface SaveTarget {
  id: string;
  preferenceKey: string;
  path: string | null;
  dirty: boolean;
  revision: string;
  save: () => Promise<unknown>;
}

export interface SaveStatus {
  enabled: boolean;
  state: "saved" | "pending" | "saving" | "location" | "error";
  error?: string;
}

interface Slot {
  target: SaveTarget;
  enabled: boolean;
  firstChange: number;
  lastChange: number;
  savedRevision?: string;
  error?: string;
  failures: number;
  retryAt: number;
  pending: number;
  chain: Promise<unknown>;
}

const PREFERENCE_KEY = "tablune.autosave.v1";
export class SaveCoordinator {
  private slots = new Map<string, Slot>();
  private preferences: Record<string, boolean> = {};
  private choices = new Map<string, boolean>();
  private paused = new Map<string, number>();
  private suspended = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  private version = 0;
  private running = true;

  constructor(private storage?: Pick<Storage, "getItem" | "setItem">) {
    try {
      const stored = JSON.parse(storage?.getItem(PREFERENCE_KEY) ?? "{}");
      if (stored && typeof stored === "object") {
        for (const [key, value] of Object.entries(stored))
          if (typeof value === "boolean") this.preferences[key] = value;
      }
    } catch { /* Keep the default when preferences are unavailable. */ }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = () => this.version;
  private emit() { this.version++; for (const listener of this.listeners) listener(); }

  reconcile(targets: SaveTarget[], enabled = true) {
    this.running = enabled;
    const ids = new Set(targets.map(t => t.id));
    for (const [id, slot] of this.slots) if (!ids.has(id) && !slot.pending) this.slots.delete(id);
    let changed = false;
    for (const target of targets) {
      const slot = this.slots.get(target.id);
      const moved = slot && slot.target.preferenceKey !== target.preferenceKey;
      const preference = this.choices.get(target.id) ?? (moved ? slot.enabled : this.preferences[target.preferenceKey]) ?? true;
      if (!slot) {
        this.slots.set(target.id, { target, enabled: preference, firstChange: Date.now(), lastChange: Date.now(), failures: 0, retryAt: 0, pending: 0, chain: Promise.resolve() });
        changed = true;
      } else {
        if (slot.target.revision !== target.revision || slot.target.dirty !== target.dirty) {
          if (!slot.target.dirty || slot.savedRevision === slot.target.revision) slot.firstChange = Date.now();
          slot.lastChange = Date.now();
          changed = true;
        }
        if (slot.target.path !== target.path || slot.enabled !== preference) changed = true;
        if (moved && target.path)
          this.persist(target.preferenceKey, preference);
        slot.target = target;
        slot.enabled = preference;
        if (!target.dirty && slot.error) { slot.error = undefined; slot.failures = 0; changed = true; }
      }
    }
    if (changed) this.emit();
    this.schedule();
  }
  status(id: string): SaveStatus | undefined {
    const slot = this.slots.get(id);
    if (!slot) return;
    return {
      enabled: slot.enabled,
      state: slot.pending ? "saving" : slot.error ? "error" : !slot.target.path ? "location" : slot.target.dirty ? "pending" : "saved",
      error: slot.error,
    };
  }
  private persist(key: string, enabled: boolean) {
    this.preferences[key] = enabled;
    try { this.storage?.setItem(PREFERENCE_KEY, JSON.stringify(this.preferences)); } catch { /* Session preference still applies. */ }
  }
  setEnabled(id: string, enabled: boolean) {
    const slot = this.slots.get(id);
    if (!slot) return;
    this.choices.set(id, enabled);
    slot.enabled = enabled;
    slot.firstChange = slot.lastChange = Date.now();
    if (slot.target.path) this.persist(slot.target.preferenceKey, enabled);
    this.emit(); this.schedule();
  }
  /** Manual Save, Save As and autosave all use the same destination queue. */
  run<T>(id: string, action: () => Promise<T>): Promise<T> {
    let slot = this.slots.get(id);
    if (!slot) {
      slot = { target: { id, preferenceKey: id, path: null, dirty: false, revision: "", save: async () => {} }, enabled: true, firstChange: Date.now(), lastChange: Date.now(), failures: 0, retryAt: 0, pending: 0, chain: Promise.resolve() };
      this.slots.set(id, slot);
    }
    slot.pending++;
    this.emit();
    const result = slot.chain.catch(() => {}).then(action);
    const settled = result.then(value => {
      slot.error = undefined; slot.failures = 0; slot.retryAt = 0;
      return value;
    }, error => {
      slot.error = String(error);
      slot.retryAt = Date.now() + Math.min(30_000, 5_000 * 2 ** slot.failures++);
      throw error;
    }).finally(() => { slot.pending--; this.emit(); this.schedule(); });
    slot.chain = settled;
    // Keep failures observable to the caller without an unhandled background rejection.
    void settled.catch(() => {});
    return settled;
  }
  async wait(id?: string) {
    const slots = id ? [this.slots.get(id)].filter((s): s is Slot => !!s) : [...this.slots.values()];
    await Promise.all(slots.map(s => s.chain.catch(() => {})));
  }
  /** Closing bypasses the debounce, but never enables a disabled or untitled target. */
  async flush(id?: string) {
    const slots = [...this.slots.values()].filter(s => (!id || s.target.id === id) && s.enabled && s.target.path);
    const results = await Promise.allSettled(slots.map(s => this.run(s.target.id, () => s.target.save())));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  pause(id?: string) {
    if (id) this.paused.set(id, (this.paused.get(id) ?? 0) + 1);
    else this.suspended++;
    this.schedule();
  }
  resume(id?: string) {
    if (id) {
      const count = (this.paused.get(id) ?? 0) - 1;
      if (count > 0) this.paused.set(id, count); else this.paused.delete(id);
    } else this.suspended = Math.max(0, this.suspended - 1);
    this.schedule();
  }
  retry(id: string) {
    const slot = this.slots.get(id);
    if (!slot || slot.pending) return;
    if (!slot.target.path) return;
    void this.run(id, () => slot.target.save()).catch(() => {});
  }
  private schedule() {
    clearTimeout(this.timer);
    if (!this.running || this.suspended) return;
    let next = Infinity;
    for (const slot of this.slots.values()) {
      if (!slot.enabled || !slot.target.dirty || !slot.target.path || slot.pending || this.paused.has(slot.target.id) || slot.savedRevision === slot.target.revision) continue;
      const due = Math.max(slot.retryAt, Math.min(slot.lastChange + 2_000, slot.firstChange + 10_000));
      next = Math.min(next, due);
    }
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => {
      for (const slot of this.slots.values()) {
        if (!slot.enabled || !slot.target.dirty || !slot.target.path || slot.pending || this.paused.has(slot.target.id) || slot.savedRevision === slot.target.revision) continue;
        if (Math.max(slot.retryAt, Math.min(slot.lastChange + 2_000, slot.firstChange + 10_000)) > Date.now()) continue;
        const revision = slot.target.revision;
        void this.run(slot.target.id, () => slot.target.save()).then(() => {
          slot.savedRevision = revision;
          slot.firstChange = slot.lastChange = Date.now();
          this.schedule();
        }).catch(() => {});
      }
      this.schedule();
    }, Math.max(0, next - Date.now()));
  }
  dispose() { this.running = false; clearTimeout(this.timer); }
}
