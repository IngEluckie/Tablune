export type NodeKind = "rect" | "rounded" | "ellipse" | "diamond" | "text" | "note" | "image" | "card" | "freehand";
export type Side = "top" | "right" | "bottom" | "left";
export interface Point { x: number; y: number; }
export interface CanvasLink { id: string; kind: "table" | "markdown" | "script"; name: string; }
export interface CanvasNode extends Point {
  id: string; kind: NodeKind; width: number; height: number; text: string;
  fill: string; stroke: string; strokeWidth: number; color: string; fontSize: number;
  points?: Point[];
  align: "left" | "center" | "right"; group?: string | null; assetId?: string; link?: CanvasLink;
}
export interface Endpoint { nodeId: string; side: Side; }
export interface CanvasEdge {
  id: string; from: Endpoint; to: Endpoint; route: "straight" | "elbow"; offset: number;
  text: string; stroke: string; strokeWidth: number; startArrow: boolean; endArrow: boolean;
}
export interface CanvasContent { nodes: CanvasNode[]; edges: CanvasEdge[]; }
export interface CanvasDocument { id: string; name: string; revision: number; content: CanvasContent; }
export const canvasId = () => crypto.randomUUID();
export const emptyCanvas = (): CanvasContent => ({ nodes: [], edges: [] });
export function newNode(kind: NodeKind, at: Point): CanvasNode {
  return { id: canvasId(), kind, ...at, width: kind === "card" ? 230 : 180, height: kind === "text" ? 60 : 100,
    text: kind === "note" ? "Una idea…" : kind === "text" ? "Texto" : kind === "card" || kind === "image" ? "" : "Proceso",
    fill: kind === "text" ? "transparent" : kind === "note" ? "#fff0b3" : "#ffffff", stroke: "#687786", strokeWidth: kind === "text" ? 0 : 1.5,
    color: "#243343", fontSize: 16, align: kind === "note" || kind === "text" ? "left" : "center" };
}
export function endpoint(content: CanvasContent, end: Endpoint): Point {
  const n = content.nodes.find(n => n.id === end.nodeId);
  if (!n) return { x: 0, y: 0 };
  return { x: n.x + (end.side === "left" ? 0 : end.side === "right" ? n.width : n.width/2),
    y: n.y + (end.side === "top" ? 0 : end.side === "bottom" ? n.height : n.height/2) };
}
export function connector(content: CanvasContent, e: CanvasEdge) {
  const a=endpoint(content,e.from), b=endpoint(content,e.to);
  const horizontal=e.from.side==="left"||e.from.side==="right";
  const middle=horizontal?{x:(a.x+b.x)/2+e.offset,y:(a.y+b.y)/2}:{x:(a.x+b.x)/2,y:(a.y+b.y)/2+e.offset};
  const points=e.route==="straight"?[a,b]:horizontal?[a,{x:middle.x,y:a.y},{x:middle.x,y:b.y},b]:[a,{x:a.x,y:middle.y},{x:b.x,y:middle.y},b];
  return { path: points.map((p,i)=>`${i?"L":"M"}${p.x},${p.y}`).join(" "), label:e.route==="straight"?{x:(a.x+b.x)/2,y:(a.y+b.y)/2}:middle, points };
}
export function selectionWithGroups(c: CanvasContent, ids: string[]) {
  const groups=new Set(c.nodes.filter(n=>ids.includes(n.id)&&n.group).map(n=>n.group));
  return [...new Set([...ids,...c.nodes.filter(n=>n.group&&groups.has(n.group)).map(n=>n.id)])];
}
export function removeElements(c: CanvasContent, ids: string[]): CanvasContent {
  const selected=new Set(selectionWithGroups(c,ids));
  return { nodes:c.nodes.filter(n=>!selected.has(n.id)),edges:c.edges.filter(e=>!selected.has(e.id)&&!selected.has(e.from.nodeId)&&!selected.has(e.to.nodeId)) };
}
export function fragment(c: CanvasContent, ids: string[]): CanvasContent {
  const explicitEdges=c.edges.filter(e=>ids.includes(e.id));
  const selected=new Set(selectionWithGroups(c,[...ids,...explicitEdges.flatMap(e=>[e.from.nodeId,e.to.nodeId])]));
  return {nodes:c.nodes.filter(n=>selected.has(n.id)),edges:c.edges.filter(e=>selected.has(e.from.nodeId)&&selected.has(e.to.nodeId))};
}
export function duplicate(c: CanvasContent, delta=24): CanvasContent {
  const ids=new Map(c.nodes.map(n=>[n.id,canvasId()]));const groups=new Map<string,string>();
  return {nodes:c.nodes.map(n=>{if(n.group&&!groups.has(n.group))groups.set(n.group,canvasId());return {...n,id:ids.get(n.id)!,x:n.x+delta,y:n.y+delta,group:n.group?groups.get(n.group):null};}),
    edges:c.edges.map(e=>({...e,id:canvasId(),from:{...e.from,nodeId:ids.get(e.from.nodeId)!},to:{...e.to,nodeId:ids.get(e.to.nodeId)!}}))};
}
export function bounds(c: CanvasContent) {
  const points=c.nodes.flatMap(n=>[{x:n.x,y:n.y},{x:n.x+n.width,y:n.y+n.height}]);
  for(const e of c.edges){const g=connector(c,e);points.push(...g.points,{x:g.label.x-e.text.length*4.5-8,y:g.label.y-24},{x:g.label.x+e.text.length*4.5+8,y:g.label.y+12});}
  if(!points.length)return {x:0,y:0,width:600,height:400};
  const x=Math.min(...points.map(p=>p.x))-24,y=Math.min(...points.map(p=>p.y))-24;
  return {x,y,width:Math.max(...points.map(p=>p.x))-x+24,height:Math.max(...points.map(p=>p.y))-y+24};
}
export function alignNodes(c: CanvasContent, ids: string[], mode: "left"|"center"|"top"|"middle"|"horizontal"|"vertical"): CanvasContent {
  const nodes=c.nodes.filter(n=>ids.includes(n.id));if(nodes.length<2)return c;
  const minX=Math.min(...nodes.map(n=>n.x)),maxX=Math.max(...nodes.map(n=>n.x+n.width));
  const minY=Math.min(...nodes.map(n=>n.y)),maxY=Math.max(...nodes.map(n=>n.y+n.height));
  const horizontal=mode==="horizontal";const ordered=[...nodes].sort((a,b)=>horizontal?a.x-b.x:a.y-b.y);
  const gap=((horizontal?maxX-minX:maxY-minY)-nodes.reduce((s,n)=>s+(horizontal?n.width:n.height),0))/(nodes.length-1);
  let cursor=horizontal?minX:minY;const positions=new Map<string,number>();ordered.forEach(n=>{positions.set(n.id,cursor);cursor+=(horizontal?n.width:n.height)+gap;});
  return {...c,nodes:c.nodes.map(n=>!ids.includes(n.id)?n:{...n,
    x:mode==="left"?minX:mode==="center"?(minX+maxX-n.width)/2:mode==="horizontal"?positions.get(n.id)!:n.x,
    y:mode==="top"?minY:mode==="middle"?(minY+maxY-n.height)/2:mode==="vertical"?positions.get(n.id)!:n.y})};
}
export const canvasClipboard: { project?: string; content?: CanvasContent } = {};

/** Store stroke points relative to the bounds so moving/resizing remains a regular node edit. */
export function freehandNode(points: Point[], id: string=canvasId()): CanvasNode {
  const x=Math.min(...points.map(p=>p.x))-8,y=Math.min(...points.map(p=>p.y))-8;
  const width=Math.max(16,Math.max(...points.map(p=>p.x))-x+8),height=Math.max(16,Math.max(...points.map(p=>p.y))-y+8);
  return {...newNode("freehand",{x,y}),id,width,height,text:"",fill:"transparent",stroke:"#243343",strokeWidth:3,
    points:points.map(p=>({x:(p.x-x)/width,y:(p.y-y)/height}))};
}
export function freehandPath(n: CanvasNode): string {
  const points=(n.points??[]).map(p=>({x:p.x*n.width,y:p.y*n.height}));
  if(!points.length)return "";
  if(points.length===1)return `M${points[0].x},${points[0].y} l0.01,0`;
  return points.map((p,i)=>`${i?"L":"M"}${p.x},${p.y}`).join(" ");
}
