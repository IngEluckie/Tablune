// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SearchBar from "./SearchBar";
import { replaceSession, searchSession } from "./ipc";
import type { DocumentSummary, SelectionRange } from "./types";

vi.mock("./ipc", () => ({
  replaceSession: vi.fn(),
  searchSession: vi.fn().mockResolvedValue([]),
}));

const summary: DocumentSummary = {
  documentId: 1,
  path: "/tmp/data.csv",
  displayName: "data.csv",
  delimiter: ",",
  lineEnding: "lf",
  revision: 0,
  viewRevision: 0,
  dirty: false,
  rowCount: 1,
  columnCount: 1,
  visibleRowCount: 1,
  headerEnabled: false,
  headerSuggested: false,
  headerNames: ["A"],
  headerValues: [],
  canUndo: false,
  canRedo: false,
  filtersActive: false,
  sortCount: 0,
};

const selection: SelectionRange = {
  anchor: { row: 0, column: 0 },
  focus: { row: 0, column: 0 },
  mode: "cells",
};

describe("SearchBar read-only mode", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps finding available while disabling replacement", () => {
    render(<SearchBar
      summary={summary}
      selection={selection}
      readOnly
      onSummary={vi.fn()}
      onNavigate={vi.fn()}
      onClose={vi.fn()}
      onError={vi.fn()}
    />);

    fireEvent.change(screen.getByRole("textbox", { name: "Find" }), { target: { value: "Ada" } });
    expect((screen.getByRole("textbox", { name: "Find" }) as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole("textbox", { name: "Replace with" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Replace" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Replace All" }) as HTMLButtonElement).disabled).toBe(true);
    expect(searchSession).not.toHaveBeenCalled();
    expect(replaceSession).not.toHaveBeenCalled();
  });
});
