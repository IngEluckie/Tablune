//! Persistent presentation metadata, independent of formula inputs and caches.
use super::*;
use std::collections::BTreeMap;

const MAX_FORMAT_CELLS: usize = 100_000;
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Alignment {
    #[default]
    Left,
    Center,
    Right,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineStyle {
    #[default]
    Solid,
    Dashed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Border {
    pub color: String,
    pub width: u8,
    pub line: LineStyle,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CellStyle {
    pub wrap_text: bool,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub text_color: String,
    pub background: String,
    pub alignment: Alignment,
    pub top: Option<Border>,
    pub right: Option<Border>,
    pub bottom: Option<Border>,
    pub left: Option<Border>,
}
fn valid_color(value: &str) -> bool {
    value.is_empty()
        || (value.len() == 7
            && value.starts_with('#')
            && value[1..].bytes().all(|b| b.is_ascii_hexdigit()))
}
impl CellStyle {
    pub fn validate(&self) -> Result<(), String> {
        if !valid_color(&self.text_color) || !valid_color(&self.background) {
            return Err("Invalid cell color".into());
        }
        for border in [&self.top, &self.right, &self.bottom, &self.left]
            .into_iter()
            .flatten()
        {
            if border.color.is_empty()
                || !valid_color(&border.color)
                || !(1..=3).contains(&border.width)
            {
                return Err("Invalid cell border".into());
            }
        }
        Ok(())
    }
    fn edge(&mut self, side: usize) -> &mut Option<Border> {
        match side {
            0 => &mut self.top,
            1 => &mut self.right,
            2 => &mut self.bottom,
            _ => &mut self.left,
        }
    }
}
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BorderPreset {
    All,
    Outer,
    Inner,
    Top,
    Right,
    Bottom,
    Left,
    None,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BorderPatch {
    pub preset: BorderPreset,
    pub border: Option<Border>,
}
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct StylePatch {
    pub wrap_text: Option<bool>,
    pub reset: bool,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub text_color: Option<String>,
    pub background: Option<String>,
    pub alignment: Option<Alignment>,
    pub borders: Option<BorderPatch>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleSummary {
    pub wrap_text: Option<bool>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub text_color: Option<String>,
    pub background: Option<String>,
    pub alignment: Option<Alignment>,
}
pub(super) fn put_style(styles: &mut BTreeMap<String, CellStyle>, key: String, style: CellStyle) {
    if style == CellStyle::default() {
        styles.remove(&key);
    } else {
        styles.insert(key, style);
    }
}
impl DocumentSession {
    pub(super) fn style_source_row(&self, view_row: usize) -> Option<usize> {
        self.visible_rows.get(view_row).copied().or_else(|| {
            (self.project_id.is_some()
                && self.view.sorts.is_empty()
                && self.view.filters.is_empty())
            .then_some(view_row)
        })
    }
    fn validate_style_range(&self, range: &CellRange) -> Result<(), String> {
        if self.project_id.is_none() {
            return Err("Guarda el CSV como proyecto .tablune para conservar formatos".into());
        }
        if range.end_row < range.start_row
            || range.end_column < range.start_column
            || range.end_row > 9_999_999
            || range.end_column >= 100_000
        {
            return Err("Invalid format range".into());
        }
        if (range.end_row - range.start_row + 1)
            .saturating_mul(range.end_column - range.start_column + 1)
            > MAX_FORMAT_CELLS
        {
            return Err("Selecciona como máximo 100 000 celdas para dar formato".into());
        }
        Ok(())
    }
    pub(super) fn style_summary(&self, range: CellRange) -> Result<StyleSummary, String> {
        self.validate_style_range(&range)?;
        let mut result: Option<StyleSummary> = None;
        for row in range.start_row..=range.end_row {
            let Some(source) = self.style_source_row(row) else {
                continue;
            };
            for column in range.start_column..=range.end_column {
                if self.covered(source, column) {
                    continue;
                }
                let style = self
                    .sheet
                    .styles
                    .get(&formulas::key((source, column)))
                    .cloned()
                    .unwrap_or_default();
                if let Some(r) = &mut result {
                    if r.wrap_text != Some(style.wrap_text) {
                        r.wrap_text = None;
                    }
                    if r.bold != Some(style.bold) {
                        r.bold = None;
                    }
                    if r.italic != Some(style.italic) {
                        r.italic = None;
                    }
                    if r.underline != Some(style.underline) {
                        r.underline = None;
                    }
                    if r.text_color.as_ref() != Some(&style.text_color) {
                        r.text_color = None;
                    }
                    if r.background.as_ref() != Some(&style.background) {
                        r.background = None;
                    }
                    if r.alignment != Some(style.alignment) {
                        r.alignment = None;
                    }
                } else {
                    result = Some(StyleSummary {
                        wrap_text: Some(style.wrap_text),
                        bold: Some(style.bold),
                        italic: Some(style.italic),
                        underline: Some(style.underline),
                        text_color: Some(style.text_color),
                        background: Some(style.background),
                        alignment: Some(style.alignment),
                    });
                }
            }
        }
        Ok(result.unwrap_or(StyleSummary {
            wrap_text: Some(false),
            bold: Some(false),
            italic: Some(false),
            underline: Some(false),
            text_color: Some(String::new()),
            background: Some(String::new()),
            alignment: Some(Alignment::Left),
        }))
    }
    pub(super) fn format_cells(
        &mut self,
        range: CellRange,
        patch: StylePatch,
    ) -> Result<(), String> {
        self.validate_style_range(&range)?;
        let mut after = self.sheet.styles.clone();
        for view_row in range.start_row..=range.end_row {
            let Some(row) = self.style_source_row(view_row) else {
                continue;
            };
            for col in range.start_column..=range.end_column {
                let key = formulas::key((row, col));
                let mut style = if patch.reset {
                    CellStyle::default()
                } else {
                    after.get(&key).cloned().unwrap_or_default()
                };
                if let Some(v) = patch.wrap_text {
                    style.wrap_text = v;
                }
                if let Some(v) = patch.bold {
                    style.bold = v;
                }
                if let Some(v) = patch.italic {
                    style.italic = v;
                }
                if let Some(v) = patch.underline {
                    style.underline = v;
                }
                if let Some(v) = &patch.text_color {
                    style.text_color = v.clone();
                }
                if let Some(v) = &patch.background {
                    style.background = v.clone();
                }
                if let Some(v) = patch.alignment {
                    style.alignment = v;
                }
                for side in 0..4 {
                    let outer = match side {
                        0 => view_row == range.start_row,
                        1 => col == range.end_column,
                        2 => view_row == range.end_row,
                        _ => col == range.start_column,
                    };
                    let selected = patch.reset
                        || patch.borders.as_ref().is_some_and(|b| match b.preset {
                            BorderPreset::All | BorderPreset::None => true,
                            BorderPreset::Outer => outer,
                            BorderPreset::Inner => !outer,
                            BorderPreset::Top => side == 0 && outer,
                            BorderPreset::Right => side == 1 && outer,
                            BorderPreset::Bottom => side == 2 && outer,
                            BorderPreset::Left => side == 3 && outer,
                        });
                    if !selected {
                        continue;
                    }
                    let border = patch.borders.as_ref().and_then(|b| {
                        if matches!(b.preset, BorderPreset::None) {
                            None
                        } else {
                            b.border.clone()
                        }
                    });
                    if patch.borders.as_ref().is_some_and(|b| {
                        !matches!(b.preset, BorderPreset::None) && b.border.is_none()
                    }) {
                        return Err("Choose a border style".into());
                    }
                    *style.edge(side) = border;
                    // Clear the opposing edge, so changing or removing a shared border is unambiguous.
                    let neighbor = match side {
                        0 => view_row
                            .checked_sub(1)
                            .and_then(|r| self.style_source_row(r))
                            .map(|r| (r, col)),
                        1 => (col < 99_999).then_some((row, col + 1)),
                        2 => self.style_source_row(view_row + 1).map(|r| (r, col)),
                        _ => col.checked_sub(1).map(|c| (row, c)),
                    };
                    if let Some(pos) = neighbor {
                        let nk = formulas::key(pos);
                        if let Some(mut other) = after.get(&nk).cloned() {
                            *other.edge((side + 2) % 4) = None;
                            put_style(&mut after, nk, other);
                        }
                    }
                }
                style.validate()?;
                put_style(&mut after, key, style);
            }
        }
        let change = SheetChange {
            merges: None,
            cells: vec![],
            styles: style_changes(&self.sheet.styles, &after),
        };
        if change.styles.is_empty() {
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
}
pub(super) type StyleChanges = Vec<(String, Option<CellStyle>, Option<CellStyle>)>;
pub(super) fn style_changes(
    before: &BTreeMap<String, CellStyle>,
    after: &BTreeMap<String, CellStyle>,
) -> StyleChanges {
    before
        .keys()
        .chain(after.keys())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|key| before.get(*key) != after.get(*key))
        .map(|key| {
            (
                key.clone(),
                before.get(key).cloned(),
                after.get(key).cloned(),
            )
        })
        .collect()
}
#[tauri::command]
pub fn sheet_style_summary(
    state: State<'_, WorkspaceState>,
    document_id: u64,
    range: CellRange,
    expected_revision: u64,
) -> Result<StyleSummary, String> {
    let handle = document_handle(&state, document_id)?;
    let session = lock_document(&handle)?;
    if session.revision != expected_revision {
        return Err("Selection changed; retry formatting".into());
    }
    session.style_summary(range)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sheet() -> DocumentSession {
        DocumentSession {
            project_id: Some(1),
            ..Default::default()
        }
    }
    fn range(r: usize, c: usize, er: usize, ec: usize) -> CellRange {
        CellRange {
            start_row: r,
            start_column: c,
            end_row: er,
            end_column: ec,
        }
    }
    fn patch(value: serde_json::Value) -> StylePatch {
        serde_json::from_value(value).unwrap()
    }
    fn text(s: &mut DocumentSession, row: usize, col: usize, value: &str) {
        s.edit_sheet_cells(vec![sheets::SheetCellInput {
            style: None,
            image: None,
            row,
            column: col,
            value: value.into(),
            literal: false,
            cell_type: None,
        }])
        .unwrap();
    }
    #[test]
    fn wrapping_is_undoable_without_recalculating_and_summaries_ignore_covered_cells() {
        let mut s = sheet();
        text(&mut s, 0, 0, "=21*2");
        calculation::calculate_for_test(&mut s, "");
        let input = s.calculation_input_revision;
        s.format_cells(
            range(0, 0, 0, 0),
            patch(serde_json::json!({"wrapText":true})),
        )
        .unwrap();
        assert_eq!(s.style_summary(range(0, 0, 0, 1)).unwrap().wrap_text, None);
        s.merge_cells(range(0, 0, 0, 1), false, false).unwrap();
        assert_eq!(
            s.style_summary(range(0, 0, 0, 1)).unwrap().wrap_text,
            Some(true)
        );
        assert_eq!(s.calculation_input_revision, input);
        assert_eq!(s.cell_info(0, 0).display, "42");
        s.undo().unwrap();
        s.undo().unwrap();
        assert!(!s.cell_info(0, 0).style.wrap_text);
        s.redo().unwrap();
        assert!(s.cell_info(0, 0).style.wrap_text);
        s.format_cells(range(0, 0, 0, 0), patch(serde_json::json!({"reset":true})))
            .unwrap();
        assert!(!s.cell_info(0, 0).style.wrap_text);
    }

    #[test]
    fn formatting_and_its_history_preserve_formula_results_and_input_revision() {
        let mut s = sheet();
        text(&mut s, 0, 0, "=21*2");
        calculation::calculate_for_test(&mut s, "");
        let input = s.calculation_input_revision;
        let source = s.document.clone();
        let cache = s.sheet.cells["0,0"].clone();
        s.format_cells(
            range(0, 0, 8, 3),
            patch(serde_json::json!({"bold":true,"background":"#fff0b3"})),
        )
        .unwrap();
        assert_eq!(s.document, source);
        assert_eq!(s.calculation_input_revision, input);
        assert_eq!(s.sheet.cells["0,0"], cache);
        assert!(s.sheet.styles["8,3"].bold);
        assert_eq!(
            s.grid_window(8, 1, 3, 1).rows[0].inputs.as_ref().unwrap()[0]
                .style
                .background,
            "#fff0b3"
        );
        // Results published after formatting must survive undoing only the style.
        s.sheet
            .cells
            .get_mut("0,0")
            .unwrap()
            .cached
            .as_mut()
            .unwrap()
            .display = "84".into();
        s.undo().unwrap();
        assert!(s.sheet.styles.is_empty());
        assert_eq!(s.cell_value(0, 0), "84");
        s.redo().unwrap();
        assert!(s.sheet.styles["0,0"].bold);
        assert_eq!(s.cell_value(0, 0), "84");
        assert_eq!(s.calculation_input_revision, input);
        assert!(!s.sheet.cells["0,0"].pending);
    }
    #[test]
    fn mixed_selection_and_filtered_ranges_use_visible_source_rows() {
        let mut s = sheet();
        for (r, v) in ["b", "hidden", "a"].iter().enumerate() {
            text(&mut s, r, 0, v);
        }
        s.view.filters = vec![
            serde_json::from_value(
                serde_json::json!({"column":0,"operator":"values","values":["a","b"]}),
            )
            .unwrap(),
        ];
        s.view.sorts = vec![SortSpec {
            column: 0,
            direction: SortDirection::Ascending,
            column_type: ColumnType::Text,
        }];
        s.rebuild_view();
        s.format_cells(range(0, 0, 0, 0), patch(serde_json::json!({"italic":true})))
            .unwrap();
        assert!(s.sheet.styles["2,0"].italic);
        assert!(!s.sheet.styles.contains_key("1,0"));
        assert_eq!(s.style_summary(range(0, 0, 1, 0)).unwrap().italic, None);
        s.format_cells(range(0, 0, 1, 0), patch(serde_json::json!({"bold":true})))
            .unwrap();
        assert!(s.sheet.styles["0,0"].bold);
        assert!(s.sheet.styles["2,0"].bold);
        assert!(!s.sheet.styles.contains_key("1,0"));
        assert_eq!(s.style_summary(range(0, 0, 1, 0)).unwrap().bold, Some(true));
    }
    #[test]
    fn clearing_shared_borders_and_format_is_atomic_and_undoable() {
        let mut s = sheet();
        s.format_cells(range(0,0,1,1),patch(serde_json::json!({"borders":{"preset":"all","border":{"color":"#112233","width":2,"line":"dashed"}}}))).unwrap();
        assert!(s.sheet.styles["0,1"].left.is_some());
        let before = s.sheet.styles.clone();
        s.format_cells(
            range(0, 0, 0, 0),
            patch(serde_json::json!({"borders":{"preset":"none"}})),
        )
        .unwrap();
        assert!(!s.sheet.styles.contains_key("0,0"));
        assert!(s.sheet.styles["0,1"].left.is_none());
        assert!(s.sheet.styles["1,0"].top.is_none());
        s.undo().unwrap();
        assert_eq!(s.sheet.styles, before);
        let rev = s.revision;
        assert!(
            s.format_cells(
                range(0, 0, 1, 1),
                patch(serde_json::json!({"background":"url(bad)"}))
            )
            .is_err()
        );
        assert_eq!(s.sheet.styles, before);
        assert_eq!(s.revision, rev);
        assert!(
            s.format_cells(range(0, 0, 100_000, 1), StylePatch::default())
                .is_err()
        );
        assert!(
            DocumentSession::default()
                .format_cells(range(0, 0, 0, 0), StylePatch::default())
                .is_err()
        );
    }
    #[test]
    fn styles_follow_structure_and_blank_cells_without_creating_data() {
        let mut s = sheet();
        text(&mut s, 0, 0, "a");
        text(&mut s, 1, 0, "b");
        s.format_cells(
            range(1, 0, 1, 0),
            patch(serde_json::json!({"underline":true})),
        )
        .unwrap();
        s.apply_edit(EditCommand::InsertRows { index: 0, count: 1 }, s.revision)
            .unwrap();
        assert!(s.sheet.styles["2,0"].underline);
        s.undo().unwrap();
        assert!(s.sheet.styles["1,0"].underline);
        s.apply_edit(EditCommand::DeleteRows { index: 1, count: 1 }, s.revision)
            .unwrap();
        assert!(s.sheet.styles.is_empty());
        s.undo().unwrap();
        assert!(s.sheet.styles["1,0"].underline);
        s.format_cells(range(10, 4, 10, 4), patch(serde_json::json!({"bold":true})))
            .unwrap();
        let rows = s.document.clone();
        s.apply_edit(EditCommand::InsertRows { index: 8, count: 2 }, s.revision)
            .unwrap();
        assert!(s.sheet.styles["12,4"].bold);
        assert_eq!(s.document, rows);
        s.apply_edit(
            EditCommand::DeleteColumns { index: 4, count: 1 },
            s.revision,
        )
        .unwrap();
        assert!(!s.sheet.styles.contains_key("12,4"));
        assert_eq!(s.document, rows);
        s.undo().unwrap();
        assert!(s.sheet.styles["12,4"].bold);
    }
    #[test]
    fn deleting_across_data_and_blank_styled_cells_preserves_history() {
        let mut s = sheet();
        text(&mut s, 0, 0, "a");
        text(&mut s, 1, 1, "b");
        s.format_cells(range(8, 8, 8, 8), patch(serde_json::json!({"bold":true})))
            .unwrap();
        let original = s.sheet.clone();
        let data = s.document.clone();
        s.apply_edit(EditCommand::DeleteRows { index: 1, count: 5 }, s.revision)
            .unwrap();
        assert!(s.sheet.styles["3,8"].bold);
        s.undo().unwrap();
        assert_eq!(s.sheet.styles, original.styles);
        assert_eq!(s.document, data);
        s.redo().unwrap();
        assert!(s.sheet.styles["3,8"].bold);
        s.undo().unwrap();
        s.apply_edit(
            EditCommand::DeleteColumns { index: 1, count: 8 },
            s.revision,
        )
        .unwrap();
        assert!(s.sheet.styles.is_empty());
        s.undo().unwrap();
        assert_eq!(s.sheet.styles, original.styles);
        assert_eq!(s.document, data);
    }
    #[test]
    fn paste_styles_are_independent_and_value_paste_or_clear_preserves_destination() {
        let mut s = sheet();
        text(&mut s, 0, 0, "abc");
        let style = CellStyle {
            bold: true,
            background: "#abcdef".into(),
            ..Default::default()
        };
        let input = s.calculation_input_revision;
        s.edit_sheet_cells(vec![sheets::SheetCellInput {
            style: Some(style.clone()),
            image: None,
            row: 0,
            column: 0,
            value: "abc".into(),
            literal: true,
            cell_type: None,
        }])
        .unwrap();
        assert_eq!(s.calculation_input_revision, input);
        assert_eq!(s.sheet.styles["0,0"], style);
        s.apply_edit(
            EditCommand::SetCells {
                cells: vec![CellInput {
                    row: 0,
                    column: 0,
                    value: String::new(),
                }],
            },
            s.revision,
        )
        .unwrap();
        assert_eq!(s.sheet.styles["0,0"], style);
        s.undo().unwrap();
        assert_eq!(s.cell_value(0, 0), "abc");
        s.format_cells(range(0, 0, 0, 0), patch(serde_json::json!({"reset":true})))
            .unwrap();
        assert_eq!(s.cell_value(0, 0), "abc");
        assert!(s.sheet.styles.is_empty());
        s.undo().unwrap();
        assert_eq!(s.sheet.styles["0,0"], style);
    }
}
