# Architecture

## Principles

1. Rust owns parsing, serialization, and the durable document model.
2. The frontend renders a view of the document and submits explicit edits.
3. Large grid rendering must not require one DOM node per cell.
4. Original cell content remains textual; project sheets add sparse formula/type metadata and separate calculated scalar/error values.
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

The desktop backend may launch a user-selected Python 3.10+ interpreter as a child process. A bundled standard-library runner exchanges versioned JSON files through a temporary directory, invokes `run(rows, context)` or `transform(rows, context)`, and writes a validated result. Python never writes the open CSV or mutates the Rust document directly.

The legacy CSV macro workflow produces a revision-bound preview. Rust retains the transformed rows, sends only summary metrics and bounded samples to React, and applies an accepted result as one undoable transaction. Cell-only transformations use compact cell edits; structural transformations replace the document atomically. Results requiring more than the 64 MiB history budget cannot be applied.

Python code runs with the current user's normal permissions. Script selection accepts `.py` files only. Tablune creates private temporary directories and terminates the launched process tree on timeout or cancellation, but the prototype is not a security sandbox and does not install interpreters or packages.

## Background Python jobs

`python_jobs.rs` owns a managed, session-local registry with monotonically increasing job IDs. Each submission captures code, source directory, input rows/metadata and a resolved interpreter. Project locks and CSV file-operation reservations coordinate submission with close. The scheduler starts at most two independent script processes and takes queued jobs in ID order; up to 32 active/finished jobs are retained. No background job acquires `PYTHON_QUEUE` or uses the calculation runtime.

Each job has its own `RuntimeInner`, cancellation flag, bounded console buffers and pending result. `run_macro` starts Python unbuffered (`-u`), drains stdout/stderr pipes on separate readers and retains at most 1 MiB of each stream. A process guard covers early failures; cancellation registration and spawn share the runtime lock. The configured timeout applies after process launch, not while queued. Cancelling one job never touches another runtime. Application exit requests cancellation of all jobs and the legacy runtime.

`PythonJobsPanel` polls job summaries independently of editors, and the selected job's console/preview every 350 ms while expanded. Polls never overlap and late responses are ignored after selection/unmount. The list stays available across workspace navigation. Only summaries, bounded logs and sample previews cross IPC; transformed rows remain in Rust. A result is consumed after successful incorporation, or released by explicit discard. CSV application checks the captured identity/header/revision and undo budget. Project application creates a new table using captured metadata even when the source script/table has changed or been removed. Jobs/results are not archived or recovered.

## Performance direction

Rust keeps the complete CSV document in memory while the frontend requests bounded `GridWindow` slices. Edits are revision-checked transactions with compact inverse operations; the frontend never receives the entire document.

Sorting and filtering create a derived row index keyed by stable internal row identifiers. The canvas renders only visible cells, and facets and profiles are calculated in Rust. The current validation target is 100,000 rows by 50 columns on Apple Silicon; streaming input and million-row files remain future work.

## Workspace and document sessions

Rust owns an ordered workspace of independently locked document sessions. Every document command carries an opaque `documentId`; there is no implicit active document in the backend. Each session keeps its own raw rows, revision, view, preferences, and bounded undo/redo history, while React owns which document is currently visible.

Canonical file paths are unique within a workspace. Opening an already open path reuses its session, and saving or renaming cannot claim a path owned by another document. The workspace lock is used only to locate or change the collection; parsing, grid queries, edits, and serialization use the selected document lock.

Crash recovery is a versioned workspace manifest containing every dirty session. Clean documents are not restored between launches. Recovery serialization borrows the in-memory rows instead of cloning the full workspace, and an identity/revision fingerprint avoids rewriting an unchanged manifest. Legacy single-document recovery payloads remain readable and are promoted to a one-document workspace during restoration.

Successful CSV replacement is the save commit point. Once it succeeds, the session path and clean revision are updated even if a later preference or recovery-maintenance write fails; those secondary failures are reported without leaving the UI in a false unsaved state.

## Active document and tabs

React is the sole owner of `activeDocumentId`. The bottom document bar renders the ordered workspace returned by Rust and sends a complete ID permutation back when tabs are reordered. Rust validates that the permutation contains every open document exactly once before changing workspace order, so recovery uses that same ordering.

Each open document has a frontend `TabUiState` keyed by `documentId`. It preserves the current `ViewState`, grid selection, horizontal and vertical scroll offsets, and sparse visual row/column sizing overrides while another tab is active. Sizing overrides are intentionally session-only, never mark CSV data dirty, and are discarded when the corresponding row or column mapping changes. Search, Data Explorer, and Python macro surfaces are intentionally transient and close when the active ID changes. Asynchronous grid and panel callbacks retain their originating document ID and cannot be applied to whichever tab happens to be active later.

Search ranges are expressed either in source coordinates or in current-view coordinates. A selection search in a sorted or filtered grid follows the visible rows, while document-wide search follows source order. Replace-one targets the active result explicitly; replace-all is exhaustive rather than inheriting the interactive result-display limit.

