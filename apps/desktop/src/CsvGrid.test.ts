import { describe, expect, it } from "vitest";
import { encodeClipboardMatrix, normalizeSelection, parseClipboardMatrix } from "./CsvGrid";

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
});
