# Projects and Python cells in Tablune 0.5

Autosave is on by default. The shared bar displays the switch, current save state, and Undo/Redo arrows. In a project the switch applies to the complete `.tablune` file, including tables, Markdown, scripts and Functions drafts. Standalone CSV/TSV/text tables and Markdown have independent switches. Tablune saves after a short pause, including work in background tabs, and keeps recovery enabled when autosave is off. New files require an initial Save to choose their destination. Saving a Python draft does not execute it or apply Functions.

The arrows operate on the last focused visible editor; for example, a focused sidebar script receives Undo while the table remains visible. Saving preserves history. Undo after autosave creates a new pending change, which is saved in turn. History survives tab navigation and Markdown mode switches during the session, but does not survive closing the editor or restarting the application.

## User behavior

Home lists open workspaces and the last 20 successfully opened or saved files. Removing a recent entry does not delete the file. Missing recent paths remain visible and report an error when opened. Closing the last CSV returns to Home. Visiting Home or another workspace preserves open work.

A new project starts empty. Importing CSV/TSV data copies it into the project; the external file is not linked. Project sheets always display original row 1 and use A, B, C column addresses. Header detection and the Header control still determine what transformation scripts receive; they do not hide row 1 in a project. Creating a project from a CSV copies the current rows and view without saving, closing, or modifying the original CSV.

Tables and scripts belong to the project. Tables open in the main area's tabs. Scripts and Functions open in the resizable left sidebar while the active table stays visible. **Back to project items** returns to the navigator without discarding drafts or interrupting a running script. Closing a table tab hides it; deleting an item is a separate confirmed action. Save and Save As write the whole project. Export CSV writes a complete table; Export View writes the currently sorted/filtered table. Exporting never clears the project's unsaved state.

The Python editor remembers a table of the same project as input. New and imported scripts default to the currently selected table; existing scripts retain their input binding. It sends the complete table, not only filtered rows, using the existing `run(rows, context)` / `transform(rows, context)` protocol. Opening a project does not execute code. **Run in background** requires the existing trust acknowledgement; scripts execute with normal user permissions. Python 3.10+ and packages are supplied by the local environment, not the project.

**Run in background** captures the saved script draft, complete input table, input/header/calculation revisions and selected Python executable. Each run is independent: keep editing the code or table, change tabs/spaces, or launch the same script again. Two background scripts run simultaneously; additional jobs wait in submission order. Formula calculation uses a separate runtime and continues independently.

The global **Python jobs** panel stays available on Home and in every workspace. It shows each job's state, duration, input/script revisions and interpreter. Select a job to see live stdout/stderr or its result preview. **Cancel job** affects only that execution, including a queued job. **Discard job** releases a finished job's console and any unaccepted result. At most 32 jobs are retained; discard old jobs to make room. The time limit defaults to 10 minutes, with 2 minutes, 1 hour and no limit also available; queued time is excluded. Each console stream retains its first 1 MiB and then displays a truncation marker while continuing to drain output.

**Create result table** adds a uniquely named, independent, editable table. Editing or deleting the original script/input after submission does not invalidate a project job's captured result. The panel identifies input changes; results always describe the input captured at start. Sheets with formulas must have current results without formula errors when a job starts. Transformations receive materialized text values, not formula source. Original tables and earlier results are retained.

The standalone CSV macro editor also offers **Run in background**, alongside the existing synchronous **Run Preview** workflow. Background results are accepted from the jobs panel with **Apply to CSV**, as one undoable transaction. Newer input/header revisions block application instead of overwriting edits, and the existing 64 MiB undo limit applies. Close the CSV macro editor to resume table editing while its background jobs continue; its script save/discard protection remains in place.

Cancel running and queued jobs before closing their project or CSV, or exiting the application. Jobs, console output and unaccepted results last only for the current app session; saving/autosave/recovery does not persist or resume them. Accepted result tables are saved normally. Scripts still run with normal user permissions: preview/result acceptance does not defer or undo external file/network side effects.

