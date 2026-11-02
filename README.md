<p align="center">
  <img src="apps/desktop/public/brand/tablune-icon.png" alt="" width="128" />
  <img src="apps/desktop/public/brand/tablune-wordmark.png" alt="Tablune Sheets" width="420" />
</p>

# Tablune Sheets

Tablune Sheets is a desktop CSV editor and a Python-powered spreadsheet for local data projects, built with Rust, Tauri, React, and TypeScript.

The initial release targets macOS for development and validation, while preserving a cross-platform architecture for Windows 11.

## Current scope (0.5)

- Mixed project explorer with nested folders and creation/import destinations
- Drag/menu moves, logical breadcrumbs, and content-preserving folder removal
- Format-5 organization and recovery with backward reading

- Create standalone Markdown documents or keep them alongside tables in projects
- Edit visually with live formatting, a `/` block menu, or Markdown source mode
- Import local PNG/JPEG images, find text, navigate headings, and undo across editor modes
- Save standalone documents with portable image folders, or embed everything in a format-6 project
- Recover unsaved Markdown and protect pending edits when saving or closing


- Insert embedded PNG/JPEG images into project cells, preview them, and copy them between projects
- Write cell formulas such as `=B1 + C1` in project sheets and recalculate affected cells automatically
- Use relative/absolute references, ranges, Python expressions, and project-defined functions
- Edit the original formula in a formula bar while the grid shows its result
- Apply cell types, copy formulas with adjusted references, paste values, and undo structural changes
- Format project cells with the **Formato** tab: text, colors, borders, alignment and quick styles ([guide](docs/cell-styles.md))
- Save formulas, original text, function drafts/applied code, and cached results in format-6 projects
- Calculate automatically after edits; reopen saved results without executing Python

- Start from Home with recent files and multiple open workspaces
- Create, save, and reopen self-contained `.tablune` projects
- Keep editable tables, Python scripts, column settings, and views together
- Reuse a Python script with another input table and create independent result tables
- Import CSV data into a project or create a project from an edited CSV
- Create a new CSV document
- Open and inspect UTF-8 CSV, TSV, and semicolon-delimited files
- Zoom each sheet from View, with trackpad pinch or Ctrl+mouse wheel
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

Project tables are calculable sheets. Cross-sheet references, multi-cell formula outputs, Excel formula compatibility, cell formatting, XLSX, pipelines, external linked sources, and out-of-memory processing remain outside this release.

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

## Install on Linux (CachyOS / Arch)

Install Rust, Node.js 22+, npm, Python 3.10+, `base-devel`, and
`webkit2gtk-4.1`, then run this from the repository as your normal user:

```bash
bash scripts/install-linux.sh
```

The script downloads the pinned pnpm version, installs locked dependencies, and
builds a release with its Python resources. It installs into `~/.local` and adds
**Tablune Sheets** with its icon to the application menu. It requires Internet
access during the first build and does not require `sudo`. Run the same command
again to rebuild and update the installation. Linux compilation and GUI behavior
must be validated on the target machine.

## Quality checks

