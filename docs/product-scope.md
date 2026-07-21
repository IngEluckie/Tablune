# CSV editor and explorer product scope

## Product statement

Tablune Sheets 0.3 is a desktop editor and non-destructive explorer for delimited text files. It is not a general spreadsheet application.

## Included

- New document
- Open CSV, TSV, and semicolon-delimited text
- Canvas-rendered grid
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
- Find and replace
- Optional first-row headers
- Unsaved-change protection and crash recovery
- Stable multi-column sorting and typed filters
- Facets, inferred types, and column profiles
- Export current view and apply sort explicitly

## Excluded

- Formulas and calculation engine
- Styling and number formats
- Multiple worksheets
- XLSX import or export
- Charts, pivot tables, and macros
- Collaboration and cloud storage
- Automatic type conversion

## Acceptance criterion

On macOS, a user can safely edit and recover a CSV, inspect up to 100,000 rows through a windowed canvas, create non-destructive views, and export results without losing or coercing textual cell values.
