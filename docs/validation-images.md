# Image cells validation

## Automated checks

- TypeScript project check and Vite production build.
- Frontend suite, including image import failures, captured destination revisions, CSV export confirmation, obsolete thumbnail requests, and a 64 MiB cache exercised with 1,000 images.
- Rust workspace tests and Clippy with warnings denied. Image coverage includes PNG/JPEG decoding, hash and dimension verification, oversized/corrupt inputs, atomic edits, undo/redo, row/column changes, formula propagation, 1,000-cell windowed reads, filtering/search, replace-text exclusions, ZIP round trips, duplication, resource pruning, and recovery from separate binaries.
- Existing CI matrix covers macOS and Windows. Frontend tests are now included in both jobs; the Windows job still needs to run in CI for these changes.

## macOS application acceptance

Built and launched a debug macOS bundle with a separate application identifier (`com.tablune.image-validation`) to keep test preferences/recovery separate from the user's application.

Verified with the native file dialog and actual WebView:

1. Insert a PNG into A1; row expands and a proportional thumbnail appears.
2. Open the full preview by double-click; save alternative text.
3. Copy to B1, delete, and undo; both cells retain images.
4. Save the project; inspect its ZIP and confirm format 3, two cell references, and one shared binary resource.
5. Delete the temporary source PNG.
6. Copy the cell, close the source project, create a different project, and paste. Enter opens its original image and preserved alternative text.
7. Reopen the saved source project with its source PNG absent. Both cells and the full preview remain available.
8. Close the test application, saving the destination project.

Test artifacts were saved to the system temporary directory. No production project files were edited during this acceptance run.
