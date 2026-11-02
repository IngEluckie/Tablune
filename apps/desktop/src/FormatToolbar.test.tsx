// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import FormatToolbar from "./FormatToolbar";
import type { StyleSummary } from "./types";
afterEach(cleanup);
const summary: StyleSummary = { bold:false, italic:false, underline:false, textColor:"", background:"", alignment:"left" };
it("applies individual properties and resolves mixed bold to enabled", () => {
  const onApply = vi.fn();
  render(<FormatToolbar disabled={false} controls={{ available:true, summary:{...summary,bold:null},onApply }} />);
  expect(screen.getByRole("button", {name:"Negrita"}).getAttribute("aria-pressed")).toBe("mixed");
  fireEvent.click(screen.getByRole("button", {name:"Negrita"})); expect(onApply).toHaveBeenLastCalledWith({bold:true});
  fireEvent.click(screen.getByRole("button", {name:"Subrayado"})); expect(onApply).toHaveBeenLastCalledWith({underline:true});
  fireEvent.click(screen.getByRole("button", {name:"Alinear: Centro"})); expect(onApply).toHaveBeenLastCalledWith({alignment:"center"});
  fireEvent.click(screen.getByRole("button", {name:/Relleno/}));
  fireEvent.click(screen.getByRole("button", {name:"Relleno #fff0b3"})); expect(onApply).toHaveBeenLastCalledWith({background:"#fff0b3"});
  fireEvent.click(screen.getByRole("button", {name:/Relleno/}));
  fireEvent.click(screen.getByRole("button", {name:"Sin relleno"})); expect(onApply).toHaveBeenLastCalledWith({background:""});
});
it("uses chosen border settings and applies quick styles or clearing as one command", () => {
  const onApply=vi.fn();render(<FormatToolbar disabled={false} controls={{available:true,summary,onApply}} />);
  fireEvent.change(screen.getByLabelText("Color del borde"),{target:{value:"#123456"}});
  fireEvent.change(screen.getByLabelText("Grosor del borde"),{target:{value:"3"}});
  fireEvent.change(screen.getByLabelText("Línea del borde"),{target:{value:"dashed"}});
  expect(onApply).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Aplicar bordes"),{target:{value:"outer"}});
  expect(onApply).toHaveBeenLastCalledWith({borders:{preset:"outer",border:{color:"#123456",width:3,line:"dashed"}}});
  fireEvent.change(screen.getByLabelText("Estilos rápidos"),{target:{value:"Encabezado"}});
  expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({bold:true,background:"#245c47",textColor:"#ffffff"}));
  fireEvent.click(screen.getByRole("button",{name:"Quitar formato"}));expect(onApply).toHaveBeenLastCalledWith({reset:true});
});
it("explains CSV persistence and offers conversion, and respects read-only controls", () => {
  const onCreateProject=vi.fn(), onApply=vi.fn();
  const {rerender}=render(<FormatToolbar disabled={false} controls={{available:false,summary:null,onApply,onCreateProject}} />);
  fireEvent.click(screen.getByRole("button",{name:"Crear proyecto desde este CSV…"}));expect(onCreateProject).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button",{name:"Negrita"})).toBeNull();
  rerender(<FormatToolbar disabled controls={{available:true,summary,onApply}} />);
  expect(screen.getByRole("button",{name:"Negrita"})).toHaveProperty("disabled",true);
  expect(onApply).not.toHaveBeenCalled();
});
