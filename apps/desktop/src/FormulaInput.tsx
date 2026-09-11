import { type ComponentProps, type RefObject, useId, useMemo, useState } from "react";
import { pythonLanguage } from "@codemirror/lang-python";

export function appliedFunctionNames(code: string): string[] {
  const names = new Set<string>();
  const root = pythonLanguage.parser.parse(code).topNode;
  for (let node = root.firstChild; node; node = node.nextSibling) {
    const definition = node.name === "DecoratedStatement" ? node.getChild("FunctionDefinition") : node;
    if (definition?.name !== "FunctionDefinition") continue;
    const name = definition.getChild("VariableName");
    if (name) {
      const text = code.slice(name.from, name.to);
      if (!text.startsWith("_")) names.add(text);
    }
  }
  return [...names].sort();
}

type Props = Omit<ComponentProps<"input">, "value" | "ref"> & {
  value: string;
  appliedCode: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onComplete: (value: string) => void;
};
export default function FormulaInput({ appliedCode, inputRef, onComplete, onChange, onFocus, onBlur, onKeyDown, onSelect, value, ...props }: Props) {
  const names = useMemo(() => appliedFunctionNames(appliedCode), [appliedCode]);
  const [focused, setFocused] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [index, setIndex] = useState(0);
  const id = useId();
  const prefix = value.slice(0, cursor);
  // Complete the initial function name; never offer names inside string literals or arguments.
  const match = /^=\s*([A-Za-z_][A-Za-z_0-9]*)?$/.exec(prefix);
  const query = match?.[1] ?? "";
  const matches = focused && !dismissed && match ? names.filter(name => name.toLowerCase().startsWith(query.toLowerCase())) : [];
  const active = Math.min(index, Math.max(0, matches.length - 1));
  const choose = (name: string) => {
    const start = cursor - query.length;
    const suffix = value.slice(cursor).replace(/^[A-Za-z_0-9]*/, "");
    const insert = name + (suffix.startsWith("(") ? "" : "()");
    onComplete(value.slice(0, start) + insert + suffix);
    setDismissed(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      const position = start + name.length + 1;
      inputRef.current?.setSelectionRange(position, position);
      setCursor(position);
    });
  };
  return <div className="formula-input-container">
    <input {...props} ref={inputRef} value={value} role="combobox" aria-autocomplete="list"
      aria-expanded={matches.length > 0} aria-controls={matches.length ? id : undefined}
      aria-activedescendant={matches.length ? `${id}-${active}` : undefined} autoComplete="off"
      onFocus={event => { setFocused(true); setCursor(event.currentTarget.selectionStart ?? value.length); setDismissed(false); onFocus?.(event); }}
      onBlur={event => { setFocused(false); onBlur?.(event); }}
      onChange={event => { setCursor(event.currentTarget.selectionStart ?? 0); setDismissed(false); setIndex(0); onChange?.(event); }}
      onSelect={event => { setCursor(event.currentTarget.selectionStart ?? 0); onSelect?.(event); }}
      onKeyDown={event => {
        if (!event.nativeEvent.isComposing && matches.length) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); event.stopPropagation();
            const next = (active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
            setIndex(next);
            document.getElementById(`${id}-${next}`)?.scrollIntoView?.({ block: "nearest" });
            return;
          }
          if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); choose(matches[active]); return; }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDismissed(true); return; }
        }
        onKeyDown?.(event);
      }} />
    {matches.length > 0 && <div className="formula-suggestions" id={id} role="listbox" aria-label="Applied functions">
      {matches.map((name, option) => <div key={name} id={`${id}-${option}`} role="option" aria-selected={option === active}
        onMouseDown={event => event.preventDefault()} onMouseEnter={() => setIndex(option)} onClick={() => choose(name)}>{name}<span>()</span></div>)}
    </div>}
  </div>;
}
