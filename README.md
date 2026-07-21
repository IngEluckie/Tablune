# Tablune Sheets

Tablune Sheets is a performance-first desktop CSV editor built with Rust, Tauri, React, and TypeScript.

The initial release targets macOS for development and validation, while preserving a cross-platform architecture for Windows 11.

## Current scope (0.3)

- Create a new CSV document
- Open and inspect UTF-8 CSV, TSV, and semicolon-delimited files
- Edit cell values in a virtualized canvas grid
- Insert and delete rows and columns
- Copy, cut, and paste tabular data
- Undo and redo edits
- Save and Save As without silently coercing textual values
- Detect and retain the delimiter and line-ending convention when practical
- Find and replace values with document, range, and cell scopes
- Suggest and persist a non-destructive header row
- Protect unsaved work and restore a recovery snapshot after an unexpected exit
- Sort and filter without mutating the source document
- Explore facets, inferred column types, and column quality profiles
- Export the current view or explicitly apply a sort to the document

The MVP deliberately excludes formulas, cell formatting, multiple worksheets, and XLSX support.

## Architecture

- `apps/desktop`: Tauri desktop shell and React user interface
- `crates/tablune-core`: in-memory table model and edit operations
- `crates/tablune-csv`: CSV parsing, dialect detection, and serialization
- `crates/tablune-history`: reusable undo and redo history
- `docs`: product scope and technical decisions

## Prerequisites

- Rust stable toolchain
- Node.js 22 or newer
- pnpm
- macOS: Xcode Command Line Tools
- Windows 11: Microsoft C++ Build Tools and WebView2

## Run on macOS

```bash
xcode-select --install
corepack enable
pnpm install
pnpm dev
```

## Quality checks

```bash
pnpm check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

## Current milestone

Tablune 0.3 is a trustworthy CSV editor and non-destructive data explorer. Rust owns the document session and sends windowed grid data to React, keeping the browser layer independent of total row count. Exact byte-for-byte preservation of the original quoting layout is not guaranteed; saved files are normalized into valid CSV using the detected dialect.
