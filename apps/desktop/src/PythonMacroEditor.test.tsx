// @vitest-environment jsdom

import { deleteBracketPair, insertBracket } from "@codemirror/autocomplete";
import { indentWithTab, insertNewlineAndIndent } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PythonMacroEditor from "./PythonMacroEditor";

afterEach(cleanup);

function getView(): EditorView {
  const textbox = screen.getByRole("textbox", { name: "Macro code" });
  const view = EditorView.findFromDOM(textbox);
  if (!view) throw new Error("CodeMirror view was not found");
  return view;
}

function replaceDocument(view: EditorView, doc: string, anchor = doc.length, head = anchor) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: doc },
    selection: { anchor, head },
  });
}

describe("PythonMacroEditor", () => {
  it("highlights standard Python token categories", () => {
    render(
      <PythonMacroEditor
        value={'def total(values):\n    # note\n    return "sum" + 42'}
        disabled={false}
        onChange={vi.fn()}
      />,
    );

    expect(document.querySelector(".cm-py-keyword")?.textContent).toBe("def");
    expect(document.querySelector(".cm-py-definition")?.textContent).toBe("total");
    expect(document.querySelector(".cm-py-comment")?.textContent).toBe("# note");
    expect(document.querySelector(".cm-py-string")?.textContent).toBe('"sum"');
    expect(document.querySelector(".cm-py-number")?.textContent).toBe("42");
  });

  it("closes, skips, wraps and deletes only bracket pairs", () => {
    render(<PythonMacroEditor value="" disabled={false} onChange={vi.fn()} />);
    const view = getView();

    for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
      replaceDocument(view, "");
      const openTransaction = insertBracket(view.state, opening);
      expect(openTransaction).not.toBeNull();
      view.dispatch(openTransaction!);
      expect(view.state.doc.toString()).toBe(`${opening}${closing}`);
      expect(view.state.selection.main.head).toBe(1);

      const closeTransaction = insertBracket(view.state, closing);
      expect(closeTransaction).not.toBeNull();
      view.dispatch(closeTransaction!);
      expect(view.state.doc.toString()).toBe(`${opening}${closing}`);
      expect(view.state.selection.main.head).toBe(2);

      replaceDocument(view, "value", 0, 5);
      const wrapTransaction = insertBracket(view.state, opening);
      expect(wrapTransaction).not.toBeNull();
      view.dispatch(wrapTransaction!);
      expect(view.state.doc.toString()).toBe(`${opening}value${closing}`);

      replaceDocument(view, "");
      view.dispatch(insertBracket(view.state, opening)!);
      expect(deleteBracketPair({ state: view.state, dispatch: (transaction) => view.dispatch(transaction) })).toBe(true);
      expect(view.state.doc.toString()).toBe("");
    }

    replaceDocument(view, "");
    expect(insertBracket(view.state, "'")).toBeNull();
    expect(insertBracket(view.state, '"')).toBeNull();
  });

  it("indents and unindents current and selected lines with four spaces", () => {
    render(<PythonMacroEditor value="first\nsecond" disabled={false} onChange={vi.fn()} />);
    const view = getView();
    replaceDocument(view, "first\nsecond", 0, 12);

    expect(indentWithTab.run!(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("    first\n    second");
    expect(indentWithTab.shift!(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("first\nsecond");
  });

  it("uses Python-aware indentation when Enter is pressed", () => {
    render(<PythonMacroEditor value="" disabled={false} onChange={vi.fn()} />);
    const view = getView();

    replaceDocument(view, "def run(rows, context):");
    expect(insertNewlineAndIndent(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("def run(rows, context):\n    ");

    replaceDocument(view, "def run():\n    value = 1");
    insertNewlineAndIndent(view);
    expect(view.state.doc.toString()).toBe("def run():\n    value = 1\n    ");

    for (const line of ['value = "not a block:"', "# not a block:"]) {
      replaceDocument(view, line);
      insertNewlineAndIndent(view);
      expect(view.state.doc.toString()).toBe(`${line}\n`);
    }
  });

  it("syncs external values, reports user changes and becomes read-only", () => {
    const onChange = vi.fn();
    const result = render(<PythonMacroEditor value="first" disabled={false} onChange={onChange} />);
    const view = getView();

    result.rerender(<PythonMacroEditor value="opened file" disabled={false} onChange={onChange} />);
    expect(view.state.doc.toString()).toBe("opened file");
    expect(onChange).not.toHaveBeenCalled();

    view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } });
    expect(onChange).toHaveBeenLastCalledWith("opened file!");

    result.rerender(<PythonMacroEditor value="opened file!" disabled onChange={onChange} />);
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
    expect(view.contentDOM.getAttribute("aria-disabled")).toBe("true");
  });

  it("allows focus to leave with Escape followed by Tab", () => {
    render(<PythonMacroEditor value="value" disabled={false} onChange={vi.fn()} />);
    const textbox = screen.getByRole("textbox", { name: "Macro code" });

    expect(fireEvent.keyDown(textbox, { key: "Tab", code: "Tab", keyCode: 9 })).toBe(false);
    fireEvent.keyDown(textbox, { key: "Escape", code: "Escape", keyCode: 27 });
    expect(fireEvent.keyDown(textbox, { key: "Tab", code: "Tab", keyCode: 9 })).toBe(true);
  });
});
