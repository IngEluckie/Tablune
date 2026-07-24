// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UnsavedChangesDialog from "./UnsavedChangesDialog";
import type { DocumentSummary } from "./types";

const document = (documentId: number, name: string): DocumentSummary => ({
  documentId,
  path: `/tmp/${name}`,
  displayName: name,
  delimiter: ",",
  lineEnding: "lf",
  revision: 1,
  viewRevision: 0,
  dirty: true,
  rowCount: 1,
  columnCount: 1,
  visibleRowCount: 1,
  headerEnabled: false,
  headerSuggested: false,
  headerNames: [],
  headerValues: [],
  canUndo: true,
  canRedo: false,
  filtersActive: false,
  sortCount: 0,
});

afterEach(cleanup);

describe("UnsavedChangesDialog", () => {
  it("offers Save, Discard and Cancel for one tab", () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    const onCancel = vi.fn();
    render(<UnsavedChangesDialog
      documents={[document(1, "first.csv")]}
      closingApplication={false}
      onSave={onSave}
      onDiscard={onDiscard}
      onCancel={onCancel}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onSave).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("lists dirty tabs for application close", () => {
    render(<UnsavedChangesDialog
      documents={[document(1, "first.csv"), document(2, "second.csv")]}
      closingApplication
      onSave={vi.fn()}
      onDiscard={vi.fn()}
      onCancel={vi.fn()}
    />);
    expect(screen.getByRole("button", { name: "Save all" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard all" })).toBeTruthy();
    expect(screen.getByText("first.csv")).toBeTruthy();
    expect(screen.getByText("second.csv")).toBeTruthy();
  });

  it("keeps the workspace disambiguation in a single-tab dialog", () => {
    const untitled = [1, 2, 3].map((documentId) => ({
      ...document(documentId, "Untitled.csv"),
      path: null,
    }));
    render(<UnsavedChangesDialog
      documents={[untitled[2]]}
      allDocuments={untitled}
      closingApplication={false}
      onSave={vi.fn()}
      onDiscard={vi.fn()}
      onCancel={vi.fn()}
    />);
    expect(screen.getByText(/Untitled \(3\)\.csv contains changes/)).toBeTruthy();
  });
});
