export interface MarkdownLinkTarget { id: string; name: string; path: string; kind: "markdown" | "table" | "script"; }
export const projectLink = (id: string) => `./.tablune-link/project/${encodeURIComponent(id)}`;
export const fileLink = (path: string) => `./.tablune-link/file/${encodeURIComponent(path)}`;
export function parseTabluneLink(href: string): { kind: "project" | "file"; value: string } | null {
  const match = /^\.\/\.tablune-link\/(project|file)\/(.+)$/.exec(href);
  if (!match) return null;
  try { return { kind: match[1] === "project" ? "project" : "file", value: decodeURIComponent(match[2]) }; } catch { return null; }
}
export function linkTrigger(text: string): { query: string; length: number } | null {
  const match = /\[\[([^\[\]\n]*)$/.exec(text);
  return match ? { query: match[1], length: match[0].length } : null;
}
export function markdownLink(label: string, href: string): string {
  return `[${label.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]")}](${href})`;
}
import { TextSelection, type EditorState } from "@milkdown/kit/prose/state";

export function insertDocumentLink(state: EditorState, range: { from: number; to: number }, label: string, href: string) {
  const link = state.schema.marks.link;
  const content = state.schema.text(label, [link.create({ href })]);
  const tr = state.tr.replaceWith(range.from, range.to, content);
  // A reference ends at its label; subsequent typing belongs to normal text.
  return tr.setSelection(TextSelection.create(tr.doc, range.from + content.nodeSize)).removeStoredMark(link);
}

