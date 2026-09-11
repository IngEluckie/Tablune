// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ProjectSidebar from "./ProjectSidebar";
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("collapses contents and restores the chosen width on expansion and remount", () => {
  const mount = () => render(<ProjectSidebar label="Items"><button>Calculate</button></ProjectSidebar>);
  const view = mount();
  fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(screen.queryByRole("button", { name: "Calculate" })).toBeNull();
  expect(screen.queryByRole("separator")).toBeNull();
  view.unmount();
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
  expect(screen.getByRole("button", { name: "Calculate" })).toBeTruthy();
  expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("240");
});
it("resizes by dragging the edge and stops after release", () => {
  class PointerEventMock extends MouseEvent { pointerId = 1; }
  vi.stubGlobal("PointerEvent", PointerEventMock);
  render(<ProjectSidebar label="Items">Items</ProjectSidebar>);
  const edge = screen.getByRole("separator");
  edge.setPointerCapture = vi.fn();
  edge.releasePointerCapture = vi.fn();
  vi.spyOn(edge.parentElement!, "getBoundingClientRect").mockReturnValue({ width: 230 } as DOMRect);
  fireEvent.pointerDown(edge, { button: 0, clientX: 230 });
  fireEvent.pointerMove(edge, { clientX: 330 });
  expect(edge.getAttribute("aria-valuenow")).toBe("330");
  fireEvent.pointerUp(edge);
  fireEvent.pointerMove(edge, { clientX: 450 });
  expect(edge.getAttribute("aria-valuenow")).toBe("330");
});
it("bounds keyboard resizing and tolerates invalid saved widths", () => {
  localStorage.setItem("tablune.sidebarWidth", "invalid");
  render(<ProjectSidebar label="Items">Items</ProjectSidebar>);
  const edge = screen.getByRole("separator");
  expect(edge.getAttribute("aria-valuenow")).toBe("230");
  fireEvent.keyDown(edge, { key: "End" });
  fireEvent.keyDown(edge, { key: "ArrowRight" });
  expect(edge.getAttribute("aria-valuenow")).toBe("480");
  fireEvent.keyDown(edge, { key: "Home" });
  fireEvent.keyDown(edge, { key: "ArrowLeft" });
  expect(edge.getAttribute("aria-valuenow")).toBe("180");
});
