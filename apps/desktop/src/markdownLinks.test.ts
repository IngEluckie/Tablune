import { describe, expect, it } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { fileLink, insertDocumentLink, linkTrigger, markdownLink, parseTabluneLink, projectLink } from "./markdownLinks";

describe("Markdown document links", () => {
  it("places the cursor after a reference and continues with unlinked text", () => {
    const schema = new Schema({
      nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} },
      marks: { link: { attrs: { href: {} } } },
    });
    const doc = schema.node("doc", null, [schema.node("paragraph", null, schema.text("Bla bla [[trans"))]);
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 16) });
    state = state.apply(insertDocumentLink(state, { from: 9, to: 16 }, "Transform.py", projectLink("script-id")));
    expect(state.selection.from).toBe(21);
    state = state.apply(state.tr.insertText(" texto normal"));
    expect(state.doc.textContent).toBe("Bla bla Transform.py texto normal");
    const paragraph = state.doc.firstChild!;
    expect(paragraph.child(1).marks[0].attrs.href).toBe(projectLink("script-id"));
    expect(paragraph.lastChild!.text).toBe(" texto normal");
    expect(paragraph.lastChild!.marks).toEqual([]);
  });
  it("keeps a project target independent of its name and folder", () => {
    const href = projectLink("unique-id");
    expect(parseTabluneLink(href)).toEqual({ kind: "project", value: "unique-id" });
    expect(markdownLink("Notas", href)).toBe("[Notas](./.tablune-link/project/unique-id)");
  });
  it("round trips file paths and rejects unrelated or malformed links", () => {
    expect(parseTabluneLink(fileLink("/tmp/una carpeta/a #1.md"))).toEqual({ kind: "file", value: "/tmp/una carpeta/a #1.md" });
    expect(parseTabluneLink("https://example.com")).toBeNull();
    expect(parseTabluneLink("./.tablune-link/file/%zz")).toBeNull();
  });
  it("finds an unfinished wiki-style trigger", () => {
    expect(linkTrigger("texto [[archivo")).toEqual({ query: "archivo", length: 9 });
    expect(linkTrigger("[[archivo]]")).toBeNull();
    expect(markdownLink("un [nombre]", projectLink("id"))).toContain("un \\[nombre\\]");
  });
});
