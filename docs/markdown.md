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
  normalize Markdown spelling. Attribute-free `<br>`, `<br/>` and `<br />` markers
  render in visual mode, including the empty-paragraph markers written by the
  editor itself. Inline markers render as line breaks while retaining their raw
  value for serialization. Other HTML/unsupported nodes, YAML-style front matter
  and footnotes use source mode so they are not discarded by the visual schema.
  The compatibility notice clears when corrected source opens in visual mode.
- Project documents use the existing tab and breadcrumb for their title; save
  remains available through File or Ctrl/Cmd+S and export through the item menu.
  The document toolbar has no permanent second hint row, and both editors use
  compact page margins instead of stacked outer/inner padding.
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
`documents/<persistent-id>.md`; image mappings live in the format-6 manifest.
Export resolves real image nodes, including reference syntax, without rewriting
image examples in code fences. Export never clears project dirty state.

## Validation

Automated coverage includes Markdown routing, immediate draft flushing, failed
updates, project-document dirty tracking, export versus save, close cancellation,
application-exit protection, Unicode/reference-image portable round trips,
missing/remote images, failed-write preservation, project archive persistence and
recovery serialization. Existing CSV, formulas, Python, image and grid suites
remain part of the required workspace checks.

The visual-compatibility regression suite accepts editor-generated blank lines
and rejects attributed HTML or executable markup. Browser checks additionally
cover the heading/separator/`<br />`/blockquote case, exact unedited source across
mode changes, inline break rendering, generated empty paragraphs, cross-mode
undo/redo, clearing a stale fallback notice, tab switching and save. In a desktop
test with the ribbon pinned, the document surface starts at approximately 185 px
instead of 290 px; this varies with window width and toolbar wrapping.

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

### Vínculos a documentos

En el editor visual o en código Markdown, escribe `[[` y parte del nombre para elegir una tabla, documento o script del proyecto. También puedes elegir **Buscar archivo…** para vincular un archivo compatible del sistema. En el editor visual, pulsa el vínculo para abrir el destino en Tablune.

Las referencias internas abren el destino en una pestaña del área principal, incluidos los scripts, conservando la pestaña de origen. Si el destino ya tiene una pestaña, se activa sin duplicarla. Abrir un script por referencia no lo ejecuta.

Los vínculos de proyecto guardan el identificador del elemento, por lo que siguen funcionando si se mueve o cambia de nombre dentro del proyecto. El texto visible conserva el nombre que tenía al crear el vínculo. Los vínculos a archivos externos guardan su ruta absoluta y dejan de funcionar si el archivo se mueve o cambia de nombre. Los vínculos se guardan como enlaces Markdown con rutas reservadas para Tablune; necesitan Tablune para abrir sus destinos.
