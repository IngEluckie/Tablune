import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, LanguageSupport, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { pythonLanguage } from "@codemirror/lang-python";
import { Annotation, Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useLayoutEffect, useRef } from "react";

interface PythonMacroEditorProps {
  label?: string;
  value: string;
  disabled: boolean;
  onChange: (code: string) => void;
}

const externalUpdate = Annotation.define<boolean>();

const pythonHighlightStyle = HighlightStyle.define([
  { tag: tags.name, class: "cm-py-name" },
  { tag: [tags.definition(tags.variableName), tags.function(tags.variableName), tags.className], class: "cm-py-definition" },
  { tag: tags.keyword, class: "cm-py-keyword" },
  { tag: [tags.string, tags.docString], class: "cm-py-string" },
  { tag: tags.comment, class: "cm-py-comment" },
  { tag: tags.number, class: "cm-py-number" },
]);

const pythonSupport = new LanguageSupport(pythonLanguage);

function editableExtensions(disabled: boolean) {
  return [
    EditorState.readOnly.of(disabled),
    EditorView.editable.of(!disabled),
    EditorView.contentAttributes.of({ "aria-disabled": String(disabled) }),
  ];
}

export default function PythonMacroEditor({ value, disabled, onChange, label = "Macro code" }: PythonMacroEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const editableCompartmentRef = useRef(new Compartment());
  onChangeRef.current = onChange;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editableCompartment = editableCompartmentRef.current;
    const state = EditorState.create({
      doc: value,
      extensions: [
        pythonSupport,
        Prec.highest(pythonLanguage.data.of({
          closeBrackets: { brackets: ["(", "[", "{"] },
        })),
        syntaxHighlighting(pythonHighlightStyle),
        closeBrackets(),
        history(),
        indentUnit.of("    "),
        EditorState.tabSize.of(4),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          "aria-label": label,
          "aria-multiline": "true",
          autocapitalize: "off",
          autocomplete: "off",
          autocorrect: "off",
          spellcheck: "false",
        }),
        keymap.of([
          ...closeBracketsKeymap,
          indentWithTab,
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        editableCompartment.of(editableExtensions(disabled)),
        EditorView.updateListener.of((update) => {
          if (
            update.docChanged
            && !update.transactions.some((transaction) => transaction.annotation(externalUpdate))
          ) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: externalUpdate.of(true),
    });
  }, [value]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartmentRef.current.reconfigure(editableExtensions(disabled)),
    });
  }, [disabled]);

  return <div ref={hostRef} className="python-macro-editor" />;
}
