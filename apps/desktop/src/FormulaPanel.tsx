import { useMemo, useState } from "react";
import { BUILTIN_FUNCTIONS, projectFunctions, searchFunctions, type FormulaFunction } from "./formulaCatalog";

export type FormulaPanelTab = "builtins" | "project";
export default function FormulaPanel({ appliedCode, draftCode, tab, onTab, disabled, onInsert, onManage, onClose }: {
  appliedCode: string;
  draftCode: string;
  tab: FormulaPanelTab;
  onTab: (tab: FormulaPanelTab) => void;
  disabled: boolean;
  onInsert: (name: string) => void;
  onManage?: (create: boolean) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("sum");
  const custom = useMemo(() => projectFunctions(appliedCode), [appliedCode]);
  const matches = searchFunctions(tab === "builtins" ? BUILTIN_FUNCTIONS : custom, query);
  const current: FormulaFunction | undefined = matches.find(f => f.name === selected) ?? matches[0];
  const switchTab = (next: FormulaPanelTab) => { setQuery(""); onTab(next); };
  return <aside className="formula-panel" data-formula-tools aria-label="Catálogo de fórmulas">
    <div className="formula-panel-heading"><h2>Insertar función</h2><button onClick={onClose} aria-label="Cerrar catálogo de fórmulas">×</button></div>
    <div className="formula-panel-tabs" role="group" aria-label="Origen de funciones">
      <button aria-pressed={tab === "builtins"} onClick={() => switchTab("builtins")}>Preestablecidas</button>
      <button aria-pressed={tab === "project"} onClick={() => switchTab("project")}>Del proyecto</button>
    </div>
    <label className="formula-search">Buscar función<input value={query} onChange={e => setQuery(e.target.value)} placeholder="Suma, redondear, texto…" /></label>
    {tab === "project" && <>
      <div className="formula-management"><button disabled={disabled || !onManage} onClick={() => onManage?.(false)}>Editar módulo</button><button disabled={disabled || !onManage} onClick={() => onManage?.(true)}>Nueva función</button></div>
      <p className="formula-help">{draftCode !== appliedCode ? "Hay un borrador sin aplicar. Las celdas y esta lista usan la versión aplicada." : "Funciones aplicadas a este proyecto."}</p>
    </>}
    <div className="formula-function-list" role="group" aria-label="Funciones disponibles">
      {matches.map(f => <button key={f.name} aria-pressed={f.name === current?.name} onClick={() => setSelected(f.name)}><code>{f.name}</code><span>{f.label === f.name ? f.signature : f.label}</span></button>)}
      {!matches.length && <p className="formula-help">{query ? "No hay funciones que coincidan." : "Aún no hay funciones aplicadas. Crea una función y aplica el módulo para utilizarla."}</p>}
    </div>
    {current && <section className="formula-function-detail" aria-label={`Ayuda de ${current.name}`}>
      <span className="formula-category">{current.category}</span>
      <h3>{current.label}</h3><code className="formula-signature">{current.signature}</code>
      <p>{current.description}</p>
      {!current.project && <pre>{current.example}</pre>}
      <p className="formula-help">{current.note}</p>
      <button className="formula-insert" disabled={disabled} onClick={() => onInsert(current.name)}>Insertar {current.name}()</button>
    </section>}
    <p className="formula-help formula-panel-tip">Inserta la función, selecciona sus celdas en la hoja y confirma con Enter. Arrastrar un rango inserta cells("A1:B2").</p>
  </aside>;
}
