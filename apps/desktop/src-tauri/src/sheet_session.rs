//! Sheet metadata is owned by the existing table session and participates in its history.
use super::*;
use crate::formulas::{CellMeta, CellResult, CellType, Position, Shift};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetCellInput {
    pub row: usize,
    pub column: usize,
    pub value: String,
    #[serde(default)]
    pub literal: bool,
    #[serde(default)]
    pub cell_type: Option<CellType>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellInfo {
    pub row: usize,
    pub column: usize,
    pub source: String,
    pub display: String,
    pub formula: bool,
    pub escaped: bool,
    pub cell_type: CellType,
    pub pending: bool,
    pub error: Option<formulas::CalcError>,
}
impl DocumentSession {
    pub(super) fn raw_cell(&self, row: usize, column: usize) -> &str {
        self.document
            .cell(CellPosition { row, column })
            .unwrap_or("")
    }
    fn effective_type(&self, p: Position) -> CellType {
        let explicit = self
            .sheet
            .cells
            .get(&formulas::key(p))
            .map(|m| m.cell_type)
            .unwrap_or_default();
        if explicit != CellType::Auto {
            return explicit;
        }
        if p.0 == 0 && self.header_enabled {
            return CellType::Text;
        }
        match self.column_types.get(&p.1) {
            Some(ColumnType::Text | ColumnType::Date) => CellType::Text,
            Some(ColumnType::Number) => CellType::Number,
            Some(ColumnType::Boolean) => CellType::Boolean,
            None => CellType::Auto,
        }
    }
    pub(super) fn scalar_at(&self, p: Position) -> CellResult {
        let meta = self.sheet.cells.get(&formulas::key(p));
        if let Some(m) = meta.filter(|m| m.formula) {
            return m.cached.clone().unwrap_or_else(|| {
                CellResult::error(
                    "#PENDING!",
                    "Enable Python calculation to evaluate this cell",
                )
            });
        }
        formulas::literal(
            self.raw_cell(p.0, p.1),
            self.effective_type(p),
            meta.is_some_and(|m| m.escaped),
        )
    }
    pub(super) fn cell_info(&self, row: usize, column: usize) -> CellInfo {
        let meta = self.sheet.cells.get(&formulas::key((row, column)));
        let result = self.scalar_at((row, column));
        CellInfo {
            row,
            column,
            source: self.raw_cell(row, column).into(),
            display: if meta.is_some_and(|m| m.formula && m.cached.is_none()) {
                "…".into()
            } else {
                result.display.clone()
            },
            formula: meta.is_some_and(|m| m.formula),
            escaped: meta.is_some_and(|m| m.escaped),
            cell_type: meta.map(|m| m.cell_type).unwrap_or_default(),
            pending: meta.is_some_and(|m| m.pending),
            error: if meta.is_some_and(|m| m.formula && m.cached.is_none()) {
                None
            } else {
                result.error
            },
        }
    }
    pub(super) fn materialized_rows(&self) -> Vec<Vec<String>> {
        self.document
            .rows()
            .iter()
            .enumerate()
            .map(|(r, row)| {
                row.iter()
                    .enumerate()
                    .map(|(c, raw)| {
                        if self.project_id.is_some() {
                            self.scalar_at((r, c)).display
                        } else {
                            raw.clone()
                        }
                    })
                    .collect()
            })
            .collect()
    }
    pub(crate) fn ensure_calculated(&self) -> Result<(), String> {
        if self.project_id.is_some() && !self.sheet.is_ready() {
            Err("Calculate the sheet and resolve its formula errors before exporting or running a transformation".into())
        } else {
            Ok(())
        }
    }
    pub(super) fn refresh_literal_caches(&mut self) {
        let updates: Vec<_> = self
            .sheet
            .cells
            .iter()
            .filter(|(_, m)| !m.formula)
            .map(|(k, _)| (k.clone(), self.scalar_at(formulas::position(k).unwrap())))
            .collect();
        for (k, result) in updates {
            self.sheet.cells.get_mut(&k).unwrap().cached = Some(result);
        }
    }
    pub(super) fn sync_sheet(&mut self) {
        for (k, m) in &self.sheet.cells {
            if m.formula {
                let (row, column) = formulas::position(k).unwrap();
                self.document
                    .set_cell(CellPosition { row, column }, m.source.clone());
            }
        }
        self.graph.refresh(&self.sheet);
        self.refresh_literal_caches();
        for (k, parsed) in &self.graph.parsed {
            if let Err(error) = parsed {
                let m = self.sheet.cells.get_mut(k).unwrap();
                m.cached = Some(CellResult::error(
                    if m.source.contains("#REF!") {
                        "#REF!"
                    } else {
                        "#SYNTAX!"
                    },
                    error,
                ));
                m.pending = false;
            }
        }
    }
    pub(super) fn sheet_after(&self, operation: &InternalOp) -> SheetData {
        let mut sheet = self.sheet.clone();
        match operation {
            InternalOp::SetCells { cells, .. } => {
                for c in cells {
                    let k = formulas::key((c.row, c.column));
                    let old = sheet.cells.get(&k).cloned().unwrap_or_default();
                    sheet.cells.insert(
                        k,
                        CellMeta {
                            formula: c.value.starts_with('='),
                            source: c.value.clone(),
                            escaped: c.value.starts_with('\''),
                            pending: c.value.starts_with('='),
                            cell_type: old.cell_type,
                            cached: None,
                        },
                    );
                }
                for k in self
                    .graph
                    .affected(cells.iter().map(|c| formulas::key((c.row, c.column))))
                {
                    if let Some(m) = sheet.cells.get_mut(&k).filter(|m| m.formula) {
                        m.pending = true;
                    }
                }
            }
            InternalOp::InsertRows { index, rows, .. } => self.shift_sheet(
                &mut sheet,
                Shift::Structure {
                    rows: true,
                    index: *index,
                    count: rows.len(),
                    delete: false,
                },
            ),
            InternalOp::RemoveRows { index, count } => self.shift_sheet(
                &mut sheet,
                Shift::Structure {
                    rows: true,
                    index: *index,
                    count: *count,
                    delete: true,
                },
            ),
            InternalOp::InsertColumns { index, count } => self.shift_sheet(
                &mut sheet,
                Shift::Structure {
                    rows: false,
                    index: *index,
                    count: *count,
                    delete: false,
                },
            ),
            InternalOp::RemoveColumns { index, count } => self.shift_sheet(
                &mut sheet,
                Shift::Structure {
                    rows: false,
                    index: *index,
                    count: *count,
                    delete: true,
                },
            ),
            InternalOp::ReorderRows(ids) => {
                let new: HashMap<_, _> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
                sheet.cells = sheet
                    .cells
                    .into_iter()
                    .filter_map(|(k, m)| {
                        let (r, c) = formulas::position(&k)?;
                        Some((formulas::key((*new.get(self.row_ids.get(r)?)?, c)), m))
                    })
                    .collect();
            }
            _ => {}
        }
        sheet
    }
    fn shift_sheet(&self, sheet: &mut SheetData, shift: Shift) {
        let Shift::Structure {
            rows,
            index,
            count,
            delete,
        } = shift
        else {
            return;
        };
        sheet.cells = std::mem::take(&mut sheet.cells)
            .into_iter()
            .filter_map(|(k, mut m)| {
                let (mut r, mut c) = formulas::position(&k)?;
                let coord = if rows { &mut r } else { &mut c };
                if delete {
                    if *coord >= index && *coord < index + count {
                        return None;
                    }
                    if *coord >= index + count {
                        *coord -= count;
                    }
                } else if *coord >= index {
                    *coord += count;
                }
                if m.formula {
                    m.source = formulas::shift_formula(&m.source, shift);
                    m.pending = true;
                }
                Some((formulas::key((r, c)), m))
            })
            .collect();
    }
    pub(super) fn edit_sheet_cells(&mut self, cells: Vec<SheetCellInput>) -> Result<(), String> {
        if self.project_id.is_none() {
            return Err("Formulas belong to project sheets".into());
        }
        if cells
            .iter()
            .any(|c| c.row > 9_999_999 || c.column >= 100_000)
        {
            return Err("Cell address exceeds sheet limits".into());
        }
        let mut after = self.sheet.clone();
        let mut before_values = Vec::new();
        let mut after_values = Vec::new();
        // A paste can target the same cell multiple times; its final value wins.
        let cells: std::collections::BTreeMap<_, _> = cells
            .into_iter()
            .map(|c| (formulas::key((c.row, c.column)), c))
            .collect();
        let mut changed = Vec::new();
        for (k, c) in cells {
            let previous = after.cells.get(&k).cloned().unwrap_or_default();
            let meta = CellMeta {
                formula: !c.literal && c.value.starts_with('='),
                source: c.value.clone(),
                escaped: !c.literal && c.value.starts_with('\''),
                cell_type: c.cell_type.unwrap_or(previous.cell_type),
                cached: None,
                pending: !c.literal && c.value.starts_with('='),
            };
            if self.raw_cell(c.row, c.column) == c.value
                && previous.formula == meta.formula
                && previous.escaped == meta.escaped
                && previous.cell_type == meta.cell_type
            {
                continue;
            }
            before_values.push(CellInput {
                row: c.row,
                column: c.column,
                value: self.raw_cell(c.row, c.column).into(),
            });
            after_values.push(CellInput {
                row: c.row,
                column: c.column,
                value: c.value,
            });
            changed.push(k.clone());
            after.cells.insert(k, meta);
        }
        if changed.is_empty() {
            return Ok(());
        }
        for k in self.graph.affected(changed) {
            if let Some(m) = after.cells.get_mut(&k).filter(|m| m.formula) {
                m.pending = true;
            }
        }
        let shape = self.document.rows().iter().map(Vec::len).collect();
        let bytes = before_values
            .iter()
            .chain(&after_values)
            .map(|c| c.value.len() + 32)
            .sum();
        self.commit(
            EditRecord {
                sheet: Some(SheetChange::new(&self.sheet, &after)),
                forward: InternalOp::SetCells {
                    cells: after_values,
                    restore_shape: None,
                },
                inverse: InternalOp::SetCells {
                    cells: before_values,
                    restore_shape: Some(shape),
                },
                column_state: None,
            },
            bytes,
        )
    }
    pub(super) fn edit_cell_types(
        &mut self,
        cells: Vec<CellPosition>,
        cell_type: CellType,
    ) -> Result<(), String> {
        if self.project_id.is_none() {
            return Err("Cell types belong to project sheets".into());
        }
        let mut after = self.sheet.clone();
        let mut changed = Vec::new();
        for c in cells {
            let k = formulas::key((c.row, c.column));
            let m = after.cells.entry(k.clone()).or_default();
            if m.cell_type != cell_type {
                m.cell_type = cell_type;
                changed.push(k);
            }
        }
        if changed.is_empty() {
            return Ok(());
        }
        for k in self.graph.affected(changed) {
            if let Some(m) = after.cells.get_mut(&k).filter(|m| m.formula) {
                m.pending = true;
            }
        }
        self.commit(
            EditRecord {
                sheet: Some(SheetChange::new(&self.sheet, &after)),
                forward: InternalOp::SetCells {
                    cells: vec![],
                    restore_shape: None,
                },
                inverse: InternalOp::SetCells {
                    cells: vec![],
                    restore_shape: None,
                },
                column_state: None,
            },
            0,
        )
    }
}
#[tauri::command]
pub fn sheet_cell(
    state: State<'_, WorkspaceState>,
    document_id: u64,
    row: usize,
    column: usize,
) -> Result<CellInfo, String> {
    Ok(lock_document(&document_handle(&state, document_id)?)?.cell_info(row, column))
}
#[tauri::command]
pub fn sheet_shift_formula(source: String, row_delta: isize, column_delta: isize) -> String {
    formulas::shift_formula(
        &source,
        Shift::Copy {
            rows: row_delta,
            columns: column_delta,
        },
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaCopy {
    source: String,
    row_delta: isize,
    column_delta: isize,
}
#[tauri::command]
pub fn sheet_shift_formulas(cells: Vec<FormulaCopy>) -> Vec<String> {
    cells
        .into_iter()
        .map(|c| {
            formulas::shift_formula(
                &c.source,
                Shift::Copy {
                    rows: c.row_delta,
                    columns: c.column_delta,
                },
            )
        })
        .collect()
}

#[tauri::command]
pub fn clipboard_read_text() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let text_type = unsafe { objc2_app_kit::NSPasteboardTypeString };
        Some(
            objc2_app_kit::NSPasteboard::generalPasteboard()
                .stringForType(text_type)
                .map(|value| value.to_string())
                .unwrap_or_default(),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}
#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let clipboard = objc2_app_kit::NSPasteboard::generalPasteboard();
        let text_type = unsafe { objc2_app_kit::NSPasteboardTypeString };
        clipboard.clearContents();
        if !clipboard.setString_forType(&objc2_foundation::NSString::from_str(&text), text_type) {
            return Err("Unable to write to the clipboard".into());
        }
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
        Ok(false)
    }
}
#[tauri::command]
pub fn clipboard_generation() -> Option<i64> {
    #[cfg(target_os = "macos")]
    {
        Some(objc2_app_kit::NSPasteboard::generalPasteboard().changeCount() as i64)
    }
    #[cfg(target_os = "windows")]
    {
        #[link(name = "user32")]
        unsafe extern "system" {
            fn GetClipboardSequenceNumber() -> u32;
        }
        Some(unsafe { GetClipboardSequenceNumber() } as i64)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sheet() -> DocumentSession {
        DocumentSession {
            project_id: Some(1),
            ..DocumentSession::default()
        }
    }
    fn edit(s: &mut DocumentSession, cells: &[(usize, usize, &str)]) {
        s.apply_edit(
            EditCommand::SetSheetCells {
                cells: cells
                    .iter()
                    .map(|(r, c, v)| SheetCellInput {
                        row: *r,
                        column: *c,
                        value: (*v).into(),
                        literal: false,
                        cell_type: None,
                    })
                    .collect(),
            },
            s.revision,
        )
        .unwrap();
    }
    #[test]
    fn cell_formulas_recalculate_incrementally_without_replacing_source() {
        let mut s = sheet();
        edit(
            &mut s,
            &[
                (0, 1, "10"),
                (0, 2, "25"),
                (0, 0, "=B1+C1"),
                (1, 0, "=A1*2"),
                (2, 0, "=1+2"),
            ],
        );
        super::super::calculation::calculate_for_test(&mut s, "");
        assert_eq!(s.cell_value(0, 0), "35");
        assert_eq!(s.cell_value(1, 0), "70");
        assert_eq!(s.raw_cell(0, 0), "=B1+C1");
        edit(&mut s, &[(0, 1, "20")]);
        assert!(s.sheet.cells["0,0"].pending);
        assert!(s.sheet.cells["1,0"].pending);
        assert!(!s.sheet.cells["2,0"].pending);
        super::super::calculation::calculate_for_test(&mut s, "");
        assert_eq!(s.cell_value(0, 0), "45");
        assert_eq!(s.cell_value(1, 0), "90");
        edit(&mut s, &[(8, 8, "unrelated")]);
        assert!(s.sheet.is_ready());
    }
    #[test]
    fn ranges_user_functions_cycles_and_errors_are_cell_results() {
        let mut s = sheet();
        edit(
            &mut s,
            &[
                (0, 1, "10"),
                (1, 1, "20"),
                (0, 0, "=sum(cells(\"B1:B2\"))"),
                (1, 0, "=precio_final(A1, 0.16)"),
                (2, 0, "=1/0"),
                (3, 0, "=A5"),
                (4, 0, "=A4"),
                (5, 0, "=A4+1"),
                (6, 0, "=missing(A1)"),
                (7, 0, "=A9+1"),
            ],
        );
        super::super::calculation::calculate_for_test(
            &mut s,
            "def precio_final(base, tax):\n    return round(base * (1 + tax), 2)\n",
        );
        assert_eq!(s.cell_value(0, 0), "30");
        assert_eq!(s.cell_value(1, 0), "34.8");
        assert_eq!(s.cell_value(2, 0), "#DIV/0!");
        assert_eq!(s.cell_value(3, 0), "#CYCLE!");
        assert_eq!(s.cell_value(5, 0), "#CYCLE!");
        assert_eq!(s.cell_value(6, 0), "#NAME?");
        assert_eq!(s.cell_value(7, 0), "#VALUE!");
        assert!(s.ensure_calculated().is_err());
    }
    #[test]
    fn structural_edit_and_undo_restore_source_metadata_and_shape() {
        let mut s = sheet();
        edit(&mut s, &[(0, 0, "=B2+$B$3"), (1, 1, "10"), (2, 1, "20")]);
        let rows = s.document.rows().to_vec();
        s.apply_edit(EditCommand::InsertRows { index: 1, count: 1 }, s.revision)
            .unwrap();
        assert_eq!(s.raw_cell(0, 0), "=B3+$B$4");
        s.undo().unwrap();
        assert_eq!(s.document.rows(), rows);
        s.redo().unwrap();
        assert_eq!(s.raw_cell(0, 0), "=B3+$B$4");
        s.apply_edit(
            EditCommand::DeleteColumns { index: 1, count: 1 },
            s.revision,
        )
        .unwrap();
        super::super::calculation::calculate_for_test(&mut s, "");
        assert_eq!(s.cell_value(0, 0), "#REF!");
        s.undo().unwrap();
        assert_eq!(s.raw_cell(0, 0), "=B3+$B$4");
    }
    #[test]
    fn imported_equals_stays_literal_and_typed_edits_are_undoable() {
        let mut s = sheet();
        s.document =
            TableDocument::from_rows(vec![vec!["=1+2".into(), "00123".into(), "12.5".into()]]);
        s.ensure_row_ids();
        s.rebuild_view();
        assert!(!s.cell_info(0, 0).formula);
        assert_eq!(s.scalar_at((0, 1)).value.unwrap().kind, "text");
        assert_eq!(s.scalar_at((0, 2)).value.unwrap().kind, "decimal");
        edit(&mut s, &[(0, 0, "=1+2")]);
        assert!(s.cell_info(0, 0).formula);
        s.undo().unwrap();
        assert!(!s.cell_info(0, 0).formula);
        s.edit_cell_types(vec![CellPosition { row: 0, column: 1 }], CellType::Number)
            .unwrap();
        assert_eq!(s.scalar_at((0, 1)).value.unwrap().kind, "integer");
        s.undo().unwrap();
        assert_eq!(s.scalar_at((0, 1)).value.unwrap().kind, "text");
    }
    #[test]
    fn views_show_original_coordinates_and_replace_skips_formulas() {
        let mut s = sheet();
        s.header_enabled = true;
        edit(&mut s, &[(0, 0, "Title"), (1, 0, "=1+2"), (2, 0, "3")]);
        super::super::calculation::calculate_for_test(&mut s, "");
        assert_eq!(s.visible_rows, vec![0, 1, 2]);
        assert_eq!(s.summary().header_names[0], "A");
        let request = ReplaceRequest {
            search: SearchRequest {
                query: "3".into(),
                case_sensitive: true,
                whole_cell: true,
                range: None,
                view_range: None,
                limit: 100,
            },
            replacement: "4".into(),
            replace_all: true,
            expected_revision: s.revision,
            target: None,
        };
        s.replace(request).unwrap();
        assert_eq!(s.raw_cell(1, 0), "=1+2");
        assert_eq!(s.raw_cell(2, 0), "4");
        assert!(s.apply_edit(EditCommand::ApplySort, s.revision).is_err());
    }
    #[test]
    #[ignore = "10,000-formula calculation benchmark"]
    fn ten_thousand_formulas_benchmark() {
        use std::time::Instant;
        let mut s = sheet();
        s.document = TableDocument::from_rows(
            (0..10_000)
                .map(|_| vec!["10".into(), "20".into(), String::new()])
                .collect(),
        );
        s.ensure_row_ids();
        let begin = Instant::now();
        s.edit_sheet_cells(
            (0..10_000)
                .map(|row| SheetCellInput {
                    row,
                    column: 2,
                    value: format!("=A{}+B{}", row + 1, row + 1),
                    literal: false,
                    cell_type: None,
                })
                .collect(),
        )
        .unwrap();
        let setup = begin.elapsed();
        let mut worker = crate::python_macros::calculation_worker::test_worker();
        let begin = Instant::now();
        super::super::calculation::calculate_with_test_worker(&mut s, "", &mut worker);
        let initial = begin.elapsed();
        assert_eq!(s.cell_value(9999, 2), "30");
        let begin = Instant::now();
        edit(&mut s, &[(4999, 0, "40")]);
        let edit_time = begin.elapsed();
        assert_eq!(s.sheet.formulas().filter(|(_, m)| m.pending).count(), 1);
        let begin = Instant::now();
        super::super::calculation::calculate_with_test_worker(&mut s, "", &mut worker);
        let incremental = begin.elapsed();
        assert_eq!(s.cell_value(4999, 2), "60");
        assert_eq!(s.cell_value(4998, 2), "30");
        drop(worker);
        #[cfg(target_os = "macos")]
        {
            let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
            unsafe {
                libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr());
                let usage = usage.assume_init();
                eprintln!(
                    "10k formulas: prepare={setup:?} initial={initial:?} edit={edit_time:?} incremental={incremental:?} peak_rss_bytes={}",
                    usage.ru_maxrss
                );
                let mut child_usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
                if libc::getrusage(libc::RUSAGE_CHILDREN, child_usage.as_mut_ptr()) == 0 {
                    eprintln!(
                        "10k formulas: python_peak_rss_bytes={}",
                        child_usage.assume_init().ru_maxrss
                    );
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        eprintln!(
            "10k formulas: prepare={setup:?} initial={initial:?} edit={edit_time:?} incremental={incremental:?}"
        );
    }
}
