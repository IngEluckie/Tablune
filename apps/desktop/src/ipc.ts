import { invoke } from "@tauri-apps/api/core";
import type { CsvPayload } from "./types";

export function readCsvDocument(path: string): Promise<CsvPayload> {
  return invoke<CsvPayload>("read_csv_document", { path });
}

export function writeCsvDocument(path: string, payload: CsvPayload): Promise<void> {
  return invoke<void>("write_csv_document", { path, payload });
}
