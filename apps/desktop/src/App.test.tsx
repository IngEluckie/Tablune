// @vitest-environment jsdom

import { open, save } from "@tauri-apps/plugin-dialog";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import {
  closeSession,
  discardRecovery,
  exitApplication,
  getWorkspaceSummary,
  newSession,
  openSession,
  recoveryAvailable,
  reorderWorkspace,
  saveSession,
} from "./ipc";
import type { DocumentSummary, GridViewportState, SelectionRange } from "./types";

const nativeWindow = vi.hoisted(() => ({
  closeHandler: null as null | ((event: { preventDefault: () => void }) => Promise<void>),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTheme: vi.fn().mockResolvedValue(undefined),
    onCloseRequested: vi.fn(async (handler) => {
      nativeWindow.closeHandler = handler;
      return vi.fn();
    }),
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("./ipc", () => ({
  applySessionEdit: vi.fn(),
  closeSession: vi.fn(),
  discardRecovery: vi.fn().mockResolvedValue(undefined),
  exitApplication: vi.fn().mockResolvedValue(undefined),
  exportSessionView: vi.fn(),
  getSessionSummary: vi.fn(),
  getWorkspaceSummary: vi.fn(),
  newSession: vi.fn(),
  openSession: vi.fn(),
  recoveryAvailable: vi.fn(),
  redoSession: vi.fn(),
  renameSession: vi.fn(),
  reorderWorkspace: vi.fn(),
  restoreRecovery: vi.fn(),
  saveSession: vi.fn(),
  setSessionColumnType: vi.fn(),
  setSessionHeader: vi.fn(),
  setSessionView: vi.fn(),
  undoSession: vi.fn(),
  writeWorkspaceRecovery: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./RibbonHeader", () => ({
  default: (props: { documentName: string; error: string | null; onNew: () => void; onOpen: () => void }) => (
    <header>
      <span data-testid="active-name">{props.documentName}</span>
      {props.error && <span role="alert">{props.error}</span>}
      <button onClick={props.onNew}>New CSV</button>
      <button onClick={props.onOpen}>Open CSV</button>
    </header>
  ),
}));

vi.mock("./CsvGrid", () => ({
  default: (props: {
    summary: DocumentSummary;
    initialSelection: SelectionRange;
    initialViewport: GridViewportState;
    onSelectionChange: (selection: SelectionRange) => void;
    onViewportChange: (viewport: GridViewportState) => void;
  }) => (
    <div
      data-testid="grid"
      data-document-id={props.summary.documentId}
      data-selection-row={props.initialSelection.focus.row}
      data-scroll-top={props.initialViewport.scrollTop}
    >
      <button onClick={() => {
        props.onSelectionChange({ anchor: { row: 7, column: 2 }, focus: { row: 7, column: 2 }, mode: "cells" });
        props.onViewportChange({ scrollTop: 180, scrollLeft: 90 });
      }}>Set grid state</button>
    </div>
  ),
  normalizeSelection: () => ({ startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }),
}));
vi.mock("./SearchBar", () => ({ default: () => null }));
vi.mock("./ExplorerPanel", () => ({ default: () => null }));
vi.mock("./PythonMacroDialog", () => ({ default: () => null }));

const summary = (
  documentId: number,
  displayName: string,
  dirty = false,
  path: string | null = `/tmp/${displayName}`,
): DocumentSummary => ({
  documentId,
  path,
  displayName,
  delimiter: ",",
  lineEnding: "lf",
  revision: dirty ? 1 : 0,
  viewRevision: 0,
  dirty,
  rowCount: 1,
  columnCount: 1,
  visibleRowCount: 1,
  headerEnabled: false,
  headerSuggested: false,
  headerNames: ["A"],
  headerValues: [],
  canUndo: dirty,
  canRedo: false,
  filtersActive: false,
  sortCount: 0,
});

describe("App multidocument tabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeWindow.closeHandler = null;
    vi.mocked(recoveryAvailable).mockResolvedValue(false);
    vi.mocked(getWorkspaceSummary).mockResolvedValue({ documents: [summary(1, "first.csv")] });
    vi.mocked(open).mockResolvedValue(null);
    vi.mocked(save).mockResolvedValue(null);
  });

  afterEach(cleanup);

  it("creates a new tab without closing the current document", async () => {
    vi.mocked(newSession).mockResolvedValue(summary(2, "Untitled.csv", false, null));
    render(<App />);
    await screen.findByRole("tab", { name: "first.csv" });

    fireEvent.click(screen.getByRole("button", { name: "New CSV" }));

    await screen.findByRole("tab", { name: "Untitled.csv" });
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByTestId("grid").getAttribute("data-document-id")).toBe("2");
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("keeps partial multi-open successes and activates the first one", async () => {
    vi.mocked(open).mockResolvedValue(["/tmp/second.csv", "/tmp/bad.csv", "/tmp/third.csv"]);
    vi.mocked(openSession).mockImplementation(async (path) => {
      if (path.endsWith("bad.csv")) throw new Error("cannot read file");
      return path.endsWith("second.csv") ? summary(2, "second.csv") : summary(3, "third.csv");
    });
    render(<App />);
    await screen.findByRole("tab", { name: "first.csv" });

    fireEvent.click(screen.getByRole("button", { name: "Open CSV" }));

    await waitFor(() => expect(openSession).toHaveBeenCalledTimes(3));
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByTestId("grid").getAttribute("data-document-id")).toBe("2");
    expect(screen.getByRole("alert").textContent).toContain("bad.csv: Error: cannot read file");
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ multiple: true }));
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("activates an already-open path without duplicating its tab", async () => {
    const second = summary(2, "second.csv");
    vi.mocked(getWorkspaceSummary).mockResolvedValue({ documents: [summary(1, "first.csv"), second] });
    vi.mocked(open).mockResolvedValue("/tmp/second.csv");
    vi.mocked(openSession).mockResolvedValue(second);
    render(<App />);
    await screen.findByRole("tab", { name: "first.csv" });

    fireEvent.click(screen.getByRole("button", { name: "Open CSV" }));

    await waitFor(() => expect(screen.getByTestId("grid").getAttribute("data-document-id")).toBe("2"));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("restores selection and viewport when returning to a tab", async () => {
    vi.mocked(getWorkspaceSummary).mockResolvedValue({
      documents: [summary(1, "first.csv"), summary(2, "second.csv")],
    });
    render(<App />);
    await screen.findByRole("tab", { name: "first.csv" });
    fireEvent.click(screen.getByRole("button", { name: "Set grid state" }));

    fireEvent.click(screen.getByRole("tab", { name: "second.csv" }));
    fireEvent.click(screen.getByRole("tab", { name: "first.csv" }));

    await waitFor(() => expect(screen.getByTestId("grid").getAttribute("data-selection-row")).toBe("7"));
    expect(screen.getByTestId("grid").getAttribute("data-scroll-top")).toBe("180");
  });

  it("propagates the complete tab order to the workspace", async () => {
    const first = summary(1, "first.csv");
    const second = summary(2, "second.csv");
    vi.mocked(getWorkspaceSummary).mockResolvedValue({ documents: [first, second] });
    vi.mocked(reorderWorkspace).mockResolvedValue({ documents: [second, first] });
    render(<App />);
    await screen.findByRole("tab", { name: "first.csv" });

    fireEvent.keyDown(screen.getByRole("tab", { name: "second.csv" }), {
      key: "ArrowLeft",
      altKey: true,
      shiftKey: true,
    });

    await waitFor(() => expect(reorderWorkspace).toHaveBeenCalledWith([2, 1]));
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["second.csv", "first.csv"]);
  });

  it("cycles tabs with Ctrl+Tab and creates with the platform shortcut", async () => {
    vi.mocked(getWorkspaceSummary).mockResolvedValue({
      documents: [summary(1, "first.csv"), summary(2, "second.csv")],
    });
    vi.mocked(newSession).mockResolvedValue(summary(3, "Untitled.csv", false, null));
    render(<App />);
    await screen.findByRole("tab", { name: "first.csv" });

    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    expect(screen.getByTestId("grid").getAttribute("data-document-id")).toBe("2");
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
    expect(screen.getByTestId("grid").getAttribute("data-document-id")).toBe("1");
    fireEvent.keyDown(window, { key: "t", metaKey: true });
    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());
    expect(screen.getByTestId("grid").getAttribute("data-document-id")).toBe("3");
  });

  it("uses the custom dirty dialog and selects the right-hand neighbor after discard", async () => {
    const first = summary(1, "first.csv", true);
    const second = summary(2, "second.csv");
    vi.mocked(getWorkspaceSummary).mockResolvedValue({ documents: [first, second] });
    vi.mocked(closeSession).mockResolvedValue({ documents: [second] });
    render(<App />);
    await screen.findByRole("tab", { name: /first.csv/ });

    fireEvent.click(screen.getByRole("button", { name: "Close first.csv" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(closeSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close first.csv" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() => expect(closeSession).toHaveBeenCalledWith(1, true));
    expect(screen.getByTestId("grid").getAttribute("data-document-id")).toBe("2");
  });

  it("creates a replacement before closing the last clean tab", async () => {
    const replacement = summary(2, "Untitled.csv", false, null);
    vi.mocked(newSession).mockResolvedValue(replacement);
    vi.mocked(closeSession).mockResolvedValue({ documents: [replacement] });
    render(<App />);
    await screen.findByRole("tab", { name: "first.csv" });

    fireEvent.click(screen.getByRole("button", { name: "Close first.csv" }));

    await waitFor(() => expect(closeSession).toHaveBeenCalledWith(1, false));
    expect(newSession).toHaveBeenCalledOnce();
    expect(screen.getByTestId("grid").getAttribute("data-document-id")).toBe("2");
  });

  it("offers one application-close dialog for every dirty document", async () => {
    vi.mocked(getWorkspaceSummary).mockResolvedValue({
      documents: [summary(1, "first.csv", true), summary(2, "second.csv", true)],
    });
    render(<App />);
    await screen.findByRole("tab", { name: /first.csv/ });

    await act(async () => {
      await nativeWindow.closeHandler?.({ preventDefault: vi.fn() });
    });

    expect(screen.getByRole("button", { name: "Save all" })).toBeTruthy();
    expect(screen.getByRole("dialog").querySelectorAll("li")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Discard all" }));
    await waitFor(() => expect(discardRecovery).toHaveBeenCalledOnce());
    expect(exitApplication).toHaveBeenCalledOnce();
  });

  it("stops Save All when a pathless document save is cancelled", async () => {
    const first = summary(1, "first.csv", true);
    const second = summary(2, "Untitled.csv", true, null);
    vi.mocked(getWorkspaceSummary).mockResolvedValue({ documents: [first, second] });
    vi.mocked(saveSession).mockResolvedValue({ ...first, dirty: false });
    vi.mocked(save).mockResolvedValue(null);
    render(<App />);
    await screen.findByRole("tab", { name: /first.csv/ });
    await act(async () => {
      await nativeWindow.closeHandler?.({ preventDefault: vi.fn() });
    });

    fireEvent.click(screen.getByRole("button", { name: "Save all" }));

    await waitFor(() => expect(saveSession).toHaveBeenCalledWith(1, "/tmp/first.csv"));
    expect(save).toHaveBeenCalledOnce();
    expect(exitApplication).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
