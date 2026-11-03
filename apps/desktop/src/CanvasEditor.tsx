import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { ProjectSummary } from "./types";
import { projectEntries, projectItemPath } from "./projectTree";
import { useEditorHistory } from "./editorHistory";
import { registerMarkdownEditor, trackMarkdownOperation } from "./markdownPending";
import { importCanvasImage, readCanvasImage } from "./ipc";
import { imageDataUrl, exportCanvas } from "./canvasExport";
import { NodeDrawing, EdgeDrawing, type Target } from "./CanvasScene";
import { freehandNode, alignNodes, bounds, canvasClipboard, canvasId, connector, duplicate, endpoint, fragment, newNode, removeElements, selectionWithGroups, type CanvasContent, type CanvasDocument, type CanvasNode, type CanvasEdge, type Endpoint, type NodeKind, type Point, type Side } from "./canvasModel";
import "./canvas.css";
interface Props { document:CanvasDocument; value:CanvasContent; project:ProjectSummary; active:boolean; disabled:boolean; onChange:(content:CanvasContent)=>void; onOpen:(target:Target)=>void; onError:(e:unknown)=>void; }
interface View extends Point { zoom:number; grid:boolean; snap:boolean; }
type Gesture = {type:"move"|"resize"|"pan"|"select"|"draw"; points?:Point[]; strokeId?:string; start:Point; before:CanvasContent; ids:string[]; view:View; moved:boolean};
const kinds: [NodeKind,string][]=[["rect","Rectángulo"],["rounded","Redondeado"],["ellipse","Elipse"],["diamond","Rombo"],["text","Texto"],["note","Nota"]];
const sides:Side[]=["top","right","bottom","left"];
const sideLabels={top:"Arriba",right:"Derecha",bottom:"Abajo",left:"Izquierda"};
function initialView(key:string):View {try{const v=JSON.parse(localStorage.getItem(key)??"null");if(v&&Number.isFinite(v.x)&&Number.isFinite(v.y)&&v.zoom>=.1&&v.zoom<=4)return {...v,grid:!!v.grid,snap:!!v.snap};}catch{/* Session defaults. */}return {x:40,y:40,zoom:1,grid:true,snap:false};}
export default function CanvasEditor({document:doc,value,project,active,disabled,onChange,onOpen,onError}:Props) {
  const [content,setContent]=useState(value),current=useRef(content);current.current=content;
  const [selection,setSelection]=useState<string[]>([]),[tool,setTool]=useState<NodeKind|"select"|"hand"|"connect">("select");
  const [view,setView]=useState(()=>initialView(`tablune.canvas.${project.persistentId}.${doc.id}`));
  const viewRef=useRef(view);viewRef.current=view;
  const [pen,setPen]=useState({color:"#687786",width:3});
  const [images,setImages]=useState<Record<string,string>>({});
  const [linkPicker,setLinkPicker]=useState(false),[linkQuery,setLinkQuery]=useState("");
  const [inspector,setInspector]=useState(true),[exporting,setExporting]=useState(false),[transparent,setTransparent]=useState(false),[onlySelected,setOnlySelected]=useState(false);
  const [status,setStatus]=useState(""),[marquee,setMarquee]=useState<{a:Point;b:Point}|null>(null);
  const [connection,setConnection]=useState<{from?:Endpoint;edgeId?:string;which?:"from"|"to"}|null>(null);
  const svgRef=useRef<SVGSVGElement>(null),hostRef=useRef<HTMLDivElement>(null),gesture=useRef<Gesture|null>(null),space=useRef(false);
  const undoStack=useRef<CanvasContent[]>([]),redoStack=useRef<CanvasContent[]>([]),textSession=useRef<CanvasContent|null>(null);
  const latest=useRef({onChange,disabled});latest.current={onChange,disabled};
  const targets:Target[]=projectEntries(project).filter(e=>e.kind==="table"||e.kind==="script"||e.kind==="markdown").map(e=>({id:e.id,kind:e.kind as Target["kind"],name:e.name,path:projectItemPath(project,e.id)}));
  const targetNames=JSON.stringify(targets.map(t=>[t.id,t.name]));
  useEffect(()=>{
    const next={...current.current,nodes:current.current.nodes.map(n=>{const t=targets.find(t=>t.id===n.link?.id);return t&&n.link&&t.name!==n.link.name?{...n,link:{...n.link,name:t.name}}:n;})};
    if(next.nodes.some((n,i)=>n!==current.current.nodes[i]))publish(next);
  },[targetNames]);
  const selectedNodes=content.nodes.filter(n=>selection.includes(n.id));
  const node=selection.length===1?selectedNodes[0]:undefined;
  const edge=selection.length===1?content.edges.find(e=>e.id===selection[0]):undefined;
  const target=node?.link?targets.find(t=>t.id===node.link!.id):undefined;
  const scope=`project:${project.projectId}`;
  function publish(next:CanvasContent){current.current=next;setContent(next);latest.current.onChange(next);}
  function remember(before:CanvasContent){undoStack.current.push(before);while(undoStack.current.length>1 && (undoStack.current.length>80 || undoStack.current.reduce((sum,c)=>sum+JSON.stringify(c).length*2,0)>32*1024*1024))undoStack.current.shift();redoStack.current=[];}
  function finishText(){if(textSession.current){if(JSON.stringify(textSession.current)!==JSON.stringify(current.current))remember(textSession.current);textSession.current=null;setContent({...current.current});}}
  function finishGesture(cancel=false){const g=gesture.current;if(!g)return;gesture.current=null;setMarquee(null);if((g.moved&&(g.type==="move"||g.type==="resize"))||g.type==="draw"){if(cancel)publish(g.before);else{remember(g.before);setContent({...current.current});}}}
  function change(next:CanvasContent){if(latest.current.disabled)return;finishText();if(JSON.stringify(next)===JSON.stringify(current.current))return;remember(current.current);publish(next);}
  function undo(){finishGesture();finishText();if(disabled||!undoStack.current.length)return;redoStack.current.push(current.current);publish(undoStack.current.pop()!);setSelection([]);}
  function redo(){finishGesture();finishText();if(disabled||!redoStack.current.length)return;undoStack.current.push(current.current);publish(redoStack.current.pop()!);setSelection([]);}
  const history=useEditorHistory({id:`canvas:${project.projectId}:${doc.id}`,scope,canUndo:undoStack.current.length>0||!!textSession.current||!!gesture.current?.moved,canRedo:redoStack.current.length>0,disabled,undo,redo});
  const flush=useRef(()=>{});flush.current=()=>{finishText();};
  useEffect(()=>registerMarkdownEditor(()=>flush.current(),scope),[scope]);
  useEffect(()=>{try{localStorage.setItem(`tablune.canvas.${project.persistentId}.${doc.id}`,JSON.stringify(view));}catch{/* Preserve session view. */}},[view,project.persistentId,doc.id]);
  useEffect(()=>{if(!active){finishGesture();flush.current();space.current=false;}},[active]);
  useEffect(()=>{let alive=true;const ids=[...new Set(content.nodes.flatMap(n=>n.assetId?[n.assetId]:[]))].filter(id=>!images[id]);
    void Promise.all(ids.map(async id=>[id,await imageDataUrl(await readCanvasImage(project.projectId,id))] as const)).then(entries=>{if(alive&&entries.length)setImages(old=>({...old,...Object.fromEntries(entries)}));}).catch(onError);
    return()=>{alive=false;};
  },[content.nodes,project.projectId,images,onError]);
  const point=(client:Point):Point=>{const r=svgRef.current!.getBoundingClientRect();return {x:(client.x-r.left-viewRef.current.x)/viewRef.current.zoom,y:(client.y-r.top-viewRef.current.y)/viewRef.current.zoom};};
  useEffect(()=>{const svg=svgRef.current;if(!svg)return;const wheel=(event:WheelEvent)=>{event.preventDefault();if(event.ctrlKey||event.metaKey)zoom(viewRef.current.zoom*Math.exp(-event.deltaY*.008),{x:event.clientX,y:event.clientY});else setView(v=>({...v,x:v.x-event.deltaX,y:v.y-event.deltaY}));};svg.addEventListener("wheel",wheel,{passive:false});return()=>svg.removeEventListener("wheel",wheel);},[]);
  const atCenter=()=>{const r=svgRef.current?.getBoundingClientRect();return r?point({x:r.left+r.width/2-90,y:r.top+r.height/2-50}):{x:100,y:100};};
  function add(kind:NodeKind,at=atCenter(),extra:Partial<CanvasNode>={}){const n={...newNode(kind,at),...extra};change({...current.current,nodes:[...current.current.nodes,n]});setSelection([n.id]);setInspector(true);setTool("select");return n;}
  function select(ids:string[]){finishText();setSelection(selectionWithGroups(current.current,ids));setInspector(true);}
  function link(t:Target,at?:Point){if(node?.kind==="card"&&linkPicker){change({...current.current,nodes:current.current.nodes.map(n=>n.id===node.id?{...n,link:{id:t.id,kind:t.kind,name:t.name}}:n)});}else add("card",at,{link:{id:t.id,kind:t.kind,name:t.name}});setLinkPicker(false);}
  function port(end:Endpoint){if(disabled)return;
    if(connection?.edgeId){change({...current.current,edges:current.current.edges.map(e=>e.id===connection.edgeId?{...e,[connection.which!]:end}:e)});setConnection(null);setTool("select");setStatus("");}
    else if(connection?.from){const e:CanvasEdge={id:canvasId(),from:connection.from,to:end,route:"elbow",offset:0,text:"",stroke:"#687786",strokeWidth:2,startArrow:false,endArrow:true};change({...current.current,edges:[...current.current.edges,e]});select([e.id]);setConnection(null);setTool("select");setStatus("");}
    else{setConnection({from:end});setTool("connect");setStatus("Selecciona el punto de destino");}
  }
  function start(event:ReactPointerEvent,kind:Gesture["type"],ids=selection){if(disabled&&kind!=="pan"&&kind!=="select")return;event.preventDefault();event.stopPropagation();svgRef.current?.focus();event.currentTarget.setPointerCapture?.(event.pointerId);gesture.current={type:kind,start:{x:event.clientX,y:event.clientY},before:current.current,ids,view:{...viewRef.current},moved:false};}
  function move(event:ReactPointerEvent){const g=gesture.current;if(!g)return;
    if(g.type==="draw"){
      const p=point({x:event.clientX,y:event.clientY}),pts=g.points!,first=pts[0],last=pts.at(-1)!;
      if(pts.length>=4096 || Math.abs(p.x-first.x)>4900 || Math.abs(p.y-first.y)>4900 || Math.abs(p.x)>999000 || Math.abs(p.y)>999000)return;
      if(Math.hypot(p.x-last.x,p.y-last.y)<1/viewRef.current.zoom)return;
      pts.push(p);g.moved=true;
      publish({...g.before,nodes:[...g.before.nodes,{...freehandNode(pts,g.strokeId),stroke:pen.color,strokeWidth:pen.width}]});return;
    }
const dx=(event.clientX-g.start.x)/g.view.zoom,dy=(event.clientY-g.start.y)/g.view.zoom;g.moved ||= Math.abs(dx)+Math.abs(dy)>2;if(!g.moved)return;
    if(g.type==="pan"){setView({...g.view,x:g.view.x+dx*g.view.zoom,y:g.view.y+dy*g.view.zoom});return;}
    if(g.type==="select"){const a=point(g.start),b=point({x:event.clientX,y:event.clientY});setMarquee({a,b});setSelection(selectionWithGroups(current.current,current.current.nodes.filter(n=>n.x+n.width>=Math.min(a.x,b.x)&&n.x<=Math.max(a.x,b.x)&&n.y+n.height>=Math.min(a.y,b.y)&&n.y<=Math.max(a.y,b.y)).map(n=>n.id)));return;}
    const snap=(n:number)=>viewRef.current.snap?Math.round(n/20)*20:n;
    publish({...g.before,nodes:g.before.nodes.map(n=>!g.ids.includes(n.id)?n:g.type==="resize"?{...n,width:Math.min(10000,Math.max(32,snap(n.width+dx))),height:Math.min(10000,Math.max(32,snap(n.height+dy)))}:{...n,x:Math.max(-1e6,Math.min(1e6,snap(n.x+dx))),y:Math.max(-1e6,Math.min(1e6,snap(n.y+dy)))})});
  }
  function update(patch:Partial<CanvasNode>&Partial<CanvasEdge>,typing=false){if(disabled)return;const next={nodes:current.current.nodes.map(n=>selection.includes(n.id)?{...n,...patch}:n),edges:current.current.edges.map(e=>selection.includes(e.id)?{...e,...patch}:e)};
    if(typing){textSession.current??=current.current;publish(next);}else change(next);
  }
  function copy(){canvasClipboard.project=project.persistentId;canvasClipboard.content=structuredClone(fragment(current.current,selection));setStatus("Selección copiada");}
  function paste(){if(disabled)return;if(canvasClipboard.project!==project.persistentId||!canvasClipboard.content){setStatus("Copia elementos de un lienzo de este proyecto");return;}const c=duplicate(canvasClipboard.content);change({nodes:[...current.current.nodes,...c.nodes],edges:[...current.current.edges,...c.edges]});select(c.nodes.map(n=>n.id));}
  function duplicateSelected(){if(edge){const e={...edge,id:canvasId(),offset:edge.offset+24};change({...current.current,edges:[...current.current.edges,e]});select([e.id]);return;}copy();paste();}
  function remove(){change(removeElements(current.current,selection));setSelection([]);}
  function zoom(scale:number,at?:Point){const r=svgRef.current?.getBoundingClientRect();if(!r)return;const v=viewRef.current,z=Math.max(.1,Math.min(4,scale)),p=at??{x:r.left+r.width/2,y:r.top+r.height/2},world=point(p);setView({...v,zoom:z,x:p.x-r.left-world.x*z,y:p.y-r.top-world.y*z});}
  function fit(){const r=svgRef.current?.getBoundingClientRect();if(!r)return;const b=bounds(current.current),z=Math.max(.1,Math.min(2,(r.width-48)/b.width,(r.height-48)/b.height));setView(v=>({...v,zoom:z,x:(r.width-b.width*z)/2-b.x*z,y:(r.height-b.height*z)/2-b.y*z}));}
  async function importImage(path:string|null,bytes:number[]|null=null,at=atCenter()) {
    await trackMarkdownOperation((async()=>{const assetId=await importCanvasImage(project.projectId,path,bytes);const data=await imageDataUrl(await readCanvasImage(project.projectId,assetId));
      const image=new Image();await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error("Imagen no disponible"));image.src=data;});setImages(old=>({...old,[assetId]:data}));
      // Save may have locked the UI while waiting for this upload; publish its result before flushing.
      const n={...newNode("image",at),assetId,text:path?.split(/[\\/]/).at(-1)??"Imagen",width:Math.max(16,image.width*Math.min(1,400/image.width,400/image.height)),height:Math.max(16,image.height*Math.min(1,400/image.width,400/image.height))};
      remember(current.current);publish({...current.current,nodes:[...current.current.nodes,n]});select([n.id]);
    })(),scope);
  }
  const importFile=()=>void (async()=>{const path=await open({filters:[{name:"Imagen",extensions:["png","jpg","jpeg"]}]});if(typeof path==="string")await importImage(path);})().catch(onError);
  async function doExport(format:"png"|"svg"){setExporting(true);try{flush.current();let c=current.current;if(onlySelected){const ids=new Set(selection);const edges=c.edges.filter(e=>ids.has(e.id));c={nodes:c.nodes.filter(n=>ids.has(n.id)||edges.some(e=>e.from.nodeId===n.id||e.to.nodeId===n.id)),edges:c.edges.filter(e=>ids.has(e.id)||(ids.has(e.from.nodeId)&&ids.has(e.to.nodeId)))};}await exportCanvas(c,project.projectId,doc.name,targets,format,transparent);}catch(e){onError(e);}finally{setExporting(false);}}
  return <section className="canvas-editor" {...history} onKeyDown={event=>{
    const input=event.target instanceof Element&&!!event.target.closest("input,textarea,select");if(input)return;
    const key=event.key.toLowerCase(),mod=event.ctrlKey||event.metaKey;
    if(key==="escape"){finishGesture(true);setConnection(null);setTool("select");setSelection([]);setLinkPicker(false);setStatus("");return;}
    if(key===" "){space.current=true;event.preventDefault();}
    if(mod&&key==="a"){select([...content.nodes,...content.edges].map(n=>n.id));event.preventDefault();}
    if(disabled)return;
    if(mod&&["z","y","c","x","v","d","g"].includes(key)){event.preventDefault();event.stopPropagation();if(key==="z")event.shiftKey?redo():undo();if(key==="y")redo();if(key==="c")copy();if(key==="x"){copy();remove();}if(key==="v")paste();if(key==="d")duplicateSelected();if(key==="g")update({group:event.shiftKey?null:canvasId()});}
    else if(key==="delete"||key==="backspace"){event.preventDefault();remove();}
    else if(["arrowleft","arrowright","arrowup","arrowdown"].includes(key)){event.preventDefault();const step=event.shiftKey?10:1;change({...content,nodes:content.nodes.map(n=>selection.includes(n.id)?{...n,x:n.x+(key==="arrowleft"?-step:key==="arrowright"?step:0),y:n.y+(key==="arrowup"?-step:key==="arrowdown"?step:0)}:n)});}
  }} onKeyUp={e=>{if(e.key===" ")space.current=false;}} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node)){space.current=false;finishGesture();flush.current();}}}>
    <div className="canvas-toolbar" role="toolbar" aria-label="Herramientas del lienzo">
      <button aria-pressed={tool==="select"} onClick={()=>{setTool("select");setConnection(null);setStatus("");}}>↖ Selección</button><button aria-pressed={tool==="hand"} onClick={()=>setTool("hand")}>✋ Mano</button>
      <button disabled={disabled} aria-pressed={tool==="freehand"} onClick={()=>{finishGesture();setTool("freehand");setConnection(null);setSelection([]);setLinkPicker(false);setStatus("Arrastra para dibujar · Escape para volver a selección");}}>✎ Trazo libre</button>
      {tool==="freehand"&&<><label>Color <input aria-label="Color del trazo" type="color" disabled={disabled} value={pen.color} onChange={e=>setPen({...pen,color:e.target.value})}/></label><label>Grosor <input aria-label="Grosor del trazo" type="number" min={.5} max={12} step={.5} disabled={disabled} value={pen.width} onChange={e=>{const width=Number(e.target.value);if(width>=.5&&width<=12)setPen({...pen,width});}} style={{width:65}}/></label></>}
      <select aria-label="Insertar forma" disabled={disabled} value="" onChange={e=>add(e.target.value as NodeKind)}><option value="" disabled>＋ Forma / texto</option>{kinds.map(([kind,label])=><option value={kind} key={kind}>{label}</option>)}</select>
      <button disabled={disabled} aria-pressed={tool==="connect"} onClick={()=>{setTool("connect");setConnection(null);setStatus("Selecciona un punto de origen y otro de destino");}}>↗ Conector</button>
      {!project.standaloneCanvas&&<button disabled={disabled} onClick={()=>{setSelection([]);setLinkPicker(!linkPicker);}}>↗ Vincular</button>}<button disabled={disabled} onClick={importFile}>Imagen…</button>
      <details className="canvas-export"><summary>Exportar</summary><div><label><input type="checkbox" checked={onlySelected} disabled={!selection.length} onChange={e=>setOnlySelected(e.target.checked)}/>Solo selección</label><label><input type="checkbox" checked={transparent} onChange={e=>setTransparent(e.target.checked)}/>Fondo transparente</label><button disabled={exporting||(!selection.length&&onlySelected)} onClick={()=>void doExport("png")}>PNG</button><button disabled={exporting||(!selection.length&&onlySelected)} onClick={()=>void doExport("svg")}>SVG</button></div></details>
    </div>
    <div className="canvas-host" ref={hostRef} onDragOver={e=>{if(!disabled&&(e.dataTransfer.types.includes("application/x-tablune-project-item")||e.dataTransfer.types.includes("Files"))){e.preventDefault();e.dataTransfer.dropEffect="copy";}}} onDrop={e=>{
      e.preventDefault();if(disabled)return;const at=point({x:e.clientX,y:e.clientY});
      const raw=e.dataTransfer.getData("application/x-tablune-project-item");if(raw){try{const item=JSON.parse(raw);const t=targets.find(t=>t.id===item.id);if(item.projectId===project.projectId&&t)link(t,at);}catch{/* Ignore foreign drag. */}return;}
      const file=e.dataTransfer.files[0];if(file){if(file.size>20*1024*1024){onError("La imagen supera 20 MiB");return;}void file.arrayBuffer().then(bytes=>importImage(null,Array.from(new Uint8Array(bytes)),at)).catch(onError);}
    }}>
      <svg ref={svgRef} className={`canvas-surface ${tool==="hand"?"canvas-pan":tool==="freehand"?"canvas-draw":""}`} tabIndex={0} role="application" aria-label={`Lienzo ${doc.name}`} onPointerDownCapture={e=>{
        if(tool!=="freehand"||disabled||space.current||e.button!==0)return;
        e.preventDefault();e.stopPropagation();finishText();svgRef.current?.focus();
        const p=point({x:e.clientX,y:e.clientY});if(Math.abs(p.x)>999000||Math.abs(p.y)>999000)return;
        const id=canvasId(),before=current.current;
        gesture.current={type:"draw",start:{x:e.clientX,y:e.clientY},before,ids:[id],view:{...viewRef.current},moved:false,points:[p],strokeId:id};
        e.currentTarget.setPointerCapture?.(e.pointerId);setSelection([]);
        publish({...before,nodes:[...before.nodes,{...freehandNode([p],id),stroke:pen.color,strokeWidth:pen.width}]});
      }} onPointerDown={e=>{
        if(e.button!==0&&e.button!==1)return;
        if(tool==="hand"||space.current||e.button===1){start(e,"pan");return;}
        if(e.target===e.currentTarget||(e.target as Element).getAttribute("data-background")){select([]);start(e,"select",[]);}
      }} onPointerMove={move} onPointerUp={e=>{if(gesture.current?.type==="draw")move(e);finishGesture();}} onPointerCancel={()=>finishGesture(true)}>
        <defs><pattern id={`grid-${doc.id}`} x={view.x} y={view.y} width={20*view.zoom} height={20*view.zoom} patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".8" className="canvas-grid-dot"/></pattern></defs>
        <rect data-background="true" width="100%" height="100%" fill={view.grid?`url(#grid-${doc.id})`:"transparent"}/>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
          {content.edges.map(e=><g key={e.id} onPointerDown={event=>{if(tool==="hand"||space.current){start(event,"pan");return;}event.stopPropagation();select(event.shiftKey?[...selection,e.id]:[e.id]);svgRef.current?.focus();}}>
            {selection.includes(e.id)&&<path d={connector(content,e).path} className="canvas-selected-edge"/>}<EdgeDrawing content={content} edge={e} idPrefix={doc.id}/><path d={connector(content,e).path} stroke="transparent" fill="none" strokeWidth={14/view.zoom}/>
          </g>)}
          {content.nodes.map(n=><g key={n.id} role="button" aria-label={n.kind==="card"?(targets.find(t=>t.id===n.link?.id)?.name??n.link?.name??"Tarjeta"):n.text||(n.kind==="freehand"?"Trazo libre":n.kind)} tabIndex={0} onKeyDown={e=>{if(e.key==="Enter"){e.stopPropagation();select([n.id]);if(n.kind==="card"){const t=targets.find(t=>t.id===n.link?.id);if(t)onOpen(t);}}}} onDoubleClick={()=>{select([n.id]);if(n.kind==="card"){const t=targets.find(t=>t.id===n.link?.id);if(t)onOpen(t);}else setTimeout(()=>hostRef.current?.querySelector<HTMLTextAreaElement>(".canvas-properties textarea")?.focus(),0);}}
            onPointerDown={e=>{if(tool==="hand"||space.current||e.button===1){start(e,"pan");return;}if(tool==="connect"){e.stopPropagation();port({nodeId:n.id,side:connection?.from?"left":"right"});return;}const ids=e.shiftKey?selection.includes(n.id)?selection.filter(id=>id!==n.id):[...selection,n.id]:selection.includes(n.id)?selection:[n.id];const expanded=selectionWithGroups(content,ids);select(expanded);start(e,"move",expanded);}}>
            <NodeDrawing node={n} images={images} targets={targets}/>
            <rect x={n.x} y={n.y} width={n.width} height={n.height} fill="transparent" stroke={selection.includes(n.id)?"var(--focus)":"none"} strokeWidth={2/view.zoom} strokeDasharray={selection.includes(n.id)?`${5/view.zoom} ${3/view.zoom}`:undefined}/>
            {selection.includes(n.id)&&!disabled&&<rect aria-label="Redimensionar" x={n.x+n.width-5/view.zoom} y={n.y+n.height-5/view.zoom} width={10/view.zoom} height={10/view.zoom} className="canvas-resize" onPointerDown={e=>start(e,"resize",[n.id])}/>}
            {(tool==="connect"||selection.includes(n.id))&&!disabled&&sides.map(side=>{const p=endpoint(content,{nodeId:n.id,side});return <circle key={side} role="button" aria-label={`Conectar ${sideLabels[side]}`} cx={p.x} cy={p.y} r={6/view.zoom} className="canvas-port" onPointerDown={e=>{e.stopPropagation();e.preventDefault();port({nodeId:n.id,side});}}/>;})}
          </g>)}
          {marquee&&<rect x={Math.min(marquee.a.x,marquee.b.x)} y={Math.min(marquee.a.y,marquee.b.y)} width={Math.abs(marquee.a.x-marquee.b.x)} height={Math.abs(marquee.a.y-marquee.b.y)} className="canvas-marquee"/>}
        </g>
      </svg>
      {!content.nodes.length&&tool!=="freehand"&&<div className="canvas-empty"><strong>Un espacio para conectar ideas</strong><span>Agrega una forma o arrastra un documento del explorador.</span><button disabled={disabled} onClick={()=>add("rounded")}>Crear primera forma</button></div>}
      {linkPicker&&<div className="canvas-link-picker" role="dialog" aria-label="Vincular documento"><header><strong>Vincular documento</strong><button onClick={()=>setLinkPicker(false)} aria-label="Cerrar vínculos">×</button></header><input aria-label="Buscar documento" placeholder="Buscar en este proyecto…" value={linkQuery} onChange={e=>setLinkQuery(e.target.value)}/>{targets.filter(t=>`${t.name} ${t.path}`.toLowerCase().includes(linkQuery.toLowerCase())).map(t=><button key={t.id} disabled={disabled} onClick={()=>link(t)}>{t.name}<small>{t.path}</small></button>)}{!targets.length&&<p>Crea una tabla, documento o script para vincularlo.</p>}</div>}
      {!!selection.length&&inspector&&<aside className="canvas-properties" aria-label="Propiedades flotantes"><header><strong>{node?.kind==="freehand"?"Trazo libre":node?.kind==="card"?"Tarjeta vinculada":edge?"Conector":`${selection.length} seleccionado(s)`}</strong><button aria-label="Cerrar propiedades" onClick={()=>setInspector(false)}>×</button></header>
        <fieldset disabled={disabled}>
          {(node?.kind!=="freehand"&&(node||edge))&&<label>{node?.kind==="image"?"Descripción":"Texto"}<textarea aria-label="Texto del elemento" readOnly={node?.kind==="card"} value={node?.kind==="card"?(target?.name??node.link?.name??""):node?.text??edge?.text??""} onFocus={()=>{textSession.current=current.current;}} onChange={e=>update({text:e.target.value},true)} onBlur={finishText}/></label>}
          {node?.kind==="card"&&<div className="canvas-target"><small>{target?target.path:"Documento no disponible"}</small><button disabled={!target} onClick={()=>target&&onOpen(target)}>Abrir documento ↗</button><button onClick={()=>setLinkPicker(true)}>Cambiar vínculo…</button></div>}
          {!!selectedNodes.length&&selectedNodes.some(n=>n.kind!=="freehand")&&<><div className="canvas-prop-row"><label>Relleno<input aria-label="Color de relleno" type="color" value={node?.fill==="transparent"?"#ffffff":node?.fill??"#ffffff"} onChange={e=>update({fill:e.target.value})}/></label><label>Texto<input aria-label="Color del texto" type="color" value={node?.color??"#243343"} onChange={e=>update({color:e.target.value})}/></label></div><button onClick={()=>update({fill:"transparent"})}>Sin relleno</button><div className="canvas-prop-row"><label>Tamaño<input type="number" min={8} max={96} value={node?.fontSize??16} onChange={e=>{const n=Number(e.target.value);if(n>=8&&n<=96)update({fontSize:n});}}/></label><label>Alineación<select value={node?.align??"center"} onChange={e=>update({align:e.target.value as CanvasNode["align"]})}><option value="left">Izquierda</option><option value="center">Centro</option><option value="right">Derecha</option></select></label></div></>}
          <div className="canvas-prop-row"><label>Borde<input aria-label="Color del borde" type="color" value={node?.stroke??edge?.stroke??"#687786"} onChange={e=>update({stroke:e.target.value})}/></label><label>Grosor<input type="number" min={0} max={12} step={.5} value={node?.strokeWidth??edge?.strokeWidth??1.5} onChange={e=>{const n=Number(e.target.value);if(n>=0&&n<=12)update({strokeWidth:n});}}/></label></div>
          {edge&&<><label>Recorrido<select value={edge.route} onChange={e=>update({route:e.target.value as CanvasEdge["route"]})}><option value="straight">Recto</option><option value="elbow">En ángulo</option></select></label>{edge.route==="elbow"&&<label>Desplazamiento del recorrido<input type="number" value={edge.offset} min={-1000000} max={1000000} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n)&&Math.abs(n)<=1e6)update({offset:n});}}/></label>}<label><input type="checkbox" checked={edge.startArrow} onChange={e=>update({startArrow:e.target.checked})}/>Flecha al inicio</label><label><input type="checkbox" checked={edge.endArrow} onChange={e=>update({endArrow:e.target.checked})}/>Flecha al final</label>{(["from","to"] as const).map(which=><div key={which} className="canvas-prop-row"><button onClick={()=>{setConnection({edgeId:edge.id,which});setTool("connect");setInspector(false);setStatus("Selecciona el nuevo punto de conexión");}}>Reconectar {which==="from"?"origen":"destino"}</button><select aria-label={`Lado ${which}`} value={edge[which].side} onChange={e=>update({[which]:{...edge[which],side:e.target.value as Side}})}>{sides.map(s=><option value={s} key={s}>{sideLabels[s]}</option>)}</select></div>)}</>}
          {selectedNodes.length>1&&<><div className="canvas-prop-row"><button onClick={()=>update({group:canvasId()})}>Agrupar</button><button onClick={()=>update({group:null})}>Desagrupar</button></div><select aria-label="Alinear o distribuir" value="" onChange={e=>change(alignNodes(content,selection,e.target.value as Parameters<typeof alignNodes>[2]))}><option disabled value="">Alinear / distribuir…</option><option value="left">Izquierda</option><option value="center">Centro horizontal</option><option value="top">Arriba</option><option value="middle">Centro vertical</option><option value="horizontal">Distribuir horizontalmente</option><option value="vertical">Distribuir verticalmente</option></select></>}
          {!!selectedNodes.length&&<div className="canvas-prop-row"><button onClick={()=>change({...content,nodes:[...content.nodes.filter(n=>!selection.includes(n.id)),...selectedNodes]})}>Al frente</button><button onClick={()=>change({...content,nodes:[...selectedNodes,...content.nodes.filter(n=>!selection.includes(n.id))]})}>Al fondo</button></div>}
          <div className="canvas-prop-row"><button onClick={copy}>Copiar</button><button onClick={duplicateSelected}>Duplicar</button><button onClick={remove}>Eliminar</button></div>
        </fieldset>
      </aside>}
      {!!selection.length&&!inspector&&<button className="canvas-show-props" onClick={()=>setInspector(true)}>Propiedades</button>}
    </div>
    <footer className="canvas-footer"><span role="status">{connection?status||"Selecciona un punto de conexión":status||`${content.nodes.length} objetos · ${content.edges.length} conexiones`}</span><label><input type="checkbox" checked={view.grid} onChange={e=>setView({...view,grid:e.target.checked})}/>Cuadrícula</label><label><input type="checkbox" checked={view.snap} onChange={e=>setView({...view,snap:e.target.checked})}/>Ajustar</label><button onClick={()=>zoom(view.zoom/1.2)} aria-label="Alejar">−</button><button onClick={()=>zoom(1)}>{Math.round(view.zoom*100)}%</button><button onClick={()=>zoom(view.zoom*1.2)} aria-label="Acercar">＋</button><button onClick={fit}>Ver todo</button></footer>
  </section>;
}
