import type {CellInfo,CellStyle,CellRange,GridWindow} from "./types";
import {cellFont} from "./cellStyles";
import {mergeAt} from "./mergedCells";
import {createAxisMetrics,DEFAULT_ROW_HEIGHT} from "./gridSizing";
export const CELL_LINE_HEIGHT=18;
export const CELL_TEXT_PADDING=8;
/** Keep explicit newlines, wrap at word boundaries, and split oversized Unicode words. */
export function wrapCellText(text:string,width:number,measure:(text:string)=>number):string[]{
  const lines:string[]=[];width=Math.max(1,width);
  for(const paragraph of text.replace(/\r\n?/g,"\n").split("\n")){
    if(!paragraph){lines.push("");continue;}
    let line="";
    for(const char of Array.from(paragraph)){
      if(line&&measure(line+char)>width){
        const lastSpace=line.lastIndexOf(" ");
        if(lastSpace>0&&!/\s/.test(char)){
          lines.push(line.slice(0,lastSpace));line=line.slice(lastSpace+1);
          if(line&&measure(line+char)>width){lines.push(line);line="";}
        }else{lines.push(line.trimEnd());line="";}
      }
      if(line||!/[ \t]/.test(char))line+=char;
    }
    lines.push(line);
  }
  return lines;
}
export function drawCellText(ctx:CanvasRenderingContext2D,text:string,style:CellStyle|undefined,x:number,y:number,width:number,height:number,zoom:number,clipTop=-Infinity,clipBottom=Infinity){
  const padding=8*zoom;
  const lines=style?.wrapText?wrapCellText(text,Math.max(1,width-16*zoom),s=>ctx.measureText(s).width):[text];
  const lineHeight=CELL_LINE_HEIGHT*zoom;
  const firstY=y+height/2-(lines.length-1)*lineHeight/2;
  const tx=style?.alignment==="center"?x+width/2:style?.alignment==="right"?x+width-padding:x+padding;
  // Paint only lines that intersect the viewport, even for a very tall cell.
  const start=Math.max(0,Math.ceil((clipTop-firstY-13*zoom)/lineHeight));
  const end=Math.min(lines.length-1,Math.floor((clipBottom-firstY+13*zoom)/lineHeight));
  for(let i=start;i<=end;i++){
    const cy=firstY+i*lineHeight,line=lines[i];ctx.fillText(line,tx,cy);
    if(style?.underline&&line){const w=ctx.measureText(line).width;ctx.fillRect(style.alignment==="center"?tx-w/2:style.alignment==="right"?tx-w:tx,cy+6*zoom,w,Math.max(1,zoom));}
  }
}
export function measureWrappedRows(data:GridWindow,merges:CellRange[],base:Record<number,number>,previous:Record<number,number>,columnWidth:(start:number,end:number)=>number,measure:(text:string,style?:CellStyle)=>number):Record<number,number>{
  const result={...previous};
  const cells: Array<{viewRow:number;cell:CellInfo}> = data.rows.flatMap(row=>(row.inputs??[]).map(cell=>({viewRow:row.viewIndex,cell})));
  // Merged anchors may be outside the fetched rows/columns.
  for(const cell of data.mergedCells??[])if(!cells.some(c=>c.cell.row===cell.row&&c.cell.column===cell.column))cells.push({viewRow:cell.row,cell});
  const needed=(cell:CellInfo,width:number)=>wrapCellText(cell.display,Math.max(1,width-16),text=>measure(text,cell.style)).length*CELL_LINE_HEIGHT+CELL_TEXT_PADDING;
  // Retain measurements for other columns of these rows as they scroll horizontally.
  for(const {viewRow,cell} of cells){
    if(!cell.style?.wrapText||cell.image||!cell.display||mergeAt(merges,{row:cell.row,column:cell.column}))continue;
    const h=needed(cell,columnWidth(cell.column,cell.column));
    if(h>(base[viewRow]??DEFAULT_ROW_HEIGHT))result[viewRow]=Math.max(result[viewRow]??0,h);
  }
  const regions=merges.filter(m=>cells.some(c=>c.cell.row===m.startRow&&c.cell.column===m.startColumn&&c.cell.style?.wrapText)).sort((a,b)=>a.endRow-b.endRow);
  for(const m of regions){
    const cell=cells.find(c=>c.cell.row===m.startRow&&c.cell.column===m.startColumn)!.cell;if(cell.image||!cell.display)continue;
    const h=needed(cell,columnWidth(m.startColumn,m.endColumn));
    const overrides={...base};for(const [row,size] of Object.entries(result))overrides[Number(row)]=Math.max(size,overrides[Number(row)]??DEFAULT_ROW_HEIGHT);
    const metrics=createAxisMetrics(m.endRow+1,DEFAULT_ROW_HEIGHT,overrides);
    const available=metrics.rangeSize(m.startRow,m.endRow+1);
    if(h>available)result[m.endRow]=(overrides[m.endRow]??DEFAULT_ROW_HEIGHT)+h-available;
  }
  return result;
}
let measurementContext:CanvasRenderingContext2D|null|undefined;
export function measureCellText(text:string,style?:CellStyle){
  if(measurementContext===undefined)measurementContext=document.createElement("canvas").getContext("2d");
  if(!measurementContext)return Array.from(text).length*7;
  measurementContext.font=cellFont(style,1);return measurementContext.measureText(text).width;
}
