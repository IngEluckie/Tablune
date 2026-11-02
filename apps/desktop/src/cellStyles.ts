import type { CellStyle, CellBorder, StylePatch } from "./types";
export const STYLE_PRESETS: Record<string, StylePatch> = {
  Encabezado: { reset: true, bold: true, background: "#245c47", textColor: "#ffffff", alignment: "left" },
  Título: { reset: true, bold: true, background: "#e7f0fc", textColor: "#173b69" },
  Total: { reset: true, bold: true, background: "#eef6ef", textColor: "#214d32", borders: { preset: "top", border: { color: "#477b56", width: 2, line: "solid" } } },
  Destacado: { reset: true, background: "#fff0b3", textColor: "#5c4300" },
};
export function cellFont(style: CellStyle | undefined, zoom: number) {
  return `${style?.italic ? "italic " : ""}${style?.bold ? "bold " : ""}${13 * zoom}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
}
export function cellTextColor(style: CellStyle | undefined, fallback: string) {
  if (style?.textColor) return style.textColor;
  const bg = style?.background;
  if (!bg) return fallback;
  const rgb = [1, 3, 5].map(i => Number.parseInt(bg.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 > 0.179 ? "#161a1f" : "#ffffff";
}
// Draw a shared edge once: wider borders win; ties favor the lower/right cell.
export function sharedBorder(primary?: CellBorder | null, adjacent?: CellBorder | null) {
  if (!primary) return adjacent;
  return adjacent && adjacent.width > primary.width ? adjacent : primary;
}
export function drawBorder(ctx: CanvasRenderingContext2D, border: CellBorder | null | undefined, x1: number, y1: number, x2: number, y2: number, zoom: number) {
  if (!border) return;
  ctx.save();
  ctx.strokeStyle = border.color;
  ctx.lineWidth = border.width * zoom;
  ctx.setLineDash(border.line === "dashed" ? [4 * zoom, 3 * zoom] : []);
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.restore();
}
