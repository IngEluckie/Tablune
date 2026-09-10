# Tablune 0.4 product scope

## Product statement

Tablune Sheets 0.4 is a desktop CSV editor and a persistent local workspace for data projects. It is not a general spreadsheet application.

## Included

- Home, recent files, and multiple simultaneously open project/CSV spaces
- Self-contained, versioned `.tablune` project files with atomic saving
- Project tables and Python scripts with independent central editor tabs
- Script input selection and reusable preview-to-result-table workflow
- Project-wide dirty protection and recovery, including script-only changes
- CSV-to-project copying and table/script import and export

- New document
- Duplicate the current document beside its source without changing the active tab
- Open CSV, TSV, and semicolon-delimited text
- Canvas-rendered grid
- Visual row-height and column-width resizing with visible-content auto-fit
- Cell selection and editing
- Keyboard navigation
- Insert and delete rows and columns
- Clipboard operations
- Undo and redo
- Save and Save As
- Unsaved-change indication
- Delimiter and line-ending detection
- UTF-8 and UTF-8 BOM input
- Continuous range and whole row/column selection
- Find and replace, including visible selections in sorted or filtered views
- Optional first-row headers
- Unsaved-change protection and crash recovery
- Stable multi-column sorting and typed filters
- Facets, inferred types, and column profiles
- Export current view and apply sort explicitly
- Full-document Python macros using a user-managed Python environment
- Macro editor, `.py` script open/save, mandatory preview, process-tree cancellation, and atomic undo

## Excluded

- Formulas and calculation engine
- Styling and number formats
- Excel workbook/worksheet compatibility
- Formula engines, transformation pipelines, and linked external sources
- XLSX import or export
- Charts and pivot tables
- Sandboxed macros, package installation, and managed Python environments
- Collaboration and cloud storage
- Automatic type conversion

## Acceptance criterion

On macOS, a user can safely edit and recover a CSV, inspect up to 100,000 rows through a windowed canvas, create non-destructive views, preview and undo Python transformations, and export results without losing or coercing textual cell values.
