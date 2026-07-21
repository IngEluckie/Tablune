// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RibbonHeader from "./RibbonHeader";

const defaultProps = {
  documentName: "Untitled.csv",
  dirty: false,
  busy: false,
  error: null,
  delimiter: ",",
  onNew: vi.fn(),
  onOpen: vi.fn(),
  onSave: vi.fn(),
  onSaveAs: vi.fn(),
  onDelimiterChange: vi.fn(),
};

describe("RibbonHeader", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("opens from a menu hover and closes after leaving the top region", () => {
    vi.useFakeTimers();
    render(<RibbonHeader {...defaultProps} />);

    const region = screen.getByTestId("top-region");
    expect(region.classList.contains("ribbon-open")).toBe(false);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "File" }));
    expect(region.classList.contains("ribbon-open")).toBe(true);

    fireEvent.mouseLeave(region);
    act(() => vi.advanceTimersByTime(179));
    expect(region.classList.contains("ribbon-open")).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(region.classList.contains("ribbon-open")).toBe(false);
  });

  it("opens when hovering the document and brand area", () => {
    render(<RibbonHeader {...defaultProps} />);

    const region = screen.getByTestId("top-region");
    fireEvent.mouseEnter(screen.getByTitle("Untitled.csv"));

    expect(region.classList.contains("ribbon-open")).toBe(true);
    expect(screen.getByRole("button", { name: "New" })).toBeTruthy();
  });

  it("restores and updates the persistent pin preference", () => {
    window.localStorage.setItem("tablune.ribbonPinned", "true");
    render(<RibbonHeader {...defaultProps} />);

    const region = screen.getByTestId("top-region");
    const pin = screen.getByRole("checkbox", { name: "Pin" });
    expect((pin as HTMLInputElement).checked).toBe(true);
    expect(region.classList.contains("ribbon-open")).toBe(true);

    fireEvent.click(pin);
    expect((pin as HTMLInputElement).checked).toBe(false);
    expect(window.localStorage.getItem("tablune.ribbonPinned")).toBe("false");
  });

  it("switches contextual content and keeps future commands disabled", () => {
    render(<RibbonHeader {...defaultProps} />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Paste" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Data" }));
    expect((screen.getByRole("button", { name: "Insert Row" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Delimiter" }), {
      target: { value: ";" },
    });
    expect(defaultProps.onDelimiterChange).toHaveBeenCalledWith(";");

    fireEvent.mouseEnter(screen.getByRole("button", { name: "View" }));
    expect((screen.getByRole("button", { name: "Fit Columns" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("preserves the working file actions", () => {
    render(<RibbonHeader {...defaultProps} />);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "File" }));

    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Save As" }));

    expect(defaultProps.onNew).toHaveBeenCalledOnce();
    expect(defaultProps.onOpen).toHaveBeenCalledOnce();
    expect(defaultProps.onSave).toHaveBeenCalledOnce();
    expect(defaultProps.onSaveAs).toHaveBeenCalledOnce();
  });
});
