import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { AxisMetrics } from "./gridSizing";

export const MIN_SHEET_ZOOM = 0.25;
export const MAX_SHEET_ZOOM = 3;
export function clampSheetZoom(value: number) {
  return Number.isFinite(value) ? Math.round(Math.min(MAX_SHEET_ZOOM, Math.max(MIN_SHEET_ZOOM, value)) * 100) / 100 : 1;
}
export function zoomAxis(metrics: AxisMetrics, zoom: number): AxisMetrics {
  return {
    count: metrics.count, defaultSize: metrics.defaultSize * zoom,
    sizeAt: index => metrics.sizeAt(index) * zoom,
    offsetAt: index => metrics.offsetAt(index) * zoom,
    indexAt: offset => metrics.indexAt(offset / zoom),
    rangeSize: (start, end) => metrics.rangeSize(start, end) * zoom,
    totalSize: metrics.totalSize * zoom,
  };
}
export function zoomScrollOffset(scroll: number, anchor: number, oldZoom: number, newZoom: number) {
  return Math.max(0, (scroll + anchor) * newZoom / oldZoom - anchor);
}
export function wheelZoom(zoom: number, delta: number, deltaMode: number) {
  const pixels = delta * (deltaMode === 1 ? 16 : deltaMode === 2 ? 600 : 1);
  return Math.min(MAX_SHEET_ZOOM, Math.max(MIN_SHEET_ZOOM, zoom * Math.exp(-Math.max(-300, Math.min(300, pixels)) * 0.002)));
}

// WebKit emits gesture events; Chromium/WebView2 emits Ctrl+wheel for trackpad pinches.
export function useSheetZoom(viewportRef: RefObject<HTMLDivElement | null>, zoom: number, onChange?: (zoom: number) => void) {
  const current = useRef({ zoom, onChange });
  current.current = { zoom, onChange };
  const applied = useRef(zoom);
  // Capture offsets before React changes the scroll extent (zooming out can clamp it).
  const beforeLayout = { left: viewportRef.current?.scrollLeft ?? 0, top: viewportRef.current?.scrollTop ?? 0 };
  const anchor = useRef<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && applied.current !== zoom) {
      const point = anchor.current ?? { x: 0, y: 0 };
      viewport.scrollLeft = zoomScrollOffset(beforeLayout.left, point.x, applied.current, zoom);
      viewport.scrollTop = zoomScrollOffset(beforeLayout.top, point.y, applied.current, zoom);
    }
    applied.current = zoom;
    anchor.current = null;
  }, [viewportRef, zoom]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let gestureBase: number | null = null;
    let wheelAccumulator = current.current.zoom;
    let wheelPublished = current.current.zoom;
    const change = (value: number, event: { clientX?: number; clientY?: number }) => {
      const next = clampSheetZoom(value);
      if (!current.current.onChange || next === current.current.zoom) return;
      const rect = viewport.getBoundingClientRect();
      anchor.current = {
        x: Number.isFinite(event.clientX) ? Math.max(0, Math.min(viewport.clientWidth, event.clientX! - rect.left)) : viewport.clientWidth / 2,
        y: Number.isFinite(event.clientY) ? Math.max(0, Math.min(viewport.clientHeight, event.clientY! - rect.top)) : viewport.clientHeight / 2,
      };
      current.current.zoom = next;
      current.current.onChange(next);
    };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !current.current.onChange) return;
      event.preventDefault();
      if (gestureBase === null) {
        if (wheelPublished !== current.current.zoom) wheelAccumulator = current.current.zoom;
        wheelAccumulator = wheelZoom(wheelAccumulator, event.deltaY, event.deltaMode);
        change(wheelAccumulator, event);
        wheelPublished = current.current.zoom;
      }
    };
    type PinchEvent = Event & { scale?: number; clientX?: number; clientY?: number };
    const start = (event: Event) => {
      if (!current.current.onChange) return;
      event.preventDefault();
      gestureBase = current.current.zoom;
    };
    const gesture = (event: PinchEvent) => {
      if (gestureBase === null) return;
      event.preventDefault();
      if (typeof event.scale === "number" && event.scale > 0) change(gestureBase * event.scale, event);
    };
    const end = (event: Event) => { if (gestureBase !== null) event.preventDefault(); gestureBase = null; };
    viewport.addEventListener("wheel", wheel, { passive: false });
    viewport.addEventListener("gesturestart", start, { passive: false });
    viewport.addEventListener("gesturechange", gesture, { passive: false });
    viewport.addEventListener("gestureend", end, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("gesturestart", start);
      viewport.removeEventListener("gesturechange", gesture);
      viewport.removeEventListener("gestureend", end);
    };
  }, [viewportRef]);
}
