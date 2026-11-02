import { describe, expect, it } from "vitest";
import { cellAddress, numericCell, parseCellAddress, proposeAutoSum } from "./autoSum";
import type { CellInfo, SelectionRange } from "./types";

const info = (source = "", overrides: Partial<CellInfo> = {}): CellInfo => ({ row: 0, column: 0, source, display: source, formula: false, cellType: "auto", pending: false, error: null, ...overrides });
const selection = (r: number, c: number, r2 = r, c2 = c): SelectionRange => ({ anchor: { row: r, column: c }, focus: { row: r2, column: c2 }, mode: "cells" });

describe("Autosuma proposals", () => {
  it("places a horizontal total to the right, even when selected backwards", async () => {
    const proposal = await proposeAutoSum(selection(0, 2, 0, 0), async () => info("2"));
    expect(proposal.formula).toBe('=sum(cells("A1:C1"))');
    expect(proposal.target).toEqual({ row: 0, column: 3 });
  });
  it("places vertical and rectangular totals below the selection", async () => {
    const proposal = await proposeAutoSum(selection(1, 1, 5, 2), async () => info("2"));
    expect(proposal.formula).toBe('=sum(cells("B2:C6"))');
    expect(proposal.target).toEqual({ row: 6, column: 1 });
  });
  it("can total one selected numeric cell without including the destination", async () => {
    const proposal = await proposeAutoSum(selection(0, 0), async () => info("2"));
    expect(proposal.formula).toBe('=sum(cells("A1"))');
    expect(proposal.target).toEqual({ row: 1, column: 0 });
  });
  it("infers contiguous numbers above an empty target, stopping at a header", async () => {
    const proposal = await proposeAutoSum(selection(4, 0), async cell => cell.row === 4 ? info() : cell.row === 0 ? info("Header") : info("2"));
    expect(proposal.formula).toBe('=sum(cells("A2:A4"))');
    expect(proposal.target).toEqual({ row: 4, column: 0 });
  });
  it("falls back to numbers on the left", async () => {
    const proposal = await proposeAutoSum(selection(0, 3), async cell => cell.column === 3 ? info() : info("2"));
    expect(proposal.formula).toBe('=sum(cells("A1:C1"))');
  });
  it("rejects occupied targets, empty neighborhoods, and non-cell selections", async () => {
    await expect(proposeAutoSum(selection(1, 1), async () => info("old"))).rejects.toThrow("celda vacía");
    await expect(proposeAutoSum(selection(1, 1), async () => info())).rejects.toThrow("No encontré");
    await expect(proposeAutoSum({ ...selection(0, 0), mode: "columns" }, async () => info())).rejects.toThrow("rango de celdas");
  });
  it("never silently truncates long inferred ranges", async () => {
    await expect(proposeAutoSum(selection(10_002, 0), async cell => info(cell.row === 10_002 ? "" : "1"))).rejects.toThrow("Selecciónalo explícitamente");
  });
  it("respects text types, leading zeros, escaped literals, and pending/errors", () => {
    for (const cell of [info("00123"), info("2", { cellType: "text" }), info("2", { escaped: true }), info("2", { pending: true }), info("2", { error: { code: "#VALUE!", message: "bad" } }), info("1,000"), info("2", { image: { assetId: "x", name: "img", alt: "" } })]) expect(numericCell(cell)).toBe(false);
    for (const cell of [info("-2.5e3"), info("00123", { cellType: "number" }), info("=A1+1", { formula: true, display: "3" })]) expect(numericCell(cell)).toBe(true);
  });
  it("validates addresses against the engine limits", () => {
    expect(cellAddress({ row: 9, column: 26 })).toBe("AA10");
    expect(parseCellAddress(" aa10 ")).toEqual({ row: 9, column: 26 });
    for (const text of ["A0", "A01", "A10000001", "ZZZZZZZZ1", "A1:B3", ""]) expect(parseCellAddress(text)).toBeNull();
  });
});