```bash
pnpm check
pnpm --dir apps/desktop test
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

## Current milestone

Tablune 0.5 adds Python calculation inside existing project sheets. Rust owns original cell content, dependency analysis, revisions, history, and persistence; a reusable Python child evaluates validated expressions and user functions. Grid rendering remains windowed. CSV files remain textual documents; saved files normalize quoting into valid CSV using the detected dialect.

## Working with projects

Choose **New project** on Home, import CSV tables, and create or import a Python script. In the left sidebar's script editor, choose an input table, run a preview, and select **Create result table** while keeping the active table visible on the right. **Back to project items** returns to the table and script list without discarding edits. Each accepted execution adds an editable copy; it never overwrites the input or a previous result. Saving a project stores all its tables and scripts in one `.tablune` file. Reopen it later and select a different table to reuse the script.

CSV workspaces retain their existing macro panel and save behavior. **Create project from this CSV** copies the current in-memory data and view, including unsaved edits, while leaving the original CSV open. Exporting a table produces a CSV and does not save the project.

## Project explorer

The left sidebar contains one folder tree for tables, Markdown documents, and Python scripts. Use **＋** to create a folder/item or import CSV, Markdown, or Python into the selected folder (selecting a file uses its parent). Click the project name to target the root. Folders can mix item types and contain nested folders.

Drag an item onto a folder or the project root, or use **⋯ → Mover a…**. Use **Renombrar** or F2 to rename, and **Quitar carpeta y conservar contenido** to lift children to the parent without deleting documents. Sibling folder-name conflicts and invalid moves are rejected before changing the project. Item menus also export content or duplicate a table. Expansion is remembered locally per project, and breadcrumbs show the active item's logical path. Scripts still edit beside the active table; returning to the explorer retains its state. **Funciones del proyecto** remains a fixed project-wide tool.

Folders live inside the portable `.tablune` project. They do not create local directories, alter Python imports, or change script input bindings. Old projects open with their items at the root; their next save writes format 6.

## Python in cells

In a project sheet, enter `10` in B1, `20` in C1, and `=B1 + C1` in A1. A1 automatically displays `30`, retains its formula, and updates when B1 or C1 changes. Imported headers remain visible in row 1; all project columns use A, B, C addresses.

Use **Fórmulas → Insertar función** to open the searchable side catalog. It explains the built-ins in Spanish and lists applied project functions with their signatures and docstrings. Inserting a function starts an editable formula; click a cell or drag a range to supply its arguments, then press Enter. The formula bar also suggests built-ins and applied project functions. **Funciones del proyecto → Nueva función** appends a template to the existing module; apply it in the Functions editor when ready.

**Σ Autosuma** proposes a formula and an editable destination before writing. Select a range, or an empty cell below/to the right of contiguous numbers. Review the highlighted range and choose **Insertar suma**. Occupied destinations and destinations inside the summed range are rejected. Autosuma requires a sheet view without sorting or filters. Calculation controls in **Fórmulas** recalculate all formulas or cancel the current calculation; browsing the catalog never runs Python.

Open **Functions**, define a function, and choose **Apply functions**:

```python
def precio_final(base, impuesto):
    return round(base * (1 + impuesto), 2)
```

Use it in a cell as `=precio_final(B2, C2)`. Editing the module saves a draft; only a successful explicit application changes the active functions. `=sum(cells("B2:B10"))` reads a row-major range. Empty cells become `None`, and `00123` remains text. An initial apostrophe forces literal text.

Python 3.10+ and any imported packages must already be installed in the user-selected environment. Projects contain source code, not Python installations or dependencies. Opening a project restores saved results and their pending status without executing Python. Editing formula inputs calculates affected cells automatically; **Recalcular todo** explicitly refreshes all formulas. Saved current results can be viewed and exported without Python installed. Unfinished results remain pending until an edit or explicit recalculation. User functions run with normal interpreter permissions, and the separate process is not a security sandbox. Exporting or transforming a sheet requires current results without formula errors. See [project and formula behavior](docs/projects.md) and [validation](docs/validation-0.5.md).

## Markdown documents

Choose **New document** on Home, or **Explorer ＋ → Nuevo documento** inside a project.
Use **Visual** for live editing and **Markdown code** for source. Type `/` for blocks,
select text for formatting, use **Insert image…**, or paste/drop an image. Selecting
an image exposes its description. **Find** (Ctrl/Cmd+F) and **Outline** navigate
the document. Ctrl/Cmd+S saves the file or its containing project.

Standalone `.md`/`.markdown` files save imported images in a neighboring
`<filename>.assets` folder. Move that folder with the Markdown file. Project
documents and images are embedded in `.tablune`; **Export Markdown…** writes an
independent document plus its resources without saving the project.

HTML, front matter and unsupported rich-text syntax stay in source mode. Remote
images and paths outside an imported document's directory tree are retained as
references but are not loaded; use Insert image to embed them locally. Projects
saved by this version use format 6 and require an application supporting format 6.
See [Markdown behavior and validation](docs/markdown.md).
