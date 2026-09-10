<p align="center">
  <img src="apps/desktop/public/brand/tablune-icon.png" alt="" width="128" />
  <img src="apps/desktop/public/brand/tablune-wordmark.png" alt="Tablune Sheets" width="420" />
</p>

# Tablune Sheets

Tablune Sheets is a performance-first desktop CSV editor built with Rust, Tauri, React, and TypeScript.

The initial release targets macOS for development and validation, while preserving a cross-platform architecture for Windows 11.

## Current scope (0.4)

- Start from Home with recent files and multiple open workspaces
- Create, save, and reopen self-contained `.tablune` projects
- Keep editable tables, Python scripts, column settings, and views together
- Reuse a Python script with another input table and create independent result tables
- Import CSV data into a project or create a project from an edited CSV
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

Projects contain multiple tables; they are not Excel workbooks. Formulas, cell formatting, XLSX support, pipelines, external linked sources, and out-of-memory processing remain outside this release.

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

Tablune 0.4 adds persistent data projects to the CSV editor and non-destructive explorer. Rust owns document and project sessions and sends windowed grid data to React, keeping the browser layer independent of total row count. Exact byte-for-byte preservation of the original quoting layout is not guaranteed; saved files are normalized into valid CSV using the detected dialect.

## Working with projects

Choose **New project** on Home, import CSV tables, and create or import a Python script. In the central script editor, choose an input table, run a preview, and select **Create result table**. Each accepted execution adds an editable copy; it never overwrites the input or a previous result. Saving a project stores all its tables and scripts in one `.tablune` file. Reopen it later and select a different table to reuse the script.

CSV workspaces retain their existing macro panel and save behavior. **Create project from this CSV** copies the current in-memory data and view, including unsaved edits, while leaving the original CSV open. Exporting a table produces a CSV and does not save the project.

Python 3.10+ and any imported packages must already be installed in the user-selected environment. Projects contain script source, not Python installations or dependencies. Opening a project never runs its scripts. See [project format and behavior](docs/projects.md) for persistence, recovery, and limits.
