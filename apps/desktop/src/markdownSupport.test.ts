import { describe, expect, it } from "vitest";
import { hasUnsupportedMarkdown, isMarkdownBreakHtml, requiresSourceMode } from "./markdownSupport";

describe("visual Markdown compatibility", () => {
  it.each(["<br />", "<br/>", "<br>", "<BR />", " \n<br />\n ", "<br /><br>", "<br />\n<br />"])("accepts empty-line and inline break markers: %s", value => {
    expect(isMarkdownBreakHtml(value)).toBe(true);
    expect(hasUnsupportedMarkdown({ type: "root", children: [{ type: "html", value }] })).toBe(false);
  });
  it.each(["<br onclick='run()'>", "<br style='color:red'>", "<br /><script>run()</script>", "<div>text</div>", "<!-- comment -->", "<img src=x>", "text<br />", "<br />text", ""])("retains source fallback for other HTML: %s", value => {
    expect(isMarkdownBreakHtml(value)).toBe(false);
    expect(hasUnsupportedMarkdown({ type: "root", children: [{ type: "html", value }] })).toBe(true);
  });
  it("allows the screenshot's headings, separator, spacing and blockquote", () => {
    expect(hasUnsupportedMarkdown({ type: "root", children: [
      { type: "heading", children: [{ type: "text", value: "Proyecto GenesysMI" }] },
      { type: "thematicBreak" },
      { type: "html", value: "<br />" },
      { type: "blockquote", children: [{ type: "paragraph", children: [{ type: "text", value: "Notas del proyecto" }] }] },
      { type: "html", value: "<br />" },
    ] })).toBe(false);
  });
  it("treats HTML examples in code as literal text, and checks unsupported nodes inside containers", () => {
    expect(hasUnsupportedMarkdown({ type: "root", children: [{ type: "code", value: "<script>example</script>" }] })).toBe(false);
    expect(hasUnsupportedMarkdown({ type: "blockquote", children: [{ type: "paragraph", children: [{ type: "html", value: "<button>" }] }] })).toBe(true);
    expect(hasUnsupportedMarkdown({ type: "customExtension" })).toBe(true);
  });
  it("continues to preserve front matter and footnote definitions in source mode", () => {
    expect(requiresSourceMode("---\ntitle: Notes\n---\n\n# Heading")).toBe(true);
    expect(requiresSourceMode("Text[^1]\n\n[^1]: A footnote")).toBe(true);
    expect(requiresSourceMode("# Heading\n\n***\n\n<br />\n")).toBe(false);
  });
});
