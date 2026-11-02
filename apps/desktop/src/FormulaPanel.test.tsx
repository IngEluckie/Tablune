// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import FormulaPanel, { type FormulaPanelTab } from "./FormulaPanel";
afterEach(cleanup);

it("searches in Spanish and inserts the actual Python function name", () => {
  const onInsert = vi.fn();
  render(<FormulaPanel tab="builtins" onTab={vi.fn()} appliedCode="" draftCode="" disabled={false} onInsert={onInsert} onClose={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Buscar función" }), { target: { value: "redondear" } });
  expect(screen.queryByRole("button", { name: /sum Suma/ })).toBeNull();
  expect(screen.getByRole("region", { name: "Ayuda de round" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Insertar round()" }));
  expect(onInsert).toHaveBeenCalledWith("round");
});
it("lists only applied project functions, reports drafts, and opens management", () => {
  const onManage = vi.fn();
  function Harness() {
    const [tab, onTab] = useState<FormulaPanelTab>("builtins");
    return <FormulaPanel tab={tab} onTab={onTab} appliedCode="def activa(valor): return valor" draftCode="def borrador(valor): return valor" disabled={false} onInsert={vi.fn()} onManage={onManage} onClose={vi.fn()} />;
  }
  render(<Harness />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "suma" } });
  fireEvent.click(screen.getByRole("button", { name: "Del proyecto" }));
  expect(screen.getByRole("textbox")).toHaveProperty("value", "");
  const list = screen.getByRole("group", { name: "Funciones disponibles" });
  expect(within(list).getByRole("button", { name: /activa/ })).toBeTruthy();
  expect(within(list).queryByRole("button", { name: /borrador/ })).toBeNull();
  expect(screen.getByText(/Hay un borrador sin aplicar/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Nueva función" }));
  expect(onManage).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Editar módulo" }));
  expect(onManage).toHaveBeenCalledWith(false);
});
