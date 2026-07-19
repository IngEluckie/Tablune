# CSV MVP product scope

## Product statement

Tablune Sheets 0.1 is a desktop editor for creating, viewing, and editing delimited text files. It is not yet a general spreadsheet application.

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

## Excluded

- Formulas and calculation engine
- Styling and number formats
- Multiple worksheets
- XLSX import or export
- Charts, pivot tables, and macros
- Collaboration and cloud storage
- Automatic type conversion

## Acceptance criterion

On macOS, a user can create a document, enter values, save it as CSV, close it, reopen it, edit it, and save it again without losing or coercing textual cell values.