## Project explorer and folders

One tree replaces the separate type lists. Folders contain any mix of tables, Markdown documents, scripts, and other folders. The root button selects the project root; selecting a file selects its parent for creation/import. The ＋ menu creates/imports directly into that destination in a single backend action. Tables and documents open in the main tabs; scripts retain their side editor with the active table visible. Returning from an editor retains tree selection and expansion. Functions remains a fixed project-wide tool.

Context menus expose rename, move, export/duplicate, and content-preserving folder removal. Drag and drop moves within a project to a folder or root. Arrows/Home/End navigate visible tree items, left/right collapse/expand, and F2 renames. Move dialogs exclude the item and its descendants. Rust independently rejects cycles, missing destinations/items, duplicate sibling folder names, invalid IDs/names, depth beyond 64 folders, and more than 10,000 folders. Removing a folder lifts its direct children to its parent; conflicting folder names reject the whole action. Delete-item actions remain separate and remove placement metadata too. Table duplication inherits the source folder. Existing table/script naming rules still apply.

`organization.folders` stores stable folder IDs, names and optional `parentId`; `organization.itemFolders` maps existing item IDs to folders, omitting root placements. Items retain content IDs, script input bindings, formula addresses and archive entry paths across moves/renames. These are logical folders, not external directories or Python packages. Breadcrumbs and input-table choices show logical paths. Expansion/selection preferences are local per persistent project and do not dirty it. Structural changes participate in dirty tracking, save protection and recovery. Earlier projects deserialize with empty organization; format 5 prevents older apps from silently discarding the hierarchy.

## Formulas and types

Project cells separate original content, calculation value, and displayed result. Editing restores the original content. CSV import, CSV-to-project conversion, and version-1 migration never activate text beginning with `=` as a formula; entering a formula explicitly does. Standalone CSV documents retain their previous behavior.

Supported examples:

```python
=B1 + C1
=round(B1 / C1, 2)
=sum(cells("B2:B10"))
=precio_final(B2, C2)
=B2 if C2 > 0 else 0
```

Expressions support arithmetic (`+`, `-`, `*`, `/`, `//`, `%`, `**`), comparisons, `and` / `or` / `not`, conditional expressions, constants, and named function calls. Cell references are uppercase A1 notation with optional absolute row/column markers (`$B$1`, `B$1`, `$B1`). `cells()` accepts exactly one literal cell/range reference and returns a row-major list. References are confined to the current sheet. Attributes, indexing, comprehensions, assignments, lambdas, arbitrary code statements, and dynamic ranges are outside the supported cell expression language. Define more involved logic in Functions.

Auto types recognize unambiguous decimal numbers and Python boolean spellings `True` / `False`. `00123`, dates, and regional separators remain text. Original spelling is preserved. A cell/selection type overrides its column type; the imported header row defaults to text. An initial apostrophe forces literal text and is hidden in the displayed value. Empty cells reach Python as `None`; adding an empty or textual cell to a number produces an error rather than an implicit zero. Functions must return one text, integer, finite decimal, boolean, or `None`, not a list or an object.

The formula bar shows the active cell address and its source. While editing a formula, selecting a cell inserts a reference; dragging across cells inserts a `cells("A1:B2")` range expression. The grid shows calculation results and provides error details below the formula bar. Syntax, reference, type, division-by-zero, unknown-function, cycle, and execution errors have separate cell states.

Copy within the same sheet preserves formula source and relative references; `$` markers remain anchored. Paste values and copying to other applications use displayed TSV values. Native clipboard generation tracking distinguishes an internal copy from a subsequent external copy, even when their text matches (macOS and Windows; platforms without this tracking fall back to values). Cut copies and clears cells without moving references from other formulas. Insert/delete rewrites references in one undo transaction; deleted references become `#REF!`, and ranges expand/contract where affected. Undo/redo restores original content, types, and reference edits; calculation itself adds no history entry.

