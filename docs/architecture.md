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
  Undo and redo state transitions
```

## Performance direction

The first implementation loads the complete document into memory. That is intentional for correctness and iteration speed. The public APIs must remain compatible with later row indexing, streaming reads, and patch-based edits for larger files.

The canvas grid renders only visible cells. CSV parsing and serialization stay in Rust. Before advertising large-file support, benchmarks must define realistic limits on Apple Silicon and Windows 11 hardware.
