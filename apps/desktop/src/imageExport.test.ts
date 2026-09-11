import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { exportProjectTable, exportSessionView } from "./ipc";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it("requires explicit confirmation for image names in each CSV export path", async () => {
  vi.mocked(invoke).mockResolvedValue({ imageCount: 1 });
  vi.mocked(ask).mockResolvedValue(false);
  await exportProjectTable(1, "/tmp/a.csv");
  expect(invoke).not.toHaveBeenCalledWith("project_export_table", expect.anything());
  vi.mocked(ask).mockResolvedValue(true);
  await exportProjectTable(1, "/tmp/a.csv");
  await exportSessionView(1, "/tmp/b.csv");
  expect(invoke).toHaveBeenCalledWith("project_export_table", { documentId: 1, path: "/tmp/a.csv", allowImages: true });
  expect(invoke).toHaveBeenCalledWith("session_export_view", { documentId: 1, path: "/tmp/b.csv", allowImages: true });
});
