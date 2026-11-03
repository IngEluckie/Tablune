import {it,expect} from "vitest";
import {expandMergedSelection,mergeAnchor} from "./mergedCells";
import {normalizeSelection} from "./CsvGrid";
it("expands a clicked covered cell while editing its top-left anchor",()=>{
  const merge={startRow:1,endRow:3,startColumn:2,endColumn:4};
  const s=expandMergedSelection({anchor:{row:3,column:4},focus:{row:3,column:4},mode:"cells"},[merge]);
  expect(normalizeSelection(s)).toEqual(merge);expect(s.focus).toEqual({row:1,column:2});
  expect(mergeAnchor([merge],{row:3,column:3})).toEqual({row:1,column:2});
});
it("expands transitively to include all touched merged blocks",()=>{
  const a={startRow:0,endRow:2,startColumn:1,endColumn:2},b={startRow:2,endRow:4,startColumn:3,endColumn:4};
  const s=expandMergedSelection({anchor:{row:0,column:0},focus:{row:2,column:3},mode:"cells"},[a,b]);
  expect(s.extent).toEqual({startRow:0,endRow:4,startColumn:0,endColumn:4});
});
