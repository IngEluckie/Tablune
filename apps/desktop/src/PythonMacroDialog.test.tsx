// @vitest-environment jsdom

import { ask } from "@tauri-apps/plugin-dialog";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPythonPreview,
  cancelPythonMacro,
  getPythonStatus,
  previewPythonMacro,
} from "./ipc";
import PythonMacroDialog from "./PythonMacroDialog";
import type { DocumentSummary, MacroPreview } from "./types";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("./ipc", () => ({
  applyPythonPreview: vi.fn(),
  cancelPythonMacro: vi.fn(),
  getPythonStatus: vi.fn(),
  previewPythonMacro: vi.fn(),
  readMacroScript: vi.fn(),
  setPythonInterpreter: vi.fn(),
  writeMacroScript: vi.fn(),
}));

const summary: DocumentSummary = {
  documentId: 7,
  path: "/tmp/test.csv",
  displayName: "test.csv",
  delimiter: ",",
  lineEnding: "lf",
  revision: 2,
  viewRevision: 0,
  dirty: false,
  rowCount: 2,
  columnCount: 2,
  visibleRowCount: 2,
  headerEnabled: false,
  headerSuggested: false,
  headerNames: ["A", "B"],
  headerValues: [],
  canUndo: false,
  canRedo: false,
  filtersActive: false,
  sortCount: 0,
};

const preview: MacroPreview = {
  id: "preview-1",
  baseRevision: 2,
  rowsBefore: 2,
  rowsAfter: 2,
  columnsBefore: 2,
  columnsAfter: 2,
  changedCells: 1,
  headerChanged: false,
  estimatedUndoBytes: 64,
  canApply: true,
  blockedReason: null,
  stdout: "macro output",
  stderr: "",
  samples: [{ row: 1, column: 0, before: "old", after: "new" }],
};

const props = {
  summary,
  trustAcknowledged: false,
  onTrustAcknowledged: vi.fn(),
  onApplied: vi.fn(),
  onClose: vi.fn(),
};

describe("PythonMacroDialog", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(getPythonStatus).mockResolvedValue({
      path: "/usr/local/bin/python3",
      version: "3.12.1",
      available: true,
      error: null,
    });
    vi.mocked(ask).mockResolvedValue(true);
    vi.mocked(previewPythonMacro).mockResolvedValue(preview);
    vi.mocked(applyPythonPreview).mockResolvedValue({ ...summary, revision: 3, dirty: true, canUndo: true });
  });

  afterEach(cleanup);

  it("warns once, previews changes, and applies by preview id", async () => {
    render(<PythonMacroDialog {...props} />);
    await screen.findByText(/Python 3\.12\.1/);
    expect(screen.getByRole("complementary", { name: "Python Macro" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Run Preview" }));
    await waitFor(() => expect(previewPythonMacro).toHaveBeenCalledWith(
      7,
      expect.stringContaining("def transform"),
      null,
      2,
    ));
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("normal user permissions"), expect.anything());
    expect(props.onTrustAcknowledged).toHaveBeenCalledOnce();
    expect((screen.getByRole("tab", { name: "Preview" }) as HTMLElement).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("R2 C1")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Console" }));
    expect(screen.getByText((_, element) => (
      element?.tagName === "PRE" && element.textContent?.includes("macro output") === true
    ))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(applyPythonPreview).toHaveBeenCalledWith(7, "preview-1", 2));
    expect(props.onApplied).toHaveBeenCalledWith(expect.objectContaining({ revision: 3 }));
  });

  it("disables execution when no compatible interpreter is available", async () => {
    vi.mocked(getPythonStatus).mockResolvedValue({
      path: null,
      version: null,
      available: false,
      error: "Python was not found",
    });
    render(<PythonMacroDialog {...props} />);
    await screen.findByText("Python was not found");
    expect((screen.getByRole("button", { name: "Run Preview" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("cancels an active child process", async () => {
    vi.mocked(previewPythonMacro).mockReturnValue(new Promise(() => {}));
    vi.mocked(cancelPythonMacro).mockResolvedValue(true);
    render(<PythonMacroDialog {...props} trustAcknowledged />);
    await screen.findByText(/Python 3\.12\.1/);
    fireEvent.click(screen.getByRole("button", { name: "Run Preview" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelPythonMacro).toHaveBeenCalledOnce());
  });

  it("switches to Console when execution fails", async () => {
    vi.mocked(previewPythonMacro).mockRejectedValue(new Error("macro exploded"));
    render(<PythonMacroDialog {...props} trustAcknowledged />);
    await screen.findByText(/Python 3\.12\.1/);

    fireEvent.click(screen.getByRole("button", { name: "Run Preview" }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Console" }).getAttribute("aria-selected")).toBe("true");
    });
    expect(screen.getByText((_, element) => (
      element?.tagName === "PRE" && element.textContent?.includes("macro exploded") === true
    ))).toBeTruthy();
  });

  it("resizes with the keyboard and persists the width", async () => {
    render(<PythonMacroDialog {...props} />);
    await screen.findByText(/Python 3\.12\.1/);
    const separator = screen.getByRole("separator", { name: "Resize Python Macro panel" });

    fireEvent.keyDown(separator, { key: "ArrowLeft" });

    expect(separator.getAttribute("aria-valuenow")).toBe("496");
    expect(window.localStorage.getItem("tablune.pythonMacroPanelWidth")).toBe("496");

    const previewTab = screen.getByRole("tab", { name: "Preview" });
    fireEvent.keyDown(previewTab, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Console" }).getAttribute("aria-selected")).toBe("true"));
  });
});
