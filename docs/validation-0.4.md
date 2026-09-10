# Tablune 0.4 validation

Validated on macOS / Apple Silicon, 2026-09-10, using the project's pinned pnpm 10.14.0 through Corepack.

## Automated checks

- `pnpm check`: TypeScript passes.
- `pnpm --dir apps/desktop test`: 92 tests across 13 files pass.
- `cargo test --workspace`: 61 regular tests pass; two expensive benchmarks are intentionally ignored in this command and were run separately.
- `cargo clippy --workspace --all-targets -- -D warnings`: passes.
- `cargo test -p tablune-desktop project_100k_by_50_round_trip -- --ignored --nocapture`: passes.
- `cargo test -p tablune-desktop handles_the_100k_by_50_validation_dataset -- --ignored --nocapture`: passes.
- Tauri debug application bundle builds successfully for macOS.

The new coverage exercises archive fidelity and corruption handling, failed saves, clean state after save, independent project copies, script revisions, input removal, project-only script recovery, CSV conversion without changing the source, independent editable Python outputs, stale-preview rejection, path reservations, and access to another project's tables while a project save lock is held. Frontend coverage includes Home, project creation, StrictMode recovery, retained drafts after failed writes, cancelled saves, running-script close protection, native Quit, and navigation during project saves.

## Dataset measurement

One synthetic table of 100,000 rows × 50 text cells, with repetitive numeric-looking strings. Measurements use a debug Rust test executable, not a release-build performance guarantee or an end-to-end UI benchmark.

| Operation | Observed |
| --- | --- |
| Write archive | 2.39 s |
| Read and validate archive | 2.27 s |
| Construct table session and view | 0.50 s |
| Archive size | 2,322,666 bytes |
| Peak process RSS during this test | 437,436,416 bytes (~417 MiB) |
| Existing CSV/core large-table smoke test | 0.74 s |

Buffering JSON writes before compression reduced archive writing from approximately 17 seconds to 2.39 seconds on this fixture. Data remains fully resident in memory; these results do not establish support for datasets larger than RAM.

## Native workflow

The packaged macOS application was used to create a project, import a UTF-8 CSV, import a Python script, preview and create an independent result, save, close, and reopen from Home's recent files. A second CSV was then imported and selected as the same script's input; its preview and second independent result were verified and exported to CSV.

Direct inspection of the saved ZIP and exported CSV verified that source names (`José`, `Ana`) remained unchanged, outputs contained the transformed values, and textual numeric values such as `0012.30` and `0020.00` retained their leading zeroes. These were generated test fixtures, not user datasets.

Windows compilation and native interaction were not exercised. The archive and atomic replacement implementation retain the existing cross-platform code paths.

A script-only edit was also restored through the native recovery prompt, retaining all four project tables. Native Cmd+Q now routes through the application's save/discard dialog instead of macOS's predefined immediate termination action. Both Cancel (project remains open with its draft) and Save (pending script persisted before exit) were verified in the packaged application.
