#[path = "calculation.rs"]
pub mod calculation;
#[path = "projects.rs"]
pub mod projects;
#[path = "sheet_session.rs"]
pub mod sheets;
use crate::formulas::{self, DependencyGraph, SheetData};
use std::{
    borrow::Cow,
    cmp::Ordering,
    collections::{HashMap, HashSet},
    fs,
    io::{BufWriter, Write},
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
static NEXT_ATOMIC_WRITE: AtomicU64 = AtomicU64::new(1);
static WORKSPACE_RECOVERY_IO: Mutex<()> = Mutex::new(());

fn next_session_identity() -> u64 {
    NEXT_SESSION_IDENTITY.fetch_add(1, AtomicOrdering::Relaxed)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    pub image_count: usize,
    pub image_rows: Vec<usize>,
    pub calculation_revision: u64,
    pub formula_count: usize,
    pub pending_cells: usize,
    pub project_id: Option<u64>,
    pub view: ViewState,
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
    pub calculation_revision: u64,
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
    pub inputs: Option<Vec<sheets::CellInfo>>,
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
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EditCommand {
    SetSheetCells {
        cells: Vec<sheets::SheetCellInput>,
    },
    SetCellTypes {
        cells: Vec<CellPosition>,
        cell_type: formulas::CellType,
    },
    SetCells {
        cells: Vec<CellInput>,
    },
    InsertRows {
        index: usize,
        count: usize,
    },
    DeleteRows {
        index: usize,
        count: usize,
    },
    InsertColumns {
        index: usize,
        count: usize,
    },
    DeleteColumns {
        index: usize,
        count: usize,
    },
    SetDelimiter {
        delimiter: String,
    },
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
    #[serde(default)]
    pub view_range: Option<CellRange>,
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
    pub target: Option<ReplaceTarget>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceTarget {
    pub source_row: usize,
    pub column: usize,
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
    python_macro_folder: Option<String>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryPayloadRef<'a> {
    rows: &'a [Vec<String>],
    path: Option<Cow<'a, str>>,
    dialect: CsvDialect,
    header_enabled: bool,
    column_types: &'a HashMap<usize, ColumnType>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRecoveryPayloadRef<'a> {
    version: u8,
    documents: Vec<RecoveryPayloadRef<'a>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RecoveryDocumentFingerprint {
    identity: u64,
    revision: u64,
    path: Option<PathBuf>,
    header_enabled: bool,
    column_types: Vec<(usize, ColumnType)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RecoveryFingerprint(Vec<RecoveryDocumentFingerprint>);

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum StoredRecoveryPayload {
    Workspace(WorkspaceRecoveryPayload),
    Legacy(RecoveryPayload),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub projects: Vec<projects::ProjectSummary>,
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
    sheet: Option<SheetChange>,
    forward: InternalOp,
    inverse: InternalOp,
    column_state: Option<ColumnStateChange>,
}

/// Only changed metadata participates in undo; cached values elsewhere remain owned by the sheet.
#[derive(Debug, Clone, Serialize)]
struct SheetChange {
    cells: Vec<(
        String,
        Option<formulas::CellMeta>,
        Option<formulas::CellMeta>,
    )>,
}
impl SheetChange {
    fn new(before: &SheetData, after: &SheetData) -> Self {
        let mut cells = Vec::new();
        for (key, old) in &before.cells {
            let new = after.cells.get(key);
            if Some(old) != new {
                cells.push((key.clone(), Some(old.clone()), new.cloned()));
            }
        }
        for (key, new) in &after.cells {
            if !before.cells.contains_key(key) {
                cells.push((key.clone(), None, Some(new.clone())));
            }
        }
        Self { cells }
    }
    fn apply(&self, target: &mut SheetData, forward: bool) {
        for (key, before, after) in &self.cells {
            if let Some(value) = if forward { after } else { before } {
                target.cells.insert(key.clone(), value.clone());
            } else {
                target.cells.remove(key);
            }
        }
    }
}

#[derive(Debug, Clone)]
struct ColumnState {
    column_types: HashMap<usize, ColumnType>,
    view: ViewState,
}

#[derive(Debug, Clone)]
struct ColumnStateChange {
    before: ColumnState,
    after: ColumnState,
}

pub struct DocumentSession {
    pub(crate) image_assets: crate::images::SharedAssets,
    sheet: SheetData,
    graph: DependencyGraph,
    calculation_revision: u64,
    pub(crate) project_id: Option<u64>,
    title: Option<String>,
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
            project_id: None,
            title: None,
            image_assets: Default::default(),
            sheet: SheetData::default(),
            graph: DependencyGraph::default(),
            calculation_revision: 0,
        };
        session.rebuild_view();
        session
    }
}

impl DocumentSession {
    fn column_state(&self) -> ColumnState {
        ColumnState {
            column_types: self.column_types.clone(),
            view: self.view.clone(),
        }
    }

    fn restore_column_state(&mut self, state: &ColumnState) {
        self.column_types = state.column_types.clone();
        self.view = state.view.clone();
    }

    fn column_state_after_insert(&self, index: usize, count: usize) -> ColumnState {
        let shift = |column: usize| {
            if column >= index {
                column.saturating_add(count)
            } else {
                column
            }
        };
        let mut state = self.column_state();
        state.column_types = state
            .column_types
            .into_iter()
            .map(|(column, column_type)| (shift(column), column_type))
            .collect();
        for sort in &mut state.view.sorts {
            sort.column = shift(sort.column);
        }
        for filter in &mut state.view.filters {
            filter.column = shift(filter.column);
        }
        state
    }

    fn column_state_after_delete(&self, index: usize, count: usize) -> ColumnState {
        let end = index.saturating_add(count);
        let shifted = |column: usize| {
            if column < index {
                Some(column)
            } else if column < end {
                None
            } else {
                Some(column - count)
            }
        };
        let mut state = self.column_state();
        state.column_types = state
            .column_types
            .into_iter()
            .filter_map(|(column, column_type)| shifted(column).map(|column| (column, column_type)))
            .collect();
        state.view.sorts = state
            .view
            .sorts
            .into_iter()
            .filter_map(|mut sort| {
                sort.column = shifted(sort.column)?;
                Some(sort)
            })
            .collect();
        state.view.filters = state
            .view
            .filters
            .into_iter()
            .filter_map(|mut filter| {
                filter.column = shifted(filter.column)?;
                Some(filter)
            })
            .collect();
        state
    }

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
            project_id: None,
            title: None,
            image_assets: Default::default(),
            sheet: SheetData::default(),
            graph: DependencyGraph::default(),
            calculation_revision: 0,
        };
        session.rebuild_view();
        session
    }

    fn duplicate_to(&self, path: PathBuf) -> Self {
        let row_count = self.document.row_count();
        let mut session = Self {
            document: self.document.clone(),
            path: Some(path),
            dialect: self.dialect,
            revision: 0,
            view_revision: 0,
            current_state: 0,
            saved_state: 0,
            next_state: 1,
            next_row_id: row_count as u64 + 1,
            row_ids: (1..=row_count as u64).collect(),
            history: TransactionHistory::with_limits(HISTORY_ENTRIES, HISTORY_BYTES),
            header_enabled: self.header_enabled,
            header_suggested: false,
            column_types: self.column_types.clone(),
            view: ViewState::default(),
            visible_rows: Vec::new(),
            identity: next_session_identity(),
            project_id: None,
            title: None,
            image_assets: self.image_assets.clone(),
            sheet: self.sheet.clone(),
            graph: self.graph.clone(),
            calculation_revision: 0,
        };
        session.rebuild_view();
        session
    }

    pub(crate) fn summary(&self) -> DocumentSummary {
        let header_names = self.header_names();
        DocumentSummary {
            image_count: self
                .sheet
                .cells
                .values()
                .filter(|m| m.image.is_some())
                .count(),
            image_rows: {
                let rows: HashSet<_> = self
                    .sheet
                    .cells
                    .iter()
                    .filter(|(_, m)| m.image.is_some())
                    .filter_map(|(k, _)| formulas::position(k).map(|p| p.0))
                    .collect();
                self.visible_rows
                    .iter()
                    .enumerate()
                    .filter_map(|(i, r)| rows.contains(r).then_some(i))
                    .collect()
            },
            calculation_revision: self.calculation_revision,
            formula_count: self.sheet.formulas().count(),
            pending_cells: self.sheet.formulas().filter(|(_, m)| m.pending).count(),
            document_id: self.identity,
            project_id: self.project_id,
            view: self.view.clone(),
            path: self
                .path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            display_name: self.title.clone().unwrap_or_else(|| {
                self.path
                    .as_ref()
                    .and_then(|path| path.file_name())
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "Untitled.csv".to_string())
            }),
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
        if self.project_id.is_some() {
            return (0..count).map(column_name).collect();
        }
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
        usize::from(
            self.project_id.is_none() && self.header_enabled && self.document.row_count() > 0,
        )
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
        {
            let raw = self.raw_cell(row, column);
            if self.project_id.is_some() {
                if let Some(meta) = self.sheet.cells.get(&formulas::key((row, column))) {
                    if let Some(image) = &meta.image {
                        return &image.name;
                    }
                    if let Some(result) = &meta.cached {
                        return &result.display;
                    }
                    if meta.formula {
                        return "…";
                    }
                    if meta.escaped {
                        return raw.strip_prefix('\'').unwrap_or(raw);
                    }
                }
            }
            raw
        }
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
                inputs: self.project_id.map(|_| {
                    (column_start..column_start.saturating_add(column_count.min(200)))
                        .map(|column| self.cell_info(source_row, column))
                        .collect()
                }),
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
                self.document.restore_columns(*index, columns);
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
            calculation_revision: self.calculation_revision,
            document_id: self.identity,
            identity: self.identity,
            revision: self.revision,
            rows: self.materialized_rows(),
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
        let before_column_state = self.column_state();
        let after_column_state = ColumnState {
            column_types: if rows.iter().map(Vec::len).max().unwrap_or(0) == before_columns {
                self.column_types.clone()
            } else {
                HashMap::new()
            },
            view: ViewState::default(),
        };
        let column_state = Some(ColumnStateChange {
            before: before_column_state,
            after: after_column_state,
        });
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
                    sheet: None,
                    forward: InternalOp::SetCells {
                        cells: after,
                        restore_shape: None,
                    },
                    inverse: InternalOp::SetCells {
                        cells: before,
                        restore_shape: None,
                    },
                    column_state: column_state.clone(),
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
                    sheet: None,
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
                    column_state,
                },
                estimated_bytes,
            )?;
        }
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

    fn commit(&mut self, mut record: EditRecord, mut estimated_bytes: usize) -> Result<(), String> {
        if self.project_id.is_some() && record.sheet.is_none() {
            record.sheet = Some(SheetChange::new(
                &self.sheet,
                &self.sheet_after(&record.forward),
            ));
        }
        if let Some(change) = &record.sheet {
            estimated_bytes += serde_json::to_vec(change).map_err(|e| e.to_string())?.len();
        }
        if estimated_bytes > HISTORY_BYTES {
            return Err("The edit exceeds the 64 MiB Undo limit".into());
        }
        self.execute(&record.forward)?;
        if let Some(change) = &record.sheet {
            change.apply(&mut self.sheet, true);
            self.sync_sheet();
        }
        if let Some(change) = &record.column_state {
            self.restore_column_state(&change.after);
        }
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
            EditCommand::SetSheetCells { cells } => {
                self.edit_sheet_cells(cells)?;
            }
            EditCommand::SetCellTypes { cells, cell_type } => {
                self.edit_cell_types(cells, cell_type)?;
            }
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
                    let old = self.raw_cell(cell.row, cell.column).to_string();
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
                            sheet: None,
                            forward: InternalOp::SetCells {
                                cells: after,
                                restore_shape: None,
                            },
                            inverse: InternalOp::SetCells {
                                cells: before,
                                restore_shape: Some(original_shape),
                            },
                            column_state: None,
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
                        sheet: None,
                        forward: InternalOp::InsertRows { index, rows, ids },
                        inverse: InternalOp::RemoveRows { index, count },
                        column_state: None,
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
                            sheet: None,
                            forward: InternalOp::RemoveRows { index, count },
                            inverse: InternalOp::InsertRows { index, rows, ids },
                            column_state: None,
                        },
                        bytes,
                    )?;
                }
            }
            EditCommand::InsertColumns { index, count } => {
                let count = count.clamp(1, 1_000);
                let index = index.min(self.document.column_count());
                let column_state = Some(ColumnStateChange {
                    before: self.column_state(),
                    after: self.column_state_after_insert(index, count),
                });
                self.commit(
                    EditRecord {
                        sheet: None,
                        forward: InternalOp::InsertColumns { index, count },
                        inverse: InternalOp::RemoveColumns { index, count },
                        column_state,
                    },
                    self.document.row_count() * count,
                )?;
            }
            EditCommand::DeleteColumns { index, count } => {
                let count = count.min(self.document.column_count().saturating_sub(index));
                if count > 0 {
                    let columns = self.document.columns(index, count);
                    let bytes = columns
                        .iter()
                        .flatten()
                        .filter_map(Option::as_ref)
                        .map(String::len)
                        .sum::<usize>();
                    let column_state = Some(ColumnStateChange {
                        before: self.column_state(),
                        after: self.column_state_after_delete(index, count),
                    });
                    self.commit(
                        EditRecord {
                            sheet: None,
                            forward: InternalOp::RemoveColumns { index, count },
                            inverse: InternalOp::RestoreColumns { index, columns },
                            column_state,
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
                            sheet: None,
                            forward: InternalOp::SetDelimiter(bytes[0]),
                            inverse: InternalOp::SetDelimiter(self.dialect.delimiter),
                            column_state: None,
                        },
                        2,
                    )?;
                }
            }
            EditCommand::ApplySort => {
                if self.sheet.formulas().next().is_some() {
                    return Err("Use view sorting on sheets with formulas; applying the order would change references".into());
                }
                if !self.view.sorts.is_empty() {
                    let before = self.row_ids.clone();
                    let mut after = Vec::with_capacity(before.len());
                    if self.data_start() == 1 && !before.is_empty() {
                        after.push(before[0]);
                    }
                    let mut all_rows: Vec<usize> =
                        (self.data_start()..self.document.row_count()).collect();
                    all_rows.sort_by(|left, right| self.compare_rows(*left, *right));
                    after.extend(all_rows.iter().map(|row| self.row_ids[*row]));
                    let sorts = std::mem::take(&mut self.view.sorts);
                    let result = self.commit(
                        EditRecord {
                            sheet: None,
                            forward: InternalOp::ReorderRows(after),
                            inverse: InternalOp::ReorderRows(before),
                            column_state: None,
                        },
                        self.row_ids.len() * 16,
                    );
                    if let Err(error) = result {
                        self.view.sorts = sorts;
                        self.rebuild_view();
                        return Err(error);
                    }
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
        if let Some(change) = &transaction.value.sheet {
            change.apply(&mut self.sheet, false);
            self.sheet.invalidate_all();
            self.sync_sheet();
        }
        if let Some(change) = &transaction.value.column_state {
            self.restore_column_state(&change.before);
        }
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
        if let Some(change) = &transaction.value.sheet {
            change.apply(&mut self.sheet, true);
            self.sheet.invalidate_all();
            self.sync_sheet();
        }
        if let Some(change) = &transaction.value.column_state {
            self.restore_column_state(&change.after);
        }
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
        let source_range = request.range.unwrap_or(CellRange {
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
        let rows = if let Some(range) = request.view_range {
            let end = range.end_row.min(self.visible_rows.len().saturating_sub(1));
            if range.start_row > end || self.visible_rows.is_empty() {
                Vec::new()
            } else {
                self.visible_rows[range.start_row..=end].to_vec()
            }
        } else {
            let end = source_range
                .end_row
                .min(self.document.row_count().saturating_sub(1));
            if source_range.start_row > end || self.document.row_count() == 0 {
                Vec::new()
            } else {
                (source_range.start_row..=end).collect()
            }
        };
        let column_range = request.view_range.unwrap_or(source_range);
        let column_end = column_range
            .end_column
            .min(self.document.column_count().saturating_sub(1));
        for row in rows {
            for column in column_range.start_column..=column_end {
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

    fn replace(&mut self, request: ReplaceRequest) -> Result<(), String> {
        if request.expected_revision != self.revision {
            return Err("the document changed; run the search again".to_string());
        }
        let mut search = request.search.clone();
        if request.replace_all {
            search.limit = usize::MAX;
        }
        let matches = self.search(&search);
        let selected = if request.replace_all {
            matches
        } else {
            let target = request
                .target
                .ok_or_else(|| "select a current match before replacing it".to_string())?;
            vec![
                matches
                    .into_iter()
                    .find(|found| {
                        found.source_row == target.source_row && found.column == target.column
                    })
                    .ok_or_else(|| "the selected match is no longer available".to_string())?,
            ]
        };
        let cells: Vec<CellInput> = selected
            .into_iter()
            .filter(|found| {
                !self
                    .sheet
                    .cells
                    .get(&formulas::key((found.source_row, found.column)))
                    .is_some_and(|m| m.formula || m.image.is_some())
            })
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
        let revision = self.revision;
        if self.project_id.is_some() {
            return self.apply_edit(
                EditCommand::SetSheetCells {
                    cells: cells
                        .into_iter()
                        .map(|c| sheets::SheetCellInput {
                            image: None,
                            row: c.row,
                            column: c.column,
                            value: c.value,
                            literal: true,
                            cell_type: None,
                        })
                        .collect(),
                },
                revision,
            );
        }
        self.apply_edit(EditCommand::SetCells { cells }, revision)
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
    projects: Mutex<Vec<Arc<projects::ProjectHandle>>>,
    documents: Mutex<Vec<DocumentHandle>>,
    last_recovery: Mutex<Option<RecoveryFingerprint>>,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            documents: Mutex::new(Vec::new()),
            projects: Mutex::new(Vec::new()),
            last_recovery: Mutex::new(None),
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
    let handles = lock_workspace(state)?.clone();
    for handle in handles {
        if lock_document(&handle)?.identity == document_id {
            return Ok(handle);
        }
    }
    projects::find_document(state, document_id)
}

fn workspace_summary_value(state: &WorkspaceState) -> Result<WorkspaceSummary, String> {
    let handles = lock_workspace(state)?.clone();
    let documents = handles
        .iter()
        .map(|handle| Ok(lock_document(handle)?.summary()))
        .collect::<Result<Vec<_>, String>>()?;
    Ok(WorkspaceSummary {
        documents,
        projects: projects::summaries(state)?,
    })
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

#[cfg(test)]
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

#[cfg(test)]
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

fn workspace_recovery_encoding(
    state: &WorkspaceState,
    excluded_document_id: Option<u64>,
) -> Result<(RecoveryFingerprint, Option<Vec<u8>>), String> {
    let handles = lock_workspace(state)?.clone();
    let sessions = handles
        .iter()
        .map(lock_document)
        .collect::<Result<Vec<_>, _>>()?;
    let dirty_sessions = sessions
        .iter()
        .filter(|session| {
            Some(session.identity) != excluded_document_id
                && session.current_state != session.saved_state
        })
        .collect::<Vec<_>>();
    let fingerprint = RecoveryFingerprint(
        dirty_sessions
            .iter()
            .map(|session| {
                let mut column_types = session
                    .column_types
                    .iter()
                    .map(|(column, column_type)| (*column, *column_type))
                    .collect::<Vec<_>>();
                column_types.sort_by_key(|(column, _)| *column);
                RecoveryDocumentFingerprint {
                    identity: session.identity,
                    revision: session.revision,
                    path: session.path.clone(),
                    header_enabled: session.header_enabled,
                    column_types,
                }
            })
            .collect(),
    );
    if dirty_sessions.is_empty() {
        return Ok((fingerprint, None));
    }
    let documents = dirty_sessions
        .iter()
        .map(|session| RecoveryPayloadRef {
            rows: session.document.rows(),
            path: session.path.as_ref().map(|path| path.to_string_lossy()),
            dialect: session.dialect,
            header_enabled: session.header_enabled,
            column_types: &session.column_types,
        })
        .collect();
    let bytes = serde_json::to_vec(&WorkspaceRecoveryPayloadRef {
        version: 1,
        documents,
    })
    .map_err(|error| error.to_string())?;
    Ok((fingerprint, Some(bytes)))
}

fn workspace_recovery_fingerprint(
    state: &WorkspaceState,
    excluded_document_id: Option<u64>,
) -> Result<RecoveryFingerprint, String> {
    let handles = lock_workspace(state)?.clone();
    let mut documents = Vec::new();
    for handle in handles {
        let session = lock_document(&handle)?;
        if Some(session.identity) == excluded_document_id
            || session.current_state == session.saved_state
        {
            continue;
        }
        let mut column_types = session
            .column_types
            .iter()
            .map(|(column, column_type)| (*column, *column_type))
            .collect::<Vec<_>>();
        column_types.sort_by_key(|(column, _)| *column);
        documents.push(RecoveryDocumentFingerprint {
            identity: session.identity,
            revision: session.revision,
            path: session.path.clone(),
            header_enabled: session.header_enabled,
            column_types,
        });
    }
    Ok(RecoveryFingerprint(documents))
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
        project_id: None,
        title: None,
        image_assets: Default::default(),
        sheet: SheetData::default(),
        graph: DependencyGraph::default(),
        calculation_revision: 0,
    };
    session.rebuild_view();
    session
}

fn write_workspace_recovery_internal(
    app: &AppHandle,
    state: &WorkspaceState,
    excluded_document_id: Option<u64>,
) -> Result<(), String> {
    let _io = WORKSPACE_RECOVERY_IO
        .lock()
        .map_err(|_| "Recovery writer unavailable")?;
    let path = recovery_path(app)?;
    let candidate = workspace_recovery_fingerprint(state, excluded_document_id)?;
    if recovery_is_current(state, &candidate)? {
        return Ok(());
    }
    let (fingerprint, bytes) = workspace_recovery_encoding(state, excluded_document_id)?;
    // Another writer, or a concurrent edit reverting to the cached state, may have
    // made the second snapshot current while it was being encoded.
    if recovery_is_current(state, &fingerprint)? {
        return Ok(());
    }
    if let Some(bytes) = bytes {
        write_bytes_atomic(&path, &bytes)?;
    } else {
        remove_if_exists(&path).map_err(|error| error.to_string())?;
    }
    *state
        .last_recovery
        .lock()
        .map_err(|_| "recovery state is unavailable".to_string())? = Some(fingerprint);
    Ok(())
}

fn recovery_is_current(
    state: &WorkspaceState,
    fingerprint: &RecoveryFingerprint,
) -> Result<bool, String> {
    Ok(state
        .last_recovery
        .lock()
        .map_err(|_| "recovery state is unavailable".to_string())?
        .as_ref()
        == Some(fingerprint))
}

fn reset_recovery_fingerprint(state: &WorkspaceState) -> Result<(), String> {
    *state
        .last_recovery
        .lock()
        .map_err(|_| "recovery state is unavailable".to_string())? = None;
    Ok(())
}

fn ensure_path_available(
    state: &WorkspaceState,
    path: &Path,
    document_id: u64,
) -> Result<(), String> {
    projects::ensure_not_project_path(state, path)?;
    if find_document_by_path(state, path, Some(document_id))?.is_some() {
        Err("another open document already uses that path".to_string())
    } else {
        Ok(())
    }
}

fn duplicate_name_parts(path: &Path) -> Result<(String, u64, Option<String>), String> {
    let stem = path
        .file_stem()
        .ok_or_else(|| "the document does not have a valid file name".to_string())?
        .to_string_lossy()
        .into_owned();
    let extension = path
        .extension()
        .map(|value| value.to_string_lossy().into_owned());
    if let Some(open) = stem.rfind('(')
        && stem.ends_with(')')
        && open > 0
        && let Ok(number) = stem[open + 1..stem.len() - 1].parse::<u64>()
    {
        let next = number
            .checked_add(1)
            .ok_or_else(|| "could not generate another duplicate file name".to_string())?;
        return Ok((stem[..open].to_string(), next, extension));
    }
    Ok((stem, 1, extension))
}

fn next_duplicate_path(path: &Path) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "the document does not have a parent folder".to_string())?;
    let (base, mut number, extension) = duplicate_name_parts(path)?;
    loop {
        let name = match &extension {
            Some(extension) => format!("{base}({number}).{extension}"),
            None => format!("{base}({number})"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
        number = number
            .checked_add(1)
            .ok_or_else(|| "could not generate another duplicate file name".to_string())?;
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
pub async fn workspace_summary(app: AppHandle) -> Result<WorkspaceSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workspace_summary_value(&app.state::<WorkspaceState>())
    })
    .await
    .map_err(|e| e.to_string())?
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
    projects::ensure_not_project_path(&state, &path_buf)?;
    if let Some(handle) = find_document_by_path(&state, &path_buf, None)? {
        projects::remember(&app, &path, "csv");
        return Ok(lock_document(&handle)?.summary());
    }
    let file = tablune_csv::read_path(&path_buf).map_err(|error| error.to_string())?;
    let preferences = load_preferences(&app)?
        .files
        .get(&canonical_key(&path_buf))
        .cloned()
        .unwrap_or_default();
    if let Some(handle) = find_document_by_path(&state, &path_buf, None)? {
        projects::remember(&app, &path, "csv");
        return Ok(lock_document(&handle)?.summary());
    }
    let handle = Arc::new(Mutex::new(DocumentSession::from_file(
        path_buf,
        file,
        preferences,
    )));
    let summary = lock_document(&handle)?.summary();
    lock_workspace(&state)?.push(handle);
    projects::remember(&app, &path, "csv");
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
    if lock_document(&handle)?.project_id.is_some() {
        return Err("Use the project commands for this table".into());
    }
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
    if lock_document(&handle)?.project_id.is_some() {
        return Err("Use the project commands for this table".into());
    }
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
        finalize_successful_save(&mut session, destination, |session| {
            save_file_preferences(&app, session)
        })
    };
    if let Err(error) = write_workspace_recovery_internal(&app, &state, None) {
        report_nonfatal("refreshing recovery after save", &error);
    }
    if let Some(path) = &summary.path {
        projects::remember(&app, path, "csv");
    }
    Ok(summary)
}

#[tauri::command]
pub fn session_duplicate(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
    document_id: u64,
) -> Result<WorkspaceSummary, String> {
    let source_handle = document_handle(&state, document_id)?;
    if lock_document(&source_handle)?.project_id.is_some() {
        return Err("Use the project commands for this table".into());
    }
    let source_path = lock_document(&source_handle)?
        .path
        .clone()
        .ok_or_else(|| "save the document before duplicating it".to_string())?;
    let mut destination = next_duplicate_path(&source_path)?;
    while find_document_by_path(&state, &destination, None)?.is_some() {
        destination = next_duplicate_path(&destination)?;
    }

    let duplicate = lock_document(&source_handle)?.duplicate_to(destination.clone());
    tablune_csv::write_path(&destination, &duplicate.document, duplicate.dialect)
        .map_err(|error| error.to_string())?;
    if let Err(error) = save_file_preferences(&app, &duplicate) {
        report_nonfatal("saving preferences for the duplicated document", &error);
    }

    let duplicate_handle = Arc::new(Mutex::new(duplicate));
    let mut workspace = match lock_workspace(&state) {
        Ok(workspace) => workspace,
        Err(error) => {
            let _ = fs::remove_file(&destination);
            return Err(error);
        }
    };
    let Some(source_index) = workspace
        .iter()
        .position(|candidate| Arc::ptr_eq(candidate, &source_handle))
    else {
        drop(workspace);
        let _ = fs::remove_file(&destination);
        return Err("the source document is no longer open".to_string());
    };
    workspace.insert(source_index + 1, duplicate_handle);
    drop(workspace);
    workspace_summary_value(&state)
}

#[tauri::command]
pub fn session_rename(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
    document_id: u64,
    new_name: String,
) -> Result<DocumentSummary, String> {
    let handle = document_handle(&state, document_id)?;
    if lock_document(&handle)?.project_id.is_some() {
        return Err("Use the project commands for this table".into());
    }
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
        if let Err(error) = save_file_preferences(&app, &session) {
            report_nonfatal("saving preferences after rename", &error);
        }
        session.summary()
    };
    if let Err(error) = write_workspace_recovery_internal(&app, &state, None) {
        report_nonfatal("refreshing recovery after rename", &error);
    }
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
    if let Err(error) = write_workspace_recovery_internal(&app, &state, None) {
        report_nonfatal("refreshing recovery after undo", &error);
    }
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
    if session.project_id.is_some() {
        session.revision += 1;
    }
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
    let summary = {
        let mut session = lock_document(&handle)?;
        save_file_preferences_for(
            &app,
            session.path.as_deref(),
            enabled,
            &session.column_types,
        )?;
        session.header_enabled = enabled;
        if session.project_id.is_some() {
            session.revision += 1;
        }
        session.header_suggested = false;
        session.view = ViewState::default();
        session.rebuild_view();
        session.summary()
    };
    if summary.dirty
        && let Err(error) = write_workspace_recovery_internal(&app, &state, None)
    {
        report_nonfatal("refreshing recovery after header change", &error);
    }
    Ok(summary)
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
    let summary = {
        let mut session = lock_document(&handle)?;
        let mut column_types = session.column_types.clone();
        column_types.insert(column, column_type);
        save_file_preferences_for(
            &app,
            session.path.as_deref(),
            session.header_enabled,
            &column_types,
        )?;
        session.column_types = column_types;
        session.sheet.invalidate_all();
        session.refresh_literal_caches();
        if session.project_id.is_some() {
            session.revision += 1;
        }
        session.rebuild_view();
        session.summary()
    };
    if summary.dirty
        && let Err(error) = write_workspace_recovery_internal(&app, &state, None)
    {
        report_nonfatal("refreshing recovery after column type change", &error);
    }
    Ok(summary)
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
    session.replace(request)?;
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
    allow_images: Option<bool>,
) -> Result<(), String> {
    ensure_path_available(&state, Path::new(&path), 0)?;
    let handle = document_handle(&state, document_id)?;
    let session = lock_document(&handle)?;
    session.ensure_calculated()?;
    if session.sheet.cells.values().any(|m| m.image.is_some()) && allow_images != Some(true) {
        return Err("CSV exports image names only. Confirm image export before continuing".into());
    }
    let mut rows =
        Vec::with_capacity(session.visible_rows.len() + usize::from(session.header_enabled));
    if session.project_id.is_none() && session.header_enabled && session.document.row_count() > 0 {
        rows.push(session.document.rows()[0].clone());
    }
    rows.extend(session.visible_rows.iter().map(|row| {
        (0..session.document.rows()[*row].len())
            .map(|column| session.cell_value(*row, column).to_string())
            .collect()
    }));
    tablune_csv::write_path(path, &TableDocument::from_rows(rows), session.dialect)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn workspace_write_recovery(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkspaceState>();
        write_workspace_recovery_internal(&app, &state, None)?;
        projects::write_recovery(&app, &state)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn workspace_recovery_available(app: AppHandle) -> Result<bool, String> {
    Ok(recovery_path(&app)?.exists() || projects::recovery_path(&app)?.exists())
}

#[tauri::command]
pub fn workspace_restore_recovery(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<WorkspaceSummary, String> {
    let restored_projects = projects::read_recovery(&app)?;
    if !recovery_path(&app)?.exists() {
        projects::restore_projects(&state, restored_projects)?;
        return workspace_summary_value(&state);
    }
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
    projects::restore_projects(&state, restored_projects)?;
    *lock_workspace(&state)? = documents;
    reset_recovery_fingerprint(&state)?;
    workspace_summary_value(&state)
}

#[tauri::command]
pub fn workspace_discard_recovery(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let _io = WORKSPACE_RECOVERY_IO
        .lock()
        .map_err(|_| "Recovery writer unavailable")?;
    projects::discard_recovery(&app)?;
    remove_if_exists(&recovery_path(&app)?).map_err(|error| error.to_string())?;
    reset_recovery_fingerprint(&state)
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

pub(crate) fn load_python_macro_folder(app: &AppHandle) -> Result<Option<String>, String> {
    Ok(load_preferences(app)?.python_macro_folder)
}

pub(crate) fn save_python_macro_folder(app: &AppHandle, path: String) -> Result<(), String> {
    let mut preferences = load_preferences(app)?;
    preferences.python_macro_folder = Some(path);
    write_json_atomic(&preferences_path(app)?, &preferences)
}

fn save_file_preferences(app: &AppHandle, session: &DocumentSession) -> Result<(), String> {
    save_file_preferences_for(
        app,
        session.path.as_deref(),
        session.header_enabled,
        &session.column_types,
    )
}

fn save_file_preferences_for(
    app: &AppHandle,
    path: Option<&Path>,
    header_enabled: bool,
    column_types: &HashMap<usize, ColumnType>,
) -> Result<(), String> {
    let Some(path) = path else {
        return Ok(());
    };
    let mut preferences = load_preferences(app)?;
    preferences.files.insert(
        canonical_key(path),
        FilePreferences {
            header_enabled: Some(header_enabled),
            column_types: column_types.clone(),
        },
    );
    write_json_atomic(&preferences_path(app)?, &preferences)
}

fn finalize_successful_save(
    session: &mut DocumentSession,
    destination: PathBuf,
    persist_preferences: impl FnOnce(&DocumentSession) -> Result<(), String>,
) -> DocumentSummary {
    session.path = Some(destination);
    session.saved_state = session.current_state;
    if let Err(error) = persist_preferences(session) {
        report_nonfatal("saving preferences after the CSV was saved", &error);
    }
    session.summary()
}

fn report_nonfatal(context: &str, error: &str) {
    eprintln!("Tablune warning while {context}: {error}");
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    write_bytes_atomic(path, &bytes)
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let write_id = NEXT_ATOMIC_WRITE.fetch_add(1, AtomicOrdering::Relaxed);
    let temporary = path.with_extension(format!("tablune-tmp-{}-{write_id}", std::process::id()));
    let file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
    let mut writer = BufWriter::new(file);
    let write_result = writer
        .write_all(bytes)
        .and_then(|()| writer.flush())
        .and_then(|()| writer.get_ref().sync_all());
    drop(writer);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    tablune_csv::replace_file_atomic(&temporary, path).map_err(|error| error.to_string())
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
    let year_text = parts.next()?;
    let month_text = parts.next()?;
    let day_text = parts.next()?;
    if parts.next().is_some()
        || year_text.len() != 4
        || month_text.len() != 2
        || day_text.len() != 2
        || !year_text.bytes().all(|byte| byte.is_ascii_digit())
        || !month_text.bytes().all(|byte| byte.is_ascii_digit())
        || !day_text.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let year = year_text.parse().ok()?;
    let month = month_text.parse().ok()?;
    let day = day_text.parse().ok()?;
    let maximum_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => return None,
    };
    (1..=maximum_day).contains(&day).then_some(())?;
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
    let lower_query = query.to_lowercase();
    if lower_query.is_empty() {
        return value.to_string();
    }
    let mut lower_value = String::new();
    let mut segments = Vec::new();
    for (original_start, character) in value.char_indices() {
        let original_end = original_start + character.len_utf8();
        let lower_start = lower_value.len();
        lower_value.extend(character.to_lowercase());
        segments.push((lower_start, lower_value.len(), original_start, original_end));
    }
    let Some(start) = lower_value.find(&lower_query) else {
        return value.to_string();
    };
    let lower_end = start + lower_query.len();
    let Some(original_start) = segments
        .iter()
        .find(|(segment_start, segment_end, _, _)| *segment_start <= start && start < *segment_end)
        .map(|(_, _, original_start, _)| *original_start)
    else {
        return value.to_string();
    };
    let Some(original_end) = segments
        .iter()
        .find(|(segment_start, segment_end, _, _)| {
            *segment_start < lower_end && lower_end <= *segment_end
        })
        .map(|(_, _, _, original_end)| *original_end)
    else {
        return value.to_string();
    };
    format!(
        "{}{}{}",
        &value[..original_start],
        replacement,
        &value[original_end..]
    )
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
    fn duplicate_names_increment_suffixes_and_preserve_extensions() {
        let unique = next_session_identity();
        let directory = std::env::temp_dir().join(format!("tablune-duplicate-{unique}"));
        fs::create_dir_all(&directory).unwrap();

        let source = directory.join("report.csv");
        fs::write(&source, b"value\n").unwrap();
        assert_eq!(
            next_duplicate_path(&source).unwrap(),
            directory.join("report(1).csv")
        );
        fs::write(directory.join("report(1).csv"), b"").unwrap();
        fs::write(directory.join("report(2).csv"), b"").unwrap();
        assert_eq!(
            next_duplicate_path(&source).unwrap(),
            directory.join("report(3).csv")
        );

        let numbered = directory.join("data(4).TSV");
        fs::write(&numbered, b"").unwrap();
        fs::write(directory.join("data(5).TSV"), b"").unwrap();
        assert_eq!(
            next_duplicate_path(&numbered).unwrap(),
            directory.join("data(6).TSV")
        );

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn duplicated_session_uses_current_data_and_starts_clean() {
        let mut source = DocumentSession {
            path: Some(PathBuf::from("/tmp/source.csv")),
            dialect: CsvDialect {
                delimiter: b';',
                line_ending: LineEnding::CrLf,
            },
            header_enabled: true,
            ..Default::default()
        };
        source.column_types.insert(0, ColumnType::Number);
        source
            .apply_edit(
                EditCommand::SetCells {
                    cells: vec![CellInput {
                        row: 0,
                        column: 0,
                        value: "42".into(),
                    }],
                },
                0,
            )
            .unwrap();

        let duplicate = source.duplicate_to(PathBuf::from("/tmp/source(1).csv"));

        assert!(source.summary().dirty);
        assert_eq!(source.cell_value(0, 0), "42");
        assert_eq!(duplicate.cell_value(0, 0), "42");
        assert!(!duplicate.summary().dirty);
        assert!(!duplicate.history.can_undo());
        assert_eq!(duplicate.dialect, source.dialect);
        assert!(duplicate.header_enabled);
        assert_eq!(duplicate.column_types.get(&0), Some(&ColumnType::Number));
        assert!(duplicate.view.sorts.is_empty());
        assert!(duplicate.view.filters.is_empty());
    }

    #[test]
    fn workspace_documents_keep_independent_history_and_views() {
        let workspace = WorkspaceState {
            documents: Mutex::new(Vec::new()),
            projects: Mutex::new(Vec::new()),
            last_recovery: Mutex::new(None),
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
        let document_id = add_session(&workspace, DocumentSession::default());
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
            projects: Mutex::new(Vec::new()),
            last_recovery: Mutex::new(None),
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
            projects: Mutex::new(Vec::new()),
            last_recovery: Mutex::new(None),
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
            projects: Mutex::new(Vec::new()),
            last_recovery: Mutex::new(None),
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
    fn recovery_serializes_borrowed_rows_and_skips_unchanged_revisions() {
        let mut dirty = DocumentSession::default();
        dirty
            .apply_edit(
                EditCommand::SetCells {
                    cells: vec![CellInput {
                        row: 0,
                        column: 0,
                        value: "recover once".into(),
                    }],
                },
                0,
            )
            .unwrap();
        let handle = Arc::new(Mutex::new(dirty));
        let state = WorkspaceState {
            documents: Mutex::new(vec![handle.clone()]),
            projects: Mutex::new(Vec::new()),
            last_recovery: Mutex::new(None),
        };

        let (fingerprint, bytes) = workspace_recovery_encoding(&state, None).unwrap();
        assert_eq!(
            workspace_recovery_fingerprint(&state, None).unwrap(),
            fingerprint
        );
        let stored: StoredRecoveryPayload =
            serde_json::from_slice(bytes.as_deref().unwrap()).unwrap();
        let StoredRecoveryPayload::Workspace(payload) = stored else {
            panic!("workspace recovery should use the versioned manifest");
        };
        assert_eq!(payload.documents[0].rows[0][0], "recover once");
        assert!(!recovery_is_current(&state, &fingerprint).unwrap());
        *state.last_recovery.lock().unwrap() = Some(fingerprint.clone());
        assert!(recovery_is_current(&state, &fingerprint).unwrap());
        reset_recovery_fingerprint(&state).unwrap();
        assert!(!recovery_is_current(&state, &fingerprint).unwrap());
        *state.last_recovery.lock().unwrap() = Some(fingerprint.clone());

        lock_document(&handle)
            .unwrap()
            .apply_edit(
                EditCommand::SetCells {
                    cells: vec![CellInput {
                        row: 0,
                        column: 0,
                        value: "recover twice".into(),
                    }],
                },
                1,
            )
            .unwrap();
        let (updated, _) = workspace_recovery_encoding(&state, None).unwrap();
        assert!(!recovery_is_current(&state, &updated).unwrap());
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
    fn successful_csv_save_remains_clean_when_preferences_fail_afterward() {
        let mut session = DocumentSession::default();
        session
            .apply_edit(
                EditCommand::SetCells {
                    cells: vec![CellInput {
                        row: 0,
                        column: 0,
                        value: "saved".into(),
                    }],
                },
                0,
            )
            .unwrap();
        let destination = PathBuf::from("/tmp/saved.csv");
        let summary = finalize_successful_save(&mut session, destination.clone(), |_| {
            Err("simulated preferences failure".to_string())
        });

        assert!(!summary.dirty);
        assert_eq!(session.path.as_ref(), Some(&destination));
        assert_eq!(session.saved_state, session.current_state);
    }

    #[test]
    fn legacy_preferences_default_the_macros_folder() {
        let preferences: Preferences =
            serde_json::from_str(r#"{"python_interpreter":"/usr/bin/python3","files":{}}"#)
                .unwrap();
        assert_eq!(
            preferences.python_interpreter.as_deref(),
            Some("/usr/bin/python3")
        );
        assert!(preferences.python_macro_folder.is_none());
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
    fn date_parsing_rejects_impossible_or_trailing_values() {
        assert_eq!(parse_date("2024-02-29"), Some((2024, 2, 29)));
        assert_eq!(parse_date("2026-02-29"), None);
        assert_eq!(parse_date("2026-04-31"), None);
        assert_eq!(parse_date("2026-01-01T12:30:00"), None);
        assert_eq!(parse_date("26-01-01"), None);
    }

    #[test]
    fn case_insensitive_replacement_maps_unicode_expansions_to_original_bytes() {
        assert_eq!(
            replace_case_insensitive_once("İstanbul", "i", "X"),
            "Xstanbul"
        );
        assert_eq!(replace_case_insensitive_once("CAFÉ", "é", "tea"), "CAFtea");
        assert_eq!(
            replace_case_insensitive_once("unchanged", "ø", "x"),
            "unchanged"
        );
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

    fn search_request(query: &str, limit: usize) -> SearchRequest {
        SearchRequest {
            query: query.to_string(),
            case_sensitive: true,
            whole_cell: true,
            range: None,
            view_range: None,
            limit,
        }
    }

    #[test]
    fn replace_uses_the_selected_match_and_replace_all_ignores_display_limit() {
        let mut session = DocumentSession {
            document: TableDocument::from_rows(
                (0..10_001).map(|_| vec!["match".to_string()]).collect(),
            ),
            ..Default::default()
        };
        session.ensure_row_ids();
        session.rebuild_view();
        session
            .replace(ReplaceRequest {
                search: search_request("match", 10_000),
                replacement: "selected".to_string(),
                replace_all: false,
                expected_revision: 0,
                target: Some(ReplaceTarget {
                    source_row: 5,
                    column: 0,
                }),
            })
            .unwrap();
        assert_eq!(session.cell_value(0, 0), "match");
        assert_eq!(session.cell_value(5, 0), "selected");

        session
            .replace(ReplaceRequest {
                search: search_request("match", 10_000),
                replacement: "all".to_string(),
                replace_all: true,
                expected_revision: 1,
                target: None,
            })
            .unwrap();
        assert_eq!(session.cell_value(0, 0), "all");
        assert_eq!(session.cell_value(10_000, 0), "all");
        assert_eq!(session.cell_value(5, 0), "selected");
    }

    #[test]
    fn search_view_range_maps_filtered_rows_back_to_sources() {
        let mut session = DocumentSession {
            document: TableDocument::from_rows(vec![
                vec!["hidden".into()],
                vec!["match".into()],
                vec!["hidden".into()],
                vec!["match".into()],
            ]),
            ..Default::default()
        };
        session.ensure_row_ids();
        session.view.filters.push(FilterSpec {
            column: 0,
            operator: "equals".into(),
            value: "match".into(),
            second_value: String::new(),
            values: Vec::new(),
            column_type: ColumnType::Text,
            case_sensitive: true,
        });
        session.rebuild_view();
        let matches = session.search(&SearchRequest {
            view_range: Some(CellRange {
                start_row: 1,
                end_row: 1,
                start_column: 0,
                end_column: 0,
            }),
            ..search_request("match", 10_000)
        });
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].source_row, 3);
        assert_eq!(matches[0].view_row, Some(1));
    }

    #[test]
    fn column_edits_and_history_preserve_ragged_rows_and_column_metadata() {
        let original = vec![
            vec!["a".into()],
            vec!["b".into(), "2".into(), "2026-01-01".into()],
            Vec::new(),
        ];
        let mut session = DocumentSession {
            document: TableDocument::from_rows(original.clone()),
            column_types: HashMap::from([
                (0, ColumnType::Text),
                (1, ColumnType::Number),
                (2, ColumnType::Date),
            ]),
            view: ViewState {
                sorts: vec![SortSpec {
                    column: 2,
                    direction: SortDirection::Ascending,
                    column_type: ColumnType::Date,
                }],
                filters: vec![FilterSpec {
                    column: 1,
                    operator: "greaterThan".into(),
                    value: "1".into(),
                    second_value: String::new(),
                    values: Vec::new(),
                    column_type: ColumnType::Number,
                    case_sensitive: false,
                }],
            },
            ..Default::default()
        };
        session.ensure_row_ids();
        session.rebuild_view();

        session
            .apply_edit(EditCommand::InsertColumns { index: 1, count: 1 }, 0)
            .unwrap();
        assert_eq!(session.document.rows()[0], ["a", ""]);
        assert_eq!(session.document.rows()[1], ["b", "", "2", "2026-01-01"]);
        assert_eq!(session.column_types.get(&2), Some(&ColumnType::Number));
        assert_eq!(session.column_types.get(&3), Some(&ColumnType::Date));
        assert_eq!(session.view.filters[0].column, 2);
        assert_eq!(session.view.sorts[0].column, 3);

        session.undo().unwrap();
        assert_eq!(session.document.rows(), original);
        assert_eq!(session.column_types.get(&1), Some(&ColumnType::Number));
        assert_eq!(session.column_types.get(&2), Some(&ColumnType::Date));
        assert_eq!(session.view.filters[0].column, 1);
        assert_eq!(session.view.sorts[0].column, 2);

        session.redo().unwrap();
        assert_eq!(session.view.filters[0].column, 2);
        assert_eq!(session.view.sorts[0].column, 3);
        session.undo().unwrap();

        session
            .apply_edit(
                EditCommand::DeleteColumns { index: 1, count: 1 },
                session.revision,
            )
            .unwrap();
        assert_eq!(session.document.rows()[0], ["a"]);
        assert_eq!(session.document.rows()[1], ["b", "2026-01-01"]);
        assert_eq!(session.column_types.get(&1), Some(&ColumnType::Date));
        assert!(!session.column_types.contains_key(&2));
        assert!(session.view.filters.is_empty());
        assert_eq!(session.view.sorts[0].column, 1);

        session.undo().unwrap();
        assert_eq!(session.document.rows(), original);
        assert_eq!(session.column_types.get(&1), Some(&ColumnType::Number));
        assert_eq!(session.column_types.get(&2), Some(&ColumnType::Date));
        assert_eq!(session.view.filters[0].column, 1);
        assert_eq!(session.view.sorts[0].column, 2);
        session.redo().unwrap();
        assert_eq!(session.document.rows()[1], ["b", "2026-01-01"]);
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
