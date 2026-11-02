interface MarkdownNode { type: string; value?: unknown; children?: MarkdownNode[]; }

// Milkdown serializes empty paragraphs as <br />. These markers must remain
// usable when reopening its own output, including older spelling variants.
export function isMarkdownBreakHtml(value: unknown): value is string {
  return typeof value === "string" && /^(?:\s*<br\s*\/?\s*>)+\s*$/i.test(value);
}

const visualTypes = new Set(["root", "paragraph", "text", "heading", "emphasis", "strong", "delete", "inlineCode", "code", "blockquote", "list", "listItem", "break", "thematicBreak", "link", "image", "definition", "linkReference", "imageReference", "table", "tableRow", "tableCell"]);
export function hasUnsupportedMarkdown(node: MarkdownNode): boolean {
  if (!visualTypes.has(node.type) && !(node.type === "html" && isMarkdownBreakHtml(node.value))) return true;
  return node.children?.some(hasUnsupportedMarkdown) ?? false;
}

export function requiresSourceMode(value: string) {
  return /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(value) || /^\[\^[^\]]+\]:/m.test(value);
}
