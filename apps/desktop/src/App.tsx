import { open, save } from "@tauri-apps/plugin-dialog";
import { useMemo, useState } from "react";
import CsvGrid from "./CsvGrid";
import { readCsvDocument, writeCsvDocument } from "./ipc";
import type { CsvPayload } from "./types";

const EMPTY_DOCUMENT: CsvPayload = {
  rows: [],
  delimiter: ",",
  lineEnding: "lf",
};

function fileName(path: string | null): string {
  if (!path) return "Untitled.csv";
  return path.split(/[\\/]/).at(-1) ?? path;
}

export default function App() {
  const [document, setDocument] = useState<CsvPayload>(EMPTY_DOCUMENT);
  const [path, setPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dimensions = useMemo(() => {
    const columns = document.rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
    return { rows: document.rows.length, columns };
  }, [document.rows]);

  const createNew = () => {
    setDocument(EMPTY_DOCUMENT);
    setPath(null);
    setDirty(false);
    setError(null);
  };

  const openDocument = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Delimited text", extensions: ["csv", "tsv", "txt"] }],
    });
    if (typeof selected !== "string") return;

    setBusy(true);
    setError(null);
    try {
      const payload = await readCsvDocument(selected);
      setDocument(payload);
      setPath(selected);
      setDirty(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveDocument = async (saveAs = false) => {
    let destination = saveAs ? null : path;
    if (!destination) {
      destination = await save({
        defaultPath: fileName(path),
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
    }
    if (!destination) return;

    setBusy(true);
    setError(null);
    try {
      await writeCsvDocument(destination, document);
      setPath(destination);
      setDirty(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const updateCell = (rowIndex: number, columnIndex: number, value: string) => {
    setDocument((current) => {
      const rows = current.rows.slice();
      while (rows.length <= rowIndex) rows.push([]);
      const row = rows[rowIndex].slice();
      while (row.length <= columnIndex) row.push("");
      row[columnIndex] = value;
      rows[rowIndex] = row;
      return { ...current, rows };
    });
    setDirty(true);
  };

  return (
    <main className="app-shell">
      <header className="titlebar">
        <div className="brand-mark" aria-hidden="true">T</div>
        <div className="brand-name"><strong>Tablune</strong> Sheets</div>
        <div className="document-name">{dirty ? "• " : ""}{fileName(path)}</div>
      </header>

      <nav className="menu-tabs" aria-label="Application sections">
        <button className="menu-tab active">File</button>
        <button className="menu-tab">Edit</button>
        <button className="menu-tab">Data</button>
        <button className="menu-tab">View</button>
        <span className="menu-spacer" />
        <span className="mvp-badge">CSV MVP</span>
      </nav>

      <section className="toolbar" aria-label="Document actions">
        <button onClick={createNew} disabled={busy}>New</button>
        <button onClick={openDocument} disabled={busy}>Open</button>
        <button onClick={() => void saveDocument(false)} disabled={busy}>Save</button>
        <button onClick={() => void saveDocument(true)} disabled={busy}>Save As</button>
        <span className="toolbar-divider" />
        <label>
          Delimiter
          <select
            value={document.delimiter}
            onChange={(event) => {
              setDocument((current) => ({ ...current, delimiter: event.target.value }));
              setDirty(true);
            }}
          >
            <option value=",">Comma</option>
            <option value=";">Semicolon</option>
            <option value={"\t"}>Tab</option>
            <option value="|">Pipe</option>
          </select>
        </label>
        <span className="status-message">{busy ? "Working…" : error ?? "Ready"}</span>
      </section>

      <CsvGrid rows={document.rows} onCellChange={updateCell} />

      <footer className="statusbar">
        <span>{dirty ? "Unsaved changes" : "Saved"}</span>
        <span>{dimensions.rows.toLocaleString()} rows</span>
        <span>{dimensions.columns.toLocaleString()} columns</span>
        <span>{document.lineEnding === "crlf" ? "CRLF" : "LF"}</span>
        <span>UTF-8</span>
      </footer>
    </main>
  );
}
