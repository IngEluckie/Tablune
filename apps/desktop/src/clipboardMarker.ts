// HTML clipboard marker for platforms without a native clipboard generation counter.
// Other applications still receive ordinary text, never private sheet metadata.
export async function writeMarkedClipboard(text: string): Promise<string | null> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return null;
  const token = crypto.randomUUID();
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  try {
    await navigator.clipboard.write([new ClipboardItem({
      "text/plain": new Blob([text], { type: "text/plain" }),
      "text/html": new Blob([`<pre data-tablune-clipboard="${token}">${escaped}</pre>`], { type: "text/html" }),
    })]);
    return token;
  } catch { return null; }
}
export async function clipboardHasMarker(token: string | null | undefined): Promise<boolean> {
  if (!token || !navigator.clipboard?.read) return false;
  try {
    for (const item of await navigator.clipboard.read()) {
      if (item.types.includes("text/html")) {
        const html = await (await item.getType("text/html")).text();
        if (html.includes(`data-tablune-clipboard="${token}"`)) return true;
      }
    }
  } catch { /* Denied rich clipboard access falls back to values. */ }
  return false;
}
