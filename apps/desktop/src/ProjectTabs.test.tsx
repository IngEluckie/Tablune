// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ProjectTabs from "./ProjectTabs";
afterEach(cleanup);
const tabs = [{kind:"table" as const,id:"same",name:"Table"},{kind:"script" as const,id:"same",name:"Script.py"},{kind:"functions" as const,id:"functions",name:"Functions"}];
it("navigates mixed editors, closes an editor, and adds a table", () => {
  const onActivate = vi.fn(), onClose = vi.fn(), onNew = vi.fn();
  render(<ProjectTabs tabs={tabs} active={tabs[0]} onActivate={onActivate} onClose={onClose} onNew={onNew} />);
  expect(screen.getByRole("tab", {name:"Script.py"}).getAttribute("aria-selected")).toBe("false");
  fireEvent.click(screen.getByRole("button", {name:"List all project tabs"}));
  fireEvent.click(screen.getByRole("menuitem", {name:"Functions"}));
  expect(onActivate).toHaveBeenCalledWith(tabs[2]);
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(screen.getByRole("button", {name:"Close Script.py editor"}));
  expect(onClose).toHaveBeenCalledWith(tabs[1]);
  fireEvent.click(screen.getByRole("button", {name:"New table"}));
  expect(onNew).toHaveBeenCalledOnce();
});
it("scrolls in both directions and navigates by keyboard", () => {
  const onActivate = vi.fn();
  render(<ProjectTabs tabs={tabs} active={tabs[0]} onActivate={onActivate} onClose={vi.fn()} onNew={vi.fn()} />);
  const scrollBy = vi.fn();
  screen.getByRole("tablist").scrollBy = scrollBy;
  fireEvent.click(screen.getByRole("button", {name:"Scroll tabs left"}));
  fireEvent.click(screen.getByRole("button", {name:"Scroll tabs right"}));
  expect(scrollBy.mock.calls).toEqual([[{left:-240,behavior:"smooth"}],[{left:240,behavior:"smooth"}]]);
  fireEvent.keyDown(screen.getByRole("tab", {name:"Table"}), {key:"ArrowRight"});
  expect(onActivate).toHaveBeenCalledWith(tabs[1]);
});
