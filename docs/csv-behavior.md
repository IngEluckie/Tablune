# CSV behavior

CSV is a family of dialects rather than a single fully self-describing format.

## MVP rules

- Values are stored as strings.
- UTF-8 and UTF-8 with BOM are accepted.
- Delimiters considered during detection: comma, semicolon, tab, and pipe.
- Delimiter detection scores complete logical records, including quoted multiline fields, and favors the candidate with the most consistent positive field count.
- Quoted fields, escaped quotes, embedded delimiters, and embedded newlines are parsed by the Rust `csv` crate.
- Ragged rows are accepted.
- Column insertion and deletion preserve each ragged row's shape; a missing cell is not materialized merely because a logical column exists elsewhere.
- The original delimiter and LF/CRLF convention are retained when detected.
- Saving produces valid normalized CSV. Exact original quote placement and byte-for-byte layout are not preserved.

## Type inference

Type inference is a non-destructive view concern and never coerces stored values. Dates are recognized only when the complete value is a valid calendar date in strict `YYYY-MM-DD` form, including leap-year validation. Datetimes, partial dates, and impossible dates remain strings.

## Non-goals

- Removing leading zeros
- Reformatting identifiers
- Preserving arbitrary legacy encodings in 0.1
- Treating the first row as structurally different from other rows

Legacy encodings and lossless source-preserving edits require separate design work.
