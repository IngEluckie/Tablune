// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import * as ipc from "./ipc";
import { save } from "@tauri-apps/plugin-dialog";
import type { ProjectSummary } from "./types";
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn().mockResolvedValue(()=>{})}));
vi.mock("@tauri-apps/api/window",()=>({getCurrentWindow:()=>({onCloseRequested:vi.fn().mockResolvedValue(()=>{})})}));
vi.mock("@tauri-apps/plugin-dialog",()=>({ask:vi.fn(),open:vi.fn(),save:vi.fn()}));
vi.mock("./ipc");
vi.mock("./CsvWorkspace",()=>({default:()=>null}));
let canvas:ProjectSummary;
beforeEach(()=>{vi.clearAllMocks(); vi.mocked(ipc.getPythonJobs).mockResolvedValue([]);localStorage.clear();canvas={projectId:9,persistentId:"standalone",standaloneCanvas:true,name:"Untitled canvas",path:null,dirty:true,revision:"0",tables:[],scripts:[],canvases:[{id:"canvas",name:"Untitled canvas",revision:0,content:{nodes:[],edges:[]}}]};vi.mocked(ipc.getWorkspaceSummary).mockResolvedValue({documents:[],projects:[]});vi.mocked(ipc.getRecentFiles).mockResolvedValue([]);vi.mocked(ipc.recoveryAvailable).mockResolvedValue(false);vi.mocked(ipc.newStandaloneCanvas).mockResolvedValue(canvas);vi.mocked(ipc.saveProject).mockImplementation(async(_,path)=>({...canvas,path,dirty:false}));});
afterEach(cleanup);
it("creates an independent canvas from Home and saves it with its own extension",async()=>{render(<App/>);const button=await screen.findByRole("button",{name:/New canvas/});await waitFor(()=>expect(button.hasAttribute("disabled")).toBe(false));fireEvent.click(button);expect(await screen.findByRole("application",{name:"Lienzo Untitled canvas"})).toBeTruthy();expect(screen.queryByLabelText("Elementos del proyecto")).toBeNull();expect(screen.queryByText("↗ Vincular")).toBeNull();vi.mocked(save).mockResolvedValue("/tmp/idea");fireEvent.keyDown(window,{key:"s",ctrlKey:true});await waitFor(()=>expect(ipc.saveProject).toHaveBeenCalledWith(9,"/tmp/idea.tlcanvas"));expect(save).toHaveBeenCalledWith(expect.objectContaining({filters:[{name:"Tablune canvas",extensions:["tlcanvas"]}]}));});
it("routes standalone canvas files through the canvas workspace",async()=>{vi.mocked(ipc.getRecentFiles).mockResolvedValue([{path:"/tmp/idea.tlcanvas",kind:"canvas"}]);vi.mocked(ipc.openProject).mockResolvedValue({...canvas,path:"/tmp/idea.tlcanvas",dirty:false});render(<App/>);fireEvent.click(await screen.findByText("idea.tlcanvas",{exact:true}));expect(await screen.findByRole("application",{name:"Lienzo Untitled canvas"})).toBeTruthy();expect(ipc.openSession).not.toHaveBeenCalled();});
