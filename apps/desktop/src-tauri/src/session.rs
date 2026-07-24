use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering as AtomicOrdering},
    },
};

use serde::{Deserialize, Serialize};
use tablune_core::{CellPosition, TableDocument};
use tablune_csv::{CsvDialect, LineEnding};
use tablune_history::{Transaction, TransactionHistory};
use tauri::{AppHandle, Manager, State};

const HISTORY_ENTRIES: usize = 500;
const HISTORY_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAX_HISTORY_BYTES: usize = HISTORY_BYTES;
static NEXT_SESSION_IDENTITY: AtomicU64 = AtomicU64::new(1);

fn next_session_identity() -> u64 {
    NEXT_SESSION_IDENTITY.fetch_add(1, AtomicOrdering::Relaxed)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    pub document_id: u64,
    pub path: Option<String>,
    pub display_name: String,
    pub delimiter: String,
    pub line_ending: LineEnding,
    pub revision: u64,
    pub view_revision: u64,
    pub dirty: bool,
    pub row_count: usize,
    pub column_count: usize,
    pub visible_row_count: usize,
    pub header_enabled: bool,
    pub header_suggested: bool,
    pub header_names: Vec<String>,
    pub header_values: Vec<String>,
    pub can_undo: bool,
    pub can_redo: bool,
    pub filters_active: bool,
    pub sort_count: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct MacroDocumentSnapshot {
    pub document_id: u64,
    pub identity: u64,
    pub revision: u64,
    pub rows: Vec<Vec<String>>,
    pub header_enabled: bool,
    pub display_name: String,
    pub delimiter: String,
    pub line_ending: LineEnding,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridRow {
    pub view_index: usize,
    pub source_row: usize,
    pub row_id: u64,
    pub cells: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridWindow {
    pub document_id: u64,
    pub revision: u64,
    pub view_revision: u64,
    pub row_start: usize,
    pub column_start: usize,
    pub rows: Vec<GridRow>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ColumnType {
    #[default]
    Text,
    Number,
    Date,
    Boolean,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Ascending,
    Descending,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    pub column: usize,
    pub direction: SortDirection,
    #[serde(default)]
    pub column_type: ColumnType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterSpec {
    pub column: usize,
    pub operator: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub second_value: String,
    #[serde(default)]
    pub values: Vec<String>,
    #[serde(default)]
    pub column_type: ColumnType,
    #[serde(default)]
    pub case_sensitive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ViewState {
    #[serde(default)]
    pub sorts: Vec<SortSpec>,
    #[serde(default)]
    pub filters: Vec<FilterSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellInput {
    pub row: usize,
    pub column: usize,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EditCommand {
    SetCells { cells: Vec<CellInput> },
    InsertRows { index: usize, count: usize },
    DeleteRows { index: usize, count: usize },
    InsertColumns { index: usize, count: usize },
    DeleteColumns { index: usize, count: usize },
    SetDelimiter { delimiter: String },
    ApplySort,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub query: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_cell: bool,
    pub range: Option<CellRange>,
    #[serde(default = "default_search_limit")]
    pub limit: usize,
}

fn default_search_limit() -> usize {
    10_000
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellRange {
    pub start_row: usize,
    pub end_row: usize,
    pub start_column: usize,
    pub end_column: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub source_row: usize,
    pub view_row: Option<usize>,
    pub column: usize,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceRequest {
    pub search: SearchRequest,
    pub replacement: String,
    pub replace_all: bool,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetValue {
    pub value: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetPage {
    pub values: Vec<FacetValue>,
    pub total_distinct: usize,
    pub next_offset: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnProfile {
    pub column: usize,
    pub total_rows: usize,
    pub visible_rows: usize,
    pub empty_count: usize,
    pub unique_count: usize,
    pub duplicate_count: usize,
    pub invalid_count: usize,
    pub min: Option<String>,
    pub max: Option<String>,
    pub min_length: usize,
    pub max_length: usize,
    pub suggested_type: ColumnType,
    pub active_type: ColumnType,
    pub confidence: f64,
    pub top_values: Vec<FacetValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FilePreferences {
    header_enabled: Option<bool>,
    #[serde(default)]
    column_types: HashMap<usize, ColumnType>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Preferences {
    #[serde(default)]
    python_interpreter: Option<String>,
    #[serde(default)]
    files: HashMap<String, FilePreferences>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryPayload {
    rows: Vec<Vec<String>>,
    path: Option<String>,
    dialect: CsvDialect,
    header_enabled: bool,
    column_types: HashMap<usize, ColumnType>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRecoveryPayload {
    version: u8,
    documents: Vec<RecoveryPayload>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum StoredRecoveryPayload {
    Workspace(WorkspaceRecoveryPayload),
    Legacy(RecoveryPayload),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub documents: Vec<DocumentSummary>,
}

#[derive(Debug, Clone)]
enum InternalOp {
    SetCells {
        cells: Vec<CellInput>,
        restore_shape: Option<Vec<usize>>,
    },
    InsertRows {
        index: usize,
        rows: Vec<Vec<String>>,
        ids: Vec<u64>,
    },
    RemoveRows {
        index: usize,
        count: usize,
    },
    InsertColumns {
        index: usize,
        count: usize,
    },
    RemoveColumns {
        index: usize,
        count: usize,
    },
    RestoreColumns {
        index: usize,
        columns: Vec<Vec<Option<String>>>,
    },
    SetDelimiter(u8),
    ReorderRows(Vec<u64>),
    ReplaceRows {
        index: usize,
        remove_count: usize,
        rows: Vec<Vec<String>>,
        ids: Vec<u64>,
    },
}

#[derive(Debug, Clone)]
struct EditRecord {
    forward: InternalOp,
    inverse: InternalOp,
}

pub struct DocumentSession {
    document: TableDocument,
    path: Option<PathBuf>,
    dialect: CsvDialect,
    revision: u64,
    view_revision: u64,
    current_state: u64,
    saved_state: u64,
    next_state: u64,
    next_row_id: u64,
    row_ids: Vec<u64>,
    history: TransactionHistory<EditRecord>,
    header_enabled: bool,
    header_suggested: bool,
    column_types: HashMap<usize, ColumnType>,
    view: ViewState,
    visible_rows: Vec<usize>,
    identity: u64,
}

impl Default for DocumentSession {
    fn default() -> Self {
        let mut session = Self {
            document: TableDocument::new(),
            path: None,
            dialect: CsvDialect::default(),
            revision: 0,
            view_revision: 0,
            current_state: 0,
            saved_state: 0,
            next_state: 1,
            next_row_id: 1,
            row_ids: Vec::new(),
            history: TransactionHistory::with_limits(HISTORY_ENTRIES, HISTORY_BYTES),
            header_enabled: false,
            header_suggested: false,
            column_types: HashMap::new(),
            view: ViewState::default(),
            visible_rows: Vec::new(),
            identity: next_session_identity(),
        };
        session.rebuild_view();
        session
    }
}

impl DocumentSession {
    fn from_file(path: PathBuf, file: tablune_csv::CsvFile, preferences: FilePreferences) -> Self {
        let suggested = suggest_header(file.document.rows());
        let header_enabled = preferences.header_enabled.unwrap_or(false);
        let row_count = file.document.row_count();
        let mut session = Self {
            document: file.document,
            path: Some(path),
            dialect: file.dialect,
            revision: 0,
            view_revision: 0,
            current_state: 0,
            saved_state: 0,
            next_state: 1,
            next_row_id: row_count as u64 + 1,
            row_ids: (1..=row_count as u64).collect(),
            history: TransactionHistory::with_limits(HISTORY_ENTRIES, HISTORY_BYTES),
            header_enabled,
            header_suggested: suggested && preferences.header_enabled.is_none(),
            column_types: preferences.column_types,
            view: ViewState::default(),
            visible_rows: Vec::new(),
            identity: next_session_identity(),
        };
        session.rebuild_view();
        session
    }

    pub(crate) fn summary(&self) -> DocumentSummary {
        let header_names = self.header_names();
        DocumentSummary {
            document_id: self.identity,
            path: self
                .path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            display_name: self
                .path
                .as_ref()
                .and_then(|path| path.file_name())
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Untitled.csv".to_string()),
            delimiter: char::from(self.dialect.delimiter).to_string(),
            line_ending: self.dialect.line_ending,
            revision: self.revision,
            view_revision: self.view_revision,
            dirty: self.current_state != self.saved_state,
            row_count: self.document.row_count(),
            column_count: self.document.column_count(),
            visible_row_count: self.visible_rows.len(),
            header_enabled: self.header_enabled,
            header_suggested: self.header_suggested,
            header_names,
            header_values: if self.header_enabled {
                self.document.rows().first().cloned().unwrap_or_default()
            } else {
                Vec::new()
            },
            can_undo: self.history.can_undo(),
            can_redo: self.history.can_redo(),
            filters_active: !self.view.filters.is_empty(),
            sort_count: self.view.sorts.len(),
        }
    }

    fn header_names(&self) -> Vec<String> {
        let count = self.document.column_count();
        let raw = if self.header_enabled {
            self.document.rows().first()
        } else {
            None
        };
        let mut seen = HashMap::<String, usize>::new();
        (0..count)
            .map(|column| {
                let base = raw
                    .and_then(|row| row.get(column))
                    .filter(|value| !value.trim().is_empty())
                    .cloned()
                    .unwrap_or_else(|| column_name(column));
                let occurrence = seen.entry(base.clone()).or_default();
                *occurrence += 1;
                if *occurrence == 1 {
                    base
                } else {
                    format!("{base} ({occurrence})")
                }
            })
            .collect()
    }

    fn ensure_row_ids(&mut self) {
        while self.row_ids.len() < self.document.row_count() {
            self.row_ids.push(self.next_row_id);
            self.next_row_id += 1;
        }
        self.row_ids.truncate(self.document.row_count());
    }

    fn data_start(&self) -> usize {
        usize::from(self.header_enabled && self.document.row_count() > 0)
    }

    fn rebuild_view(&mut self) {
        let mut rows: Vec<usize> = (self.data_start()..self.document.row_count())
            .filter(|&row| {
                self.view
                    .filters
                    .iter()
                    .all(|filter| self.matches_filter(row, filter))
            })
            .collect();
        if !self.view.sorts.is_empty() {
            rows.sort_by(|left, right| self.compare_rows(*left, *right));
        }
        self.visible_rows = rows;
        self.view_revision = self.view_revision.wrapping_add(1);
    }

    fn compare_rows(&self, left: usize, right: usize) -> Ordering {
        for sort in &self.view.sorts {
            let left_value = self.cell_value(left, sort.column);
            let right_value = self.cell_value(right, sort.column);
            let blanks = left_value.is_empty() || right_value.is_empty();
            let mut ordering = compare_values(left_value, right_value, sort.column_type);
            if sort.direction == SortDirection::Descending && !blanks {
                ordering = ordering.reverse();
            }
            if ordering != Ordering::Equal {
                return ordering;
            }
        }
        left.cmp(&right)
    }

    fn matches_filter(&self, row: usize, filter: &FilterSpec) -> bool {
        let raw = self.cell_value(row, filter.column);
        let normalized = if filter.case_sensitive {
            raw.to_string()
        } else {
            raw.to_lowercase()
        };
        let needle = if filter.case_sensitive {
            filter.value.clone()
        } else {
            filter.value.to_lowercase()
        };
        match filter.operator.as_str() {
            "contains" => normalized.contains(&needle),
            "equals" => normalized == needle,
            "startsWith" => normalized.starts_with(&needle),
            "endsWith" => normalized.ends_with(&needle),
            "empty" => raw.is_empty(),
            "notEmpty" => !raw.is_empty(),
            "values" => filter.values.iter().any(|value| value == raw),
            "greaterThan" => compare_typed(raw, &filter.value, filter.column_type)
                .is_some_and(|order| order == Ordering::Greater),
            "lessThan" => compare_typed(raw, &filter.value, filter.column_type)
                .is_some_and(|order| order == Ordering::Less),
            "between" => {
                compare_typed(raw, &filter.value, filter.column_type)
                    .is_some_and(|order| order != Ordering::Less)
                    && compare_typed(raw, &filter.second_value, filter.column_type)
                        .is_some_and(|order| order != Ordering::Greater)
            }
            _ => true,
        }
    }

    fn cell_value(&self, row: usize, column: usize) -> &str {
        self.document
            .cell(CellPosition { row, column })
            .unwrap_or("")
    }

    fn grid_window(
        &self,
        row_start: usize,
        row_count: usize,
        column_start: usize,
        column_count: usize,
    ) -> GridWindow {
        let rows = self
            .visible_rows
            .iter()
            .enumerate()
            .skip(row_start)
            .take(row_count.min(500))
            .map(|(view_index, &source_row)| GridRow {
                view_index,
                source_row,
                row_id: self.row_ids[source_row],
                cells: (column_start..column_start.saturating_add(column_count.min(200)))
                    .map(|column| self.cell_value(source_row, column).to_string())
                    .collect(),
            })
            .collect();
        GridWindow {
            document_id: self.identity,
            revision: self.revision,
            view_revision: self.view_revision,
            row_start,
            column_start,
            rows,
        }
    }

    fn execute(&mut self, operation: &InternalOp) -> Result<(), String> {
        match operation {
            InternalOp::SetCells {
                cells,
                restore_shape,
            } => {
                for cell in cells {
                    self.document.set_cell(
                        CellPosition {
                            row: cell.row,
                            column: cell.column,
                        },
                        cell.value.clone(),
                    );
                }
                if let Some(row_lengths) = restore_shape {
                    self.document.restore_shape(row_lengths);
                }
                self.ensure_row_ids();
            }
            InternalOp::InsertRows { index, rows, ids } => {
                let index = (*index).min(self.document.row_count());
                self.document.insert_rows(index, rows.clone());
                self.row_ids.splice(index..index, ids.clone());
            }
            InternalOp::RemoveRows { index, count } => {
                let end = index.saturating_add(*count).min(self.document.row_count());
                self.document.delete_rows(*index, *count);
                if *index < self.row_ids.len() {
                    self.row_ids.drain(*index..end);
                }
            }
            InternalOp::InsertColumns { index, count } => {
                self.document.insert_columns(*index, *count)
            }
            InternalOp::RemoveColumns { index, count } => {
                self.document.delete_columns(*index, *count);
            }
            InternalOp::RestoreColumns { index, columns } => {
                self.document.insert_columns(*index, columns.len());
                for (offset, values) in columns.iter().enumerate() {
                    for (row, value) in values.iter().enumerate() {
                        if let Some(value) = value {
                            self.document.set_cell(
                                CellPosition {
                                    row,
                                    column: index + offset,
                                },
                                value.clone(),
                            );
                        }
                    }
                }
            }
            InternalOp::SetDelimiter(delimiter) => self.dialect.delimiter = *delimiter,
            InternalOp::ReorderRows(ids) => self.reorder_by_ids(ids)?,
            InternalOp::ReplaceRows {
                index,
                remove_count,
                rows,
                ids,
            } => {
                let index = (*index).min(self.document.row_count());
                let end = index
                    .saturating_add(*remove_count)
                    .min(self.document.row_count());
                self.document.delete_rows(index, *remove_count);
                self.row_ids.drain(index..end);
                self.document.insert_rows(index, rows.clone());
                self.row_ids.splice(index..index, ids.clone());
            }
        }
        Ok(())
    }

    pub(crate) fn macro_snapshot(&self) -> MacroDocumentSnapshot {
        MacroDocumentSnapshot {
            document_id: self.identity,
            identity: self.identity,
            revision: self.revision,
            rows: self.document.rows().to_vec(),
            header_enabled: self.header_enabled,
            display_name: self.summary().display_name,
            delimiter: char::from(self.dialect.delimiter).to_string(),
            line_ending: self.dialect.line_ending,
        }
    }

    pub(crate) fn matches_macro_revision(&self, identity: u64, revision: u64) -> bool {
        self.identity == identity && self.revision == revision
    }

    pub(crate) fn matches_macro_snapshot(
        &self,
        identity: u64,
        revision: u64,
        header_enabled: bool,
    ) -> bool {
        self.matches_macro_revision(identity, revision) && self.header_enabled == header_enabled
    }

    pub(crate) fn apply_macro_rows(
        &mut self,
        rows: Vec<Vec<String>>,
        expected_identity: u64,
        expected_revision: u64,
    ) -> Result<(), String> {
        if !self.matches_macro_revision(expected_identity, expected_revision) {
            return Err("the document changed; run the macro preview again".to_string());
        }
        let estimated_bytes = estimate_macro_history(self.document.rows(), &rows);
        if estimated_bytes > MAX_HISTORY_BYTES {
            return Err("this macro result is too large to keep an undo entry".to_string());
        }
        if self.document.rows() == rows {
            return Ok(());
        }

        let before_columns = self.document.column_count();
        let same_shape = self.document.rows().len() == rows.len()
            && self
                .document
                .rows()
                .iter()
                .zip(&rows)
                .all(|(before, after)| before.len() == after.len());
        if same_shape {
            let mut before = Vec::new();
            let mut after = Vec::new();
            for (row_index, (old_row, new_row)) in
                self.document.rows().iter().zip(&rows).enumerate()
            {
                for (column, (old, new)) in old_row.iter().zip(new_row).enumerate() {
                    if old != new {
                        before.push(CellInput {
                            row: row_index,
                            column,
                            value: old.clone(),
                        });
                        after.push(CellInput {
                            row: row_index,
                            column,
                            value: new.clone(),
                        });
                    }
                }
            }
            self.commit(
                EditRecord {
                    forward: InternalOp::SetCells {
                        cells: after,
                        restore_shape: None,
                    },
                    inverse: InternalOp::SetCells {
                        cells: before,
                        restore_shape: None,
                    },
                },
                estimated_bytes,
            )?;
        } else {
            let (start, before_end, after_end) = macro_changed_range(self.document.rows(), &rows);
            let before_rows = self.document.rows()[start..before_end].to_vec();
            let before_ids = self.row_ids[start..before_end].to_vec();
            let after_rows = rows[start..after_end].to_vec();
            let after_ids = (0..after_rows.len())
                .map(|_| {
                    let id = self.next_row_id;
                    self.next_row_id = self.next_row_id.wrapping_add(1);
                    id
                })
                .collect();
            self.commit(
                EditRecord {
                    forward: InternalOp::ReplaceRows {
                        index: start,
                        remove_count: before_rows.len(),
                        rows: after_rows,
                        ids: after_ids,
                    },
                    inverse: InternalOp::ReplaceRows {
                        index: start,
                        remove_count: after_end - start,
                        rows: before_rows,
                        ids: before_ids,
                    },
                },
                estimated_bytes,
            )?;
        }
        self.view = ViewState::default();
        if self.document.column_count() != before_columns {
            self.column_types.clear();
        }
        self.rebuild_view();
        Ok(())
    }

    fn reorder_by_ids(&mut self, ids: &[u64]) -> Result<(), String> {
        if ids.len() != self.row_ids.len() {
            return Err("row order no longer matches the document".to_string());
        }
        let positions: HashMap<u64, usize> = self
            .row_ids
            .iter()
            .enumerate()
            .map(|(index, id)| (*id, index))
            .collect();
        let order = ids
            .iter()
            .map(|id| {
                positions
                    .get(id)
                    .copied()
                    .ok_or_else(|| "unknown row in order".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.document.reorder_rows(&order).map_err(str::to_string)?;
        self.row_ids = ids.to_vec();
        Ok(())
    }

    fn commit(&mut self, record: EditRecord, estimated_bytes: usize) -> Result<(), String> {
        self.execute(&record.forward)?;
        let before_state = self.current_state;
        let after_state = self.next_state;
        self.next_state += 1;
        self.current_state = after_state;
        self.revision = self.revision.wrapping_add(1);
        self.history.record(Transaction {
            before_state,
            after_state,
            estimated_bytes,
            value: record,
        });
        self.rebuild_view();
        Ok(())
    }

    fn apply_edit(&mut self, command: EditCommand, expected_revision: u64) -> Result<(), String> {
        if expected_revision != self.revision {
            return Err(format!(
                "stale revision: expected {}, current {}",
                expected_revision, self.revision
            ));
        }
        match command {
            EditCommand::SetCells { cells } => {
                let original_shape = self
                    .document
                    .rows()
                    .iter()
                    .map(Vec::len)
                    .collect::<Vec<_>>();
                let mut before = Vec::new();
                let mut after = Vec::new();
                let mut bytes = 0;
                for cell in cells {
                    let old = self.cell_value(cell.row, cell.column).to_string();
                    if old != cell.value {
                        bytes += old.len() + cell.value.len() + 32;
                        before.push(CellInput {
                            row: cell.row,
                            column: cell.column,
                            value: old,
                        });
                        after.push(cell);
                    }
                }
                if !after.is_empty() {
                    self.commit(
                        EditRecord {
                            forward: InternalOp::SetCells {
                                cells: after,
                                restore_shape: None,
                            },
                            inverse: InternalOp::SetCells {
                                cells: before,
                                restore_shape: Some(original_shape),
                            },
                        },
                        bytes,
                    )?;
                }
            }
            EditCommand::InsertRows { index, count } => {
                let count = count.clamp(1, 10_000);
                let index = index.min(self.document.row_count());
                let rows = vec![Vec::new(); count];
                let ids: Vec<u64> = (0..count)
                    .map(|_| {
                        let id = self.next_row_id;
                        self.next_row_id += 1;
                        id
                    })
                    .collect();
                self.commit(
                    EditRecord {
                        forward: InternalOp::InsertRows { index, rows, ids },
                        inverse: InternalOp::RemoveRows { index, count },
                    },
                    count * 32,
                )?;
            }
            EditCommand::DeleteRows { index, count } => {
                let index = index.min(self.document.row_count());
                let count = count.min(self.document.row_count().saturating_sub(index));
                if count > 0 {
                    let rows = self.document.rows()[index..index + count].to_vec();
                    let ids = self.row_ids[index..index + count].to_vec();
                    let bytes = rows.iter().flatten().map(String::len).sum::<usize>() + count * 32;
                    self.commit(
                        EditRecord {
                            forward: InternalOp::RemoveRows { index, count },
                            inverse: InternalOp::InsertRows { index, rows, ids },
                        },
                        bytes,
                    )?;
                }
            }
            EditCommand::InsertColumns { index, count } => {
                let count = count.clamp(1, 1_000);
                self.commit(
                    EditRecord {
                        forward: InternalOp::InsertColumns { index, count },
                        inverse: InternalOp::RemoveColumns { index, count },
                    },
                    self.document.row_count() * count,
                )?;
            }
            EditCommand::DeleteColumns { index, count } => {
                let count = count.min(self.document.column_count().saturating_sub(index));
                if count > 0 {
                    let mut copy = self.document.clone();
                    let columns = copy.delete_columns(index, count);
                    let bytes = columns
                        .iter()
                        .flatten()
                        .filter_map(Option::as_ref)
                        .map(String::len)
                        .sum::<usize>();
                    self.commit(
                        EditRecord {
                            forward: InternalOp::RemoveColumns { index, count },
                            inverse: InternalOp::RestoreColumns { index, columns },
                        },
                        bytes,
                    )?;
                }
            }
            EditCommand::SetDelimiter { delimiter } => {
                let bytes = delimiter.as_bytes();
                if bytes.len() != 1 || matches!(bytes[0], b'\n' | b'\r' | b'"') {
                    return Err("delimiter must be one valid ASCII character".to_string());
                }
                if bytes[0] != self.dialect.delimiter {
                    self.commit(
                        EditRecord {
                            forward: InternalOp::SetDelimiter(bytes[0]),
                            inverse: InternalOp::SetDelimiter(self.dialect.delimiter),
                        },
                        2,
                    )?;
                }
            }
            EditCommand::ApplySort => {
                if !self.view.sorts.is_empty() {
                    let before = self.row_ids.clone();
                    let mut after = Vec::with_capacity(before.len());
                    if self.header_enabled && !before.is_empty() {
                        after.push(before[0]);
                    }
                    let mut all_rows: Vec<usize> =
                        (self.data_start()..self.document.row_count()).collect();
                    all_rows.sort_by(|left, right| self.compare_rows(*left, *right));
                    after.extend(all_rows.iter().map(|row| self.row_ids[*row]));
                    self.commit(
                        EditRecord {
                            forward: InternalOp::ReorderRows(after),
                            inverse: InternalOp::ReorderRows(before),
                        },
                        self.row_ids.len() * 16,
                    )?;
                    self.view.sorts.clear();
                    self.rebuild_view();
                }
            }
        }
        Ok(())
    }

    fn undo(&mut self) -> Result<(), String> {
        let Some(transaction) = self.history.take_undo() else {
            return Ok(());
        };
        self.execute(&transaction.value.inverse)?;
        self.current_state = transaction.before_state;
        self.revision = self.revision.wrapping_add(1);
        self.history.finish_undo(transaction);
        self.rebuild_view();
        Ok(())
    }

    fn redo(&mut self) -> Result<(), String> {
        let Some(transaction) = self.history.take_redo() else {
            return Ok(());
        };
        self.execute(&transaction.value.forward)?;
        self.current_state = transaction.after_state;
        self.revision = self.revision.wrapping_add(1);
        self.history.finish_redo(transaction);
        self.rebuild_view();
        Ok(())
    }

    fn search(&self, request: &SearchRequest) -> Vec<SearchMatch> {
        if request.query.is_empty() {
            return Vec::new();
        }
        let query = if request.case_sensitive {
            request.query.clone()
        } else {
            request.query.to_lowercase()
        };
        let range = request.range.unwrap_or(CellRange {
            start_row: 0,
            end_row: self.document.row_count().saturating_sub(1),
            start_column: 0,
            end_column: self.document.column_count().saturating_sub(1),
        });
        let view_positions: HashMap<usize, usize> = self
            .visible_rows
            .iter()
            .enumerate()
            .map(|(view, source)| (*source, view))
            .collect();
        let mut matches = Vec::new();
        for row in range.start_row
            ..=range
                .end_row
                .min(self.document.row_count().saturating_sub(1))
        {
            for column in range.start_column
                ..=range
                    .end_column
                    .min(self.document.column_count().saturating_sub(1))
            {
                let value = self.cell_value(row, column);
                let candidate = if request.case_sensitive {
                    value.to_string()
                } else {
                    value.to_lowercase()
                };
                let found = if request.whole_cell {
                    candidate == query
                } else {
                    candidate.contains(&query)
                };
                if found {
                    matches.push(SearchMatch {
                        source_row: row,
                        view_row: view_positions.get(&row).copied(),
                        column,
                        value: value.to_string(),
                    });
                    if matches.len() >= request.limit {
                        return matches;
                    }
                }
            }
        }
        matches
    }

    fn profile(&self, column: usize) -> ColumnProfile {
        let mut counts = HashMap::<String, usize>::new();
        let mut empty_count = 0;
        let mut min_length = usize::MAX;
        let mut max_length = 0;
        let mut min: Option<String> = None;
        let mut max: Option<String> = None;
        let values: Vec<&str> = (self.data_start()..self.document.row_count())
            .map(|row| self.cell_value(row, column))
            .collect();
        for value in &values {
            if value.is_empty() {
                empty_count += 1;
            }
            min_length = min_length.min(value.chars().count());
            max_length = max_length.max(value.chars().count());
            if min.as_deref().is_none_or(|current| *value < current) {
                min = Some((*value).to_string());
            }
            if max.as_deref().is_none_or(|current| *value > current) {
                max = Some((*value).to_string());
            }
            *counts.entry((*value).to_string()).or_default() += 1;
        }
        let (suggested_type, confidence) = infer_type(&values);
        let selected_type = self
            .column_types
            .get(&column)
            .copied()
            .unwrap_or(suggested_type);
        let invalid_count = values
            .iter()
            .filter(|value| !value.is_empty() && parse_typed(value, selected_type).is_none())
            .count();
        let mut top_values: Vec<FacetValue> = counts
            .iter()
            .map(|(value, count)| FacetValue {
                value: value.clone(),
                count: *count,
            })
            .collect();
        top_values.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.value.cmp(&b.value)));
        top_values.truncate(10);
        let unique_count = counts.len();
        ColumnProfile {
            column,
            total_rows: values.len(),
            visible_rows: self.visible_rows.len(),
            empty_count,
            unique_count,
            duplicate_count: values.len().saturating_sub(unique_count),
            invalid_count,
            min,
            max,
            min_length: if values.is_empty() { 0 } else { min_length },
            max_length,
            suggested_type,
            active_type: selected_type,
            confidence,
            top_values,
        }
    }

    fn facets(&self, column: usize, query: &str, offset: usize, limit: usize) -> FacetPage {
        let query = query.to_lowercase();
        let mut counts = HashMap::<String, usize>::new();
        for &row in &self.visible_rows {
            let value = self.cell_value(row, column);
            if query.is_empty() || value.to_lowercase().contains(&query) {
                *counts.entry(value.to_string()).or_default() += 1;
            }
        }
        let mut values: Vec<FacetValue> = counts
            .into_iter()
            .map(|(value, count)| FacetValue { value, count })
            .collect();
        values.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.value.cmp(&b.value)));
        let total_distinct = values.len();
        let values = values
            .into_iter()
            .skip(offset)
            .take(limit.min(200))
            .collect::<Vec<_>>();
        let next_offset = (offset + values.len() < total_distinct).then_some(offset + values.len());
        FacetPage {
            values,
            total_distinct,
            next_offset,
        }
    }
}

pub(crate) type DocumentHandle = Arc<Mutex<DocumentSession>>;

pub struct WorkspaceState {
    documents: Mutex<Vec<DocumentHandle>>,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            documents: Mutex::new(vec![Arc::new(Mutex::new(DocumentSession::default()))]),
        }
    }
}

fn lock_workspace(
    state: &WorkspaceState,
) -> Result<std::sync::MutexGuard<'_, Vec<DocumentHandle>>, String> {
    state
        .documents
        .lock()
        .map_err(|_| "document workspace is unavailable".to_string())
}

pub(crate) fn lock_document(
    handle: &DocumentHandle,
) -> Result<std::sync::MutexGuard<'_, DocumentSession>, String> {
    handle
        .lock()
        .map_err(|_| "document session is unavailable".to_string())
}

pub(crate) fn document_handle(
    state: &WorkspaceState,
    document_id: u64,
) -> Result<DocumentHandle, String> {
    lock_workspace(state)?
        .iter()
        .find(|handle| {
            lock_document(handle)
                .map(|session| session.identity == document_id)
                .unwrap_or(false)
        })
        .cloned()
        .ok_or_else(|| format!("document {document_id} is not open"))
}

fn workspace_summary_value(state: &WorkspaceState) -> Result<WorkspaceSummary, String> {
    let handles = lock_workspace(state)?.clone();
    let documents = handles
        .iter()
        .map(|handle| Ok(lock_document(handle)?.summary()))
        .collect::<Result<Vec<_>, String>>()?;
    Ok(WorkspaceSummary { documents })
}

fn reorder_documents_internal(
    state: &WorkspaceState,
    document_ids: Vec<u64>,
) -> Result<WorkspaceSummary, String> {
    let handles = lock_workspace(state)?.clone();
    if document_ids.len() != handles.len() {
        return Err("the reordered list must contain every open document exactly once".to_string());
    }

    let mut handles_by_id = HashMap::with_capacity(handles.len());
    for handle in &handles {
        let document_id = lock_document(handle)?.identity;
        handles_by_id.insert(document_id, handle.clone());
    }

    let mut seen = HashSet::with_capacity(document_ids.len());
    let mut reordered = Vec::with_capacity(document_ids.len());
    for document_id in document_ids {
        if !seen.insert(document_id) {
            return Err(format!("document {document_id} appears more than once"));
        }
        reordered.push(
            handles_by_id
                .get(&document_id)
                .cloned()
                .ok_or_else(|| format!("document {document_id} is not open"))?,
        );
    }

    let mut current = lock_workspace(state)?;
    if current.len() != handles.len()
        || !current
            .iter()
            .all(|candidate| handles.iter().any(|handle| Arc::ptr_eq(candidate, handle)))
    {
        return Err("the workspace changed while the documents were being reordered".to_string());
    }
    *current = reordered;
    drop(current);
    workspace_summary_value(state)
}

fn find_document_by_path(
    state: &WorkspaceState,
    path: &Path,
    except_document_id: Option<u64>,
) -> Result<Option<DocumentHandle>, String> {
    let key = canonical_key(path);
    let handles = lock_workspace(state)?.clone();
    for handle in handles {
        let session = lock_document(&handle)?;
        if Some(session.identity) != except_document_id
            && session
                .path
                .as_deref()
                .is_some_and(|open| canonical_key(open) == key)
        {
            drop(session);
            return Ok(Some(handle));
        }
    }
    Ok(None)
}

fn recovery_payload(session: &DocumentSession) -> Option<RecoveryPayload> {
    (session.current_state != session.saved_state).then(|| RecoveryPayload {
        rows: session.document.rows().to_vec(),
        path: session
            .path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        dialect: session.dialect,
        header_enabled: session.header_enabled,
        column_types: session.column_types.clone(),
    })
}

fn workspace_recovery_payload(
    state: &WorkspaceState,
    excluded_document_id: Option<u64>,
) -> Result<Option<WorkspaceRecoveryPayload>, String> {
    let handles = lock_workspace(state)?.clone();
    let mut documents = Vec::new();
    for handle in handles {
        let session = lock_document(&handle)?;
        if Some(session.identity) != excluded_document_id
            && let Some(payload) = recovery_payload(&session)
        {
            documents.push(payload);
        }
    }
    Ok((!documents.is_empty()).then_some(WorkspaceRecoveryPayload {
        version: 1,
        documents,
    }))
}

fn session_from_recovery(payload: RecoveryPayload) -> DocumentSession {
    let row_count = payload.rows.len();
    let mut session = DocumentSession {
        document: TableDocument::from_rows(payload.rows),
        path: payload.path.map(PathBuf::from),
        dialect: payload.dialect,
        revision: 1,
        view_revision: 0,
        current_state: 1,
        saved_state: 0,
        next_state: 2,
        next_row_id: row_count as u64 + 1,
        row_ids: (1..=row_count as u64).collect(),
        history: TransactionHistory::with_limits(HISTORY_ENTRIES, HISTORY_BYTES),
        header_enabled: payload.header_enabled,
        header_suggested: false,
        column_types: payload.column_types,
        view: ViewState::default(),
        visible_rows: Vec::new(),
        identity: next_session_identity(),
    };
    session.rebuild_view();
    session
}

fn write_workspace_recovery_internal(
    app: &AppHandle,
    state: &WorkspaceState,
    excluded_document_id: Option<u64>,
) -> Result<(), String> {
    let path = recovery_path(app)?;
    let Some(payload) = workspace_recovery_payload(state, excluded_document_id)? else {
        return remove_if_exists(&path).map_err(|error| error.to_string());
    };
    write_json_atomic(&path, &payload)
}

fn ensure_path_available(
    state: &WorkspaceState,
    path: &Path,
    document_id: u64,
) -> Result<(), String> {
    if find_document_by_path(state, path, Some(document_id))?.is_some() {
        Err("another open document already uses that path".to_string())
    } else {
        Ok(())
    }
}

fn close_document_internal(
    state: &WorkspaceState,
    document_id: u64,
    discard_unsaved: bool,
) -> Result<(), String> {
    let handle = document_handle(state, document_id)?;
    if lock_document(&handle)?.summary().dirty && !discard_unsaved {
        return Err("save or explicitly discard this document before closing it".to_string());
    }
    let mut documents = lock_workspace(state)?;
    let index = documents
        .iter()
        .position(|candidate| Arc::ptr_eq(candidate, &handle))
        .ok_or_else(|| format!("document {document_id} is not open"))?;
    documents.remove(index);
    Ok(())
}

#[tauri::command]
pub fn workspace_summary(state: State<'_, WorkspaceState>) -> Result<WorkspaceSummary, String> {
    workspace_summary_value(&state)
}

#[tauri::command]
pub fn workspace_reorder(
    state: State<'_, WorkspaceState>,
    document_ids: Vec<u64>,
) -> Result<WorkspaceSummary, String> {
    reorder_documents_internal(&state, document_ids)
}

#[tauri::command]
pub fn session_summary(
    state: State<'_, WorkspaceState>,
    document_id: u64,
) -> Result<DocumentSummary, String> {
    Ok(lock_document(&document_handle(&state, document_id)?)?.summary())
}

#[tauri::command]
pub fn session_new(state: State<'_, WorkspaceState>) -> Result<DocumentSummary, String> {
    let handle = Arc::new(Mutex::new(DocumentSession::default()));
    let summary = lock_document(&handle)?.summary();
    lock_workspace(&state)?.push(handle);
    Ok(summary)
}

#[tauri::command]
pub fn session_open(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
    path: String,
) -> Result<DocumentSummary, String> {
    let path_buf = PathBuf::from(&path);
    if let Some(handle) = find_document_by_path(&state, &path_buf, None)? {
        return Ok(lock_document(&handle)?.summary());
    }
    let file = tablune_csv::read_path(&path_buf).map_err(|error| error.to_string())?;
    let preferences = load_preferences(&app)?
        .files
        .get(&canonical_key(&path_buf))
        .cloned()
        .unwrap_or_default();
    if let Some(handle) = find_document_by_path(&state, &path_buf, None)? {
        return Ok(lock_document(&handle)?.summary());
    }
    let handle = Arc::new(Mutex::new(DocumentSession::from_file(
        path_buf,
        file,
        preferences,
    )));
    let summary = lock_document(&handle)?.summary();
    lock_workspace(&state)?.push(handle);
    Ok(summary)
}

#[tauri::command]
pub fn session_close(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
    document_id: u64,
    discard_unsaved: bool,
) -> Result<WorkspaceSummary, String> {
    let handle = document_handle(&state, document_id)?;
    if lock_document(&handle)?.summary().dirty && !discard_unsaved {
        return Err("save or explicitly discard this document before closing it".to_string());
    }
    write_workspace_recovery_internal(&app, &state, Some(document_id))?;
    close_document_internal(&state, document_id, discard_unsaved)?;
    workspace_summary_value(&state)
}

#[tauri::command]
pub fn session_save(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
    document_id: u64,
    path: Option<String>,
) -> Result<DocumentSummary, String> {
    let handle = document_handle(&state, document_id)?;
    let destination = {
        let session = lock_document(&handle)?;
        path.map(PathBuf::from)
            .or_else(|| session.path.clone())
            .ok_or_else(|| "a destination path is required".to_string())?
    };
    ensure_path_available(&state, &destination, document_id)?;
    let summary = {
        let mut session = lock_document(&handle)?;
        tablune_csv::write_path(&destination, &session.document, session.dialect)
            .map_err(|error| error.to_string())?;
        session.path = Some(destination);
        session.saved_state = session.current_state;
        save_file_preferences(&app, &session)?;
        session.summary()
    };
    write_workspace_recovery_internal(&app, &state, None)?;
    Ok(summary)
}

#[tauri::command]
pub fn session_rename(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
    document_id: u64,
    new_name: String,
) -> Result<DocumentSummary, String> {
    let handle = document_handle(&state, document_id)?;
    let source = lock_document(&handle)?
        .path
        .clone()
        .ok_or_else(|| "save the document before renaming it".to_string())?;
    let destination = source
        .parent()
        .ok_or_else(|| "the document does not have a parent folder".to_string())?
        .join(new_name.trim());
    ensure_path_available(&state, &destination, document_id)?;
    let summary = {
        let mut session = lock_document(&handle)?;
        session.path = Some(super::rename_document_path(&source, new_name.trim())?);
        save_file_preferences(&app, &session)?;
        session.summary()
    };
    write_workspace_recovery_internal(&app, &state, None)?;
    Ok(summary)
}

#[tauri::command]
pub fn session_grid_window(
    state: State<'_, WorkspaceState>,
    document_id: u64,
    row_start: usize,
    row_count: usize,
    column_start: usize,
    column_count: usize,
) -> Result<GridWindow, String> {
    Ok(
        lock_document(&document_handle(&state, document_id)?)?.grid_window(
            row_start,
            row_count,
            column_start,
            column_count,
        ),
    )
}

#[tauri::command]
pub fn session_apply_edit(
    state: State<'_, WorkspaceState>,
    document_id: u64,
    command: EditCommand,
    expected_revision: u64,
) -> Result<DocumentSummary, String> {
    let handle = document_handle(&state, document_id)?;
    let mut session = lock_document(&handle)?;
    session.apply_edit(command, expected_revision)?;
    Ok(session.summary())
}

#[tauri::command]
pub fn session_undo(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
    document_id: u64,
) -> Result<DocumentSummary, String> {
    let handle = document_handle(&state, document_id)?;
    let summary = {
        let mut session = lock_document(&handle)?;
        session.undo()?;
        session.summary()
    };
    write_workspace_recovery_internal(&app, &state, None)?;
    Ok(summary)
}

#[tauri::command]
pub fn session_redo(
    state: State<'_, WorkspaceState>,
    document_id: u64,
) -> Result<DocumentSummary, String> {
    let handle = document_handle(&state, document_id)?;
    let mut session = lock_document(&handle)?;
    session.redo()?;
    Ok(session.summary())
}

#[tauri::command]
pub fn session_set_view(
    state: State<'_, WorkspaceState>,
    document_id: u64,
    view: ViewState,
) -> Result<DocumentSummary, String> {
    let handle = document_handle(&state, document_id)?;
    let mut session = lock_document(&handle)?;
    session.view = view;
    session.rebuild_view();
    Ok(session.summary())
}

#[tauri::command]
pub fn session_set_header(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
    document_id: u64,
    enabled: bool,
) -> Result<DocumentSummary, String> {
    let handle = document_handle(&state, document_id)?;
    let mut session = lock_document(&handle)?;
    session.header_enabled = enabled;
    session.header_suggested = false;
    session.view = ViewState::default();
    session.rebuild_view();
    save_file_preferences(&app, &session)?;
    Ok(session.summary())
}

#[tauri::command]
pub fn session_set_column_type(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
    document_id: u64,
    column: usize,
    column_type: ColumnType,
) -> Result<DocumentSummary, String> {
    let handle = document_handle(&state, document_id)?;
    let mut session = lock_document(&handle)?;
    session.column_types.insert(column, column_type);
    session.rebuild_view();
    save_file_preferences(&app, &session)?;
    Ok(session.summary())
}

#[tauri::command]
pub fn session_search(
    state: State<'_, WorkspaceState>,
    document_id: u64,
    request: SearchRequest,
) -> Result<Vec<SearchMatch>, String> {
    Ok(lock_document(&document_handle(&state, document_id)?)?.search(&request))
}

#[tauri::command]
pub fn session_replace(
    state: State<'_, WorkspaceState>,
    document_id: u64,
    request: ReplaceRequest,
) -> Result<DocumentSummary, String> {
    let handle = document_handle(&state, document_id)?;
    let mut session = lock_document(&handle)?;
    if request.expected_revision != session.revision {
        return Err("the document changed; run the search again".to_string());
    }
    let matches = session.search(&request.search);
    let selected = if request.replace_all {
        matches
    } else {
        matches.into_iter().take(1).collect()
    };
    let cells = selected
        .into_iter()
        .map(|found| {
            let value = if request.search.whole_cell {
                request.replacement.clone()
            } else if request.search.case_sensitive {
                found
                    .value
                    .replacen(&request.search.query, &request.replacement, 1)
            } else {
                replace_case_insensitive_once(
                    &found.value,
                    &request.search.query,
                    &request.replacement,
                )
            };
            CellInput {
                row: found.source_row,
                column: found.column,
                value,
            }
        })
        .collect();
    let revision = session.revision;
    session.apply_edit(EditCommand::SetCells { cells }, revision)?;
    Ok(session.summary())
}

#[tauri::command]
pub fn session_column_profile(
    state: State<'_, WorkspaceState>,
    document_id: u64,
    column: usize,
) -> Result<ColumnProfile, String> {
    Ok(lock_document(&document_handle(&state, document_id)?)?.profile(column))
}

#[tauri::command]
pub fn session_facets(
    state: State<'_, WorkspaceState>,
    document_id: u64,
    column: usize,
    query: String,
    offset: usize,
    limit: usize,
) -> Result<FacetPage, String> {
    Ok(
        lock_document(&document_handle(&state, document_id)?)?
            .facets(column, &query, offset, limit),
    )
}

#[tauri::command]
pub fn session_export_view(
    state: State<'_, WorkspaceState>,
    document_id: u64,
    path: String,
) -> Result<(), String> {
    let handle = document_handle(&state, document_id)?;
    let session = lock_document(&handle)?;
    let mut rows =
        Vec::with_capacity(session.visible_rows.len() + usize::from(session.header_enabled));
    if session.header_enabled && session.document.row_count() > 0 {
        rows.push(session.document.rows()[0].clone());
    }
    rows.extend(
        session
            .visible_rows
            .iter()
            .map(|row| session.document.rows()[*row].clone()),
    );
    tablune_csv::write_path(path, &TableDocument::from_rows(rows), session.dialect)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn workspace_write_recovery(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    write_workspace_recovery_internal(&app, &state, None)
}

#[tauri::command]
pub fn workspace_recovery_available(app: AppHandle) -> Result<bool, String> {
    Ok(recovery_path(&app)?.exists())
}

#[tauri::command]
pub fn workspace_restore_recovery(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<WorkspaceSummary, String> {
    let stored: StoredRecoveryPayload = read_json(&recovery_path(&app)?)?;
    let payloads = match stored {
        StoredRecoveryPayload::Workspace(payload) => {
            if payload.version != 1 {
                return Err(format!("unsupported recovery version {}", payload.version));
            }
            payload.documents
        }
        StoredRecoveryPayload::Legacy(payload) => vec![payload],
    };
    let documents = payloads
        .into_iter()
        .map(|payload| Arc::new(Mutex::new(session_from_recovery(payload))))
        .collect();
    *lock_workspace(&state)? = documents;
    workspace_summary_value(&state)
}

#[tauri::command]
pub fn workspace_discard_recovery(app: AppHandle) -> Result<(), String> {
    remove_if_exists(&recovery_path(&app)?).map_err(|error| error.to_string())
}

pub(crate) fn estimate_macro_history(before: &[Vec<String>], after: &[Vec<String>]) -> usize {
    let same_shape = before.len() == after.len()
        && before
            .iter()
            .zip(after)
            .all(|(old_row, new_row)| old_row.len() == new_row.len());
    if same_shape {
        before
            .iter()
            .zip(after)
            .flat_map(|(old_row, new_row)| old_row.iter().zip(new_row))
            .filter(|(old, new)| old != new)
            .map(|(old, new)| old.len().saturating_add(new.len()).saturating_add(32))
            .fold(0usize, usize::saturating_add)
    } else {
        let (start, before_end, after_end) = macro_changed_range(before, after);
        before[start..before_end]
            .iter()
            .chain(&after[start..after_end])
            .flatten()
            .map(String::len)
            .fold(0usize, usize::saturating_add)
            .saturating_add(
                (before_end - start)
                    .saturating_add(after_end - start)
                    .saturating_mul(32),
            )
    }
}

fn macro_changed_range(before: &[Vec<String>], after: &[Vec<String>]) -> (usize, usize, usize) {
    let mut prefix = 0;
    while prefix < before.len() && prefix < after.len() && before[prefix] == after[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < before.len().saturating_sub(prefix)
        && suffix < after.len().saturating_sub(prefix)
        && before[before.len() - suffix - 1] == after[after.len() - suffix - 1]
    {
        suffix += 1;
    }
    (prefix, before.len() - suffix, after.len() - suffix)
}

fn canonical_key(path: &Path) -> String {
    path.canonicalize()
        .or_else(|_| {
            let parent = path.parent().unwrap_or_else(|| Path::new("."));
            parent.canonicalize().map(|parent| {
                path.file_name()
                    .map_or(parent.clone(), |name| parent.join(name))
            })
        })
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn app_data_path(app: &AppHandle, file_name: &str) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join(file_name))
}

fn preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    app_data_path(app, "preferences.json")
}

fn recovery_path(app: &AppHandle) -> Result<PathBuf, String> {
    app_data_path(app, "recovery.json")
}

fn load_preferences(app: &AppHandle) -> Result<Preferences, String> {
    let path = preferences_path(app)?;
    if !path.exists() {
        return Ok(Preferences::default());
    }
    read_json(&path)
}

pub(crate) fn load_python_interpreter(app: &AppHandle) -> Result<Option<String>, String> {
    Ok(load_preferences(app)?.python_interpreter)
}

pub(crate) fn save_python_interpreter(app: &AppHandle, path: String) -> Result<(), String> {
    let mut preferences = load_preferences(app)?;
    preferences.python_interpreter = Some(path);
    write_json_atomic(&preferences_path(app)?, &preferences)
}

fn save_file_preferences(app: &AppHandle, session: &DocumentSession) -> Result<(), String> {
    let Some(path) = &session.path else {
        return Ok(());
    };
    let mut preferences = load_preferences(app)?;
    preferences.files.insert(
        canonical_key(path),
        FilePreferences {
            header_enabled: Some(session.header_enabled),
            column_types: session.column_types.clone(),
        },
    );
    write_json_atomic(&preferences_path(app)?, &preferences)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn remove_if_exists(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn suggest_header(rows: &[Vec<String>]) -> bool {
    let Some(first) = rows.first() else {
        return false;
    };
    let Some(second) = rows.get(1) else {
        return false;
    };
    if first.len() < 2 || first.iter().any(|value| value.trim().is_empty()) {
        return false;
    }
    let unique: HashSet<&str> = first.iter().map(String::as_str).collect();
    unique.len() == first.len()
        && first.iter().all(|value| parse_number(value).is_none())
        && second
            .iter()
            .any(|value| parse_number(value).is_some() || parse_boolean(value).is_some())
}

fn infer_type(values: &[&str]) -> (ColumnType, f64) {
    let non_empty: Vec<&str> = values
        .iter()
        .copied()
        .filter(|value| !value.is_empty())
        .collect();
    if non_empty.is_empty() {
        return (ColumnType::Text, 1.0);
    }
    let candidates = [ColumnType::Number, ColumnType::Date, ColumnType::Boolean];
    let mut best = (ColumnType::Text, 0.0);
    for candidate in candidates {
        let valid = non_empty
            .iter()
            .filter(|value| parse_typed(value, candidate).is_some())
            .count();
        let confidence = valid as f64 / non_empty.len() as f64;
        if confidence > best.1 {
            best = (candidate, confidence);
        }
    }
    if best.1 >= 0.8 {
        best
    } else {
        (ColumnType::Text, 1.0 - best.1)
    }
}

fn parse_number(value: &str) -> Option<f64> {
    let normalized = if value.contains(',') && !value.contains('.') {
        value.replace(',', ".")
    } else {
        value.to_string()
    };
    normalized
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
}

fn parse_boolean(value: &str) -> Option<bool> {
    match value.to_ascii_lowercase().as_str() {
        "true" | "yes" | "1" => Some(true),
        "false" | "no" | "0" => Some(false),
        _ => None,
    }
}

fn parse_date(value: &str) -> Option<(i32, u32, u32)> {
    let mut parts = value.split('-');
    let year = parts.next()?.parse().ok()?;
    let month = parts.next()?.parse().ok()?;
    let day_text = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let day = day_text.get(..2)?.parse().ok()?;
    (1..=12).contains(&month).then_some(())?;
    (1..=31).contains(&day).then_some(())?;
    Some((year, month, day))
}

fn parse_typed(value: &str, column_type: ColumnType) -> Option<TypedValue> {
    match column_type {
        ColumnType::Text => Some(TypedValue::Text(value.to_lowercase())),
        ColumnType::Number => parse_number(value).map(TypedValue::Number),
        ColumnType::Date => parse_date(value).map(TypedValue::Date),
        ColumnType::Boolean => parse_boolean(value).map(TypedValue::Boolean),
    }
}

#[derive(Debug, PartialEq)]
enum TypedValue {
    Text(String),
    Number(f64),
    Date((i32, u32, u32)),
    Boolean(bool),
}

fn compare_typed(left: &str, right: &str, column_type: ColumnType) -> Option<Ordering> {
    match (
        parse_typed(left, column_type)?,
        parse_typed(right, column_type)?,
    ) {
        (TypedValue::Text(a), TypedValue::Text(b)) => Some(a.cmp(&b)),
        (TypedValue::Number(a), TypedValue::Number(b)) => a.partial_cmp(&b),
        (TypedValue::Date(a), TypedValue::Date(b)) => Some(a.cmp(&b)),
        (TypedValue::Boolean(a), TypedValue::Boolean(b)) => Some(a.cmp(&b)),
        _ => None,
    }
}

fn compare_values(left: &str, right: &str, column_type: ColumnType) -> Ordering {
    if left.is_empty() && right.is_empty() {
        return Ordering::Equal;
    }
    if left.is_empty() {
        return Ordering::Greater;
    }
    if right.is_empty() {
        return Ordering::Less;
    }
    match (
        parse_typed(left, column_type),
        parse_typed(right, column_type),
    ) {
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), Some(_)) => compare_typed(left, right, column_type).unwrap_or(Ordering::Equal),
        (None, None) => left.to_lowercase().cmp(&right.to_lowercase()),
    }
}

fn column_name(index: usize) -> String {
    let mut value = index + 1;
    let mut result = String::new();
    while value > 0 {
        value -= 1;
        result.insert(0, char::from(b'A' + (value % 26) as u8));
        value /= 26;
    }
    result
}

fn replace_case_insensitive_once(value: &str, query: &str, replacement: &str) -> String {
    let lower_value = value.to_lowercase();
    let lower_query = query.to_lowercase();
    let Some(start) = lower_value.find(&lower_query) else {
        return value.to_string();
    };
    let end = start + query.len();
    if !value.is_char_boundary(start) || !value.is_char_boundary(end) {
        return value.to_string();
    }
    format!("{}{}{}", &value[..start], replacement, &value[end..])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add_session(workspace: &WorkspaceState, session: DocumentSession) -> u64 {
        let document_id = session.identity;
        lock_workspace(workspace)
            .unwrap()
            .push(Arc::new(Mutex::new(session)));
        document_id
    }

    #[test]
    fn workspace_documents_keep_independent_history_and_views() {
        let workspace = WorkspaceState {
            documents: Mutex::new(Vec::new()),
        };
        let first_id = add_session(&workspace, DocumentSession::default());
        let second_id = add_session(&workspace, DocumentSession::default());

        let first = document_handle(&workspace, first_id).unwrap();
        lock_document(&first)
            .unwrap()
            .apply_edit(
                EditCommand::SetCells {
                    cells: vec![CellInput {
                        row: 0,
                        column: 0,
                        value: "first".into(),
                    }],
                },
                0,
            )
            .unwrap();
        let second = document_handle(&workspace, second_id).unwrap();
        lock_document(&second)
            .unwrap()
            .view
            .filters
            .push(FilterSpec {
                column: 0,
                operator: "equals".into(),
                value: "second".into(),
                second_value: String::new(),
                values: Vec::new(),
                column_type: ColumnType::Text,
                case_sensitive: false,
            });
        lock_document(&second).unwrap().rebuild_view();

        let first = lock_document(&first).unwrap();
        let second = lock_document(&second).unwrap();
        assert_eq!(first.cell_value(0, 0), "first");
        assert!(first.history.can_undo());
        assert!(first.view.filters.is_empty());
        assert_eq!(second.cell_value(0, 0), "");
        assert!(!second.history.can_undo());
        assert_eq!(second.view.filters.len(), 1);
    }

    #[test]
    fn workspace_close_requires_explicit_discard_and_rejects_unknown_ids() {
        let workspace = WorkspaceState::default();
        let document_id = workspace_summary_value(&workspace).unwrap().documents[0].document_id;
        let handle = document_handle(&workspace, document_id).unwrap();
        lock_document(&handle)
            .unwrap()
            .apply_edit(
                EditCommand::SetCells {
                    cells: vec![CellInput {
                        row: 0,
                        column: 0,
                        value: "dirty".into(),
                    }],
                },
                0,
            )
            .unwrap();

        assert!(close_document_internal(&workspace, document_id, false).is_err());
        close_document_internal(&workspace, document_id, true).unwrap();
        assert!(
            workspace_summary_value(&workspace)
                .unwrap()
                .documents
                .is_empty()
        );
        assert!(document_handle(&workspace, document_id).is_err());
    }

    #[test]
    fn workspace_reorder_requires_the_exact_open_document_set() {
        let workspace = WorkspaceState {
            documents: Mutex::new(Vec::new()),
        };
        let first_id = add_session(&workspace, DocumentSession::default());
        let second_id = add_session(&workspace, DocumentSession::default());
        let third_id = add_session(&workspace, DocumentSession::default());

        let reordered =
            reorder_documents_internal(&workspace, vec![third_id, first_id, second_id]).unwrap();
        assert_eq!(
            reordered
                .documents
                .iter()
                .map(|document| document.document_id)
                .collect::<Vec<_>>(),
            vec![third_id, first_id, second_id]
        );

        assert!(
            reorder_documents_internal(&workspace, vec![third_id, third_id, first_id]).is_err()
        );
        assert!(reorder_documents_internal(&workspace, vec![third_id, first_id]).is_err());
        assert!(
            reorder_documents_internal(&workspace, vec![third_id, first_id, u64::MAX]).is_err()
        );

        assert_eq!(
            workspace_summary_value(&workspace)
                .unwrap()
                .documents
                .iter()
                .map(|document| document.document_id)
                .collect::<Vec<_>>(),
            vec![third_id, first_id, second_id]
        );
    }

    #[test]
    fn canonical_paths_reuse_the_existing_document() {
        let unique = next_session_identity();
        let directory = std::env::temp_dir().join(format!("tablune-workspace-{unique}"));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("data.csv");
        fs::write(&path, b"value\n").unwrap();
        let session = DocumentSession {
            path: Some(path.clone()),
            ..Default::default()
        };
        let document_id = session.identity;
        let workspace = WorkspaceState {
            documents: Mutex::new(vec![Arc::new(Mutex::new(session))]),
        };

        let equivalent = directory.join(".").join("data.csv");
        let found = find_document_by_path(&workspace, &equivalent, None)
            .unwrap()
            .unwrap();
        assert_eq!(lock_document(&found).unwrap().identity, document_id);
        assert!(
            find_document_by_path(&workspace, &path, Some(document_id))
                .unwrap()
                .is_none()
        );
        let other_id = add_session(&workspace, DocumentSession::default());
        assert!(ensure_path_available(&workspace, &path, other_id).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn recovery_manifest_contains_only_dirty_documents_and_reads_legacy_payloads() {
        let clean = DocumentSession::default();
        assert!(recovery_payload(&clean).is_none());
        let mut dirty = DocumentSession::default();
        dirty
            .apply_edit(
                EditCommand::SetCells {
                    cells: vec![CellInput {
                        row: 0,
                        column: 0,
                        value: "recover".into(),
                    }],
                },
                0,
            )
            .unwrap();
        let payload = recovery_payload(&dirty).unwrap();
        let mut second_dirty = DocumentSession::default();
        second_dirty
            .apply_edit(
                EditCommand::SetCells {
                    cells: vec![CellInput {
                        row: 1,
                        column: 0,
                        value: "also recover".into(),
                    }],
                },
                0,
            )
            .unwrap();
        let state = WorkspaceState {
            documents: Mutex::new(vec![
                Arc::new(Mutex::new(clean)),
                Arc::new(Mutex::new(dirty)),
                Arc::new(Mutex::new(second_dirty)),
            ]),
        };
        let workspace = workspace_recovery_payload(&state, None).unwrap().unwrap();
        assert_eq!(workspace.documents.len(), 2);
        assert_eq!(workspace.documents[0].rows[0][0], "recover");
        assert_eq!(workspace.documents[1].rows[1][0], "also recover");
        let stored: StoredRecoveryPayload =
            serde_json::from_slice(&serde_json::to_vec(&workspace).unwrap()).unwrap();
        assert!(matches!(stored, StoredRecoveryPayload::Workspace(_)));
        let legacy: StoredRecoveryPayload =
            serde_json::from_slice(&serde_json::to_vec(&payload).unwrap()).unwrap();
        assert!(matches!(legacy, StoredRecoveryPayload::Legacy(_)));
        let restored = session_from_recovery(payload);
        assert!(restored.summary().dirty);
        assert_eq!(restored.cell_value(0, 0), "recover");
    }

    #[test]
    fn edits_are_transactional_and_saved_state_is_restored_by_undo() {
        let mut session = DocumentSession::default();
        session
            .apply_edit(
                EditCommand::SetCells {
                    cells: vec![CellInput {
                        row: 2,
                        column: 3,
                        value: "value".into(),
                    }],
                },
                0,
            )
            .unwrap();
        assert!(session.summary().dirty);
        assert_eq!(session.cell_value(2, 3), "value");
        session.undo().unwrap();
        assert!(!session.summary().dirty);
        assert_eq!(session.cell_value(2, 3), "");
        assert_eq!(session.document.row_count(), 0);
        assert_eq!(session.document.column_count(), 0);
        session.redo().unwrap();
        assert_eq!(session.cell_value(2, 3), "value");
    }

    #[test]
    fn macro_changes_are_one_atomic_undo_entry() {
        let mut session = DocumentSession {
            document: TableDocument::from_rows(vec![vec!["name".into()], vec!["Ada".into()]]),
            header_enabled: true,
            ..Default::default()
        };
        session.ensure_row_ids();
        let identity = session.identity;
        session
            .apply_macro_rows(
                vec![
                    vec!["person".into(), "active".into()],
                    vec!["Ada".into(), "yes".into()],
                    vec!["Linus".into(), "no".into()],
                ],
                identity,
                0,
            )
            .unwrap();
        assert_eq!(session.revision, 1);
        assert!(session.history.can_undo());
        assert_eq!(session.document.row_count(), 3);
        session.undo().unwrap();
        assert_eq!(session.document.rows(), &[vec!["name"], vec!["Ada"]]);
        session.redo().unwrap();
        assert_eq!(session.document.row_count(), 3);
    }

    #[test]
    fn same_shape_macro_history_only_counts_changed_cells() {
        let before = vec![vec!["same".to_string(), "old".to_string()]];
        let after = vec![vec!["same".to_string(), "new".to_string()]];
        assert_eq!(estimate_macro_history(&before, &after), 38);
    }

    #[test]
    fn structural_macro_history_excludes_unchanged_edges() {
        let before = vec![
            vec!["prefix".to_string()],
            vec!["old".to_string()],
            vec!["suffix".to_string()],
        ];
        let after = vec![
            vec!["prefix".to_string()],
            vec!["new".to_string(), "column".to_string()],
            vec!["added".to_string()],
            vec!["suffix".to_string()],
        ];
        assert_eq!(macro_changed_range(&before, &after), (1, 2, 3));
        assert_eq!(estimate_macro_history(&before, &after), 113);
    }

    #[test]
    fn header_suggestion_is_conservative() {
        assert!(suggest_header(&[
            vec!["name".into(), "age".into()],
            vec!["Ada".into(), "37".into()]
        ]));
        assert!(!suggest_header(&[
            vec!["one".into(), "two".into()],
            vec!["three".into(), "four".into()]
        ]));
    }

    #[test]
    fn filters_and_profiles_never_change_raw_values() {
        let file = tablune_csv::read_bytes(b"name,score\nAda,10\nLinus,2\n").unwrap();
        let mut session = DocumentSession::from_file(
            PathBuf::from("test.csv"),
            file,
            FilePreferences {
                header_enabled: Some(true),
                column_types: HashMap::new(),
            },
        );
        session.view.filters.push(FilterSpec {
            column: 1,
            operator: "greaterThan".into(),
            value: "5".into(),
            second_value: String::new(),
            values: Vec::new(),
            column_type: ColumnType::Number,
            case_sensitive: false,
        });
        session.rebuild_view();
        assert_eq!(session.visible_rows, vec![1]);
        assert_eq!(session.profile(1).suggested_type, ColumnType::Number);
        assert_eq!(session.cell_value(2, 1), "2");
    }

    #[test]
    fn descending_sort_keeps_blank_values_last() {
        let mut session = DocumentSession {
            document: TableDocument::from_rows(vec![
                vec!["value".into()],
                vec!["2".into()],
                vec![String::new()],
                vec!["10".into()],
            ]),
            header_enabled: true,
            ..Default::default()
        };
        session.ensure_row_ids();
        session.view.sorts.push(SortSpec {
            column: 0,
            direction: SortDirection::Descending,
            column_type: ColumnType::Number,
        });
        session.rebuild_view();
        let values = session
            .visible_rows
            .iter()
            .map(|row| session.cell_value(*row, 0))
            .collect::<Vec<_>>();
        assert_eq!(values, vec!["10", "2", ""]);
    }

    #[test]
    #[ignore = "100k × 50 performance smoke test"]
    fn handles_the_100k_by_50_validation_dataset() {
        let rows = (0..100_000)
            .map(|row| {
                (0..50)
                    .map(|column| ((row + column) % 10_000).to_string())
                    .collect()
            })
            .collect();
        let mut session = DocumentSession {
            document: TableDocument::from_rows(rows),
            ..Default::default()
        };
        session.ensure_row_ids();
        session.rebuild_view();
        let window = session.grid_window(50_000, 100, 10, 25);
        assert_eq!(window.rows.len(), 100);
        assert_eq!(window.rows[0].cells.len(), 25);
        let profile = session.profile(7);
        assert_eq!(profile.total_rows, 100_000);
        assert_eq!(profile.suggested_type, ColumnType::Number);
    }
}
