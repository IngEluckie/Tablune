import { describe, expect, it, vi } from "vitest";
import {
  encodeClipboardMatrix,
  fetchGridSelectionMatrix,
  normalizeSelection,
  parseClipboardMatrix,
} from "./CsvGrid";

describe("grid selection and clipboard", () => {
  it("normalizes a selection dragged backwards", () => {
    expect(normalizeSelection({
      anchor: { row: 8, column: 5 },
      focus: { row: 2, column: 1 },
      mode: "cells",
    })).toEqual({ startRow: 2, endRow: 8, startColumn: 1, endColumn: 5 });
  });

  it("round trips tabs, quotes and multiline values", () => {
    const matrix = [["name", "notes"], ["Ada", "one\ttwo"], ["Linus", "two\nlines and \"quotes\""]];
    expect(parseClipboardMatrix(encodeClipboardMatrix(matrix))).toEqual(matrix);
  });

  it("accepts a normal spreadsheet TSV payload with CRLF", () => {
    expect(parseClipboardMatrix("a\tb\r\n1\t2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("reads every column in selections wider than the backend window limit", async () => {
    const loadWindow = vi.fn(async (
      documentId: number,
      rowStart: number,
      rowCount: number,
      columnStart: number,
      columnCount: number,
    ) => ({
      documentId,
      revision: 0,
      viewRevision: 0,
      rowStart,
      columnStart,
      rows: Array.from({ length: rowCount }, (_, rowOffset) => ({
        viewIndex: rowStart + rowOffset,
        sourceRow: rowStart + rowOffset,
        rowId: rowStart + rowOffset + 1,
        cells: Array.from({ length: columnCount }, (_, columnOffset) => (
          `r${rowStart + rowOffset}c${columnStart + columnOffset}`
        )),
      })),
    }));

    const result = await fetchGridSelectionMatrix(7, {
      startRow: 0,
      endRow: 1,
      startColumn: 0,
      endColumn: 449,
    }, loadWindow);

    expect(loadWindow).toHaveBeenCalledTimes(3);
    expect(loadWindow.mock.calls.map((call) => [call[3], call[4]])).toEqual([
      [0, 200],
      [200, 200],
      [400, 50],
    ]);
    expect(result.matrix).toHaveLength(2);
    expect(result.matrix[0]).toHaveLength(450);
    expect(result.matrix[1][449]).toBe("r1c449");
    expect(result.sourceRows).toEqual([0, 1]);
  });

  it("rejects a segmented selection if the view changes between chunks", async () => {
    let call = 0;
    const loadWindow = vi.fn(async (
      documentId: number,
      rowStart: number,
      rowCount: number,
      columnStart: number,
      columnCount: number,
    ) => ({
      documentId,
      revision: 4,
      viewRevision: call++ === 0 ? 9 : 10,
      rowStart,
      columnStart,
      rows: Array.from({ length: rowCount }, (_, rowOffset) => ({
        viewIndex: rowStart + rowOffset,
        sourceRow: rowStart + rowOffset,
        rowId: rowStart + rowOffset + 1,
        cells: Array.from({ length: columnCount }, () => "value"),
      })),
    }));

    await expect(fetchGridSelectionMatrix(7, {
      startRow: 0,
      endRow: 0,
      startColumn: 0,
      endColumn: 249,
    }, loadWindow)).rejects.toThrow("view changed");
  });
});
