use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CellPosition {
    pub row: usize,
    pub column: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableDocument {
    rows: Vec<Vec<String>>,
}

impl TableDocument {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn from_rows(rows: Vec<Vec<String>>) -> Self {
        Self { rows }
    }

    #[must_use]
    pub fn rows(&self) -> &[Vec<String>] {
        &self.rows
    }

    pub fn into_rows(self) -> Vec<Vec<String>> {
        self.rows
    }

    #[must_use]
    pub fn row_count(&self) -> usize {
        self.rows.len()
    }

    #[must_use]
    pub fn column_count(&self) -> usize {
        self.rows.iter().map(Vec::len).max().unwrap_or(0)
    }

    #[must_use]
    pub fn cell(&self, position: CellPosition) -> Option<&str> {
        self.rows
            .get(position.row)
            .and_then(|row| row.get(position.column))
            .map(String::as_str)
    }

    pub fn set_cell(&mut self, position: CellPosition, value: String) -> String {
        if self.rows.len() <= position.row {
            self.rows.resize_with(position.row + 1, Vec::new);
        }

        let row = &mut self.rows[position.row];
        if row.len() <= position.column {
            row.resize(position.column + 1, String::new());
        }

        std::mem::replace(&mut row[position.column], value)
    }

    pub fn insert_row(&mut self, index: usize) {
        self.rows.insert(index.min(self.rows.len()), Vec::new());
    }

    pub fn delete_row(&mut self, index: usize) -> Option<Vec<String>> {
        (index < self.rows.len()).then(|| self.rows.remove(index))
    }

    pub fn insert_column(&mut self, index: usize) {
        for row in &mut self.rows {
            row.insert(index.min(row.len()), String::new());
        }
    }

    pub fn delete_column(&mut self, index: usize) -> Vec<Option<String>> {
        self.rows
            .iter_mut()
            .map(|row| (index < row.len()).then(|| row.remove(index)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{CellPosition, TableDocument};

    #[test]
    fn setting_a_distant_cell_expands_the_document() {
        let mut document = TableDocument::new();
        let previous = document.set_cell(CellPosition { row: 2, column: 3 }, "value".into());

        assert!(previous.is_empty());
        assert_eq!(document.row_count(), 3);
        assert_eq!(document.column_count(), 4);
        assert_eq!(
            document.cell(CellPosition { row: 2, column: 3 }),
            Some("value")
        );
    }

    #[test]
    fn ragged_rows_are_supported() {
        let document =
            TableDocument::from_rows(vec![vec!["a".into()], vec!["b".into(), "c".into()]]);
        assert_eq!(document.column_count(), 2);
    }
}
