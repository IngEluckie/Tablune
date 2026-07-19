# Tablune Sheets

Tablune Sheets is a performance-first desktop CSV editor built with Rust, Tauri, React, and TypeScript.

The initial release targets macOS for development and validation, while preserving a cross-platform architecture for Windows 11.

## MVP scope

- Create a new CSV document
- Open and inspect UTF-8 CSV, TSV, and semicolon-delimited files
- Edit cell values in a virtualized canvas grid
- Insert and delete rows and columns
- Copy, cut, and paste tabular data
- Undo and redo edits
- Save and Save As without silently coercing textual values
- Detect and retain the delimiter and line-ending convention when practical

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

The first milestone is a macOS application that can create, open, edit, save, close, and reopen a CSV file without altering its textual cell values. Exact byte-for-byte preservation of the original quoting layout is not an MVP guarantee; saved files are normalized into valid CSV using the detected dialect.
