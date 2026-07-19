# Contributing

## Ground rules

- Preserve CSV values as text unless the product explicitly introduces typed columns.
- Keep platform-specific code behind small interfaces.
- Add regression fixtures for every CSV parsing or serialization bug.
- Measure performance-sensitive changes instead of assuming they are faster.
- Do not introduce spreadsheet formulas, formatting, or XLSX concerns into the CSV MVP without an approved scope change.

## Local checks

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm install
pnpm check
```

Use focused pull requests and explain user-visible behavior changes in the PR description.
