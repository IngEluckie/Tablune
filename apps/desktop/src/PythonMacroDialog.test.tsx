// @vitest-environment jsdom

import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPythonPreview,
  cancelPythonMacro,
  getPythonMacroFolder,
  getPythonStatus,
  previewPythonMacro,
  readMacroScript,
  setPythonMacroFolder,
  writeMacroScript,
} from "./ipc";
import PythonMacroDialog from "./PythonMacroDialog";
import type { DocumentSummary, MacroPreview } from "./types";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/api/path", () => ({
  join: vi.fn(),
}));

vi.mock("./ipc", () => ({
  applyPythonPreview: vi.fn(),
  cancelPythonMacro: vi.fn(),
  getPythonMacroFolder: vi.fn(),
  getPythonStatus: vi.fn(),
  previewPythonMacro: vi.fn(),
  readMacroScript: vi.fn(),
  setPythonInterpreter: vi.fn(),
  setPythonMacroFolder: vi.fn(),
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

function mockWorkAreaResize(initialHeight: number) {
  let height = initialHeight;
  let notifyWorkArea = () => {};

  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("macro-work-area") ? height : 0;
  });

  class MockResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}

    observe(target: Element) {
      if (target.classList.contains("macro-work-area")) {
        notifyWorkArea = () => this.callback([], this as unknown as ResizeObserver);
      }
      this.callback([], this as unknown as ResizeObserver);
    }

    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  return {
    setHeight(nextHeight: number) {
      height = nextHeight;
      act(() => notifyWorkArea());
    },
  };
}

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
    vi.mocked(getPythonMacroFolder).mockResolvedValue(null);
    vi.mocked(join).mockImplementation(async (...parts) => parts.join("/"));
    vi.mocked(readMacroScript).mockResolvedValue("def run(rows, context):\n    pass\n");
    vi.mocked(writeMacroScript).mockResolvedValue();
    vi.mocked(ask).mockResolvedValue(true);
    vi.mocked(previewPythonMacro).mockResolvedValue(preview);
    vi.mocked(applyPythonPreview).mockResolvedValue({ ...summary, revision: 3, dirty: true, canUndo: true });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("warns once, previews changes, and applies by preview id", async () => {
    render(<PythonMacroDialog {...props} />);
    await screen.findByText(/Python 3\.12\.1/);
    expect(screen.getByRole("complementary", { name: "Python Macro" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Run Preview" }));
    await waitFor(() => expect(previewPythonMacro).toHaveBeenCalledWith(
      7,
      expect.stringContaining("def run"),
      null,
      2,
    ));
    expect(previewPythonMacro).toHaveBeenCalledWith(
      7,
      expect.stringContaining("def transform"),
      null,
      2,
    );
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
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Macro code" }).getAttribute("contenteditable")).toBe("false"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelPythonMacro).toHaveBeenCalledOnce());
  });

  it("invalidates the preview after an editor change and runs the updated code", async () => {
    render(<PythonMacroDialog {...props} trustAcknowledged />);
    await screen.findByText(/Python 3\.12\.1/);
    fireEvent.click(screen.getByRole("button", { name: "Run Preview" }));
    await screen.findByText("R2 C1");

    const textbox = screen.getByRole("textbox", { name: "Macro code" });
    const view = EditorView.findFromDOM(textbox);
    if (!view) throw new Error("CodeMirror view was not found");
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\nprint('updated')" } }));

    await waitFor(() => expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Run Preview" }));
    await waitFor(() => expect(previewPythonMacro).toHaveBeenLastCalledWith(
      7,
      expect.stringContaining("print('updated')"),
      null,
      2,
    ));
  });

  it("uses the preferred macros folder without restricting Open to it", async () => {
    vi.mocked(getPythonMacroFolder).mockResolvedValue("/Users/test/Macros");
    vi.mocked(open).mockResolvedValue("/Users/test/Elsewhere/example.py");
    render(<PythonMacroDialog {...props} trustAcknowledged />);
    await screen.findByRole("button", { name: /Current folder: \/Users\/test\/Macros/ });

    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => expect(readMacroScript).toHaveBeenCalledWith("/Users/test/Elsewhere/example.py"));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      directory: false,
      defaultPath: "/Users/test/Macros",
    }));
    expect(screen.getByText("example.py")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Current folder: \/Users\/test\/Macros/ })).toBeTruthy();
  });

  it("starts Save As in the preferred folder", async () => {
    vi.mocked(getPythonMacroFolder).mockResolvedValue("/Users/test/Macros");
    vi.mocked(save).mockResolvedValue("/Users/test/Macros/Untitled macro.py");
    render(<PythonMacroDialog {...props} trustAcknowledged />);
    await screen.findByRole("button", { name: /Current folder: \/Users\/test\/Macros/ });

    fireEvent.click(screen.getByRole("button", { name: "Save As" }));

    await waitFor(() => expect(writeMacroScript).toHaveBeenCalledWith(
      "/Users/test/Macros/Untitled macro.py",
      expect.stringContaining("def run"),
    ));
    expect(join).toHaveBeenCalledWith("/Users/test/Macros", "Untitled macro.py");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: "/Users/test/Macros/Untitled macro.py",
    }));
  });

  it("changes the preferred folder from the compact toolbar button", async () => {
    vi.mocked(open).mockResolvedValue("/Users/test/New Macros");
    vi.mocked(setPythonMacroFolder).mockResolvedValue("/Users/test/New Macros");
    render(<PythonMacroDialog {...props} trustAcknowledged />);
    await screen.findByRole("button", { name: "Choose macros folder" });

    fireEvent.click(screen.getByRole("button", { name: "Choose macros folder" }));

    await waitFor(() => expect(setPythonMacroFolder).toHaveBeenCalledWith("/Users/test/New Macros"));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      title: "Choose macros folder",
      directory: true,
      canCreateDirectories: true,
    }));
    expect(screen.getByRole("button", { name: /Current folder: \/Users\/test\/New Macros/ })).toBeTruthy();
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

  it("resizes Preview and Console by pointer, captures it, and persists on completion", async () => {
    class MockPointerEvent extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    vi.stubGlobal("PointerEvent", MockPointerEvent);
    render(<PythonMacroDialog {...props} />);
    await screen.findByText(/Python 3\.12\.1/);
    const separator = screen.getByRole("separator", { name: "Resize Preview and Console area" });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperties(separator, {
      setPointerCapture: { value: setPointerCapture },
      hasPointerCapture: { value: () => true },
      releasePointerCapture: { value: releasePointerCapture },
    });

    fireEvent.pointerDown(separator, { button: 0, pointerId: 7, clientY: 300 });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(separator.classList.contains("resizing")).toBe(true);
    fireEvent.pointerMove(separator, { pointerId: 7, clientY: 260 });
    expect(separator.getAttribute("aria-valuenow")).toBe("220");
    fireEvent.pointerMove(separator, { pointerId: 7, clientY: 600 });
    expect(separator.getAttribute("aria-valuenow")).toBe("120");
    fireEvent.pointerMove(separator, { pointerId: 7, clientY: 0 });
    expect(separator.getAttribute("aria-valuenow")).toBe("240");
    fireEvent.pointerCancel(separator, { pointerId: 7 });
    expect(separator.classList.contains("resizing")).toBe(false);
    expect(window.localStorage.getItem("tablune.pythonMacroResultsHeight")).toBe("240");

    fireEvent.pointerDown(separator, { button: 0, pointerId: 8, clientY: 300 });
    fireEvent.pointerMove(separator, { pointerId: 8, clientY: 350 });
    fireEvent.pointerUp(separator, { pointerId: 8, clientY: 350 });
    expect(releasePointerCapture).toHaveBeenCalledWith(8);
    expect(separator.getAttribute("aria-valuenow")).toBe("190");
    expect(window.localStorage.getItem("tablune.pythonMacroResultsHeight")).toBe("190");

    fireEvent.click(screen.getByRole("tab", { name: "Console" }));
    expect(separator.getAttribute("aria-valuenow")).toBe("190");
  });

  it("supports accessible keyboard resizing and reports current limits", async () => {
    mockWorkAreaResize(500);
    render(<PythonMacroDialog {...props} />);
    await screen.findByText(/Python 3\.12\.1/);
    const separator = screen.getByRole("separator", { name: "Resize Preview and Console area" });

    expect(separator.getAttribute("aria-orientation")).toBe("horizontal");
    expect(separator.getAttribute("aria-valuemin")).toBe("120");
    expect(separator.getAttribute("aria-valuemax")).toBe("402");
    expect(separator.getAttribute("aria-valuenow")).toBe("150");

    fireEvent.keyDown(separator, { key: "ArrowUp" });
    expect(separator.getAttribute("aria-valuenow")).toBe("166");
    fireEvent.keyDown(separator, { key: "ArrowUp", shiftKey: true });
    expect(separator.getAttribute("aria-valuenow")).toBe("214");
    fireEvent.keyDown(separator, { key: "ArrowDown" });
    expect(separator.getAttribute("aria-valuenow")).toBe("198");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator.getAttribute("aria-valuenow")).toBe("120");
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator.getAttribute("aria-valuenow")).toBe("402");
    expect(window.localStorage.getItem("tablune.pythonMacroResultsHeight")).toBe("402");
  });

  it("temporarily clamps a saved height and restores it when space returns", async () => {
    window.localStorage.setItem("tablune.pythonMacroResultsHeight", "300");
    const workArea = mockWorkAreaResize(400);
    render(<PythonMacroDialog {...props} />);
    await screen.findByText(/Python 3\.12\.1/);
    const separator = screen.getByRole("separator", { name: "Resize Preview and Console area" });

    expect(separator.getAttribute("aria-valuenow")).toBe("300");
    workArea.setHeight(260);
    expect(separator.getAttribute("aria-valuemax")).toBe("162");
    expect(separator.getAttribute("aria-valuenow")).toBe("162");
    expect(window.localStorage.getItem("tablune.pythonMacroResultsHeight")).toBe("300");

    workArea.setHeight(400);
    expect(separator.getAttribute("aria-valuenow")).toBe("300");
  });
});
