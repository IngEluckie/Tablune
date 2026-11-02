import { describe, expect, it } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState } from "@milkdown/kit/prose/state";
import { completionDatePlugin } from "./markdownTaskDates";

const schema = new Schema({ nodes: {
  doc: { content: "list_item+" },
  list_item: { content: "paragraph+", attrs: { checked: { default: false } } },
  paragraph: { content: "text*" },
  text: {},
} });
const initial = (checked: boolean, content: string) => EditorState.create({
  doc: schema.node("doc", null, [schema.node("list_item", { checked }, [schema.node("paragraph", null, content ? schema.text(content) : undefined)])]),
  plugins: [completionDatePlugin(() => new Date(2026, 10, 2, 23, 30))],
});
const toggle = (state: EditorState, checked: boolean) => state.applyTransaction(state.tr.setNodeMarkup(0, undefined, { checked })).state;

describe("Markdown task completion dates", () => {
  it("adds a local completion date and removes it when reopened", () => {
    const completed = toggle(initial(false, "Hola"), true);
    expect(completed.doc.textContent).toBe("Hola ✅ 2026-11-02");
    expect(toggle(completed, false).doc.textContent).toBe("Hola");
  });
  it("replaces an existing completion suffix and leaves other dates untouched", () => {
    const completed = toggle(initial(false, "Due 2025-01-01 ✅ 2025-02-02"), true);
    expect(completed.doc.textContent).toBe("Due 2025-01-01 ✅ 2026-11-02");
    expect(toggle(completed, false).doc.textContent).toBe("Due 2025-01-01");
  });
  it("does not alter tasks on ordinary text edits", () => {
    const state = initial(true, "Existing");
    expect(state.applyTransaction(state.tr.insertText("!", 10)).state.doc.textContent).toBe("Existing!");
  });
});
