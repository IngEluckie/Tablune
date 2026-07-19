# Tablune Sheets

Tablune Sheets is a performance-first desktop CSV editor built with Rust, Tauri, React, and TypeScript.

The initial release targets macOS for development and validation, while preserving a cross-platform architecture for Windows 11.

## MVP scope

- Create a new CSV document
- Open and inspect CSV files
- Edit cell values
- Insert and delete rows and columns
- Copy, cut, and paste tabular data
- Undo and redo edits
- Save and Save As without silently changing cell contents
- Preserve CSV quoting, delimiters, line endings, and UTF-8 text where possible

The MVP deliberately excludes formulas, cell formatting, multiple worksheets, and XLSX support.

## Architecture

- `apps/desktop`: Tauri desktop shell and React user interface
- `crates/tablune-core`: in-memory table model and edit operations
- `crates/tablune-csv`: CSV parsing, dialect handling, and serialization
- `crates/tablune-history`: command-based undo and redo
- `docs`: product scope and technical decisions

## Development status

The repository is in the initial bootstrap phase. The first milestone is a macOS application that can create, open, edit, save, close, and reopen a CSV file without altering its textual values.
