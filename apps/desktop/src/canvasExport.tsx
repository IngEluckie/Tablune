import { renderToStaticMarkup } from "react-dom/server";
import { save } from "@tauri-apps/plugin-dialog";
import { readCanvasImage, writeCanvasExport } from "./ipc";
import { bounds, type CanvasContent } from "./canvasModel";
import { EdgeDrawing, NodeDrawing, type Target } from "./CanvasScene";
export function imageDataUrl(bytes: ArrayBuffer): Promise<string> {
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error("No se pudo leer la imagen"));const b=new Uint8Array(bytes);reader.readAsDataURL(new Blob([bytes],{type:b[0]===137?"image/png":"image/jpeg"}));});
}
export async function canvasSvg(content:CanvasContent,projectId:number,targets:Target[],transparent:boolean) {
  const images:Record<string,string>={};
  await Promise.all([...new Set(content.nodes.flatMap(n=>n.assetId?[n.assetId]:[]))].map(async id=>{images[id]=await imageDataUrl(await readCanvasImage(projectId,id));}));
  const box=bounds(content);
  return {box,svg:renderToStaticMarkup(<svg xmlns="http://www.w3.org/2000/svg" width={box.width} height={box.height} viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}>
    {!transparent&&<rect x={box.x} y={box.y} width={box.width} height={box.height} fill="#ffffff"/>}
    {content.edges.map(e=><EdgeDrawing key={e.id} content={content} edge={e} idPrefix="export"/>)}
    {content.nodes.map(n=><NodeDrawing key={n.id} node={n} images={images} targets={targets}/>)}</svg>)};
}
export async function exportCanvas(content:CanvasContent,projectId:number,name:string,targets:Target[],format:"svg"|"png",transparent:boolean) {
  let path=await save({defaultPath:`${name}.${format}`,filters:[{name:format.toUpperCase(),extensions:[format]}]});if(!path)return;
  if(!path.toLowerCase().endsWith(`.${format}`))path+=`.${format}`;
  const {svg,box}=await canvasSvg(content,projectId,targets,transparent);
  let bytes:Uint8Array;
  if(format==="svg")bytes=new TextEncoder().encode(svg);
  else {
    if(box.width>16384||box.height>16384||box.width*box.height>25_000_000)throw new Error("El PNG supera 25 megapíxeles. Exporta una selección o usa SVG.");
    const url=URL.createObjectURL(new Blob([svg],{type:"image/svg+xml"}));
    try {const img=new Image();await new Promise<void>((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(new Error("No se pudo renderizar el PNG"));img.src=url;});
      const canvas=document.createElement("canvas");canvas.width=Math.ceil(box.width);canvas.height=Math.ceil(box.height);const ctx=canvas.getContext("2d");if(!ctx)throw new Error("PNG no disponible");ctx.drawImage(img,0,0);
      const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error("No se pudo crear el PNG")),"image/png"));bytes=new Uint8Array(await blob.arrayBuffer());
    }finally{URL.revokeObjectURL(url);}
  }
  await writeCanvasExport(path,Array.from(bytes));
}