View sorting and filtering retain original addresses. Physical Apply sort to data is disabled when the sheet contains formulas. Search, filters, facets, and profiles inspect displayed results; text replacement skips formulas. Export View preserves the visible sort/filter order.

## Functions and calculation

The **Fórmulas** ribbon is available for project sheets. **Insertar función** opens a right sidebar with a searchable built-in catalog: Spanish names/descriptions, Python signatures, examples, and notes about blanks and types. **Del proyecto** lists only applied public functions; signatures and first-line docstrings are read without executing the module. Draft-only functions do not appear as callable until applied. **Editar módulo** opens the existing left-side Functions editor; **Nueva función** appends a uniquely named template without replacing imports, helpers, or other definitions. Renaming/removal is done in the module; callers must be updated too. Autocompletion uses the same catalog and accepts a suggestion with Enter or Tab. Inserting from the panel creates an editable formula or inserts a call at the current formula cursor; selecting cells supplies references, and Enter commits.

**Σ Autosuma** handles explicit rectangular selections and infers contiguous numeric values above an empty cell, falling back to the left. A single numeric cell proposes a total below it. A horizontal selection proposes its result to the right; vertical/rectangular selections propose it below the first column. The source range stays highlighted while a preview shows the exact formula and editable destination. Confirming rejects an occupied destination or one inside the source range, and writes one undoable sheet edit with the original revision. Changing data/view, selection, or read-only state invalidates the proposal. Sorted/filtered views require clearing the view first so physical range addresses remain unambiguous. Inference stops after 10,000 numeric cells with a request to select the range explicitly, never a truncated sum. Blank/text handling retains Python's existing semantics.

Calculation state and **Recalcular todo** or **Cancelar cálculo** are also available in this ribbon. Opening the catalog, selecting an entry, and preparing a sum do not execute Python. Confirming formula/input edits automatically calculates affected formulas; there is no activation button or session authorization dialog. CSV documents retain their textual behavior and do not expose this ribbon.

Each project has a **Functions** editor in the left sidebar, separate from transformation scripts:

```python
def precio_final(base, impuesto):
    return round(base * (1 + impuesto), 2)
```

Writing changes the saved draft. **Apply functions** explicitly loads and validates it; success replaces the applied module and invalidates project formulas. Failure leaves the previous applied version available and reports the error. Public synchronous functions defined in the module are callable from cells. Names matching cell references and built-ins are reserved. Built-ins are `sum`, `min`, `max`, `abs`, `round`, `len`, `int`, `float`, `str`, `bool`, and `cells`, with Python semantics.

Opening or recovering a project does not run code. Formula sources, saved results, and pending flags are retained. Current saved results can be viewed and exported without Python installed. Previously unfinished results stay pending until an input edit or **Recalcular todo**. Editing sheet content or applying Functions automatically calculates pending formulas, starting Python only when needed. This includes execution of the project’s applied Python code, without an activation dialog. Functions run with the normal user's permissions; a separate process is not a security sandbox. Python 3.10+ and imported packages must exist in the selected environment. External files, clocks, and services are not tracked dependencies: use **Recalcular todo** to refresh them. Globals in Functions are recreated for each calculation generation; persistent global state is not part of the contract.

Edits invalidate affected formulas and their dependents; unrelated formulas retain their results. A Rust dependency graph orders evaluation and detects cycles. A reusable Python process evaluates validated expression trees, with a fresh module namespace per project generation. Background script jobs have their own scheduler and processes. Calculation, interpreter changes and the legacy CSV Run Preview workflow retain their serialized queue. Navigating remains possible while a job runs; cancel a project's job before closing it. **Cancel calculation** and a timeout leave formulas pending with no automatic infinite retries; a new content edit or **Recalcular todo** resumes calculation. Choosing another Python interpreter invalidates results but does not by itself execute projects; recalculate explicitly or edit an input. Calculation and legacy CSV preview limits remain two minutes per execution (background jobs use their selected time limit), 1 MiB of module source, 1 MiB of captured console output, and 512 MiB of protocol input/output. Each formula is limited to 16 KiB, and a referenced range to 50 million cells; these are rejection limits, not performance guarantees.

