import { Plugin } from "@milkdown/kit/prose/state";

const completionSuffix = /\s+✅ \d{4}-\d{2}-\d{2}$/;

function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Keep completion dates in ordinary Markdown text, so they survive export. */
export function completionDatePlugin(now = () => new Date()): Plugin {
  return new Plugin({
    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some(transaction => transaction.docChanged)) return null;
      const changes: { from: number; to: number; text: string }[] = [];
      oldState.doc.descendants((oldNode, oldPos) => {
        if (oldNode.type.name !== "list_item" || typeof oldNode.attrs.checked !== "boolean") return;
        let pos = oldPos;
        for (const transaction of transactions) pos = transaction.mapping.map(pos, -1);
        const node = newState.doc.nodeAt(pos);
        if (!node || node.type !== oldNode.type || typeof node.attrs.checked !== "boolean" || node.attrs.checked === oldNode.attrs.checked) return;
        const paragraph = node.firstChild;
        if (!paragraph?.isTextblock) return;
        const value = paragraph.textContent;
        const suffix = value.match(completionSuffix)?.[0] ?? "";
        const end = pos + 2 + paragraph.content.size;
        changes.push({ from: end - suffix.length, to: end, text: node.attrs.checked ? ` ✅ ${localDate(now())}` : "" });
      });
      if (!changes.length) return null;
      const tr = newState.tr;
      for (const change of changes.sort((a, b) => b.from - a.from)) tr.insertText(change.text, change.from, change.to);
      return tr.docChanged ? tr : null;
    },
  });
}
