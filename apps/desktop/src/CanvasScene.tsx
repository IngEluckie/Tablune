import type { CanvasContent, CanvasNode, CanvasLink } from "./canvasModel";
import { connector, freehandPath } from "./canvasModel";
export interface Target extends CanvasLink { path: string; }
export function textLines(text: string, width: number, fontSize: number) {
  const limit=Math.max(1,Math.floor(width/(fontSize*.6))),lines:string[]=[];
  for(const paragraph of text.split("\n")) {
    if(!paragraph){lines.push("");continue;}
    let line="";
    for(const word of paragraph.split(/\s+/)) {
      if(line&&line.length+word.length+1>limit){lines.push(line);line="";}
      let rest=word;
      while(rest.length>limit){if(line){lines.push(line);line="";}lines.push(rest.slice(0,limit));rest=rest.slice(limit);}
      if(rest)line+=(line?" ":"")+rest;
    }
    if(line)lines.push(line);
  }
  return lines;
}
export function NodeDrawing({node:n,images,targets}:{node:CanvasNode;images:Record<string,string>;targets:Target[]}) {
  if(n.kind==="freehand")return <g transform={`translate(${n.x} ${n.y})`}><path d={freehandPath(n)} fill="none" stroke={n.stroke} strokeWidth={n.strokeWidth} strokeLinecap="round" strokeLinejoin="round"/></g>;
  const shape={fill:n.fill,stroke:n.stroke,strokeWidth:n.strokeWidth};
  const target=n.link?targets.find(t=>t.id===n.link!.id):undefined;
  const text=n.kind==="card"?(target?.name??n.link?.name??n.text):n.text;
  const contentWidth=n.width-(n.kind==="diamond"?n.width*.45:24);
  const lines=textLines(text,contentWidth,n.fontSize),limit=Math.max(1,Math.floor((n.height-(n.kind==="card"?54:20))/(n.fontSize*1.25)));
  const visible=lines.slice(0,limit);if(lines.length>limit)visible[visible.length-1]=visible.at(-1)!.slice(0,-1)+"…";
  const lineHeight=n.fontSize*1.25;
  const x=n.align==="left"?12:n.align==="right"?n.width-12:n.width/2;
  const y=n.kind==="card"?45:(n.height-visible.length*lineHeight)/2+n.fontSize;
  return <g transform={`translate(${n.x} ${n.y})`}>
    {n.kind==="ellipse"?<ellipse cx={n.width/2} cy={n.height/2} rx={n.width/2} ry={n.height/2} {...shape}/>:
      n.kind==="diamond"?<polygon points={`${n.width/2},0 ${n.width},${n.height/2} ${n.width/2},${n.height} 0,${n.height/2}`} {...shape}/>:
      <rect width={n.width} height={n.height} rx={n.kind==="rounded"||n.kind==="card"?10:0} {...shape}/>}
    {n.kind==="image" && (images[n.assetId??""]?<image href={images[n.assetId!]} width={n.width} height={n.height} preserveAspectRatio="xMidYMid meet"/>:<text x="12" y="24" fill={n.color} fontSize="12">Cargando imagen…</text>)}
    {n.kind!=="image"&&<>
      {n.kind==="card"&&<text x="12" y="20" fontSize="11" fill={n.color}>{target?({table:"▤ Tabla vinculada",markdown:"▧ Markdown vinculado",script:"⌘ Script vinculado"}[target.kind]):"⚠ Documento no disponible"}</text>}
      <text x={x} y={y} fill={n.color} fontFamily="sans-serif" fontSize={n.fontSize} textAnchor={n.align==="left"?"start":n.align==="right"?"end":"middle"}>
        {visible.map((line,i)=><tspan x={x} dy={i?lineHeight:0} key={i}>{line}</tspan>)}
      </text>
      {n.kind==="card"&&<text x="12" y={n.height-12} fontSize="10" fill={n.color}>{textLines(target?.path??"Elige otro documento",n.width-24,10)[0]}</text>}
    </>}
  </g>;
}
export function EdgeDrawing({content,edge,idPrefix}:{content:CanvasContent;edge:CanvasContent["edges"][number];idPrefix:string}) {
  const g=connector(content,edge),id=`${idPrefix}-${edge.id}`;
  return <g><defs><marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill={edge.stroke}/></marker></defs>
    <path d={g.path} fill="none" stroke={edge.stroke} strokeWidth={edge.strokeWidth} markerStart={edge.startArrow?`url(#${id})`:undefined} markerEnd={edge.endArrow?`url(#${id})`:undefined}/>
    {edge.text&&<text x={g.label.x} y={g.label.y-8} fill={edge.stroke} fontSize="14" fontFamily="sans-serif" textAnchor="middle">{edge.text}</text>}
  </g>;
}
