# Cell styles: first stage

Select cells in a project table and open **Formato**. The ribbon provides:

- Negrita, Cursiva and Subrayado, with mixed-selection indicators.
- Text and fill palettes, custom colors, automatic text color and no fill.
- All, outer, inner and individual-side borders, or removal; choose border color, width and continuous/dashed line before applying.
- Left, center and right alignment.
- Encabezado, Título, Total and Destacado presets, plus Quitar formato.

Each operation is undoable. Individual controls change only their property; presets replace the selected style. Quitar formato preserves contents and formulas. Deleting contents preserves styles. Shared borders are updated on both neighboring cells, so clearing a border removes the visible edge.

Styles belong to source cells: filtering/sorting a view formats only selected visible rows. Insert/delete shifts styles, including styles on empty cells; applying a physical sort moves styles with the rows. An operation accepts at most 100,000 selected cells and the existing sheet bounds (10 million rows, 100,000 columns). This is an operation limit, not a performance guarantee.

Normal copy/paste between project tables carries formulas and styles while the current system clipboard can be identified as the original internal copy. Paste values preserves destination styles. Platforms without a clipboard generation counter use an HTML token alongside ordinary text; when rich clipboard access is unavailable, paste falls back to plain values. External copies never reuse metadata merely because their text matches. Native clipboard behavior still needs platform-specific desktop validation.

Formatting does not execute Python or invalidate cached results. Empty styled cells do not materialize textual rows or alter CSV exports. New saves and recovery snapshots use `.tablune` format 6; formats 1–5 remain readable and migrate on save. Older applications cannot read format 6. CSV does not store styles; Formato offers to create a project from a standalone CSV.

Number/date formats, conditional formatting, merged cells, wrapping and font family/size are outside this stage.