## File format, version 9

A `.tablune` file is a ZIP containing:

- `manifest.json`: folder organization (`organization`), format version, persistent project ID and name, ordered table and script metadata, headers, dialects, selected column types, filter/sort views, and script input bindings.
- `tables/<persistent-id>.json`: an object containing `rows` (arrays of original strings) and `sheet` (sparse formula/type metadata, a separate `styles` map, cached scalar/error results, pending flags, and applied-functions cache revision). Empty rows, irregular row shapes, absent cells, empty strings, Unicode, and original numeric spelling remain distinct.
- `documents/<persistent-id>.md`: UTF-8 Markdown text. The manifest contains document IDs, names, revisions and image-reference mappings, without duplicating the text.
- `scripts/<persistent-id>.py`: UTF-8 transformation source. Source code is omitted from the manifest's script entries.
- `functions/draft.py` and `functions/applied.py`: separate source versions; their revisions are in the manifest.

The runtime does not extract archive entries to the filesystem. It checks IDs, references, duplicate entries, archive integrity, and supported format version before registration. Limits are 2 GiB of uncompressed archive entries, 16 MiB for the manifest, and 1 MiB per script. These are validation limits, not a promise that datasets at the limit fit in available RAM. Save writes a sibling temporary file and atomically replaces the destination only after successful completion.

Version-1 through version-6 projects are read without reinterpreting their data. Migration happens in memory, and the next save writes version 9. Earlier application versions reject the new format. Dependencies are rebuilt on open without running Python.

Project identity is persistent; open-session IDs are regenerated. A second copy of the same saved project has independent sessions. Reopening the same canonical path activates its existing space. Concurrent open/save operations reserve their destination path, and Save As cannot claim another open project's path.

## Persistence and recovery

Data edits, formulas, cell types, cell styles, Functions drafts/applied code, script source, names, input bindings, and persisted metadata mark a project dirty. Project save commits its tables and scripts together. Undo remains per-table and session-only; it is not a persistent history or transformation pipeline. Editor selection, scrolling, and visual cell sizes survive workspace switches but are not part of the project format.

Formula edits and queued formatting operations are flushed before save/close. Saving during calculation writes a coherent snapshot, retaining pending status for unfinished results; saving never starts Python. Results published after a save mark the project dirty again, so closing and recovery protect them even when no further source edits were made.

Draft edits are held immediately in the frontend and transferred to Rust after a short debounce. Save, execution, and closing flush pending drafts first. A failed draft write leaves the draft in the editor and prevents saving stale code. Background recovery covers dirty projects, including new projects and changes only to formulas or Functions/script drafts. Project recovery format 6 contains the same formula/type/cache/function data as the archive, includes image descriptors with separate binary resources, and still reads recovery formats 1 through 5. Like CSV recovery, this is periodic crash protection, not a guarantee for the final keystrokes before a sudden exit.

Projects do not embed Python interpreters, packages, console output, preview results that were not accepted, or undo stacks. Recovery does not restart scripts or calculations. The original CSV recovery formats remain supported.

## Images in cells (format 3)

Use **Edit → Insert image…** or the cell context menu to insert a PNG/JPEG into the active cell. CSV workspaces offer to create a project first. An image replaces the previous cell content as one undoable edit. Enter or double-click opens a proportional full preview, with controls to replace/remove the image and edit alternative text. Typing or pasting text replaces the image. Image rows automatically use 96 px unless manually resized; automatic heights are reconstructed on reopening. Manual grid sizing remains session-only.

Original files are embedded, so moving/deleting the source does not break a saved project. Each resource is addressed by its SHA-256 hash and shared across cells in the project. The format-3 manifest adds `assets`, mapping each hash to its format and dimensions; bytes are stored in ZIP entries `assets/<hash>`. Each cell's optional `image` metadata contains `assetId`, `name`, and `alt`. Its textual row/source representation is the filename, with formula mode disabled. Images are not scalar calculation results. Versions 1 and 2 remain readable; all new saves use version 9, which older applications reject.

