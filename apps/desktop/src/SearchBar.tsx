import { useEffect, useMemo, useState } from "react";
import { replaceSession, searchSession } from "./ipc";
import { normalizeSelection } from "./CsvGrid";
import type { DocumentSummary, SearchMatch, SearchRequest, SelectionRange } from "./types";

interface SearchBarProps {
  summary: DocumentSummary;
  selection: SelectionRange;
  readOnly?: boolean;
  onSummary: (summary: DocumentSummary) => void;
  onNavigate: (match: SearchMatch) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

export default function SearchBar({ summary, selection, readOnly = false, onSummary, onNavigate, onClose, onError }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeCell, setWholeCell] = useState(false);
  const [scope, setScope] = useState<"document" | "selection" | "cell">("document");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [active, setActive] = useState(-1);
  const [searching, setSearching] = useState(false);

  const request = useMemo<SearchRequest>(() => {
    const range = normalizeSelection(selection);
    const headerOffset = Number(summary.headerEnabled);
    const sourceRange = summary.filtersActive || summary.sortCount > 0
      ? null
      : {
          startRow: range.startRow + headerOffset,
          endRow: range.endRow + headerOffset,
          startColumn: range.startColumn,
          endColumn: range.endColumn,
        };
    const viewRange = summary.filtersActive || summary.sortCount > 0
      ? {
          startRow: range.startRow,
          endRow: range.endRow,
          startColumn: range.startColumn,
          endColumn: range.endColumn,
        }
      : null;
    return {
      query,
      caseSensitive,
      wholeCell,
      range: scope === "document" ? null : scope === "cell"
        ? sourceRange && { ...sourceRange, endRow: sourceRange.startRow, endColumn: sourceRange.startColumn }
        : sourceRange,
      viewRange: scope === "document" ? null : scope === "cell"
        ? viewRange && { ...viewRange, endRow: viewRange.startRow, endColumn: viewRange.startColumn }
        : viewRange,
      limit: 10_000,
    };
  }, [caseSensitive, query, scope, selection, summary.filtersActive, summary.headerEnabled, summary.sortCount, wholeCell]);

  const runSearch = async (direction = 1) => {
    if (!query) {
      setMatches([]);
      setActive(-1);
      return;
    }
    setSearching(true);
    try {
      const found = await searchSession(summary.documentId, request);
      setMatches(found);
      if (!found.length) {
        setActive(-1);
        return;
      }
      const next = active < 0 ? 0 : (active + direction + found.length) % found.length;
      setActive(next);
      onNavigate(found[next]);
    } catch (reason) {
      onError(String(reason));
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (query) void runSearch(0);
    }, 250);
    return () => window.clearTimeout(timer);
    // Search deliberately restarts when the request changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const replace = async (replaceAll: boolean) => {
    if (!query || readOnly) return;
    try {
      const activeMatch = active >= 0 ? matches[active] : null;
      const next = await replaceSession(summary.documentId, {
        search: request,
        replacement,
        replaceAll,
        expectedRevision: summary.revision,
        target: !replaceAll && activeMatch
          ? { sourceRow: activeMatch.sourceRow, column: activeMatch.column }
          : null,
      });
      onSummary(next);
      setMatches([]);
      setActive(-1);
      await runSearch(0);
    } catch (reason) {
      onError(String(reason));
    }
  };

  return (
    <section className="search-bar" aria-label="Find and replace">
      <input autoFocus aria-label="Find" placeholder="Find" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter") void runSearch(event.shiftKey ? -1 : 1);
        if (event.key === "Escape") onClose();
      }} />
      <button onClick={() => void runSearch(-1)} aria-label="Previous match">↑</button>
      <button onClick={() => void runSearch(1)} aria-label="Next match">↓</button>
      <span className="search-count">{searching ? "…" : matches.length ? `${Math.max(1, active + 1)} / ${matches.length}` : "No matches"}</span>
      <input aria-label="Replace with" placeholder="Replace with" value={replacement} disabled={readOnly} onChange={(event) => setReplacement(event.target.value)} />
      <button onClick={() => void replace(false)} disabled={readOnly || active < 0}>Replace</button>
      <button onClick={() => void replace(true)} disabled={readOnly || !matches.length}>Replace All</button>
      <label><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} /> Aa</label>
      <label><input type="checkbox" checked={wholeCell} onChange={(event) => setWholeCell(event.target.checked)} /> Whole cell</label>
      <select aria-label="Search scope" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
        <option value="document">Document</option>
        <option value="selection">Selection</option>
        <option value="cell">Active cell</option>
      </select>
      <button className="search-close" onClick={onClose} aria-label="Close search">×</button>
    </section>
  );
}
