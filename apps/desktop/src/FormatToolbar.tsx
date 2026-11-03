import { useState } from "react";
import { STYLE_PRESETS } from "./cellStyles";
import type { CellBorder, StylePatch, StyleSummary } from "./types";
export interface FormatControls {
  available: boolean;
  summary: StyleSummary | null;
  onMerge?: (action:"merge"|"center"|"split")=>void;
  mergeDisabled?:boolean;
  onApply: (patch: StylePatch) => void;
  onCreateProject?: () => void;
}
const COLORS = ["#ffffff", "#161a1f", "#e7ebf0", "#e74c3c", "#f4b942", "#fff0b3", "#245c47", "#45c982", "#2563eb", "#e7f0fc", "#8b5cf6", "#ec4899"];
function ColorPicker({ label, value, onChange, disabled, reset }: { label: string; value: string | null; onChange: (color: string) => void; disabled: boolean; reset: string }) {
  const [expanded, setExpanded] = useState(false);
  return <div className="format-color-picker">
    <button disabled={disabled} aria-expanded={expanded} onClick={() => setExpanded(!expanded)} title={value === null ? "La selección combina colores" : label}>
      <span className="format-color-sample" style={{ background: value || "transparent" }} />{label}{value === null ? " · Mixto" : ""} ▾
    </button>
    {expanded && <div className="format-palette" role="group" aria-label={`Paleta: ${label}`}>
      <button disabled={disabled} onClick={() => { onChange(""); setExpanded(false); }}>{reset}</button>
      <div className="format-swatches">{COLORS.map(color => <button key={color} disabled={disabled} aria-label={`${label} ${color}`} style={{ background: color }} onClick={() => { onChange(color); setExpanded(false); }} />)}</div>
      <label>Personalizado <input disabled={disabled} aria-label={`${label} personalizado`} type="color" value={value || "#245c47"} onChange={e => onChange(e.target.value)} /></label>
    </div>}
  </div>;
}
export default function FormatToolbar({ controls, disabled }: { controls: FormatControls; disabled: boolean }) {
  const [border, setBorder] = useState<CellBorder>({ color: "#64748b", width: 1, line: "solid" });
  if (!controls.available) return <div className="ribbon-group format-csv-notice"><span>CSV conserva datos, pero no estilos ni combinaciones. Usa un proyecto .tablune para guardar formatos.</span>{controls.onCreateProject && <button disabled={disabled} onClick={controls.onCreateProject}>Crear proyecto desde este CSV…</button>}</div>;
  const state = controls.summary;
  const locked = disabled || !state;
  return <div className="ribbon-group format-toolbar" aria-label="Formato de celdas" data-format-tools>
    <div className="format-section" role="group" aria-label="Texto">
      {([['bold', 'Negrita', 'N'], ['italic', 'Cursiva', 'C'], ['underline', 'Subrayado', 'S']] as const).map(([property, label, text]) => <button key={property} className={`format-${property}`} disabled={locked} title={label} aria-label={label} aria-pressed={state?.[property] === null ? "mixed" : state?.[property] ?? false} onClick={() => controls.onApply({ [property]: state?.[property] !== true })}>{text}</button>)}
      <ColorPicker label="Texto" value={state?.textColor ?? null} disabled={locked} reset="Color automático" onChange={textColor => controls.onApply({ textColor })} />
      <ColorPicker label="Relleno" value={state?.background ?? null} disabled={locked} reset="Sin relleno" onChange={background => controls.onApply({ background })} />
    </div>
    <div className="format-section" role="group" aria-label="Bordes">
      <select disabled={locked} aria-label="Aplicar bordes" value="" onChange={e => { if (e.target.value) controls.onApply({ borders: { preset: e.target.value as NonNullable<StylePatch['borders']>['preset'], border } }); }}>
        <option value="" disabled>Bordes…</option>
        <option value="all">Todos los bordes</option><option value="outer">Bordes exteriores</option><option value="inner">Bordes interiores</option>
        <option value="top">Borde superior</option><option value="right">Borde derecho</option><option value="bottom">Borde inferior</option><option value="left">Borde izquierdo</option><option value="none">Quitar bordes</option>
      </select>
      <input disabled={locked} aria-label="Color del borde" title="Color del borde" type="color" value={border.color} onChange={e => setBorder({ ...border, color: e.target.value })} />
      <select disabled={locked} aria-label="Grosor del borde" value={border.width} onChange={e => setBorder({ ...border, width: Number(e.target.value) as 1 | 2 | 3 })}><option value={1}>Fino</option><option value={2}>Medio</option><option value={3}>Grueso</option></select>
      <select disabled={locked} aria-label="Línea del borde" value={border.line} onChange={e => setBorder({ ...border, line: e.target.value as CellBorder['line'] })}><option value="solid">Continua</option><option value="dashed">Discontinua</option></select>
    </div>
    <div className="format-section" role="group" aria-label="Alineación">
      {([['left', 'Izquierda', '⇤'], ['center', 'Centro', '↔'], ['right', 'Derecha', '⇥']] as const).map(([alignment, label, text]) => <button key={alignment} disabled={locked} title={label} aria-label={`Alinear: ${label}`} aria-pressed={state?.alignment === alignment} onClick={() => controls.onApply({ alignment })}>{text}</button>)}
    </div>
    <div className="format-section"><button disabled={locked} aria-label="Ajustar texto" aria-pressed={state?.wrapText===null?"mixed":state?.wrapText??false} onClick={()=>controls.onApply({wrapText:state?.wrapText!==true})}>Ajustar texto</button></div>
    <div className="format-section" role="group" aria-label="Combinar celdas">
      <button disabled={disabled||controls.mergeDisabled||!controls.onMerge} onClick={()=>controls.onMerge?.("merge")}>Combinar celdas</button>
      <button disabled={disabled||controls.mergeDisabled||!controls.onMerge} onClick={()=>controls.onMerge?.("center")}>Combinar y centrar</button>
      <button disabled={disabled||controls.mergeDisabled||!controls.onMerge} onClick={()=>controls.onMerge?.("split")}>Separar celdas</button>
    </div>
    <div className="format-section">
      <select disabled={locked} aria-label="Estilos rápidos" value="" onChange={e => { if (e.target.value) controls.onApply(STYLE_PRESETS[e.target.value]); }}><option value="" disabled>Estilos rápidos…</option>{Object.keys(STYLE_PRESETS).map(name => <option key={name}>{name}</option>)}</select>
      <button disabled={locked} onClick={() => controls.onApply({ reset: true })}>Quitar formato</button>
    </div>
  </div>;
}
