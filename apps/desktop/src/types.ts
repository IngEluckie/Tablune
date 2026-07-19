export type LineEnding = "lf" | "crlf";

export interface CsvPayload {
  rows: string[][];
  delimiter: string;
  lineEnding: LineEnding;
}

export interface Selection {
  row: number;
  column: number;
}
