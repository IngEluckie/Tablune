# Tablune 0.5 validation

Platform: Apple Silicon macOS, 2026-09-10. Frontend tooling uses the pinned pnpm 10.14.0 through Corepack. Python tests use the local `python3` interpreter. Windows native interaction has not been exercised.

## Automated checks

- TypeScript and the production frontend build pass.
- Frontend: 102 tests across 14 files pass.
- Rust workspace: 78 regular tests pass; the three opt-in benchmarks are run separately.
- `cargo clippy --workspace --all-targets -- -D warnings` passes.
- `cargo fmt --all -- --check` and `git diff --check` pass.

Formula coverage includes arithmetic, ranges, custom functions, dependency chains, incremental invalidation, cached source/result separation, conservative numbers, types, imported formula-like text, cyclic dependencies, errors, and structural undo. Reference tests include mixed absolute/relative coordinates, conditional-expression source spans, range expansion/contraction, and deletion before/inside/after a range.

Worker tests exercise reusable processes with fresh namespaces, unavailable Python/packages, invalid/reserved function declarations, cancellation, a shortened test timeout, bounded logs, and rejection of stale or cross-sheet results. Persistence tests cover format-2 source/types/caches, distinct Functions draft/applied code, script/formula recovery, version-1 archives without formula activation, corruption, atomic failed writes, path ownership, and project isolation. Existing CSV/history/view/macro tests remain passing.

Frontend tests cover raw formula editing, reference insertion without premature commit, formula-aware copy/paste, Paste values, detection of an external clipboard replacement with identical text, per-cell type changes, cell-edit flushing before save, Functions draft flushing, execution only after enabling, and closing protection during calculation.

## Measurements

These are isolated debug Rust test runs, not end-to-end UI timings or release performance guarantees. Data remains in memory.

| Fixture / operation                                           | Observed                     |
| ------------------------------------------------------------- | ---------------------------- |
| 100,000 × 50: write format-2 archive                          | 2.465 s                      |
| Read and validate archive                                     | 2.206 s                      |
| Construct project session / view                              | 0.575 s                      |
| Archive size                                                  | 2,327,217 bytes              |
| Peak Rust process RSS                                         | 438,386,688 bytes (~418 MiB) |
| Existing 100,000 × 50 CSV/core smoke test                     | 0.79 s                       |
| 10,000 formulas: parse and commit initial formulas            | 0.598 s                      |
| Initial calculation, including worker request and publication | 1.179 s                      |
| Confirm one input edit and invalidate its dependent           | 78.7 ms                      |
| Incremental calculation with the same Python process          | 32.4 ms                      |
| Formula test peak Rust process RSS                            | 256,671,744 bytes (~245 MiB) |
| Formula test peak Python child RSS                            | 55,296,000 bytes (~53 MiB)   |

The formula fixture has 10,000 rows containing A=10, B=20, and C=`=A[row]+B[row]`. Changing A5000 to 40 invalidates exactly one formula; C5000 becomes 60 and adjacent results remain 30. Reusing parsed expressions and recording metadata deltas reduced the observed input-edit time from approximately 662 ms to 79 ms. Range dependencies remain compact, though each referenced value still needs materialization for Python evaluation.

Commands:

```sh
corepack pnpm check
corepack pnpm --dir apps/desktop test
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p tablune-desktop project_100k_by_50_round_trip -- --ignored --nocapture
cargo test -p tablune-desktop handles_the_100k_by_50_validation_dataset -- --ignored --nocapture
cargo test -p tablune-desktop ten_thousand_formulas_benchmark -- --ignored --nocapture
corepack pnpm --dir apps/desktop tauri build --bundles app
```

## Native release verification

The optimized macOS `.app` builds successfully (17,956,076 bytes of bundle contents). Its ad-hoc signature passes `codesign --verify --deep --strict`. The bundle identifier, version 0.5.0, and exact copies of both bundled Python workers were checked. Executable SHA-256: `81255bfb162dd4a686da74f4765cd55e4f17829e0b192196e3f555608ed0da36`.

The packaged macOS application was used to create and save a project, paste UTF-8 test data, enter a cell formula, enable Python for the session, edit its input, define/apply `precio_final`, copy its formula with relative references, save, close, reopen with calculation disabled, re-enable calculation, and export values to CSV. Native import of `prices.csv` then added a separate sheet with its original header visible as row 1; arithmetic, input editing, the saved function, and relative formula copying were verified again on that imported sheet.

Observed results: D2=`=B2 + C2` changed from 10.16 to 15.16 when B2 changed from 10 to 15. After applying Functions, D2=`=precio_final(B2, C2)` displayed 17.4; copying into D3 adjusted its source to `=precio_final(B3, C3)` and displayed 23.2. Reopening retained these cached results while showing calculation disabled for the new session. Inspection of the saved archive confirmed both formula sources, cache values, Functions draft/applied code, UTF-8 text, and the source header. The exported CSV contains the values, and the original input file remains unchanged.

Native testing found a WebKit clipboard permission prompt that interrupted grid paste. macOS grid copy/paste now uses native NSPasteboard IPC, including the existing generation check for internal formula copies. The new frontend regression covers native read/write without browser clipboard calls; CSV and sheet copy tests pass. Native paste and relative formula copy were repeated successfully after rebuilding. Other platforms retain their browser clipboard fallback.

The automation could not confirm a selection in the native file picker's icon view. Switching the picker to list view and invoking the file's native Open Finder item action completed the import. Save dialogs worked normally. This was an automation obstacle rather than a failing CSV import.

Generated native fixtures are in `/private/tmp/tablune-05-qa/`; they contain no user dataset. The original 0.4 project draft was saved before its application was closed, and no user changes were discarded.

The verified optimized bundle replaced `/Users/josueernestogalindomorales/Desktop/Tablune Sheets.app`. The installed copy was opened from that exact path; its executable matches the verified build. It reopened both saved sheets with calculation disabled, enabled and recalculated the imported sheet, and exported `prices-imported-export.csv` with the expected header and values. The application was left on Home with no pending project changes.
