# Architecture

## Principles

1. Rust owns parsing, serialization, and the durable document model.
2. The frontend renders a view of the document and submits explicit edits.
3. Large grid rendering must not require one DOM node per cell.
4. CSV values remain strings. Type inference may be added later as a non-destructive view concern.
5. Frontend/backend messages should be batched before large-file work begins.

## Initial components

```text
apps/desktop
  React + TypeScript UI
  Tauri commands and native dialogs

crates/tablune-core
  Table document and edit primitives

crates/tablune-csv
  Dialect detection, reader, writer, safe replacement

crates/tablune-history
  Bounded transaction history and state checkpoints
```

## Python macros

The desktop backend may launch a user-selected Python 3.10+ interpreter as a child process. A bundled standard-library runner exchanges versioned JSON files through a temporary directory, invokes `transform(rows, context)`, and writes a validated result. Python never writes the open CSV or mutates the Rust document directly.

Macro execution produces a revision-bound preview. Rust retains the transformed rows, sends only summary metrics and bounded samples to React, and applies an accepted result as one undoable transaction. Cell-only transformations use compact cell edits; structural transformations replace the document atomically. Results requiring more than the 64 MiB history budget cannot be applied.

Python code runs with the current user's normal permissions. Tablune provides timeout and cancellation controls, but the prototype is not a security sandbox and does not install interpreters or packages.

## Performance direction

Rust keeps the complete CSV document in memory while the frontend requests bounded `GridWindow` slices. Edits are revision-checked transactions with compact inverse operations; the frontend never receives the entire document.

Sorting and filtering create a derived row index keyed by stable internal row identifiers. The canvas renders only visible cells, and facets and profiles are calculated in Rust. The current validation target is 100,000 rows by 50 columns on Apple Silicon; streaming input and million-row files remain future work.

## Workspace and document sessions

Rust owns an ordered workspace of independently locked document sessions. Every document command carries an opaque `documentId`; there is no implicit active document in the backend. Each session keeps its own raw rows, revision, view, preferences, and bounded undo/redo history, while React owns which document is currently visible.

Canonical file paths are unique within a workspace. Opening an already open path reuses its session, and saving or renaming cannot claim a path owned by another document. The workspace lock is used only to locate or change the collection; parsing, grid queries, edits, and serialization use the selected document lock.

Crash recovery is a versioned workspace manifest containing every dirty session. Clean documents are not restored between launches. Legacy single-document recovery payloads remain readable and are promoted to a one-document workspace during restoration.

## Active document and tabs

React is the sole owner of `activeDocumentId`. The bottom document bar renders the ordered workspace returned by Rust and sends a complete ID permutation back when tabs are reordered. Rust validates that the permutation contains every open document exactly once before changing workspace order, so recovery uses that same ordering.

Each open document has a frontend `TabUiState` keyed by `documentId`. It preserves the current `ViewState`, grid selection, and horizontal and vertical scroll offsets while another tab is active. Search, Data Explorer, and Python macro surfaces are intentionally transient and close when the active ID changes. Asynchronous grid and panel callbacks retain their originating document ID and cannot be applied to whichever tab happens to be active later.

Creating or opening a document never closes another tab. Multi-file open is sequential so header suggestions can be resolved per file; successful documents remain open when another selected path fails. Only dirty sessions participate in restart recovery, and closing the final tab creates a new empty session before removing it so the desktop UI always has a visible document.
