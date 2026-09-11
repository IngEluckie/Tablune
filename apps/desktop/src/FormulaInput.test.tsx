// @vitest-environment jsdom
import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import FormulaInput, { appliedFunctionNames } from "./FormulaInput";
afterEach(cleanup);
const code = 'def precio_final(base, impuesto):\n return base\ndef suma(n1,n2):\n return n1+n2\n';
function Harness({ appliedCode = code, commit = vi.fn() }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  return <FormulaInput aria-label="Formula bar" value={value} inputRef={inputRef} appliedCode={appliedCode}
    onComplete={setValue} onChange={e => setValue(e.target.value)} onKeyDown={e => { if(e.key === "Enter") commit(); }} />;
}
it("lists applied functions, filters them, and accepts a mouse selection without losing focus", async () => {
  render(<Harness />);
  const bar = screen.getByRole("combobox") as HTMLInputElement;
  fireEvent.focus(bar);
  fireEvent.change(bar, { target: { value: "=" } });
  expect(screen.getAllByRole("option")).toHaveLength(2);
  fireEvent.change(bar, { target: { value: "=su" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.mouseDown(screen.getByRole("option"));
  fireEvent.click(screen.getByRole("option"));
  expect(bar.value).toBe("=suma()");
  await waitFor(() => expect(bar.selectionStart).toBe(6));
  expect(screen.queryByRole("listbox")).toBeNull();
});
it("handles arrows and Enter before committing, and Escape dismisses suggestions", () => {
  const commit = vi.fn();
  render(<Harness commit={commit} />);
  const bar = screen.getByRole("combobox") as HTMLInputElement;
  fireEvent.focus(bar);
  fireEvent.change(bar, { target: { value: "=" } });
  fireEvent.keyDown(bar, { key: "ArrowDown" });
  fireEvent.keyDown(bar, { key: "Enter" });
  expect(bar.value).toBe("=suma()");
  expect(commit).not.toHaveBeenCalled();
  fireEvent.keyDown(bar, { key: "Enter" });
  expect(commit).toHaveBeenCalledOnce();
  fireEvent.change(bar, { target: { value: "=p" } });
  fireEvent.keyDown(bar, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
});
it("ignores function-like text in strings, private helpers, methods, and nested definitions", () => {
  expect(appliedFunctionNames('"""\ndef fake(): pass\n"""\ndef _helper(): pass\nclass C:\n def method(self): pass\ndef public():\n def nested(): pass\n')).toEqual(["public"]);
});
it("updates after application and hides nonmatching suggestions", () => {
  const view = render(<Harness appliedCode="" />);
  const bar = screen.getByRole("combobox");
  fireEvent.focus(bar);
  fireEvent.change(bar, { target: { value: "=" } });
  expect(screen.queryByRole("listbox")).toBeNull();
  view.rerender(<Harness appliedCode={code} />);
  expect(screen.getAllByRole("option")).toHaveLength(2);
  fireEvent.change(bar, { target: { value: "=missing" } });
  expect(screen.queryByRole("listbox")).toBeNull();
});
