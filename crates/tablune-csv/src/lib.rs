use std::{
    fs::{self, File},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
};

use csv::{ReaderBuilder, Terminator, WriterBuilder};
use serde::{Deserialize, Serialize};
use tablune_core::TableDocument;
use thiserror::Error;

const DELIMITER_CANDIDATES: [u8; 4] = *b",;\t|";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    Lf,
    CrLf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CsvDialect {
    pub delimiter: u8,
    pub line_ending: LineEnding,
}

impl Default for CsvDialect {
    fn default() -> Self {
        Self {
            delimiter: b',',
            line_ending: LineEnding::Lf,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CsvFile {
    pub document: TableDocument,
    pub dialect: CsvDialect,
}

#[derive(Debug, Error)]
pub enum CsvError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("CSV error: {0}")]
    Csv(#[from] csv::Error),
    #[error("the file is not valid UTF-8")]
    InvalidUtf8,
    #[error("delimiter must be a single-byte character")]
    InvalidDelimiter,
}

pub fn read_path(path: impl AsRef<Path>) -> Result<CsvFile, CsvError> {
    let bytes = fs::read(path)?;
    read_bytes(&bytes)
}

pub fn read_bytes(bytes: &[u8]) -> Result<CsvFile, CsvError> {
    let text = std::str::from_utf8(bytes).map_err(|_| CsvError::InvalidUtf8)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let dialect = detect_dialect(text.as_bytes());

    let mut reader = ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(dialect.delimiter)
        .from_reader(text.as_bytes());

    let rows = reader
        .records()
        .map(|result| result.map(|record| record.iter().map(str::to_owned).collect()))
        .collect::<Result<Vec<Vec<String>>, csv::Error>>()?;

    Ok(CsvFile {
        document: TableDocument::from_rows(rows),
        dialect,
    })
}

pub fn write_path(
    path: impl AsRef<Path>,
    document: &TableDocument,
    dialect: CsvDialect,
) -> Result<(), CsvError> {
    validate_delimiter(dialect.delimiter)?;
    let path = path.as_ref();
    let temporary_path = temporary_path(path);

    let file = File::create(&temporary_path)?;
    let buffer = BufWriter::new(file);
    let terminator = match dialect.line_ending {
        LineEnding::Lf => Terminator::Any(b'\n'),
        LineEnding::CrLf => Terminator::CRLF,
    };

    let mut writer = WriterBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(dialect.delimiter)
        .terminator(terminator)
        .from_writer(buffer);

    for row in document.rows() {
        if row.is_empty() {
            writer.write_record([""])?;
        } else {
            writer.write_record(row)?;
        }
    }

    writer.flush()?;
    let mut buffer = writer.into_inner().map_err(|error| error.into_error())?;
    buffer.flush()?;
    buffer.get_ref().sync_all()?;
    drop(buffer);

    replace_file(&temporary_path, path)
}

fn detect_dialect(bytes: &[u8]) -> CsvDialect {
    let line_ending = if bytes.windows(2).any(|window| window == b"\r\n") {
        LineEnding::CrLf
    } else {
        LineEnding::Lf
    };

    let delimiter = DELIMITER_CANDIDATES
        .into_iter()
        .max_by_key(|candidate| delimiter_score(bytes, *candidate))
        .filter(|candidate| delimiter_score(bytes, *candidate) > 0)
        .unwrap_or(b',');

    CsvDialect {
        delimiter,
        line_ending,
    }
}

fn delimiter_score(bytes: &[u8], delimiter: u8) -> usize {
    bytes
        .split(|byte| *byte == b'\n')
        .take(32)
        .map(|line| count_unquoted(line, delimiter))
        .sum()
}

fn count_unquoted(line: &[u8], delimiter: u8) -> usize {
    let mut quoted = false;
    let mut count = 0;
    let mut index = 0;

    while index < line.len() {
        match line[index] {
            b'"' if quoted && line.get(index + 1) == Some(&b'"') => index += 1,
            b'"' => quoted = !quoted,
            byte if byte == delimiter && !quoted => count += 1,
            _ => {}
        }
        index += 1;
    }

    count
}

fn validate_delimiter(delimiter: u8) -> Result<(), CsvError> {
    if matches!(delimiter, b'\n' | b'\r' | b'"') {
        return Err(CsvError::InvalidDelimiter);
    }
    Ok(())
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| "tablune.csv".into());
    name.push(format!(".tablune-tmp-{}", std::process::id()));
    path.with_file_name(name)
}

fn replace_file(temporary_path: &Path, destination: &Path) -> Result<(), CsvError> {
    #[cfg(windows)]
    if destination.exists() {
        fs::remove_file(destination)?;
    }

    match fs::rename(temporary_path, destination) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(temporary_path);
            Err(CsvError::Io(error))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use tablune_core::{CellPosition, TableDocument};

    use super::{CsvDialect, LineEnding, read_bytes, read_path, write_path};

    #[test]
    fn parses_quoted_delimiters_and_newlines() {
        let file = read_bytes(b"name,notes\nAda,\"first, second\"\nLinus,\"two\nlines\"\n")
            .expect("CSV should parse");

        assert_eq!(file.document.row_count(), 3);
        assert_eq!(file.document.rows()[1][1], "first, second");
        assert_eq!(file.document.rows()[2][1], "two\nlines");
    }

    #[test]
    fn detects_semicolon_and_crlf() {
        let file = read_bytes(b"a;b\r\n1;2\r\n").expect("CSV should parse");
        assert_eq!(
            file.dialect,
            CsvDialect {
                delimiter: b';',
                line_ending: LineEnding::CrLf,
            }
        );
    }

    #[test]
    fn strips_utf8_bom() {
        let file = read_bytes(b"\xEF\xBB\xBFa,b\n1,2\n").expect("CSV should parse");
        assert_eq!(file.document.rows()[0][0], "a");
    }

    #[test]
    fn preserves_blank_rows_before_a_wide_sparse_row() {
        let mut document = TableDocument::new();
        document.set_cell(CellPosition { row: 3, column: 4 }, "Fads".into());

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("tablune-sparse-{unique}.csv"));

        write_path(&path, &document, CsvDialect::default())
            .expect("sparse document should be written");
        let reopened = read_path(&path).expect("sparse document should reopen");

        assert_eq!(reopened.document.row_count(), 4);
        assert_eq!(
            reopened.document.cell(CellPosition { row: 3, column: 4 }),
            Some("Fads")
        );

        fs::remove_file(path).expect("temporary CSV should be removed");
    }
}
