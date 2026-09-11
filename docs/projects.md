# Projects and Python cells in Tablune 0.5

## User behavior

Home lists open workspaces and the last 20 successfully opened or saved files. Removing a recent entry does not delete the file. Missing recent paths remain visible and report an error when opened. Closing the last CSV returns to Home. Visiting Home or another workspace preserves open work.

A new project starts empty. Importing CSV/TSV data copies it into the project; the external file is not linked. Project sheets always display original row 1 and use A, B, C column addresses. Header detection and the Header control still determine what transformation scripts receive; they do not hide row 1 in a project. Creating a project from a CSV copies the current rows and view without saving, closing, or modifying the original CSV.

Tables and scripts belong to the project. Closing an internal editor tab hides it; deleting an item is a separate confirmed action. Save and Save As write the whole project. Export CSV writes a complete table; Export View writes the currently sorted/filtered table. Exporting never clears the project's unsaved state.

The Python editor remembers a table of the same project as input. It sends the complete table, not only filtered rows, using the existing `run(rows, context)` / `transform(rows, context)` protocol. Opening a project does not execute code. Run Preview requires the existing trust acknowledgement; scripts execute with normal user permissions. Python 3.10+ and packages are supplied by the local environment, not the project.

Accepting a preview creates a uniquely named, independent, editable table. Re-running adds another result. Input data and prior results are retained. Changing input data, calculation results, headers, script code, or input selection invalidates the pending preview. Sheets with formulas must have current results without formula errors before export, transformation execution, or preview acceptance. Transformations receive materialized text values, not formula source. Only one Python execution may run across the application. Navigation remains available; closing its project requires cancelling the execution first.

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

Each project has a central **Functions** editor, separate from transformation scripts:

```python
def precio_final(base, impuesto):
    return round(base * (1 + impuesto), 2)
```

Writing changes the saved draft. **Apply functions** explicitly loads and validates it; success replaces the applied module and invalidates project formulas. Failure leaves the previous applied version available and reports the error. Public synchronous functions defined in the module are callable from cells. Names matching cell references and built-ins are reserved. Built-ins are `sum`, `min`, `max`, `abs`, `round`, `len`, `int`, `float`, `str`, `bool`, and `cells`, with Python semantics.

Opening or recovering a project does not run code. Saved results appear as pending until **Enable Python** authorizes calculation for that project session. This authorization is never persisted. Functions run with the normal user's permissions; a separate process is not a security sandbox. Python 3.10+ and imported packages must exist in the selected environment. External files, clocks, and services are not tracked dependencies: use **Recalculate** to refresh them. Globals in Functions are recreated for each calculation generation; persistent global state is not part of the contract.

Edits invalidate affected formulas and their dependents; unrelated formulas retain their results. A Rust dependency graph orders evaluation and detects cycles. A reusable Python process evaluates validated expression trees, with a fresh module namespace per project generation. Macros and calculation share one application-wide queue. Navigating remains possible while a job runs; cancel a project's job before closing it. **Cancel calculation** and a timeout leave formulas pending with no automatic infinite retries; **Recalculate** resumes explicitly. Limits remain two minutes per execution, 1 MiB of module source, 1 MiB of captured console output, and 512 MiB of protocol input/output. Each formula is limited to 16 KiB, and a referenced range to 50 million cells; these are rejection limits, not performance guarantees.

## File format, version 2

A `.tablune` file is a ZIP containing:

- `manifest.json`: format version, persistent project ID and name, ordered table and script metadata, headers, dialects, selected column types, filter/sort views, and script input bindings.
- `tables/<persistent-id>.json`: an object containing `rows` (arrays of original strings) and `sheet` (sparse formula/type metadata, cached scalar/error results, pending flags, and applied-functions cache revision). Empty rows, irregular row shapes, absent cells, empty strings, Unicode, and original numeric spelling remain distinct.
- `scripts/<persistent-id>.py`: UTF-8 transformation source. Source code is omitted from the manifest's script entries.
- `functions/draft.py` and `functions/applied.py`: separate source versions; their revisions are in the manifest.

The runtime does not extract archive entries to the filesystem. It checks IDs, references, duplicate entries, archive integrity, and supported format version before registration. Limits are 2 GiB of uncompressed archive entries, 16 MiB for the manifest, and 1 MiB per script. These are validation limits, not a promise that datasets at the limit fit in available RAM. Save writes a sibling temporary file and atomically replaces the destination only after successful completion.

Version-1 projects are read without reinterpreting their data. Migration happens in memory, and the next save writes version 2. Earlier application versions reject the new format. Dependencies are rebuilt on open without running Python.

Project identity is persistent; open-session IDs are regenerated. A second copy of the same saved project has independent sessions. Reopening the same canonical path activates its existing space. Concurrent open/save operations reserve their destination path, and Save As cannot claim another open project's path.

## Persistence and recovery

Data edits, formulas, cell types, Functions drafts/applied code, script source, names, input bindings, and persisted metadata mark a project dirty. Project save commits its tables and scripts together. Undo remains per-table and session-only; it is not a persistent history or transformation pipeline. Editor selection, scrolling, and visual cell sizes survive workspace switches but are not part of the project format.

Formula edits are flushed before save/close. Saving during calculation writes a coherent snapshot, retaining pending status for unfinished results; saving never starts Python.

Draft edits are held immediately in the frontend and transferred to Rust after a short debounce. Save, execution, and closing flush pending drafts first. A failed draft write leaves the draft in the editor and prevents saving stale code. Background recovery covers dirty projects, including new projects and changes only to formulas or Functions/script drafts. Project recovery format 2 contains the same formula/type/cache/function data as the archive and still reads recovery format 1. Like CSV recovery, this is periodic crash protection, not a guarantee for the final keystrokes before a sudden exit.

Projects do not embed Python interpreters, packages, console output, preview results that were not accepted, or undo stacks. Recovery does not restart scripts, calculations, or execution authorization. The original CSV recovery formats remain supported.
