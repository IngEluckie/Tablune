# Development setup

## macOS

```bash
xcode-select --install
rustup toolchain install stable --component rustfmt --component clippy
corepack enable
pnpm install
pnpm dev
```

Python macro development and integration tests require Python 3.10 or later. The application detects Homebrew and `PATH` installations, and users can select another interpreter from the macro dialog. Tablune does not require or install third-party Python packages.

Macro files define this standard-library contract:

```python
def transform(rows, context):
    # rows is list[list[str]]; return rows or {"rows": rows, "headers": [...]}.
    return rows
```

The first supported development target is Apple Silicon macOS. Intel macOS compatibility should be kept where dependencies permit it.

## Windows 11

Install the Microsoft C++ Build Tools with the Desktop development with C++ workload, Rust stable, Node.js 22+, and pnpm. WebView2 is normally present on Windows 11.

```powershell
corepack enable
pnpm install
pnpm dev
```

## Application icons

The approved Tablune Sheets assets are committed under `apps/desktop/public/brand`, and the platform-specific application icons live under `apps/desktop/src-tauri/icons`. Regenerate the latter from `tablune-icon.png` with the Tauri icon command whenever the master artwork changes.

## Commands

```bash
cargo test --workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
pnpm check
pnpm frontend:build
```

## Project and calculation validation (0.5)

Use the pnpm version declared in `package.json` (`corepack pnpm --version` should report 10.14.0). The desktop checks can also be run directly as `corepack pnpm --dir apps/desktop check` and `corepack pnpm --dir apps/desktop test` if another pnpm shadows Corepack in PATH.

Project archive behavior is documented in `docs/projects.md`. The opt-in large-table checks are:

```sh
cargo test -p tablune-desktop project_100k_by_50_round_trip -- --ignored --nocapture
cargo test -p tablune-desktop handles_the_100k_by_50_validation_dataset -- --ignored --nocapture
cargo test -p tablune-desktop ten_thousand_formulas_benchmark -- --ignored --nocapture
```

Recorded observations and the native validation scenario are in `docs/validation-0.5.md`.

Run performance checks separately from compilation and other benchmarks to reduce contention. The 10,000-formula fixture measures initial evaluation, one confirmed input edit, and incremental evaluation with the same Python process. Its Rust RSS excludes Python child memory; macOS child RSS is recorded separately. These measurements do not expand the 100,000 × 50 in-memory validation target.
