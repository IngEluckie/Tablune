# Markdown documents

Markdown documents work independently and inside a project. They support headings,
paragraphs, emphasis, strikethrough, links, lists, task lists, quotes, code fences,
images and GFM tables. Markdown tables are text, not calculable sheets.

## Editing and persistence

- Home → New document creates an unsaved `.md`. Open accepts `.md` and `.markdown`.
- Project → Documents offers New document and Import Markdown. Documents open in
  the main tab area, independently of the sidebar's Python editor.
- Visual mode supports Markdown shortcuts, `/` insertion, selection formatting,
  image selection/description, text search and a heading outline.
- Markdown code uses CodeMirror. Undo/redo spans mode changes (up to 100 grouped
  text snapshots, with a 64 MiB target budget; a single prior document is retained).
- Opening and mode changes alone preserve source text. An actual visual edit can
  normalize Markdown spelling. HTML/unsupported nodes, YAML-style front matter
  and footnotes use source mode so they are not discarded by the visual schema.
- Save flushes pending transactions, uploads and revision-checked drafts. A failed
  draft update blocks save and retains the source for retry. Cancelled Save As or
  cancelled discard keeps the document open.
- Closing a project tab hides it; Delete removes its document. Standalone Close
  offers save, then an explicit discard/cancel decision if save is declined.
- Standalone files and project-document edits participate in crash recovery.
  Recovery is debounced protection, not a guarantee for the last keystroke.

## Images and portability

Insert image accepts PNG/JPEG up to 20 MiB and 25 megapixels. The visual editor also
accepts image file paste/drop. Image data is validated in Rust. Text is limited to
16 MiB per document. Imported document images are capped at 256 MiB; image uploads
also check a 256 MiB resource-store budget (shared across a project).

Standalone save/export writes `<name>.assets/<hash>.<format>` and relative Markdown
links. Asset writes finish before the Markdown file is atomically replaced.
Resource names are content-addressed; unrelated files are not pruned. Moving the
Markdown file to another computer requires moving its asset folder too.

Project imports collect local references relative to the source document, keep
missing references intact, and embed available supported images in the project.
The source directory's tree bounds automatic imports; absolute paths, remote URLs,
HTML images and files outside that tree are not loaded. Explicit Insert image
allows choosing a PNG/JPEG anywhere through the file picker. No remote image
fetching is required for document rendering.

The project archive shares image resources with cells. Markdown sources live in
`documents/<persistent-id>.md`; image mappings live in the format-4 manifest.
Export resolves real image nodes, including reference syntax, without rewriting
image examples in code fences. Export never clears project dirty state.

## Validation

Automated coverage includes Markdown routing, immediate draft flushing, failed
updates, project-document dirty tracking, export versus save, close cancellation,
application-exit protection, Unicode/reference-image portable round trips,
missing/remote images, failed-write preservation, project archive persistence and
recovery serialization. Existing CSV, formulas, Python, image and grid suites
remain part of the required workspace checks.

Browser validation exercises real Milkdown/CodeMirror editing against simulated
Tauri IPC. Native file dialogs, OS clipboard integration and WebKit-specific
interaction still require validation in the packaged application on each target OS.

Validation run on Linux: 162 frontend tests and 90 Rust tests pass; the three
opt-in Rust benchmarks were not run. TypeScript, Rust formatting and Clippy
checks pass. The production web build passes with a bundle-size advisory for
the lazily loaded editor and shared code. Production Chromium validation with
simulated IPC passed typing, source/visual switching, save, local image display,
alt-text preservation, cross-mode undo/redo, search and HTML-source fallback,
without browser console errors.
