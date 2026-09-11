// @vitest-environment jsdom
import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { clampSheetZoom, useSheetZoom, wheelZoom, zoomAxis, zoomScrollOffset } from "./sheetZoom";
import { createAxisMetrics } from "./gridSizing";

afterEach(cleanup);
it("scales irregular rows without changing stored sizes or cell hit testing", () => {
  const original = createAxisMetrics(1000, 28, { 2: 96, 3: 45 });
  const scaled = zoomAxis(original, 2);
  expect(scaled.sizeAt(2)).toBe(192);
  expect(scaled.indexAt(scaled.offsetAt(3) + 40)).toBe(3);
  expect(scaled.rangeSize(1, 4)).toBe(original.rangeSize(1, 4) * 2);
  expect(original.sizeAt(2)).toBe(96);
  expect(clampSheetZoom(5)).toBe(3);
  expect(clampSheetZoom(0)).toBe(0.25);
  expect(clampSheetZoom(NaN)).toBe(1);
  expect(wheelZoom(1, 1, 1)).toBe(wheelZoom(1, 16, 0));
  expect(zoomScrollOffset(200, 100, 1, 2)).toBe(500);
});
function Harness({ change = vi.fn() }) {
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  useSheetZoom(viewport, zoom, value => { change(value); setZoom(value); });
  return <div ref={viewport} data-testid="viewport"><output>{Math.round(zoom * 100)}%</output><button onClick={() => setZoom(1)}>Reset</button></div>;
}
function gesture(type: string, scale = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "scale", { value: scale });
  return event;
}
it("zooms with Ctrl+wheel, anchors the cursor and leaves normal scrolling alone", () => {
  const changed = vi.fn();
  render(<Harness change={changed} />);
  const viewport = screen.getByTestId("viewport");
  Object.defineProperties(viewport, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  viewport.scrollLeft = 200;
  viewport.scrollTop = 300;
  const normal = new WheelEvent("wheel", { deltaY: 100, cancelable: true, bubbles: true });
  act(() => { viewport.dispatchEvent(normal); });
  expect(changed).not.toHaveBeenCalled();
  expect(normal.defaultPrevented).toBe(false);
  const zoom = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, clientX: 100, clientY: 200, cancelable: true, bubbles: true });
  act(() => { viewport.dispatchEvent(zoom); });
  expect(zoom.defaultPrevented).toBe(true);
  expect(screen.getByText("122%")).toBeTruthy();
  expect(viewport.scrollLeft).toBeCloseTo(266);
  expect(viewport.scrollTop).toBeCloseTo(410);
  fireEvent.click(screen.getByText("Reset"));
  expect(screen.getByText("100%")).toBeTruthy();
});
it("uses the pinch's initial scale, clamps it, and ignores duplicate Ctrl+wheel during a gesture", () => {
  render(<Harness />);
  const viewport = screen.getByTestId("viewport");
  act(() => { viewport.dispatchEvent(gesture("gesturestart")); });
  act(() => { viewport.dispatchEvent(gesture("gesturechange", 1.5)); });
  expect(screen.getByText("150%")).toBeTruthy();
  fireEvent.wheel(viewport, { ctrlKey: true, deltaY: -100 });
  expect(screen.getByText("150%")).toBeTruthy();
  act(() => { viewport.dispatchEvent(gesture("gesturechange", 2)); });
  expect(screen.getByText("200%")).toBeTruthy();
  act(() => { viewport.dispatchEvent(gesture("gesturechange", 5)); });
  expect(screen.getByText("300%")).toBeTruthy();
  act(() => { viewport.dispatchEvent(gesture("gestureend")); });
  fireEvent.wheel(viewport, { ctrlKey: true, deltaY: 100 });
  expect(screen.getByText("246%")).toBeTruthy();
});

it("accumulates sub-percent precision trackpad wheel changes", () => {
  render(<Harness />);
  const viewport = screen.getByTestId("viewport");
  for (let i = 0; i < 10; i++) fireEvent.wheel(viewport, { ctrlKey: true, deltaY: -0.5 });
  expect(screen.getByText("101%")).toBeTruthy();
});