Inputs must decode as PNG/JPEG and be at most 20 MiB and 25 megapixels. Resource hashes, dimensions, formats, and cell references are validated before a project is opened. Thumbnails are generated at up to 256 × 256, requested only for the current grid window with at most four requests per window, and retained in a 64 MiB decoded-image cache per mounted grid. The original is loaded on demand for preview. Unsupported or damaged input leaves the cell unchanged.

Copy/cut/paste inside Tablune preserves images across sheets and projects. The internal clipboard retains its image resources even after the source project closes. External clipboard text, pasting into CSV, and **Paste values** use filenames. Search, filtering, sorting, and profiles use filenames; replace-text and cell-type changes skip image cells. Structural edits and undo/redo preserve image references. Sorting a sheet that contains formulas remains subject to the existing restriction on physically applying sorts.

A formula that references an image receives `#VALUE!`; unrelated formulas still calculate. Python transformations with images as input are blocked in this first version. Both CSV export paths require confirmation before writing image filenames; image bytes remain in the project. Formula readiness/error rules still apply.

Recovery format 3 stores image descriptors alongside project data, and binary assets in `projects-recovery-assets/<hash>` beside the recovery manifest. Resources are written before atomically publishing that manifest; recovery reads formats 1 and 2 as before. Saves omit resources not referenced by current tables, while open sessions retain resources needed for undo and the internal clipboard. Recovery still excludes the undo history.

Image URLs, external image clipboard input, drag and drop, mixed text/image content, and Python-created images are outside this version.

## Sheet zoom

**View → Zoom** offers levels from 25% to 300%, −/+ buttons, and **Reset Zoom** (100%). Ctrl+mouse wheel and trackpad pinch gestures zoom the sheet at the pointer; ordinary two-finger scrolling still pans. Toolbar changes preserve the top-left visible part of the sheet. The controls affect the canvas, headers, images, selection, and cell editor, leaving the surrounding application at its normal size.

Zoom is independent for each open CSV/table and retained when switching editors during the session. It does not change cell dimensions, data, undo history, or the saved project format. Reset Cell Size and Reset Zoom are separate operations.

The native WebKit path handles [gesture events](https://developer.apple.com/documentation/webkitjs/gestureevent); the wheel path supports Ctrl+wheel, including precision trackpad deltas, without also applying wheel zoom during an active native pinch.

## Markdown documents (format 4)

The project explorer includes Markdown documents alongside tables and scripts. Create/import opens a main-area tab;
closing its tab hides it, while Delete removes it from the project on next save.
Document imports and copies from standalone sessions are independent snapshots.
Document-only edits participate in project dirty tracking, coherent saves and
recovery. Export is independent of project save.

Markdown image mappings share the project's content-addressed asset store with
cell images. They pin resources through undo and recovery; deleting a document
allows its unshared resources to be omitted on the next save. No external source
path is stored for a project document. See [Markdown](markdown.md).

## Cell styles (format 6)

The **Formato** ribbon stores text emphasis, colors, alignment and per-edge borders in a sparse `sheet.styles` map. Formatting empty cells does not create CSV rows. Styles survive project save, recovery and duplication; CSV export contains values only. Format-only edits do not invalidate or execute Python. See [cell styles](cell-styles.md) for controls, clipboard behavior and limits.


## Project canvases (format 7)

The explorer creates, moves, renames, duplicates and removes canvases. Their stable
IDs appear in the same organization tree and tab area as other documents. The
manifest contains canvas names/revisions; `canvases/<id>.json` contains validated
objects and connectors. Images use the shared project resource store. Recovery
format 6 can carry format-9 project data, including canvas content and its assets.
See [canvas interactions, persistence and validation](canvas.md).
