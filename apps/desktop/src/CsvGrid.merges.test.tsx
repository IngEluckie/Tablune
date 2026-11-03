// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {it,expect,vi,beforeEach,afterEach} from "vitest";
import CsvGrid from "./CsvGrid";
import * as ipc from "./ipc";
import type {DocumentSummary} from "./types";
vi.mock("./ipc",()=>({getGridWindow:vi.fn(),getSheetCell:vi.fn(),getSessionSummary:vi.fn(),getStyleSummary:vi.fn(),clipboardGeneration:vi.fn(),writeNativeClipboard:vi.fn(),readNativeClipboard:vi.fn()}));
const merge={startRow:0,endRow:2,startColumn:0,endColumn:2};
const summary:DocumentSummary={projectId:1,documentId:1,path:null,displayName:"Table",delimiter:",",lineEnding:"lf",revision:0,viewRevision:0,dirty:false,rowCount:10,columnCount:10,visibleRowCount:10,headerEnabled:false,headerSuggested:false,headerNames:[],headerValues:[],canUndo:false,canRedo:false,filtersActive:false,sortCount:0,merges:[merge]};
beforeEach(()=>{
  globalThis.PointerEvent=MouseEvent as typeof PointerEvent;
  globalThis.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
  vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(800);vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(600);
  vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue(null);
  vi.mocked(ipc.getGridWindow).mockImplementation(async(documentId,rowStart,_n,columnStart)=>({documentId,revision:0,viewRevision:0,rowStart,columnStart,rows:[]}));
  vi.mocked(ipc.getSheetCell).mockImplementation(async(_id,row,column)=>({row,column,source:"Título",display:"Título",formula:false,cellType:"auto",pending:false,error:null}));
  vi.mocked(ipc.getSessionSummary).mockResolvedValue(summary);
  vi.mocked(ipc.clipboardGeneration).mockResolvedValue(10);
  vi.mocked(ipc.writeNativeClipboard).mockResolvedValue(true);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
function mount(){const onSelectionChange=vi.fn(),onApplyEdit=vi.fn().mockResolvedValue(undefined);const result=render(<CsvGrid summary={summary} theme="light" onApplyEdit={onApplyEdit} onSelectionChange={onSelectionChange} onError={vi.fn()} onHeaderSort={vi.fn()}/>);return {...result,onSelectionChange,onApplyEdit,viewport:result.container.querySelector(".grid-viewport")!};}
it("selects the complete rectangle, edits the anchor, and navigates past its edges",async()=>{
 const {viewport,onSelectionChange}=mount();
 fireEvent.pointerDown(viewport,{button:0,clientX:260,clientY:75});fireEvent.pointerUp(viewport);
 expect(onSelectionChange.mock.lastCall![0].extent).toEqual(merge);expect(onSelectionChange.mock.lastCall![0].focus).toEqual({row:0,column:0});
 fireEvent.keyDown(viewport,{key:"F2"});const editor=await screen.findByLabelText("Edit cell");expect(editor).toHaveProperty("value","Título");expect(ipc.getSheetCell).toHaveBeenLastCalledWith(1,0,0);
 fireEvent.keyDown(editor,{key:"Escape"});fireEvent.keyDown(viewport,{key:"ArrowRight"});expect(onSelectionChange.mock.lastCall![0].focus).toEqual({row:0,column:3});
});
it("sends combine/center/split as revision checked table edits",async()=>{
 const {onApplyEdit}=mount();await act(async()=>{document.dispatchEvent(new CustomEvent("tablune-grid-command",{detail:{documentId:1,command:"center"}}));});
 await waitFor(()=>expect(onApplyEdit).toHaveBeenCalledWith({kind:"mergeCells",range:merge,center:true},{documentId:1,revision:0}));
 await act(async()=>{document.dispatchEvent(new CustomEvent("tablune-grid-command",{detail:{documentId:1,command:"split"}}));});
 expect(onApplyEdit).toHaveBeenLastCalledWith({kind:"unmergeCells",range:merge},{documentId:1,revision:0});
});

it("copies and pastes complete merged blocks with their range in one edit",async()=>{
 const info=(row:number,column:number)=>({row,column,source:row===0&&column===0?"Title":"",display:row===0&&column===0?"Title":"",formula:false,cellType:"auto" as const,pending:false,error:null});
 vi.mocked(ipc.getGridWindow).mockImplementation(async(documentId,rowStart,rowCount,columnStart,columnCount)=>({documentId,revision:0,viewRevision:0,rowStart,columnStart,rows:Array.from({length:rowCount},(_,r)=>{const inputs=Array.from({length:columnCount},(_,c)=>info(rowStart+r,columnStart+c));return {sourceRow:rowStart+r,viewIndex:rowStart+r,rowId:r,inputs,cells:inputs.map(i=>i.display)};})}));
 vi.mocked(ipc.readNativeClipboard).mockImplementation(async()=>vi.mocked(ipc.writeNativeClipboard).mock.lastCall![0]);
 const {viewport,onApplyEdit}=mount();
 await act(async()=>{document.dispatchEvent(new CustomEvent("tablune-grid-command",{detail:{documentId:1,command:"copy"}}));});
 fireEvent.pointerDown(viewport,{button:0,clientX:560,clientY:160});fireEvent.pointerUp(viewport);
 await act(async()=>{document.dispatchEvent(new CustomEvent("tablune-grid-command",{detail:{documentId:1,command:"paste"}}));});
 expect(onApplyEdit).toHaveBeenLastCalledWith(expect.objectContaining({kind:"pasteMergedCells",range:{startRow:4,endRow:6,startColumn:3,endColumn:5},merges:[{startRow:4,endRow:6,startColumn:3,endColumn:5}]}));
});
it("automatically grows wrapped merged cells and restores row heights when wrapping is disabled",async()=>{
 let wrapped=true,revision=0;
 const text="Texto largo para comprobar el ajuste de línea. ".repeat(30);
 vi.mocked(ipc.getGridWindow).mockImplementation(async(documentId,rowStart,_rows,columnStart)=>({documentId,revision,viewRevision:0,rowStart,columnStart,rows:[],mergedCells:[{row:0,column:0,source:text,display:text,style:{wrapText:wrapped},formula:false,cellType:"auto",pending:false,error:null}]}));
 const {container,rerender}=mount();
 const spacer=container.querySelector('[data-testid="grid-spacer"]') as HTMLElement;
 await waitFor(()=>expect(parseFloat(spacer.style.height)).toBeGreaterThan(2832));
 wrapped=false;revision=1;
 rerender(<CsvGrid summary={{...summary,revision}} theme="light" onApplyEdit={vi.fn()} onSelectionChange={vi.fn()} onError={vi.fn()} onHeaderSort={vi.fn()}/>);
 await waitFor(()=>expect(parseFloat(spacer.style.height)).toBe(2832));
});
