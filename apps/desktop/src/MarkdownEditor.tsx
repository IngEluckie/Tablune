import { useEffect, useRef, useState } from "react";
import { Crepe } from "@milkdown/crepe";
import { commandsCtx, editorViewCtx, remarkCtx } from "@milkdown/kit/core";
import { $prose, $view, insert, replaceAll } from "@milkdown/kit/utils";
import { imageSchema, htmlSchema, linkSchema, clearTextInCurrentBlockCommand } from "@milkdown/kit/preset/commonmark";
import { uploadConfig } from "@milkdown/kit/plugin/upload";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { open } from "@tauri-apps/plugin-dialog";
import * as ipc from "./ipc";
import { registerMarkdownEditor, trackMarkdownOperation } from "./markdownPending";
import { fileLink, insertDocumentLink, linkTrigger, markdownLink, parseTabluneLink, projectLink, type MarkdownLinkTarget } from "./markdownLinks";
import { completionDatePlugin } from "./markdownTaskDates";
import { hasUnsupportedMarkdown, isMarkdownBreakHtml, requiresSourceMode } from "./markdownSupport";
export { requiresSourceMode } from "./markdownSupport";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/classic.css";
import "./markdown.css";

interface Props {
  documentId: string;
  projectId: number | null;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onError: (error: unknown) => void;
  onSave: () => void;
  linkTargets: MarkdownLinkTarget[];
  onOpenLink: (link: { kind: "project" | "file"; value: string }) => void;
}
export default function MarkdownEditor(props: Props) {
  const [mode, setMode] = useState<"visual" | "source">(() => requiresSourceMode(props.value) ? "source" : "visual");
  const [linkQuery, setLinkQuery] = useState<string | null>(null);
  const linkRange = useRef<{ from: number; to: number } | null>(null);
  const updateLinkQuery = (before: string, cursor: number) => {
    const match = linkTrigger(before);
    linkRange.current = match ? { from: cursor - match.length, to: cursor } : null;
    setLinkQuery(match?.query ?? null);
  };
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [searchStatus, setSearchStatus] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const insertImageRef = useRef(() => {});
  const [selectedImage, setSelectedImage] = useState<{ position: number; alt: string } | null>(null);
  const [headings, setHeadings] = useState<{ label: string; position: number }[]>([]);
  const host = useRef<HTMLDivElement>(null);
  const sourceHost = useRef<HTMLDivElement>(null);
  const editor = useRef<Crepe | null>(null);
  const source = useRef<EditorView | null>(null);
  const latest = useRef(props); latest.current = props;
  const text = useRef(props.value);
  const flushRef = useRef(() => {});
  const ready = useRef<Promise<unknown>>(Promise.resolve());
  const historyState = useRef({ undo: [] as string[], redo: [] as string[], last: 0 });
  const replaying = useRef(false);
  const readOnly = useRef(new Compartment());
  const [historyRevision, setHistoryRevision] = useState(0);
  const urls = useRef(new Map<string, Promise<string>>());
  const blobUrls = useRef(new Set<string>());
  const mounted = useRef(true);
  const publish = (value: string) => {
    if (value === text.current) return;
    if (!replaying.current) {
      const h = historyState.current;
      if (Date.now() - h.last > 600 || !h.undo.length) h.undo.push(text.current);
      h.redo = []; h.last = Date.now();
      while (h.undo.length > 1 && (h.undo.length > 100 || h.undo.reduce((sum, item) => sum + item.length * 2, 0) > 64 * 1024 * 1024)) h.undo.shift();
    }
    text.current = value; latest.current.onChange(value); setHistoryRevision(r => r + 1);
  };
  useEffect(() => registerMarkdownEditor(() => flushRef.current()), []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; for (const url of blobUrls.current) URL.revokeObjectURL(url); blobUrls.current.clear(); urls.current.clear(); }; }, []);
  // Parent acknowledgements do not reset the selection, history or unconfirmed input.
  useEffect(() => { if (!editor.current && !source.current) text.current = props.value; }, [props.value]);
  useEffect(() => {
    if (mode !== "source" || !sourceHost.current) return;
    const view = new EditorView({ parent: sourceHost.current, state: EditorState.create({
      doc: text.current,
      extensions: [markdown(), history(), keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": "Markdown source", spellcheck: "true" }),
        readOnly.current.of(EditorView.editable.of(!latest.current.disabled)),
        EditorView.updateListener.of(update => {
          if (update.docChanged) publish(update.state.doc.toString());
          if (update.docChanged || update.selectionSet) { const cursor = update.state.selection.main; const line = update.state.doc.lineAt(cursor.head); updateLinkQuery(cursor.empty ? update.state.doc.sliceString(line.from, cursor.head) : "", cursor.head); }
        })],
    }) });
    source.current = view;
    flushRef.current = () => publish(view.state.doc.toString());
    return () => { flushRef.current(); flushRef.current = () => {}; source.current = null; view.destroy(); };
  }, [mode]);
  useEffect(() => {
    if (mode !== "visual" || !host.current) return;
    const element = document.createElement("div"); host.current.append(element);
    let alive = true; let instance: Crepe | null = null; let baseline: ProseNode | null = null;
    setLoading(true);
    const proxy = (url: string) => {
      let cached = urls.current.get(url);
      if (!cached) {
        cached = ipc.readMarkdownImage(latest.current.projectId, latest.current.documentId, url).then(bytes => {
          if (!mounted.current) return "";
          const result = URL.createObjectURL(new Blob([bytes])); blobUrls.current.add(result); return result;
        }).catch(() => { urls.current.delete(url); return ""; });
        urls.current.set(url, cached);
      }
      return cached;
    };
    const upload = async (file: File) => trackMarkdownOperation((async () => {
      if (file.size > 20 * 1024 * 1024) throw new Error("Images must be smaller than 20 MiB");
      const url = await ipc.importMarkdownImage(latest.current.projectId, latest.current.documentId, null, Array.from(new Uint8Array(await file.arrayBuffer())));
      return url;
    })().catch(error => { latest.current.onError(error); throw error; }));
    const task = ready.current.catch(() => {}).then(async () => {
      if (!alive) return;
      instance = new Crepe({ root: element, defaultValue: text.current,
        features: { [Crepe.Feature.Latex]: false, [Crepe.Feature.AI]: false, [Crepe.Feature.ImageBlock]: false },
        featureConfigs: { [Crepe.Feature.BlockEdit]: { buildMenu: builder => {
          builder.addGroup("media", "Media").addItem("local-image", { label: "Image", icon: "▧", onRun: ctx => {
            ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key); insertImageRef.current();
          } });
        } } },
      });
      // Use standard Markdown image nodes: Crepe's block images encode their
      // resize ratio in alt text, which would discard an imported description.
      instance.editor.config(ctx => {
        // Returning to the end of an existing link must also allow plain text.
        ctx.update(linkSchema.key, previous => ctx => ({ ...previous(ctx), inclusive: false }));
        // Render only attribute-free <br> markers. Keep the raw value on the
        // schema node for serialization/clipboard; never interpret other HTML.
        ctx.update(htmlSchema.key, previous => ctx => {
          const schema = previous(ctx);
          return { ...schema, toDOM: node => {
            const value: unknown = node.attrs.value;
            if (!isMarkdownBreakHtml(value)) return schema.toDOM!(node);
            const span = document.createElement("span");
            span.dataset.type = "html"; span.dataset.value = value;
            for (const _ of value.matchAll(/<br\s*\/?\s*>/gi)) span.append(document.createElement("br"));
            return span;
          } };
        });
        ctx.update(uploadConfig.key, previous => ({ ...previous, uploader: async (files, schema) => {
          return Promise.all(Array.from(files).filter(file => file.type.startsWith("image/")).map(async file => schema.nodes.image.create({ src: await upload(file), alt: file.name })));
        } }));
      }).use($prose(() => completionDatePlugin())).use($view(imageSchema.node, () => (initial, view, getPos) => {
        const dom = document.createElement("span"); dom.className = "markdown-image";
        const img = document.createElement("img"); const status = document.createElement("span");
        dom.append(img, status); let node = initial; let disposed = false; let src = "";
        const bind = () => {
          img.alt = node.attrs.alt ?? ""; img.title = node.attrs.title ?? "";
          if (src === node.attrs.src) return;
          src = node.attrs.src; const requested = src;
          img.removeAttribute("src"); status.textContent = "Loading image…";
          void proxy(src).then(url => {
            if (disposed || src !== requested) return;
            if (url) { img.src = url; status.textContent = ""; }
            else status.textContent = `Image unavailable: ${img.alt || src}`;
          });
        };
        bind();
        return { dom, update(next) { if (next.type !== initial.type) return false; node = next; bind(); return true; },
          selectNode() { historyState.current.last = 0; dom.classList.add("selected"); const pos = getPos(); if (pos !== undefined) setSelectedImage({ position: pos, alt: node.attrs.alt ?? "" }); },
          deselectNode() { dom.classList.remove("selected"); setSelectedImage(null); },
          destroy() { disposed = true; },
        };
      }));
      const outline = (doc: ProseNode) => {
        const next: { label: string; position: number }[] = [];
        doc.descendants((node, pos) => { if (node.type.name === "heading") next.push({ label: `${"  ".repeat(Math.max(0, Number(node.attrs.level) - 1))}${node.textContent}`, position: pos + 1 }); });
        setHeadings(next);
      };
      const flush = () => {
        if (!alive || !instance || !baseline) return;
        const current = instance.editor.action(ctx => ctx.get(editorViewCtx).state.doc);
        if (!current.eq(baseline)) { baseline = current; outline(current); publish(instance.getMarkdown()); }
      };
      instance.on(listener => listener.updated((ctx) => {
        flush(); const selection = ctx.get(editorViewCtx).state.selection;
        updateLinkQuery(selection.empty ? selection.$from.parent.textBetween(0, selection.$from.parentOffset, "", "\uFFFC") : "", selection.from);
      }).selectionUpdated((ctx, selection) => {
        updateLinkQuery(selection.empty ? selection.$from.parent.textBetween(0, selection.$from.parentOffset, "", "\uFFFC") : "", selection.from);
        if (selection instanceof NodeSelection && selection.node.type.name === "image") setSelectedImage({ position: selection.from, alt: selection.node.attrs.alt ?? "" });
        else setSelectedImage(null);
      }));
      await instance.create();
      if (!alive) return;
      const unsupported = instance.editor.action(ctx => {
        const ast = ctx.get(remarkCtx).parse(text.current);
        return hasUnsupportedMarkdown(ast);
      });
      if (unsupported || requiresSourceMode(text.current)) {
        setNotice("This document contains syntax outside the visual editor. Markdown code preserves the complete original content.");
        setMode("source"); return;
      }
      baseline = instance.editor.action(ctx => ctx.get(editorViewCtx).state.doc);
      outline(baseline);
      editor.current = instance;
      setNotice("");
      instance.setReadonly(Boolean(latest.current.disabled));
      flushRef.current = flush; setLoading(false);
    }).catch(error => { if (alive) { latest.current.onError(error); setNotice("The visual editor could not open this content. You can continue in Markdown code."); setMode("source"); } });
    ready.current = task;
    return () => {
      flushRef.current(); flushRef.current = () => {}; alive = false; editor.current = null;
      ready.current = task.then(async () => { if (instance) await instance.destroy(); element.remove(); });
    };
  }, [mode]);
  useEffect(() => {
    editor.current?.setReadonly(Boolean(props.disabled));
    source.current?.dispatch({ effects: readOnly.current.reconfigure(EditorView.editable.of(!props.disabled)) });
  }, [props.disabled]);
  const replay = (redo: boolean) => {
    if (props.disabled) return;
    flushRef.current();
    const h = historyState.current; const stack = redo ? h.redo : h.undo;
    const next = stack.pop(); if (next === undefined) return;
    (redo ? h.undo : h.redo).push(text.current); h.last = 0;
    replaying.current = true;
    if (source.current) source.current.dispatch({ changes: { from: 0, to: source.current.state.doc.length, insert: next } });
    else if (editor.current) { editor.current.editor.action(replaceAll(next)); flushRef.current(); }
    publish(next); replaying.current = false;
    setHistoryRevision(r => r + 1);
  };
  const switchMode = (next: typeof mode) => { flushRef.current(); historyState.current.last = 0; setMode(next); };
  const findNext = () => {
    if (!query) return;
    const needle = query.toLocaleLowerCase();
    if (source.current) {
      const view = source.current; const value = view.state.doc.toString().toLocaleLowerCase();
      let at = value.indexOf(needle, view.state.selection.main.to);
      if (at < 0) at = value.indexOf(needle);
      setSearchStatus(at < 0 ? "No matches" : "Match selected");
      if (at >= 0) { view.dispatch({ selection: { anchor: at, head: at + query.length }, scrollIntoView: true }); view.focus(); }
    } else if (editor.current) {
      editor.current.editor.action(ctx => {
        const view = ctx.get(editorViewCtx); const positions: number[] = [];
        view.state.doc.descendants((node, pos) => {
          if (!node.isTextblock) return;
          const value = node.textBetween(0, node.content.size, "", "\uFFFC").toLocaleLowerCase();
          let at = value.indexOf(needle);
          while (at >= 0) { positions.push(pos + 1 + at); at = value.indexOf(needle, at + Math.max(1, needle.length)); }
        });
        const position = positions.find(pos => pos >= view.state.selection.to) ?? positions[0];
        setSearchStatus(position === undefined ? "No matches" : `${positions.indexOf(position) + 1} / ${positions.length}`);
        if (position !== undefined) { view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position, position + query.length)).scrollIntoView()); view.focus(); }
      });
    }
  };
  const insertImage = () => {
    void trackMarkdownOperation((async () => {
      const path = await open({ title: "Insert image", filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }] });
      if (typeof path !== "string") return;
      const url = await ipc.importMarkdownImage(props.projectId, props.documentId, path);
      const name = path.split(/[\\/]/).at(-1)?.replace(/[\[\]\\]/g, "") ?? "Image";
      const markup = `![${name}](${url})`;
      if (source.current) { const v = source.current; v.dispatch(v.state.replaceSelection(markup)); v.focus(); }
      else if (editor.current) { editor.current.editor.action(insert(markup)); flushRef.current(); }
    })()).catch(props.onError);
  };
  insertImageRef.current = insertImage;
  const insertLink = (label: string, href: string) => {
    const range = linkRange.current;
    if (!range || props.disabled) return;
    if (source.current) {
      const view = source.current; const value = markdownLink(label, href);
      view.dispatch({ changes: { ...range, insert: value }, selection: { anchor: range.from + value.length } }); view.focus();
    } else if (editor.current) {
      editor.current.editor.action(ctx => {
        const view = ctx.get(editorViewCtx); const link = view.state.schema.marks.link;
        if (!link) return;
        view.dispatch(insertDocumentLink(view.state, range, label, href)); view.focus();
      });
      flushRef.current();
    }
    linkRange.current = null; setLinkQuery(null);
  };
  const chooseFileLink = async () => {
    const path = await open({ title: "Vincular archivo", filters: [{ name: "Documentos", extensions: ["md", "markdown", "csv", "tsv", "txt", "tablune"] }] });
    if (typeof path === "string") insertLink(path.split(/[\\/]/).at(-1) ?? path, fileLink(path));
  };
  return <section className="markdown-editor" data-history={historyRevision} onClickCapture={event => {
    // Links remain text-editing targets; never navigate the desktop WebView away.
    const anchor = (event.target as HTMLElement).closest("a[href]");
    if (anchor) {
      event.preventDefault();
      const link = parseTabluneLink(anchor.getAttribute("href") ?? "");
      if (link) { event.stopPropagation(); props.onOpenLink(link); }
    }
  }} onKeyDownCapture={event => {
    if (linkQuery !== null && event.key === "Escape") { event.preventDefault(); setLinkQuery(null); linkRange.current = null; return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); event.stopPropagation(); searchInput.current?.focus(); return; }
    if (event.target !== searchInput.current && (event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) {
      event.preventDefault(); event.stopPropagation(); replay(event.shiftKey || event.key.toLowerCase() === "y");
    }
  }} onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); flushRef.current(); props.onSave(); }
  }}>
    <div className="markdown-toolbar" role="toolbar" aria-label="Document editing">
      <button aria-pressed={mode === "visual"} title="Type / for blocks · Select text to format" onClick={() => switchMode("visual")}>Visual</button>
      <button aria-pressed={mode === "source"} title="Markdown source · Ctrl/Cmd+S to save" onClick={() => switchMode("source")}>Markdown code</button>
      <span className="toolbar-divider" />
      <button disabled={props.disabled || !historyState.current.undo.length} onClick={() => replay(false)}>Undo</button>
      <button disabled={props.disabled || !historyState.current.redo.length} onClick={() => replay(true)}>Redo</button>
      <button disabled={props.disabled || (mode === "visual" && loading)} onClick={insertImage}>Insert image…</button>
      {mode === "visual" && selectedImage && <label className="markdown-image-alt">Image description <input aria-label="Image description" value={selectedImage.alt} disabled={props.disabled} onChange={event => {
        const alt = event.target.value;
        editor.current?.editor.action(ctx => { const view = ctx.get(editorViewCtx); const node = view.state.doc.nodeAt(selectedImage.position); if (node?.type.name === "image") view.dispatch(view.state.tr.setNodeMarkup(selectedImage.position, undefined, { ...node.attrs, alt })); });
        setSelectedImage({ ...selectedImage, alt }); flushRef.current();
      }} /></label>}
      {mode === "visual" && headings.length > 0 && <select aria-label="Document outline" value="" onChange={event => {
        const position = Number(event.target.value);
        editor.current?.editor.action(ctx => { const view = ctx.get(editorViewCtx); view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position)).scrollIntoView()); view.focus(); });
      }}><option value="" disabled>Outline…</option>{headings.map(h => <option key={h.position} value={h.position}>{h.label}</option>)}</select>}
      <input ref={searchInput} className="markdown-search" aria-label="Find in document" placeholder="Find…" value={query} onChange={event => { setQuery(event.target.value); setSearchStatus(""); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); findNext(); } }} />
      <button disabled={!query} onClick={findNext}>Next match</button>
      <span className="markdown-search-status" role="status">{searchStatus}</span>
    </div>
    {linkQuery !== null && !props.disabled && <div className="markdown-link-menu" role="listbox" aria-label="Vincular documento" onMouseDown={event => event.preventDefault()}>
      {props.linkTargets.filter(target => `${target.name} ${target.path}`.toLocaleLowerCase().includes(linkQuery.toLocaleLowerCase())).slice(0, 12).map(target =>
        <button type="button" role="option" aria-selected="false" key={target.id} onClick={() => insertLink(target.name, projectLink(target.id))}>{target.name}<small>{target.path}</small></button>)}
      <button type="button" onClick={() => void chooseFileLink().catch(props.onError)}>Buscar archivo…</button>
    </div>}
    {notice && <p className="markdown-notice" role="status">{notice}</p>}
    {mode === "visual" && loading && <p role="status">Opening document…</p>}
    <div className="markdown-page" hidden={mode !== "visual"} ref={host} />
    <div className="markdown-source" hidden={mode !== "source"} ref={sourceHost} />
  </section>;
}
