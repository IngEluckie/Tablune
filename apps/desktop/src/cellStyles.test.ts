import { expect, it, vi } from "vitest";
import { cellFont, cellTextColor, drawBorder, sharedBorder } from "./cellStyles";
it("keeps auto text readable on explicit light and dark fills in either theme",()=>{
  expect(cellTextColor({background:"#ffffff"},"#ffffff")).toBe("#161a1f");
  expect(cellTextColor({background:"#000000"},"#161a1f")).toBe("#ffffff");
  expect(cellTextColor({textColor:"#123456",background:"#ffffff"},"#000000")).toBe("#123456");
  expect(cellTextColor({},"#e7ebf0")).toBe("#e7ebf0");
  expect(cellFont({bold:true,italic:true},2)).toContain("italic bold 26px");
});
it("resolves shared borders consistently and scales their width and dashes with zoom",()=>{
  const thin={color:"#123456",width:1 as const,line:"solid" as const}, thick={color:"#234567",width:3 as const,line:"dashed" as const};
  expect(sharedBorder(thin,thick)).toBe(thick);expect(sharedBorder(thick,thin)).toBe(thick);
  const ctx={save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),setLineDash:vi.fn(),lineWidth:0,strokeStyle:""};
  drawBorder(ctx as unknown as CanvasRenderingContext2D,thick,0,0,40,0,2);
  expect(ctx.lineWidth).toBe(6);expect(ctx.setLineDash).toHaveBeenCalledWith([8,6]);expect(ctx.stroke).toHaveBeenCalledOnce();
});
