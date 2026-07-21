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

    pub fn insert_rows(&mut self, index: usize, rows: Vec<Vec<String>>) {
        let index = index.min(self.rows.len());
        self.rows.splice(index..index, rows);
    }

    pub fn delete_row(&mut self, index: usize) -> Option<Vec<String>> {
        (index < self.rows.len()).then(|| self.rows.remove(index))
    }

    pub fn delete_rows(&mut self, index: usize, count: usize) -> Vec<Vec<String>> {
        if index >= self.rows.len() || count == 0 {
            return Vec::new();
        }
        let end = index.saturating_add(count).min(self.rows.len());
        self.rows.drain(index..end).collect()
    }

    pub fn insert_column(&mut self, index: usize) {
        for row in &mut self.rows {
            row.insert(index.min(row.len()), String::new());
        }
    }

    pub fn insert_columns(&mut self, index: usize, count: usize) {
        for _ in 0..count {
            self.insert_column(index);
        }
    }

    pub fn delete_column(&mut self, index: usize) -> Vec<Option<String>> {
        self.rows
            .iter_mut()
            .map(|row| (index < row.len()).then(|| row.remove(index)))
            .collect()
    }

    pub fn delete_columns(&mut self, index: usize, count: usize) -> Vec<Vec<Option<String>>> {
        (0..count).map(|_| self.delete_column(index)).collect()
    }

    pub fn reorder_rows(&mut self, order: &[usize]) -> Result<(), &'static str> {
        if order.len() != self.rows.len() {
            return Err("row order must contain every row");
        }
        let mut seen = vec![false; self.rows.len()];
        let mut reordered = Vec::with_capacity(self.rows.len());
        for &index in order {
            if index >= self.rows.len() || seen[index] {
                return Err("row order must be a permutation");
            }
            seen[index] = true;
            reordered.push(self.rows[index].clone());
        }
        self.rows = reordered;
        Ok(())
    }

    pub fn restore_shape(&mut self, row_lengths: &[usize]) {
        self.rows.truncate(row_lengths.len());
        for (row, length) in self.rows.iter_mut().zip(row_lengths) {
            row.truncate(*length);
        }
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

    #[test]
    fn row_ranges_and_reordering_are_supported() {
        let mut document = TableDocument::from_rows(vec![vec!["a".into()], vec!["b".into()]]);
        document.insert_rows(1, vec![vec!["middle".into()]]);
        assert_eq!(document.delete_rows(0, 1), vec![vec!["a".to_string()]]);
        document.reorder_rows(&[1, 0]).unwrap();
        assert_eq!(document.rows()[0][0], "b");
        assert_eq!(document.rows()[1][0], "middle");
    }
}
