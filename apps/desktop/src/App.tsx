import { open, save } from "@tauri-apps/plugin-dialog";
import { useMemo, useState } from "react";
import CsvGrid from "./CsvGrid";
import RibbonHeader from "./RibbonHeader";
import { readCsvDocument, renameCsvDocument, writeCsvDocument } from "./ipc";
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

  const saveDocument = async (saveAs = false, suggestedName?: string): Promise<boolean> => {
    try {
      let destination = saveAs ? null : path;
      if (!destination) {
        destination = await save({
          defaultPath: suggestedName ?? fileName(path),
          filters: [{ name: "CSV", extensions: ["csv"] }],
        });
      }
      if (!destination) return false;

      setBusy(true);
      setError(null);
      await writeCsvDocument(destination, document);
      setPath(destination);
      setDirty(false);
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const renameDocument = async (nextName: string): Promise<boolean> => {
    const normalizedName = nextName.trim();
    if (
      normalizedName.length === 0
      || normalizedName === "."
      || normalizedName === ".."
      || normalizedName.includes("/")
      || normalizedName.includes("\\")
      || normalizedName.includes("\0")
    ) {
      setError("Enter a valid file name without folders.");
      return false;
    }

    if (!path) return saveDocument(true, normalizedName);
    if (normalizedName === fileName(path)) return true;

    setBusy(true);
    setError(null);
    try {
      const renamedPath = await renameCsvDocument(path, normalizedName);
      setPath(renamedPath);
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
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
      <RibbonHeader
        documentName={fileName(path)}
        dirty={dirty}
        busy={busy}
        error={error}
        delimiter={document.delimiter}
        onNew={createNew}
        onOpen={() => void openDocument()}
        onSave={() => void saveDocument(false)}
        onSaveAs={() => void saveDocument(true)}
        onDelimiterChange={(delimiter) => {
          setDocument((current) => ({ ...current, delimiter }));
          setDirty(true);
        }}
        onDocumentNameCommit={renameDocument}
      />

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
