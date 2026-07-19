# CSV behavior

CSV is a family of dialects rather than a single fully self-describing format.

## MVP rules

- Values are stored as strings.
- UTF-8 and UTF-8 with BOM are accepted.
- Delimiters considered during detection: comma, semicolon, tab, and pipe.
- Quoted fields, escaped quotes, embedded delimiters, and embedded newlines are parsed by the Rust `csv` crate.
- Ragged rows are accepted.
- The original delimiter and LF/CRLF convention are retained when detected.
- Saving produces valid normalized CSV. Exact original quote placement and byte-for-byte layout are not preserved.

## Non-goals

- Guessing dates or numbers
- Removing leading zeros
- Reformatting identifiers
- Preserving arbitrary legacy encodings in 0.1
- Treating the first row as structurally different from other rows

Legacy encodings and lossless source-preserving edits require separate design work.
