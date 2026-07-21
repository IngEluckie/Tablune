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

## Performance direction

Rust keeps the complete CSV document in memory while the frontend requests bounded `GridWindow` slices. Edits are revision-checked transactions with compact inverse operations; the frontend never receives the entire document.

Sorting and filtering create a derived row index keyed by stable internal row identifiers. The canvas renders only visible cells, and facets and profiles are calculated in Rust. The current validation target is 100,000 rows by 50 columns on Apple Silicon; streaming input and million-row files remain future work.
