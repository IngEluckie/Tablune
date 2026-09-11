import { useEffect, useMemo, useState } from "react";
import { readCellImage } from "./ipc";
import type { GridWindow } from "./types";

export class ImageCache<T> {
  private entries = new Map<string, { value: T; bytes: number }>();
  bytes = 0;
  constructor(readonly limit: number, private dispose: (value: T) => void) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T, bytes: number) {
    const old = this.entries.get(key);
    if (old) { this.bytes -= old.bytes; this.dispose(old.value); this.entries.delete(key); }
    if (bytes > this.limit) { this.dispose(value); return; }
    this.entries.set(key, { value, bytes }); this.bytes += bytes;
    while (this.bytes > this.limit) {
      const key = this.entries.keys().next().value!;
      const entry = this.entries.get(key)!;
      this.entries.delete(key); this.bytes -= entry.bytes; this.dispose(entry.value);
    }
  }
  clear() { for (const entry of this.entries.values()) this.dispose(entry.value); this.entries.clear(); this.bytes = 0; }
}
export async function imageElement(bytes: ArrayBuffer | number[]): Promise<HTMLImageElement> {
  const blob = new Blob([bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes)]);
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("Image could not be displayed")); image.src = url; });
    return image;
  } finally { URL.revokeObjectURL(url); }
}
export function useImageThumbnails(documentId: number, windowData: GridWindow | null) {
  const cache = useMemo(() => new ImageCache<HTMLImageElement>(64 * 1024 * 1024, image => { image.src = ""; }), [documentId]);
  const [loaded, setLoaded] = useState<Map<string, HTMLImageElement>>(new Map());
  useEffect(() => () => cache.clear(), [cache]);
  useEffect(() => {
    let stale = false;
    const ids = [...new Set(windowData?.documentId === documentId ? windowData.rows.flatMap(row => row.inputs?.flatMap(cell => cell.image ? [cell.image.assetId] : []) ?? []) : [])];
    const current = new Map<string, HTMLImageElement>();
    const queue: string[] = [];
    for (const id of ids) { const image = cache.get(id); if (image) current.set(id, image); else queue.push(id); }
    setLoaded(new Map(current));
    const worker = async () => {
      while (!stale && queue.length) {
        const id = queue.shift()!;
        try {
          const bytes = await readCellImage(documentId, id, true);
          if (stale) return;
          const image = await imageElement(bytes);
          if (stale) { image.src = ""; return; }
          cache.set(id, image, image.width * image.height * 4);
          current.set(id, image);
          setLoaded(new Map(current));
        } catch { /* Name placeholder remains available; opening preview reports the error. */ }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    return () => { stale = true; };
  }, [cache, documentId, windowData]);
  return loaded;
}
