// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("replaces the active match instead of the first match", async () => {
    vi.mocked(searchSession).mockResolvedValue([
      { sourceRow: 1, viewRow: 1, column: 0, value: "Ada" },
      { sourceRow: 8, viewRow: 8, column: 2, value: "Ada" },
    ]);
    vi.mocked(replaceSession).mockResolvedValue({ ...summary, revision: 1, dirty: true });
    render(<SearchBar
      summary={summary}
      selection={selection}
      onSummary={vi.fn()}
      onNavigate={vi.fn()}
      onClose={vi.fn()}
      onError={vi.fn()}
    />);

    fireEvent.change(screen.getByRole("textbox", { name: "Find" }), { target: { value: "Ada" } });
    await waitFor(() => expect(screen.getByText("1 / 2")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    await waitFor(() => expect(screen.getByText("2 / 2")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    await waitFor(() => expect(replaceSession).toHaveBeenCalledWith(1, expect.objectContaining({
      replaceAll: false,
      target: { sourceRow: 8, column: 2 },
    })));
  });

  it("sends a view-relative selection when filters are active", async () => {
    vi.mocked(searchSession).mockResolvedValue([]);
    render(<SearchBar
      summary={{ ...summary, filtersActive: true, visibleRowCount: 10 }}
      selection={{
        anchor: { row: 2, column: 3 },
        focus: { row: 5, column: 7 },
        mode: "cells",
      }}
      onSummary={vi.fn()}
      onNavigate={vi.fn()}
      onClose={vi.fn()}
      onError={vi.fn()}
    />);

    fireEvent.change(screen.getByRole("combobox", { name: "Search scope" }), { target: { value: "selection" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Find" }), { target: { value: "Ada" } });

    await waitFor(() => expect(searchSession).toHaveBeenCalledWith(1, expect.objectContaining({
      range: null,
      viewRange: { startRow: 2, endRow: 5, startColumn: 3, endColumn: 7 },
    })));
  });
});
