// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageCache, useImageThumbnails } from "./imageThumbnails";
import { readCellImage } from "./ipc";
import type { GridWindow } from "./types";
vi.mock("./ipc", () => ({ readCellImage: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("bounds decoded memory and disposes least recently used images and close resources", () => {
  const dispose = vi.fn();
  const cache = new ImageCache<number>(64 * 1024 * 1024, dispose);
  for (let i = 0; i < 1000; i++) cache.set(String(i), i, 256 * 256 * 4);
  expect(cache.bytes).toBe(64 * 1024 * 1024);
  expect(cache.get("0")).toBeUndefined();
  expect(cache.get("999")).toBe(999);
  expect(dispose).toHaveBeenCalledTimes(744);
  cache.clear();
  expect(dispose).toHaveBeenCalledTimes(1000);
  expect(cache.bytes).toBe(0);
});
it("requests only window images, deduplicates and stops obsolete window requests", async () => {
  const resolves: Array<(v: ArrayBuffer) => void> = [];
  vi.mocked(readCellImage).mockImplementation(() => new Promise(resolve => resolves.push(resolve)));
  const window = (start: number): GridWindow => ({ documentId: 1, revision: 1, viewRevision: 1, rowStart: start, columnStart: 0, rows: Array.from({ length: 12 }, (_, i) => ({ viewIndex: start + i, sourceRow: start + i, rowId: start + i, cells: ["photo.png"], inputs: [{ row: start + i, column: 0, source: "photo.png", display: "photo.png", formula: false, pending: false, error: null, cellType: "text", image: { assetId: String(start + i), name: "photo.png", alt: "" } }] })) });
  const { rerender } = renderHook(({ data }) => useImageThumbnails(1, data), { initialProps: { data: window(0) } });
  await waitFor(() => expect(readCellImage).toHaveBeenCalledTimes(4));
  rerender({ data: window(988) });
  await waitFor(() => expect(readCellImage).toHaveBeenCalledTimes(8));
  await act(async () => { for (const resolve of resolves.slice(0, 4)) resolve(new ArrayBuffer(0)); });
  expect(readCellImage).toHaveBeenCalledTimes(8);
  expect(vi.mocked(readCellImage).mock.calls.every(([, id]) => Number(id) < 4 || Number(id) >= 988)).toBe(true);
});