Creating or opening a document never closes another tab. Multi-file open is sequential so header suggestions can be resolved per file; successful documents remain open when another selected path fails. Only dirty sessions participate in restart recovery, and closing the final CSV tab returns to Home without creating another document.

Duplicating a saved document snapshots its current in-memory rows and dialect, writes the first available incremented sibling path, and inserts a clean session immediately after the source. The frontend commits the returned workspace without changing `activeDocumentId`, so the new tab opens in the background while unsaved changes remain on the original.

## Project spaces

`useWorkspace` owns Home navigation, open spaces, recent files, script drafts, and project lifecycle. Table tabs and the selected sidebar Python editor are tracked independently per project. `ProjectSidebar` switches between the navigator and Python editing while keeping the table workspace visible. `CsvWorkspace` supplies the shared table editing experience. Its targeted grid commands include a document ID so a command cannot reach another mounted workspace, and its global shortcuts ignore events from the sidebar editor. Script editors remain mounted while navigating; drafts are flushed through a serialized queue before saving or running.

Rust stores project ownership above `DocumentSession`. Persistent IDs identify projects, tables, and scripts in the archive; runtime IDs identify open sessions, allowing separate copies of one project to remain independent. A table directory resolves project grid queries independently. Project save briefly locks its scripts and tables to capture a coherent snapshot, then releases the edit locks before compression and atomic replacement. A separate save lock prevents overlapping file operations. Completion acknowledges the captured signature and table states; edits and calculation results received during I/O remain dirty. CSV saves use the same snapshot/checkpoint principle on blocking workers. Manual project saves retain their existing UI lock; autosave leaves the editors available.

The archive codec lives separately from the CSV parser. Project saves replace one ZIP atomically. Project jobs record the script and input revisions for provenance. Accepting a completed job creates a new table from its captured input and uses no input-table undo entry. CSV macros continue to use the existing undoable apply operation.

Project crash recovery has its own versioned manifest (`projects-recovery.json`) alongside the compatible CSV recovery manifest. It includes dirty projects and script drafts acknowledged by Rust; it excludes running processes, previews, Python environments, and undo history. Clean projects appear in recent files instead of reopening automatically.

## Calculation (0.5)

`formulas.rs` uses RustPython Parser to construct an allowlisted expression tree and collect cell/range references. A lexical layer preserves reference spans and absolute markers without rewriting string literals. Parsed trees are reused for unchanged formula source. Reverse dependency indexes use direct cell keys and compact rectangles for ranges. Topological evaluation detects cycles before invoking Python.

`sheet_session.rs` extends existing document transactions with sparse metadata changes. Raw `TableDocument` strings remain editable source; cached values drive the view. Structural operations rewrite references atomically, and undo stores only changed metadata. Content revisions and calculation revisions are distinct. Recalculating rebuilds the view without making an independent undo step. Project headers remain source row 1.

`calculation.rs` snapshots pending formulas and referenced values, binds requests to project generation, sheet identity, calculation input revision, and applied-functions revision, and rejects stale publication. A separate runtime input revision advances on edits/undo/redo/type changes, allowing view changes during calculation without discarding valid results. `calculation_worker.rs` owns a reusable subprocess and exchanges bounded JSON through private temporary files. The worker interprets validated trees rather than evaluating raw cell text. User Functions code is explicitly activated Python code with normal interpreter permissions. Each generation builds a new module namespace; source edits only update the persisted draft until successful application.

Calculations, interpreter changes and legacy CSV previews share an async mutex covering execution and publication. Background jobs use independent runtimes and a separate two-process scheduler. Project state is locked only for preparation/publication; Python runs outside document locks. Worker reservation and generation checks share the project lock so cancellation cannot miss a job during startup. Interpreter changes join the same queue and invalidate cached results. Formula results are published through `tablune-calculation` project summaries, and grid windows include displayed values plus editable cell information. React batches confirmed edits before scheduling a new generation.

Format 2 stores raw rows plus sparse sheet metadata in each table entry, and keeps Functions draft/applied source separately. Recovery uses the same metadata and reads older formats. Loaded caches retain their saved pending status; no calculation process starts on opening or recovery. A runtime calculation checkpoint tracks sheet input revisions and applied-functions revision. Automatic requests are ignored until these inputs change; view changes and unmodified pending results cannot start a job. Attempts consume that checkpoint so errors and cancellation cannot loop. Recalculate-all explicitly bypasses it. Calculation revisions participate in the project save/recovery signature, including results published after a save. Export and transformation snapshots materialize current results. Legacy previews check current revisions on acceptance; independent project jobs retain their captured results across subsequent edits.

On macOS, grid clipboard reads/writes use small NSPasteboard IPC commands to avoid WebKit's additional paste authorization prompt. Clipboard generation still guards formula-aware copies; other platforms retain the browser clipboard fallback.

## Markdown sessions

