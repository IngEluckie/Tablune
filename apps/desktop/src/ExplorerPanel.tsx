import { useEffect, useState } from "react";
import { getColumnProfile, getFacets } from "./ipc";
import { columnName } from "./CsvGrid";
import type {
  ColumnProfile,
  ColumnType,
  DocumentSummary,
  FacetPage,
  FilterSpec,
  ViewState,
} from "./types";

interface ExplorerPanelProps {
  summary: DocumentSummary;
  column: number;
  view: ViewState;
  onViewChange: (view: ViewState) => Promise<void>;
  onColumnTypeChange: (type: ColumnType) => Promise<void>;
  onApplySort: () => Promise<void>;
  onExport: () => Promise<void>;
  onClose: () => void;
  onError: (message: string) => void;
}

const EMPTY_FACETS: FacetPage = { values: [], totalDistinct: 0, nextOffset: null };

export default function ExplorerPanel({
  summary,
  column,
  view,
  onViewChange,
  onColumnTypeChange,
  onApplySort,
  onExport,
  onClose,
  onError,
}: ExplorerPanelProps) {
  const [profile, setProfile] = useState<ColumnProfile | null>(null);
  const [facets, setFacets] = useState<FacetPage>(EMPTY_FACETS);
  const [facetQuery, setFacetQuery] = useState("");
  const [operator, setOperator] = useState<FilterSpec["operator"]>("contains");
  const [filterValue, setFilterValue] = useState("");
  const [secondValue, setSecondValue] = useState("");
  const [type, setType] = useState<ColumnType>("text");
  const [loading, setLoading] = useState(false);
  const name = summary.headerNames[column] ?? columnName(column);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([getColumnProfile(column), getFacets(column, facetQuery, 0, 100)])
      .then(([nextProfile, nextFacets]) => {
        if (!active) return;
        setProfile(nextProfile);
        setFacets(nextFacets);
        setType(nextProfile.activeType);
      })
      .catch((reason) => onError(String(reason)))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [column, facetQuery, onError, summary.revision, summary.viewRevision]);

  const replaceColumnFilter = (filter: FilterSpec | null) => {
    const filters = view.filters.filter((candidate) => candidate.column !== column);
    if (filter) filters.push(filter);
    return onViewChange({ ...view, filters });
  };

  const setSort = (direction: "ascending" | "descending" | null) => {
    const sorts = view.sorts.filter((sort) => sort.column !== column);
    if (direction) sorts.push({ column, direction, columnType: type });
    return onViewChange({ ...view, sorts });
  };

  const toggleFacet = (value: string, checked: boolean) => {
    const current = view.filters.find((filter) => filter.column === column && filter.operator === "values");
    const values = new Set(current?.values ?? []);
    if (checked) values.add(value); else values.delete(value);
    return replaceColumnFilter(values.size ? {
      column,
      operator: "values",
      value: "",
      secondValue: "",
      values: [...values],
      columnType: type,
      caseSensitive: true,
    } : null);
  };

  const selectedFacets = new Set(view.filters.find((filter) => filter.column === column && filter.operator === "values")?.values ?? []);

  const loadMoreFacets = async () => {
    if (facets.nextOffset === null) return;
    try {
      const next = await getFacets(column, facetQuery, facets.nextOffset, 100);
      setFacets({
        values: [...facets.values, ...next.values],
        totalDistinct: next.totalDistinct,
        nextOffset: next.nextOffset,
      });
    } catch (reason) {
      onError(String(reason));
    }
  };

  return (
    <aside className="explorer-panel" aria-label="Data explorer">
      <header>
        <div><span>Column</span><strong title={name}>{name}</strong></div>
        <button onClick={onClose} aria-label="Close data explorer">×</button>
      </header>
      <div className="explorer-scroll">
        <section className="explorer-section">
          <h3>Type and sort</h3>
          <label>Interpret as
            <select value={type} onChange={(event) => {
              const next = event.target.value as ColumnType;
              setType(next);
              void onColumnTypeChange(next);
            }}>
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="date">Date</option>
              <option value="boolean">Boolean</option>
            </select>
          </label>
          <div className="button-row">
            <button onClick={() => void setSort("ascending")}>Sort A → Z</button>
            <button onClick={() => void setSort("descending")}>Sort Z → A</button>
            <button onClick={() => void setSort(null)}>Clear</button>
          </div>
          {summary.sortCount > 0 && <button className="wide-action" onClick={() => void onApplySort()}>Apply sort to data</button>}
        </section>

        <section className="explorer-section">
          <h3>Filter</h3>
          <select value={operator} onChange={(event) => setOperator(event.target.value as FilterSpec["operator"])}>
            <option value="contains">Contains</option>
            <option value="equals">Equals</option>
            <option value="startsWith">Starts with</option>
            <option value="endsWith">Ends with</option>
            <option value="empty">Is empty</option>
            <option value="notEmpty">Is not empty</option>
            <option value="greaterThan">Greater than</option>
            <option value="lessThan">Less than</option>
            <option value="between">Between</option>
          </select>
          {!operator.endsWith("Empty") && operator !== "empty" && (
            <input placeholder="Value" value={filterValue} onChange={(event) => setFilterValue(event.target.value)} />
          )}
          {operator === "between" && <input placeholder="And" value={secondValue} onChange={(event) => setSecondValue(event.target.value)} />}
          <div className="button-row">
            <button onClick={() => void replaceColumnFilter({
              column,
              operator,
              value: filterValue,
              secondValue,
              values: [],
              columnType: type,
              caseSensitive: false,
            })}>Apply</button>
            <button onClick={() => void replaceColumnFilter(null)}>Clear</button>
          </div>
        </section>

        <section className="explorer-section">
          <h3>Facets <small>{facets.totalDistinct.toLocaleString()} distinct</small></h3>
          <input placeholder="Search values" value={facetQuery} onChange={(event) => setFacetQuery(event.target.value)} />
          <div className="facet-list">
            {facets.values.map((facet) => (
              <label key={facet.value} title={facet.value || "(blank)"}>
                <input type="checkbox" checked={selectedFacets.has(facet.value)} onChange={(event) => void toggleFacet(facet.value, event.target.checked)} />
                <span>{facet.value || "(blank)"}</span>
                <em>{facet.count.toLocaleString()}</em>
              </label>
            ))}
            {facets.nextOffset !== null && <button className="facet-more" onClick={() => void loadMoreFacets()}>Load more…</button>}
          </div>
        </section>

        <section className="explorer-section profile-section">
          <h3>Profile {loading && <small>Working…</small>}</h3>
          {profile && (
            <dl>
              <dt>Rows</dt><dd>{profile.totalRows.toLocaleString()}</dd>
              <dt>Visible</dt><dd>{summary.visibleRowCount.toLocaleString()}</dd>
              <dt>Empty</dt><dd>{profile.emptyCount.toLocaleString()}</dd>
              <dt>Unique</dt><dd>{profile.uniqueCount.toLocaleString()}</dd>
              <dt>Duplicates</dt><dd>{profile.duplicateCount.toLocaleString()}</dd>
              <dt>Invalid</dt><dd>{profile.invalidCount.toLocaleString()}</dd>
              <dt>Min / max</dt><dd title={`${profile.min ?? ""} / ${profile.max ?? ""}`}>{profile.min ?? "—"} / {profile.max ?? "—"}</dd>
              <dt>Length</dt><dd>{profile.minLength}–{profile.maxLength}</dd>
              <dt>Suggested</dt><dd>{profile.suggestedType} ({Math.round(profile.confidence * 100)}%)</dd>
            </dl>
          )}
        </section>
        <button className="wide-action" onClick={() => void onExport()}>Export current view…</button>
      </div>
    </aside>
  );
}
