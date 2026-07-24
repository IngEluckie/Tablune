// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DocumentTabs, { documentTabLabels } from "./DocumentTabs";
import type { DocumentSummary } from "./types";

const summary = (documentId: number, name: string, path: string | null, dirty = false): DocumentSummary => ({
  documentId,
  path,
  displayName: name,
  delimiter: ",",
  lineEnding: "lf",
  revision: Number(dirty),
  viewRevision: 0,
  dirty,
  rowCount: 0,
  columnCount: 0,
  visibleRowCount: 0,
  headerEnabled: false,
  headerSuggested: false,
  headerNames: [],
  headerValues: [],
  canUndo: false,
  canRedo: false,
  filtersActive: false,
  sortCount: 0,
});

describe("DocumentTabs", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, "scrollBy", { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("numbers untitled documents and contextualizes equal real file names", () => {
    const labels = documentTabLabels([
      summary(1, "Untitled.csv", null),
      summary(2, "Untitled.csv", null),
      summary(3, "data.csv", "/north/data.csv"),
      summary(4, "data.csv", "/south/data.csv"),
    ]);
    expect(labels.get(1)).toBe("Untitled.csv");
    expect(labels.get(2)).toBe("Untitled (2).csv");
    expect(labels.get(3)).toBe("data.csv — north");
    expect(labels.get(4)).toBe("data.csv — south");
  });

  it("renders active and dirty states and exposes new, close and list actions", () => {
    const activate = vi.fn();
    const close = vi.fn();
    const create = vi.fn();
    render(<DocumentTabs
      documents={[summary(1, "first.csv", "/tmp/first.csv", true), summary(2, "second.csv", "/tmp/second.csv")]}
      activeDocumentId={1}
      onActivate={activate}
      onClose={close}
      onNew={create}
      onReorder={vi.fn()}
    />);
    expect(screen.getByRole("tab", { name: /first.csv/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New document" }));
    fireEvent.click(screen.getByRole("button", { name: "Close second.csv" }));
    fireEvent.click(screen.getByRole("button", { name: "List all documents" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "second.csv" }));
    expect(create).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith(2);
    expect(activate).toHaveBeenCalledWith(2);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Scroll tabs right" }));
    expect(HTMLElement.prototype.scrollBy).toHaveBeenCalledWith({ left: 240, behavior: "smooth" });
  });

  it("reorders with the keyboard and drag-and-drop", () => {
    const reorder = vi.fn();
    const documents = [
      summary(1, "first.csv", "/tmp/first.csv"),
      summary(2, "second.csv", "/tmp/second.csv"),
      summary(3, "third.csv", "/tmp/third.csv"),
    ];
    render(<DocumentTabs
      documents={documents}
      activeDocumentId={2}
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onNew={vi.fn()}
      onReorder={reorder}
    />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "second.csv" }), {
      key: "ArrowRight",
      altKey: true,
      shiftKey: true,
    });
    expect(reorder).toHaveBeenCalledWith([1, 3, 2]);

    const transfer = { effectAllowed: "none", setData: vi.fn(), getData: vi.fn(() => "1") };
    const firstContainer = screen.getByRole("tab", { name: "first.csv" }).parentElement as HTMLElement;
    const thirdContainer = screen.getByRole("tab", { name: "third.csv" }).parentElement as HTMLElement;
    fireEvent.dragStart(firstContainer, { dataTransfer: transfer });
    fireEvent.dragOver(thirdContainer, { dataTransfer: transfer });
    fireEvent.drop(thirdContainer, { dataTransfer: transfer });
    expect(reorder).toHaveBeenLastCalledWith([2, 3, 1]);
  });
});
