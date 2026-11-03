import type {CellRange,CellCoordinate,SelectionRange} from "./types";
export const containsCell=(r:CellRange,p:CellCoordinate)=>p.row>=r.startRow&&p.row<=r.endRow&&p.column>=r.startColumn&&p.column<=r.endColumn;
export const intersectsRange=(a:CellRange,b:CellRange)=>a.startRow<=b.endRow&&b.startRow<=a.endRow&&a.startColumn<=b.endColumn&&b.startColumn<=a.endColumn;
export const enclosesRange=(a:CellRange,b:CellRange)=>a.startRow<=b.startRow&&a.endRow>=b.endRow&&a.startColumn<=b.startColumn&&a.endColumn>=b.endColumn;
export function mergeAt(merges:CellRange[],cell:CellCoordinate){return merges.find(m=>containsCell(m,cell));}
export function mergeAnchor(merges:CellRange[],cell:CellCoordinate):CellCoordinate {const m=mergeAt(merges,cell);return m?{row:m.startRow,column:m.startColumn}:cell;}
export function expandMergedSelection(selection:SelectionRange,merges:CellRange[]):SelectionRange {
  if(!merges.length)return selection;
  let r={startRow:Math.min(selection.anchor.row,selection.focus.row),endRow:Math.max(selection.anchor.row,selection.focus.row),startColumn:Math.min(selection.anchor.column,selection.focus.column),endColumn:Math.max(selection.anchor.column,selection.focus.column)};
  let changed=true;while(changed){changed=false;for(const m of merges){if(!intersectsRange(r,m)||enclosesRange(r,m))continue;r={startRow:Math.min(r.startRow,m.startRow),endRow:Math.max(r.endRow,m.endRow),startColumn:Math.min(r.startColumn,m.startColumn),endColumn:Math.max(r.endColumn,m.endColumn)};changed=true;}}
  return {...selection,focus:mergeAnchor(merges,selection.focus),extent:r};
}
