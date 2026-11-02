// @vitest-environment jsdom
import {afterEach,expect,it,vi} from "vitest";
import {clipboardHasMarker,writeMarkedClipboard} from "./clipboardMarker";
afterEach(()=>vi.unstubAllGlobals());
it("preserves an internal clipboard identity and rejects externally replaced identical text",async()=>{
  let items: {types:string[];getType:(type:string)=>Promise<Blob>}[]=[];
  vi.stubGlobal("ClipboardItem",class { types:string[]; constructor(private data:Record<string,Blob>){this.types=Object.keys(data);} getType(type:string){return Promise.resolve(this.data[type]);} });
  vi.stubGlobal("Blob",class { constructor(private parts: string[]) {} text(){return Promise.resolve(this.parts.join(""));} });
  vi.stubGlobal("navigator",{clipboard:{write:vi.fn(async value=>{items=value;}),read:vi.fn(async()=>items)}});
  const token=await writeMarkedClipboard("<tag>\t42");expect(token).not.toBeNull();expect(await clipboardHasMarker(token)).toBe(true);
  expect(await (await items[0].getType("text/plain")).text()).toBe("<tag>\t42");
  expect(await (await items[0].getType("text/html")).text()).toContain("&lt;tag&gt;");
  items=[];expect(await clipboardHasMarker(token)).toBe(false);
});
it("falls back safely when rich clipboard access is unavailable",async()=>{
  vi.stubGlobal("navigator",{clipboard:{}});expect(await writeMarkedClipboard("42")).toBeNull();expect(await clipboardHasMarker("token")).toBe(false);
});
