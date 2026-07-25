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

    replace_file_atomic(&temporary_path, path)
}

fn detect_dialect(bytes: &[u8]) -> CsvDialect {
    let line_ending = if bytes.windows(2).any(|window| window == b"\r\n") {
        LineEnding::CrLf
    } else {
        LineEnding::Lf
    };

    let delimiter = DELIMITER_CANDIDATES
        .into_iter()
        .enumerate()
        .map(|(preference, candidate)| {
            (
                delimiter_score(bytes, candidate),
                usize::MAX - preference,
                candidate,
            )
        })
        .max()
        .filter(|(score, _, _)| score.1 > 0)
        .map_or(b',', |(_, _, candidate)| candidate);

    CsvDialect {
        delimiter,
        line_ending,
    }
}

fn delimiter_score(bytes: &[u8], delimiter: u8) -> (usize, usize, usize, usize) {
    let counts = logical_record_delimiter_counts(bytes, delimiter);
    let mut frequencies = std::collections::HashMap::<usize, usize>::new();
    let mut positive_rows = 0;
    let mut total = 0;
    for count in counts {
        if count > 0 {
            positive_rows += 1;
            total += count;
            *frequencies.entry(count).or_default() += 1;
        }
    }
    let (modal_rows, modal_count) = frequencies
        .into_iter()
        .map(|(count, frequency)| (frequency, count))
        .max()
        .unwrap_or_default();
    (modal_rows, positive_rows, modal_count, total)
}

fn logical_record_delimiter_counts(bytes: &[u8], delimiter: u8) -> Vec<usize> {
    let mut quoted = false;
    let mut count = 0;
    let mut counts = Vec::new();
    let mut index = 0;

    while index < bytes.len() && counts.len() < 32 {
        match bytes[index] {
            b'"' if quoted && bytes.get(index + 1) == Some(&b'"') => index += 1,
            b'"' => quoted = !quoted,
            byte if byte == delimiter && !quoted => count += 1,
            b'\n' if !quoted => {
                counts.push(count);
                count = 0;
            }
            _ => {}
        }
        index += 1;
    }
    if counts.len() < 32 && (!bytes.is_empty() && bytes.last() != Some(&b'\n')) {
        counts.push(count);
    }
    counts
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

pub fn replace_file_atomic(temporary_path: &Path, destination: &Path) -> Result<(), CsvError> {
    #[cfg(windows)]
    return finish_replace(temporary_path, destination, |temporary, destination| {
        if destination.exists() {
            replace_existing_windows(temporary, destination)
        } else {
            fs::rename(temporary, destination)
        }
    });

    #[cfg(not(windows))]
    finish_replace(temporary_path, destination, |temporary, destination| {
        fs::rename(temporary, destination)
    })
}

fn finish_replace(
    temporary_path: &Path,
    destination: &Path,
    replace: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), CsvError> {
    match replace(temporary_path, destination) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(temporary_path);
            Err(CsvError::Io(error))
        }
    }
}

#[cfg(windows)]
fn replace_existing_windows(temporary_path: &Path, destination: &Path) -> std::io::Result<()> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let temporary = temporary_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    // ReplaceFileW leaves the original destination intact when replacement fails.
    let replaced = unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            temporary.as_ptr(),
            ptr::null(),
            0,
            ptr::null(),
            ptr::null(),
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use tablune_core::{CellPosition, TableDocument};

    use super::{CsvDialect, LineEnding, finish_replace, read_bytes, read_path, write_path};

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
    fn delimiter_detection_prefers_consistent_tsv_over_commas_inside_values() {
        let file = read_bytes(b"id\tlist\n1\ta,b,c,d\n2\te,f,g,h\n").expect("TSV should parse");
        assert_eq!(file.dialect.delimiter, b'\t');
        assert_eq!(file.document.rows()[1][1], "a,b,c,d");
    }

    #[test]
    fn delimiter_detection_tracks_quoted_multiline_records() {
        let file =
            read_bytes(b"id;notes\n1;\"a,b\nc,d\"\n2;plain\n").expect("semicolon CSV should parse");
        assert_eq!(file.dialect.delimiter, b';');
        assert_eq!(file.document.rows()[1][1], "a,b\nc,d");
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

    #[test]
    fn failed_replacement_never_removes_the_original_destination() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("tablune-replace-{unique}"));
        fs::create_dir_all(&directory).unwrap();
        let destination = directory.join("data.csv");
        let temporary = directory.join("data.tmp");
        fs::write(&destination, "original").unwrap();
        fs::write(&temporary, "replacement").unwrap();

        let result = finish_replace(&temporary, &destination, |_, _| {
            Err(std::io::Error::other("simulated replacement failure"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&destination).unwrap(), "original");
        assert!(!temporary.exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
