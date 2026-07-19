# Development setup

## macOS

```bash
xcode-select --install
rustup toolchain install stable --component rustfmt --component clippy
corepack enable
pnpm install
pnpm dev
```

The first supported development target is Apple Silicon macOS. Intel macOS compatibility should be kept where dependencies permit it.

## Windows 11

Install the Microsoft C++ Build Tools with the Desktop development with C++ workload, Rust stable, Node.js 22+, and pnpm. WebView2 is normally present on Windows 11.

```powershell
corepack enable
pnpm install
pnpm dev
```

## Bootstrap icon

Until the approved Tablune application icon assets are committed, the Rust build script creates a small temporary icon locally so Tauri development builds can compile on macOS and Windows. The generated file is ignored by Git and must be replaced before packaging a release.

## Commands

```bash
cargo test --workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
pnpm check
pnpm frontend:build
```