`markdown.rs` owns standalone Markdown sessions and project-document commands.
Standalone summaries are separate from tabular `DocumentSummary`; project
documents live in `ProjectData.markdown`. Revision checks protect text edits.
Images use the shared PNG/JPEG validation and SHA-256 storage. `pulldown-cmark`
locates real image references for export, including reference-style images,
without rewriting code examples. Export publishes assets before atomic text
replacement. Canonical-path checks protect other open documents.

`MarkdownEditor` loads lazily. Milkdown/ProseMirror handles visual editing and
CodeMirror handles source. A standard Markdown image node view resolves bytes
through IPC into object URLs, never navigates the WebView or fetches remote
images. A bounded per-editor source history survives mode changes; cursor and
scroll state survive workspace changes because editors remain mounted. Opening
a visual editor never publishes its initial normalized serialization. Unsupported
AST nodes fall back to source.

`useWorkspace.flushDrafts` drains editor transactions and image uploads before
revision-checked text updates, save or close. Standalone recovery is versioned
separately; project recovery format 6 includes Markdown alongside existing data.
Archive format 7 stores Markdown source in `documents/<id>.md` and still reads formats 1–6.

## Shared save and editor capabilities

`SaveCoordinator` schedules persistence by destination, independently of the visible editor. `useWorkspace` registers standalone CSV/TSV/text tables, standalone Markdown, and project targets. A project target includes every table, document, script and Functions draft. New document types implement `SaveTarget` (`id`, preference key, path, dirty/revision state and a save callback); they do not introduce timers in their UI. Saves are debounced for 2 seconds with a 10-second maximum wait during continuous confirmed edits. Manual Save, Save As and autosave share the destination queue. Background failures retain dirty state and retry with bounded backoff; other destinations continue saving.

Autosave defaults to enabled. Preferences are local and remembered by file path, with session choices carried to the first Save or Save As. Untitled targets remain in recovery until the user chooses a path; background work never opens a file dialog. Recovery is independent of the switch. Background draft flushing waits for confirmed cell transactions and Markdown image imports without committing an active cell editor. Explicit save/close still commits the active cell. Close suspends scheduling, waits for writes already in flight, and saves enabled targets immediately. Remaining dirty documents (untitled, disabled or failed saves) retain the save/discard dialog; scheduling stays suspended during that decision.

`useEditorHistory` registers each editor's own history implementation with a stable editor ID and destination scope. `DocumentActions` resolves the last focused visible editor, with the selected document as fallback, and exposes accessible SVG arrows plus save state. Tables retain Rust transactions, Markdown retains its bounded source history across visual/source mode changes, and Python/Functions retain CodeMirror history. Save acknowledgements do not recreate editors or add undo entries. Histories are session-local; crash recovery restores document content, not undo stacks.

## Project organization (format 5)

`ProjectData.organization` defaults to empty when reading formats 1–4. Folder records have stable IDs, names and parent IDs; a sparse item-to-folder map places existing tables, scripts and Markdown. ZIP payload paths remain ID-based. `project_tree.rs` validates a candidate organization before committing changes, including missing parents/items, folder ID collisions, sibling name collisions, cycles, depth (64) and count (10,000). Creation/import validates the destination first and records placement under the same project lock. Folder removal lifts children to the parent; deletion cleans up item placements.

Archive writers use version 7; the recovery envelope remains version 6 with versioned project data. Organization is included in the project signature, so structural edits participate in dirty tracking and recovery without changing script input IDs or invalidating Python modules. `ProjectExplorer` provides a mixed tree with keyboard navigation, project-scoped drag payloads, and locally remembered expansion/selection by persistent project ID. Breadcrumbs and input-table choices use the same logical path helpers. Scripts and Functions retain their side-editor lifecycle.

## Cell formatting (format 6)

`session::styles` validates formatting patches and maps visible selections to source rows. `SheetData.styles` is sparse and independent of formula/type/cache metadata, including for empty cells. Style-only history records update display revision and dirty state without changing the calculation input revision or overwriting asynchronously published results. Structural edits shift styles; applied sorting moves them by stable row IDs.

`FormatToolbar` emits queued `formatCells` edits through `CsvGrid`; save/close waits for that queue. `sheet_style_summary` supplies mixed-selection state. The windowed canvas renders fills, font emphasis, alignment and shared-edge borders. Normal internal paste carries explicit styles; values-only paste preserves destination styles. Native clipboard generation, or a per-copy HTML marker when unavailable, prevents reusing internal metadata for unrelated external text.


## Project canvas documents

`CanvasEditor` owns interactive SVG editing and bounded undo snapshots, using the
shared active-editor history registry. `useWorkspace` holds immediate canvas
drafts and flushes revision-checked `updateCanvas` actions before project save,
close, or recovery. Failed updates retain drafts. Pending image operations share
the editor flush registry so save waits for their resulting nodes. Viewport and
grid preferences are local UI state keyed by persistent project/canvas identity.

Rust validates geometry, IDs, styles, endpoints and image references before
replacing a canvas. Format 7 archives separate each canvas scene into JSON;
resource retention includes canvas image nodes. Missing linked documents are
valid references rendered as unavailable cards. SVG/PNG export uses the same
node/edge drawing components and embeds images, independently of project saving.
