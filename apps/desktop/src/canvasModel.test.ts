import { expect, it } from "vitest";
import { alignNodes, bounds, connector, duplicate, fragment, newNode, removeElements, type CanvasContent } from "./canvasModel";
const fixture=():CanvasContent=>{const a={...newNode("rect",{x:0,y:0}),id:"a",group:"g"},b={...newNode("card",{x:400,y:200}),id:"b",group:"g",link:{id:"doc",kind:"markdown" as const,name:"Notes"}};
  return {nodes:[a,b],edges:[{id:"e",from:{nodeId:"a",side:"right"},to:{nodeId:"b",side:"left"},route:"elbow",offset:30,text:"Next",stroke:"#000000",strokeWidth:2,startArrow:false,endArrow:true}]};};
it("moves connector anchors with geometry while respecting manually adjusted routes",()=>{const c=fixture(),e=c.edges[0];expect(connector(c,e).points[0]).toEqual({x:180,y:50});c.nodes[0].x=50;expect(connector(c,e).points[0]).toEqual({x:230,y:50});expect(connector(c,e).label.x).toBe(345);});
it("deletes a group and its incident connectors atomically without mutating its snapshot",()=>{const c=fixture();expect(removeElements(c,["a"])).toEqual({nodes:[],edges:[]});expect(c.nodes).toHaveLength(2);});
it("duplicates selected groups with new IDs, internal edges, and the same document references",()=>{const c=fixture(),copy=duplicate(fragment(c,["a"]));expect(copy.nodes).toHaveLength(2);expect(copy.nodes[0].group).not.toBe("g");expect(copy.nodes[0].group).toBe(copy.nodes[1].group);expect(copy.edges[0].from.nodeId).toBe(copy.nodes[0].id);expect(copy.nodes[1].link).toEqual(c.nodes[1].link);});
it("distributes unequal widths using equal gaps and preserves outside objects",()=>{const c=fixture();c.nodes.push({...newNode("rect",{x:200,y:400}),id:"c",width:60});const aligned=alignNodes(c,["a","b","c"],"horizontal");const sorted=[...aligned.nodes].sort((a,b)=>a.x-b.x);expect(sorted[1].x-sorted[0].x-sorted[0].width).toBe(sorted[2].x-sorted[1].x-sorted[1].width);});
it("includes detours in export bounds",()=>{const c=fixture();c.edges[0].offset=1000;expect(bounds(c).width).toBeGreaterThan(1000);});
it("keeps original nodes when deleting only a connector",()=>{const c=fixture();expect(removeElements(c,["e"]).nodes).toEqual(c.nodes);expect(removeElements(c,["e"]).edges).toEqual([]);});
it("copies connector endpoints so pasted fragments never contain dangling edges",()=>{const c=fixture(),copy=duplicate(fragment(c,["e"]));expect(copy.nodes).toHaveLength(2);expect(copy.nodes.some(n=>n.id===copy.edges[0].to.nodeId)).toBe(true);});
it("keeps freehand paths relative to their bounds through duplication and resizing",async()=>{
  const {freehandNode,freehandPath}=await import("./canvasModel");
  const n=freehandNode([{x:10,y:20},{x:50,y:80}],"stroke");
  expect(n.points!.every(p=>p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1)).toBe(true);
  const c=duplicate({nodes:[n],edges:[]});expect(c.nodes[0].points).toEqual(n.points);
  expect(freehandPath({...n,width:n.width*2})).not.toBe(freehandPath(n));
});
