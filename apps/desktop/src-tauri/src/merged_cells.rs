//! Rectangular presentation regions. Only the top-left cell owns content.
use super::*;
impl CellRange {
    pub fn contains(&self, row: usize, col: usize) -> bool {
        row >= self.start_row
            && row <= self.end_row
            && col >= self.start_column
            && col <= self.end_column
    }
    pub fn intersects(&self, other: &Self) -> bool {
        self.start_row <= other.end_row
            && other.start_row <= self.end_row
            && self.start_column <= other.end_column
            && other.start_column <= self.end_column
    }
    pub fn encloses(&self, other: &Self) -> bool {
        self.contains(other.start_row, other.start_column)
            && self.contains(other.end_row, other.end_column)
    }
}
pub fn validate(ranges: &[CellRange]) -> Result<(), String> {
    if ranges.len() > 1000 {
        return Err("La hoja admite hasta 1000 combinaciones".into());
    }
    let mut total = 0usize;
    for (i, r) in ranges.iter().enumerate() {
        if r.start_row > r.end_row
            || r.start_column > r.end_column
            || r.end_row >= 10_000_000
            || r.end_column >= 100_000
            || (r.start_row == r.end_row && r.start_column == r.end_column)
            || (r.end_row - r.start_row + 1).saturating_mul(r.end_column - r.start_column + 1)
                > 100_000
        {
            return Err("Selecciona un rectángulo de 2 a 100 000 celdas".into());
        }
        total = total.saturating_add(
            (r.end_row - r.start_row + 1).saturating_mul(r.end_column - r.start_column + 1),
        );
        if total > 100_000 {
            return Err("La hoja admite hasta 100 000 celdas combinadas".into());
        }
        if ranges[..i].iter().any(|m| m.intersects(r)) {
            return Err("Las combinaciones no pueden superponerse".into());
        }
    }
    Ok(())
}
impl DocumentSession {
    pub(super) fn covered(&self, row: usize, col: usize) -> bool {
        self.sheet
            .merges
            .iter()
            .any(|m| m.contains(row, col) && (row != m.start_row || col != m.start_column))
    }
    pub(super) fn merge_cells(
        &mut self,
        range: CellRange,
        center: bool,
        split: bool,
    ) -> Result<(), String> {
        if self.project_id.is_none() {
            return Err("Crea un proyecto .tablune para combinar celdas".into());
        }
        if !self.view.sorts.is_empty() || !self.view.filters.is_empty() {
            return Err("Quita los filtros y la ordenación antes de combinar celdas".into());
        }
        if range.start_row > range.end_row || range.start_column > range.end_column {
            return Err("Selección inválida".into());
        }
        let mut after = self.sheet.clone();
        if split {
            if after
                .merges
                .iter()
                .any(|m| m.intersects(&range) && !range.encloses(m))
            {
                return Err("Selecciona la combinación completa para separarla".into());
            }
            after.merges.retain(|m| !m.intersects(&range));
        } else {
            validate(&[range])?;
            if after
                .merges
                .iter()
                .any(|m| m.intersects(&range) && !range.encloses(m))
            {
                return Err(
                    "La selección corta una combinación existente; selecciónala completa".into(),
                );
            }
            for row in range.start_row..=range.end_row {
                for col in range.start_column..=range.end_column {
                    if row == range.start_row && col == range.start_column {
                        continue;
                    }
                    let meta = self.sheet.cells.get(&formulas::key((row, col)));
                    if !self.raw_cell(row, col).is_empty()
                        || meta.is_some_and(|m| m.formula || m.image.is_some())
                    {
                        return Err(format!(
                            "{} contiene datos. Muévelos o elimínalos antes de combinar.",
                            formulas::key((row, col))
                        ));
                    }
                }
            }
            if !after.merges.contains(&range) {
                after.merges.retain(|m| !m.intersects(&range));
                after.merges.push(range);
            }
            validate(&after.merges)?;
            if center {
                let key = formulas::key((range.start_row, range.start_column));
                let style = after.styles.entry(key).or_default();
                style.alignment = styles::Alignment::Center;
            }
        }
        self.commit_merge_metadata(after)
    }
    fn commit_merge_metadata(&mut self, after: SheetData) -> Result<(), String> {
        let change = SheetChange::new(&self.sheet, &after);
        if change.merges.is_none() && change.styles.is_empty() {
            return Ok(());
        }
        self.commit(
            EditRecord {
                sheet: Some(change),
                forward: InternalOp::StyleOnly,
                inverse: InternalOp::StyleOnly,
                column_state: None,
            },
            0,
        )
    }
    pub(super) fn check_merge_structure(&self, command: &EditCommand) -> Result<(), String> {
        let op = match command {
            EditCommand::InsertRows { index, count } => Some((*index, *count, true, false)),
            EditCommand::DeleteRows { index, count } => Some((*index, *count, true, true)),
            EditCommand::InsertColumns { index, count } => Some((*index, *count, false, false)),
            EditCommand::DeleteColumns { index, count } => Some((*index, *count, false, true)),
            _ => None,
        };
        if let Some((i, count, rows, delete)) = op {
            if count == 0 {
                return Ok(());
            }
            for m in &self.sheet.merges {
                let (start, end) = if rows {
                    (m.start_row, m.end_row)
                } else {
                    (m.start_column, m.end_column)
                };
                if if delete {
                    i <= end && i.saturating_add(count) > start
                } else {
                    i > start && i <= end
                } {
                    return Err("Separa las celdas combinadas antes de modificar filas o columnas que las atraviesan".into());
                }
            }
        }
        if matches!(command, EditCommand::ApplySort) && !self.sheet.merges.is_empty() {
            return Err("Separa las celdas combinadas antes de ordenar".into());
        }
        Ok(())
    }
    pub(super) fn paste_merged_cells(
        &mut self,
        cells: Vec<sheets::SheetCellInput>,
        range: CellRange,
        merges: Vec<CellRange>,
    ) -> Result<(), String> {
        if !self.view.sorts.is_empty() || !self.view.filters.is_empty() {
            return Err("Quita los filtros y la ordenación antes de pegar combinaciones".into());
        }
        if self
            .sheet
            .merges
            .iter()
            .any(|m| m.intersects(&range) && !range.encloses(m))
        {
            return Err("El pegado corta una combinación existente".into());
        }
        if merges.iter().any(|m| !range.encloses(m))
            || cells.iter().any(|c| !range.contains(c.row, c.column))
        {
            return Err("Pegado fuera del rango".into());
        }
        let mut next = self.sheet.merges.clone();
        next.retain(|m| !m.intersects(&range));
        next.extend(merges);
        validate(&next)?;
        self.edit_sheet_cells_with_merges(cells, Some(next))
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
    fn rect() -> CellRange {
        CellRange {
            start_row: 0,
            end_row: 2,
            start_column: 0,
            end_column: 2,
        }
    }
    fn edit(s: &mut DocumentSession, row: usize, col: usize, value: &str) {
        s.apply_edit(
            EditCommand::SetSheetCells {
                cells: vec![sheets::SheetCellInput {
                    row,
                    column: col,
                    value: value.into(),
                    style: None,
                    image: None,
                    literal: false,
                    cell_type: None,
                }],
            },
            s.revision,
        )
        .unwrap();
    }
    #[test]
    fn merge_center_split_history_keep_formula_sources_and_cached_results() {
        let mut s = sheet();
        edit(&mut s, 0, 0, "=1+2");
        let rev = s.calculation_input_revision;
        s.apply_edit(
            EditCommand::MergeCells {
                range: rect(),
                center: true,
            },
            s.revision,
        )
        .unwrap();
        assert_eq!(s.sheet.merges, vec![rect()]);
        assert_eq!(
            s.sheet.styles[&formulas::key((0, 0))].alignment,
            styles::Alignment::Center
        );
        assert_eq!(s.raw_cell(0, 0), "=1+2");
        assert_eq!(s.calculation_input_revision, rev);
        assert!(s.scalar_at((1, 1)).display.is_empty());
        s.apply_edit(EditCommand::UnmergeCells { range: rect() }, s.revision)
            .unwrap();
        assert!(s.sheet.merges.is_empty());
        s.undo().unwrap();
        assert_eq!(s.sheet.merges, vec![rect()]);
        s.undo().unwrap();
        assert!(s.sheet.merges.is_empty());
        s.redo().unwrap();
        assert_eq!(s.sheet.merges, vec![rect()]);
    }
    #[test]
    fn occupied_cells_and_partial_overlaps_fail_without_changes() {
        let mut s = sheet();
        edit(&mut s, 1, 1, "=None");
        let rev = s.revision;
        assert!(
            s.apply_edit(
                EditCommand::MergeCells {
                    range: rect(),
                    center: false
                },
                rev
            )
            .is_err()
        );
        assert_eq!(s.revision, rev);
        edit(&mut s, 1, 1, "");
        s.apply_edit(
            EditCommand::MergeCells {
                range: rect(),
                center: false,
            },
            s.revision,
        )
        .unwrap();
        let overlapping = CellRange {
            start_row: 1,
            end_row: 4,
            start_column: 1,
            end_column: 4,
        };
        assert!(
            s.apply_edit(
                EditCommand::MergeCells {
                    range: overlapping,
                    center: false
                },
                s.revision
            )
            .is_err()
        );
        assert!(
            s.apply_edit(
                EditCommand::SetCells {
                    cells: vec![CellInput {
                        row: 1,
                        column: 1,
                        value: "hidden".into()
                    }]
                },
                s.revision
            )
            .is_err()
        );
    }
    #[test]
    fn structural_changes_outside_shift_merges_and_crossing_edits_are_atomic() {
        let mut s = sheet();
        let r = CellRange {
            start_row: 10,
            end_row: 12,
            start_column: 3,
            end_column: 4,
        };
        s.apply_edit(
            EditCommand::MergeCells {
                range: r,
                center: false,
            },
            s.revision,
        )
        .unwrap();
        assert!(
            s.apply_edit(
                EditCommand::DeleteRows {
                    index: 11,
                    count: 1
                },
                s.revision
            )
            .is_err()
        );
        assert!(
            s.apply_edit(
                EditCommand::InsertColumns { index: 4, count: 1 },
                s.revision
            )
            .is_err()
        );
        s.apply_edit(EditCommand::InsertRows { index: 0, count: 2 }, s.revision)
            .unwrap();
        assert_eq!(s.sheet.merges[0].start_row, 12);
        s.undo().unwrap();
        assert_eq!(s.sheet.merges[0], r);
        s.apply_edit(EditCommand::DeleteRows { index: 0, count: 2 }, s.revision)
            .unwrap();
        assert_eq!(s.sheet.merges[0].start_row, 8);
        assert!(s.apply_edit(EditCommand::ApplySort, s.revision).is_err());
    }
    #[test]
    fn pasted_merges_are_one_transaction_and_preserve_anchor_only() {
        let mut s = sheet();
        let range = rect();
        let cells = vec![sheets::SheetCellInput {
            row: 0,
            column: 0,
            value: "Title".into(),
            style: None,
            image: None,
            literal: true,
            cell_type: None,
        }];
        s.paste_merged_cells(cells, range, vec![range]).unwrap();
        assert_eq!(s.sheet.merges, vec![range]);
        assert_eq!(s.raw_cell(0, 0), "Title");
        s.undo().unwrap();
        assert!(s.sheet.merges.is_empty());
        assert_eq!(s.raw_cell(0, 0), "");
        s.redo().unwrap();
        assert_eq!(s.raw_cell(0, 0), "Title");
        assert!(
            s.paste_merged_cells(
                vec![],
                CellRange {
                    end_column: 1,
                    ..range
                },
                vec![]
            )
            .is_err()
        );
        let w = s.grid_window(1, 1, 1, 1);
        assert_eq!(w.merged_cells[0].source, "Title");
    }
}
