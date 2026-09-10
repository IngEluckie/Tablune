import type { MacroPreview } from "./types";
export default function MacroPreviewResults({
  preview,
  stale = false,
  showUndo = true,
}: {
  preview: MacroPreview;
  stale?: boolean;
  showUndo?: boolean;
}) {
  const bytes = preview.estimatedUndoBytes;
  const formatted =
    bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)} KiB`
        : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return (
    <>
      <div className="macro-metrics">
        <span>
          Rows{" "}
          <strong>
            {preview.rowsBefore.toLocaleString()} →{" "}
            {preview.rowsAfter.toLocaleString()}
          </strong>
        </span>
        <span>
          Columns{" "}
          <strong>
            {preview.columnsBefore} → {preview.columnsAfter}
          </strong>
        </span>
        <span>
          Changed cells <strong>{preview.changedCells.toLocaleString()}</strong>
        </span>
        {showUndo && (
          <span>
            Undo <strong>{formatted}</strong>
          </span>
        )}
        {preview.headerChanged && <span>Header changed</span>}
      </div>
      {(preview.blockedReason || stale) && (
        <p className="macro-warning">
          {stale
            ? "The document changed; run Preview again."
            : preview.blockedReason}
        </p>
      )}
      {preview.samples.length > 0 && (
        <div className="macro-samples-scroll">
          <table className="macro-samples">
            <thead>
              <tr>
                <th>Cell</th>
                <th>Before</th>
                <th>After</th>
              </tr>
            </thead>
            <tbody>
              {preview.samples.map((sample) => (
                <tr key={`${sample.row}:${sample.column}`}>
                  <th>
                    R{sample.row + 1} C{sample.column + 1}
                  </th>
                  <td>{sample.before ?? "∅"}</td>
                  <td>{sample.after ?? "∅"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
