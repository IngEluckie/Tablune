// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import DocumentActions from "./DocumentActions";
import { useEditorHistory } from "./editorHistory";
import { SaveCoordinator } from "./saveCoordinator";
import PythonMacroEditor from "./PythonMacroEditor";

afterEach(cleanup);
const coordinator = () => {
  const saves = new SaveCoordinator();
  saves.reconcile([{ id: "project:1", preferenceKey: "test", path: "/tmp/test.tablune", dirty: false, revision: "0", save: async () => {} }]);
  return saves;
};

it("routes the shared arrows to the focused visible editor and falls back after navigation", () => {
  const tableUndo = vi.fn(), pythonUndo = vi.fn();
  function Editor({ id, hidden = false, undo }: { id: string; hidden?: boolean; undo: () => void }) {
    const binding = useEditorHistory({ id, scope: "project:1", canUndo: true, canRedo: false, undo, redo: () => {} });
    return <div hidden={hidden}><div {...binding}><input aria-label={id} /></div></div>;
  }
  const saves = coordinator();
  const content = (hidden = false) => <><DocumentActions coordinator={saves} targetId="project:1" editorId="table" /><Editor id="table" undo={tableUndo} /><Editor id="python" hidden={hidden} undo={pythonUndo} /></>;
  const view = render(content());
  fireEvent.focus(screen.getByLabelText("python")); fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(pythonUndo).toHaveBeenCalledOnce(); expect(tableUndo).not.toHaveBeenCalled();
  view.rerender(content(true)); fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(tableUndo).toHaveBeenCalledOnce();
  expect((screen.getByRole("button", { name: "Redo" }) as HTMLButtonElement).disabled).toBe(true);
  saves.dispose();
});

it("undoes and redoes real Python edits after a save acknowledgement without rebuilding its history", () => {
  const saves = coordinator(), onChange = vi.fn();
  const content = (value: string) => <><DocumentActions coordinator={saves} targetId="project:1" editorId="python" /><PythonMacroEditor historyId="python" historyScope="project:1" value={value} disabled={false} onChange={onChange} /></>;
  const mounted = render(content("value = 1"));
  const textbox = screen.getByRole("textbox", { name: "Macro code" });
  const view = EditorView.findFromDOM(textbox)!;
  act(() => { view.dispatch({ changes: { from: 8, to: 9, insert: "2" } }); view.focus(); });
  mounted.rerender(content("value = 2"));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(view.state.doc.toString()).toBe("value = 1");
  fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  expect(view.state.doc.toString()).toBe("value = 2");
  expect(onChange).toHaveBeenLastCalledWith("value = 2");
  saves.dispose();
});
