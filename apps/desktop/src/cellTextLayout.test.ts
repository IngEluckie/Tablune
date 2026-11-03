import {it,expect,vi} from "vitest";
import {wrapCellText,drawCellText,measureWrappedRows} from "./cellTextLayout";
import type {GridWindow,CellInfo} from "./types";
const cell=(row:number,column:number,text:string):CellInfo=>({row,column,display:text,source:text,style:{wrapText:true},formula:false,cellType:"auto",pending:false,error:null});
const data=(cells:CellInfo[]):GridWindow=>({documentId:1,revision:0,viewRevision:0,rowStart:0,columnStart:0,rows:cells.map(c=>({viewIndex:c.row,sourceRow:c.row,rowId:c.row,cells:[c.display],inputs:[c]}))});
it("wraps words, explicit newlines and oversized Unicode words without losing text",()=>{
 expect(wrapCellText("uno dos tres",7,s=>s.length)).toEqual(["uno dos","tres"]);
 expect(wrapCellText("abcd\r\n\r\nefghijk",4,s=>s.length)).toEqual(["abcd","","efgh","ijk"]);
 expect(wrapCellText("🙂🙂🙂",2,s=>Array.from(s).length)).toEqual(["🙂🙂","🙂"]);
});
it("grows regular rows, preserves manual minimum heights and retains measurements across horizontal scrolling",()=>{
 const d=data([cell(0,0,"a".repeat(40))]);const h=measureWrappedRows(d,[],{}, {},()=>40,s=>s.length*6);
 expect(h[0]).toBeGreaterThan(28);
 expect(measureWrappedRows(d,[],{0:400},{},()=>40,s=>s.length*6)[0]).toBeUndefined();
 expect(measureWrappedRows(data([cell(0,1,"x")]),[],{},h,()=>160,s=>s.length*6)).toEqual(h);
});
it("uses merged width and expands only the last row of a vertical block to fit",()=>{
 const anchor=cell(0,0,"a".repeat(120)),m={startRow:0,endRow:1,startColumn:0,endColumn:1};
 const d={...data([]),mergedCells:[anchor]};
 const narrow=measureWrappedRows(d,[m],{}, {},()=>80,s=>s.length*6);
 const wide=measureWrappedRows(d,[m],{}, {},()=>320,s=>s.length*6);
 expect(narrow[0]).toBeUndefined();expect(narrow[1]).toBeGreaterThan(wide[1]??28);
 expect(measureWrappedRows(d,[m],{},narrow,()=>80,s=>s.length*6)).toEqual(narrow);
});
it("paints aligned multiline text with underlines and skips offscreen lines",()=>{
 const ctx={measureText:(s:string)=>({width:s.length*7}),fillText:vi.fn(),fillRect:vi.fn()};
 drawCellText(ctx as unknown as CanvasRenderingContext2D,"a\nb\nc",{wrapText:true,underline:true,alignment:"center"},0,0,160,80,1,38,42);
 expect(ctx.fillText.mock.calls.every(c=>c[1]===80)).toBe(true);expect(ctx.fillText.mock.calls.length).toBeLessThan(3);expect(ctx.fillRect).toHaveBeenCalled();
});
