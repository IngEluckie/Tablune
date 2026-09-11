# Sheet zoom validation

- TypeScript check and production frontend build.
- Frontend suite covers zoom limits, irregular row/image sizing, preserving stored dimensions, pointer-centered Ctrl+wheel, wheel delta modes, sub-percent trackpad accumulation, WebKit pinch scale relative to gesture start, suppression of duplicate wheel zoom during pinch, and unchanged ordinary scrolling.
- Grid integration tests verify selection/editor placement at 200% and fixed-header selection after scrolling; ribbon tests cover View percentages, increase, and reset.
- macOS release application checked with the image-cell acceptance project: View exposes the zoom controls and updates canvas text, cell dimensions and embedded images independently of the application chrome. Zoom remains a view-only operation and leaves the project saved.
- Native pinch event handling is tested with synthetic gesture events; a physical trackpad pinch is not reproducible through the available desktop automation interface.

Zoom is per open sheet, ranges from 25% to 300%, and resets to 100%. Menu changes preserve the visible top-left position; pointer gestures preserve the point under the cursor. Binary deployment uses a locally signed release bundle and keeps a backup of the prior Desktop application.
