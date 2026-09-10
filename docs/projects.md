# Projects in Tablune 0.4

## User behavior

Home lists open workspaces and the last 20 successfully opened or saved files. Removing a recent entry does not delete the file. Missing recent paths remain visible and report an error when opened. Closing the last CSV returns to Home. Visiting Home or another workspace preserves open work.

A new project starts empty. Importing CSV/TSV data copies it into the project; the external file is not linked. The first row is suggested as headers using the existing detector and enabled on project import when detected; the Header control can change it. Creating a project from a CSV copies the current rows and view without saving, closing, or modifying the original CSV.

Tables and scripts belong to the project. Closing an internal editor tab hides it; deleting an item is a separate confirmed action. Save and Save As write the whole project. Export CSV writes a complete table; Export View writes the currently sorted/filtered table. Exporting never clears the project's unsaved state.

The Python editor remembers a table of the same project as input. It sends the complete table, not only filtered rows, using the existing `run(rows, context)` / `transform(rows, context)` protocol. Opening a project does not execute code. Run Preview requires the existing trust acknowledgement; scripts execute with normal user permissions. Python 3.10+ and packages are supplied by the local environment, not the project.

Accepting a preview creates a uniquely named, independent, editable table. Re-running adds another result. Input data and prior results are retained. Changing input data, headers, script code, or input selection invalidates the pending preview. Only one Python execution may run across the application. Navigation remains available; closing its project requires cancelling the execution first.

## File format, version 1

A `.tablune` file is a ZIP containing:

- `manifest.json`: format version, persistent project ID and name, ordered table and script metadata, headers, dialects, selected column types, filter/sort views, and script input bindings.
- `tables/<persistent-id>.json`: each table as an array of arrays of strings. Empty rows, sparse row shapes, empty strings, Unicode, and textual numeric representations remain distinct.
- `scripts/<persistent-id>.py`: UTF-8 script source. Source code is omitted from the manifest's script entries.

The runtime does not extract archive entries to the filesystem. It checks IDs, references, duplicate entries, archive integrity, and supported format version before registration. Limits are 2 GiB of uncompressed archive entries, 16 MiB for the manifest, and 1 MiB per script. These are validation limits, not a promise that datasets at the limit fit in available RAM. Save writes a sibling temporary file and atomically replaces the destination only after successful completion.

Project identity is persistent; open-session IDs are regenerated. A second copy of the same saved project has independent sessions. Reopening the same canonical path activates its existing space. Concurrent open/save operations reserve their destination path, and Save As cannot claim another open project's path.

## Persistence and recovery

Data edits, scripts, names, input bindings, and persisted metadata mark a project dirty. Project save commits its tables and scripts together. Undo remains per-table and session-only; it is not a persistent history or transformation pipeline. Editor selection, scrolling, and visual cell sizes survive workspace switches but are not part of the project format.

Draft edits are held immediately in the frontend and transferred to Rust after a short debounce. Save, execution, and closing flush pending drafts first. A failed draft write leaves the draft in the editor and prevents saving stale code. Background recovery covers dirty projects, including new projects and changes only to scripts. Like CSV recovery, this is periodic crash protection, not a guarantee for the final keystrokes before a sudden exit.

Projects do not embed Python interpreters, packages, console output, preview results that were not accepted, or undo stacks. Recovery does not restart scripts. The original CSV recovery formats remain supported.
