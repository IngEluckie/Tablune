// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CanvasEditor from "./CanvasEditor";
import { emptyCanvas, newNode, type CanvasContent } from "./canvasModel";
import { flushMarkdownEditors } from "./markdownPending";
import type { ProjectSummary } from "./types";
vi.mock("@tauri-apps/plugin-dialog",()=>({open:vi.fn(),save:vi.fn()}));
vi.mock("./ipc",()=>({importCanvasImage:vi.fn(),readCanvasImage:vi.fn(),writeCanvasExport:vi.fn()}));
const p:ProjectSummary={projectId:1,persistentId:"p",name:"Proyecto",revision:"0",dirty:false,path:null,tables:[],scripts:[{id:"script",name:"limpiar.py",code:"",revision:0,inputTableId:null}]};
beforeEach(()=>{localStorage.clear();});afterEach(cleanup);
function mount(content=emptyCanvas()) {const onChange=vi.fn(),onOpen=vi.fn();const props={document:{id:"canvas",name:"Mapa",content,revision:0},value:content,project:p,active:true,disabled:false,onChange,onOpen,onError:vi.fn()};return {...render(<CanvasEditor {...props}/>),props,onChange,onOpen};}
it("creates editable shapes and keeps text undoable when a save flushes the active editor",async()=>{const {onChange}=mount();fireEvent.click(screen.getByText("Crear primera forma"));const text=screen.getByLabelText("Texto del elemento");fireEvent.focus(text);fireEvent.change(text,{target:{value:"Proceso final"}});await act(async()=>{await flushMarkdownEditors("project:1");});expect(onChange.mock.lastCall![0].nodes[0].text).toBe("Proceso final");fireEvent.keyDown(screen.getByRole("application"),{key:"z",ctrlKey:true});expect(onChange.mock.lastCall![0].nodes[0].text).toBe("Proceso");});
it("opens linked scripts without invoking execution and displays unavailable targets",()=>{const node={...newNode("card",{x:10,y:20}),link:{id:"script",kind:"script" as const,name:"old.py"}};const {onOpen,rerender,props}=mount({nodes:[node],edges:[]});fireEvent.doubleClick(screen.getByRole("button",{name:"limpiar.py"}));expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({id:"script",kind:"script"}));rerender(<CanvasEditor {...props} project={{...p,scripts:[]}}/>);expect(screen.getAllByText("Documento no disponible").length).toBeGreaterThan(0);});
it("creates anchored connectors and removes their shapes in one undoable edit",()=>{const a={...newNode("rect",{x:0,y:0}),id:"a",text:"Origen"},b={...newNode("rect",{x:400,y:0}),id:"b",text:"Destino"};const {onChange}=mount({nodes:[a,b],edges:[]});fireEvent.click(screen.getByText("↗ Conector"));fireEvent.pointerDown(screen.getByRole("button",{name:"Origen"}));fireEvent.pointerDown(screen.getByRole("button",{name:"Destino"}));expect(onChange.mock.lastCall![0].edges).toHaveLength(1);fireEvent.pointerDown(screen.getByRole("button",{name:"Origen"}));fireEvent.keyDown(screen.getByRole("application"),{key:"Delete"});expect(onChange.mock.lastCall![0].edges).toHaveLength(0);fireEvent.keyDown(screen.getByRole("application"),{key:"z",ctrlKey:true});expect(onChange.mock.lastCall![0].edges).toHaveLength(1);});
it("copies cards within the project without duplicating their documents",()=>{const n={...newNode("card",{x:0,y:0}),link:{id:"script",kind:"script" as const,name:"limpiar.py"}};const {onChange}=mount({nodes:[n],edges:[]});fireEvent.pointerDown(screen.getByRole("button",{name:"limpiar.py"}));fireEvent.click(screen.getByText("Duplicar"));const c=onChange.mock.lastCall![0] as CanvasContent;expect(c.nodes).toHaveLength(2);expect(c.nodes[0].link).toEqual(c.nodes[1].link);expect(c.nodes[0].id).not.toBe(c.nodes[1].id);});
it("draws multiple strokes over shapes, saves their geometry and undoes a complete stroke",()=>{
  const old=window.PointerEvent;window.PointerEvent=MouseEvent as typeof PointerEvent;
  try {
    const existing={...newNode("rect",{x:0,y:0}),text:"Existente"};
    const {onChange}=mount({nodes:[existing],edges:[]});
    fireEvent.click(screen.getByRole("button",{name:"✎ Trazo libre"}));
    fireEvent.change(screen.getByLabelText("Color del trazo"),{target:{value:"#ff0000"}});
    const surface=screen.getByRole("application");
    fireEvent.pointerDown(screen.getByRole("button",{name:"Existente"}),{button:0,clientX:80,clientY:90,pointerId:1});
    fireEvent.pointerMove(surface,{clientX:110,clientY:120,pointerId:1});
    fireEvent.pointerMove(surface,{clientX:150,clientY:100,pointerId:1});
    fireEvent.pointerUp(surface,{clientX:150,clientY:100,pointerId:1});
    const c=onChange.mock.lastCall![0] as CanvasContent;
    expect(c.nodes).toHaveLength(2);expect(c.nodes[1].kind).toBe("freehand");expect(c.nodes[1].points).toHaveLength(3);expect(c.nodes[1].stroke).toBe("#ff0000");expect(c.nodes[0]).toEqual(existing);
    fireEvent.keyDown(surface,{key:"z",ctrlKey:true});expect(onChange.mock.lastCall![0].nodes).toEqual([existing]);
    fireEvent.keyDown(surface,{key:"z",ctrlKey:true,shiftKey:true});expect(onChange.mock.lastCall![0].nodes[1].points).toEqual(c.nodes[1].points);
    fireEvent.pointerDown(surface,{button:0,clientX:80,clientY:90,pointerId:2});
    fireEvent.pointerMove(surface,{clientX:110,clientY:120,pointerId:2});
    fireEvent.keyDown(surface,{key:"Escape"});expect(onChange.mock.lastCall![0].nodes).toHaveLength(2);
  }finally{window.PointerEvent=old;}
});
it("exports a freehand stroke as a vector path without a filled shape",async()=>{
  const {freehandNode}=await import("./canvasModel");const {canvasSvg}=await import("./canvasExport");
  const n=freehandNode([{x:10,y:20},{x:40,y:60}]);
  const result=await canvasSvg({nodes:[n],edges:[]},1,[],true);
  expect(result.svg).toContain('stroke-linecap="round"');expect(result.svg).toContain('fill="none"');expect(result.svg).not.toContain('<rect');
});
