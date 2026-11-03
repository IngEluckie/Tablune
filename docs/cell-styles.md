# Cell styles: first stage

Select cells in a project table and open **Formato**. The ribbon provides:

- Negrita, Cursiva and Subrayado, with mixed-selection indicators.
- Text and fill palettes, custom colors, automatic text color and no fill.
- All, outer, inner and individual-side borders, or removal; choose border color, width and continuous/dashed line before applying.
- Left, center and right alignment.
- **Ajustar texto** wraps text into multiple lines and automatically grows row heights, including merged cells.
- Encabezado, Título, Total and Destacado presets, plus Quitar formato.

Each operation is undoable. Individual controls change only their property; presets replace the selected style. Quitar formato preserves contents and formulas. Deleting contents preserves styles. Shared borders are updated on both neighboring cells, so clearing a border removes the visible edge.

Styles belong to source cells: filtering/sorting a view formats only selected visible rows. Insert/delete shifts styles, including styles on empty cells; applying a physical sort moves styles with the rows. An operation accepts at most 100,000 selected cells and the existing sheet bounds (10 million rows, 100,000 columns). This is an operation limit, not a performance guarantee.

Normal copy/paste between project tables carries formulas and styles while the current system clipboard can be identified as the original internal copy. Paste values preserves destination styles. Platforms without a clipboard generation counter use an HTML token alongside ordinary text; when rich clipboard access is unavailable, paste falls back to plain values. External copies never reuse metadata merely because their text matches. Native clipboard behavior still needs platform-specific desktop validation.

Formatting does not execute Python or invalidate cached results. Empty styled cells do not materialize textual rows or alter CSV exports. New saves use `.tablune` format 9; formats 1–8 remain readable and migrate on save. Recovery keeps the same style metadata. Older applications cannot read format 9. CSV does not store styles; Formato offers to create a project from a standalone CSV.

Merged cells are available through Formato; see [combining cells](merged-cells.md). Number/date formats, conditional formatting and font family/size remain outside this stage.


## Ajustar texto

Select a range and toggle **Formato → Ajustar texto**. The control supports mixed
selections and applies through the existing style transaction, including undo,
redo, project saving, recovery and internal copy/paste. Quitar formato turns it off.
Wrapping only changes presentation; source text, formulas and CSV values stay the
same. Explicit line breaks are honored and long words are split when necessary.

Row heights grow automatically to fit the displayed text at the current column
width, font style and zoom. Manually chosen row heights act as minimum heights.
For a merged cell, wrapping uses the full merged width; if the combined height
is insufficient, its last row grows. Disabling wrapping restores normal/manual
heights. Measurements are derived locally from visible cells and merged anchors,
retained across horizontal scrolling, and recalculated after edits, calculation,
view or sizing changes. Automatic heights are derived again when reopening.

Rendering keeps alignment, text color and underlining on every line. Very tall
cells paint only the lines intersecting the viewport. Images retain their existing
sizing behavior. CSV workspaces offer conversion to a project to store formatting.
