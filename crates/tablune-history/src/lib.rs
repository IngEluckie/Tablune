#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change<T> {
    pub before: T,
    pub after: T,
}

#[derive(Debug, Clone, Default)]
pub struct History<T> {
    undo_stack: Vec<Change<T>>,
    redo_stack: Vec<Change<T>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transaction<T> {
    pub before_state: u64,
    pub after_state: u64,
    pub estimated_bytes: usize,
    pub value: T,
}

#[derive(Debug, Clone)]
pub struct TransactionHistory<T> {
    undo_stack: Vec<Transaction<T>>,
    redo_stack: Vec<Transaction<T>>,
    max_entries: usize,
    max_bytes: usize,
    undo_bytes: usize,
}

impl<T> TransactionHistory<T> {
    #[must_use]
    pub fn with_limits(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            max_entries,
            max_bytes,
            undo_bytes: 0,
        }
    }

    pub fn record(&mut self, transaction: Transaction<T>) {
        self.undo_bytes = self.undo_bytes.saturating_add(transaction.estimated_bytes);
        self.undo_stack.push(transaction);
        self.redo_stack.clear();
        while self.undo_stack.len() > self.max_entries || self.undo_bytes > self.max_bytes {
            if self.undo_stack.len() <= 1 {
                break;
            }
            let removed = self.undo_stack.remove(0);
            self.undo_bytes = self.undo_bytes.saturating_sub(removed.estimated_bytes);
        }
    }

    pub fn take_undo(&mut self) -> Option<Transaction<T>> {
        let transaction = self.undo_stack.pop()?;
        self.undo_bytes = self.undo_bytes.saturating_sub(transaction.estimated_bytes);
        Some(transaction)
    }

    pub fn finish_undo(&mut self, transaction: Transaction<T>) {
        self.redo_stack.push(transaction);
    }

    pub fn take_redo(&mut self) -> Option<Transaction<T>> {
        self.redo_stack.pop()
    }

    pub fn finish_redo(&mut self, transaction: Transaction<T>) {
        self.undo_bytes = self.undo_bytes.saturating_add(transaction.estimated_bytes);
        self.undo_stack.push(transaction);
    }

    #[must_use]
    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    #[must_use]
    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    pub fn clear(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.undo_bytes = 0;
    }
}

impl<T: Clone> History<T> {
    #[must_use]
    pub fn new() -> Self {
        Self {
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        }
    }

    pub fn record(&mut self, before: T, after: T) {
        self.undo_stack.push(Change { before, after });
        self.redo_stack.clear();
    }

    pub fn undo(&mut self) -> Option<T> {
        let change = self.undo_stack.pop()?;
        let state = change.before.clone();
        self.redo_stack.push(change);
        Some(state)
    }

    pub fn redo(&mut self) -> Option<T> {
        let change = self.redo_stack.pop()?;
        let state = change.after.clone();
        self.undo_stack.push(change);
        Some(state)
    }

    #[must_use]
    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    #[must_use]
    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::{History, Transaction, TransactionHistory};

    #[test]
    fn recording_after_undo_discards_redo_history() {
        let mut history = History::new();
        history.record(0, 1);
        assert_eq!(history.undo(), Some(0));
        assert!(history.can_redo());

        history.record(0, 2);
        assert!(!history.can_redo());
        assert_eq!(history.undo(), Some(0));
    }

    #[test]
    fn transaction_history_tracks_state_and_enforces_entry_limit() {
        let mut history = TransactionHistory::with_limits(2, 1024);
        for state in 0..3 {
            history.record(Transaction {
                before_state: state,
                after_state: state + 1,
                estimated_bytes: 4,
                value: state,
            });
        }
        assert_eq!(history.take_undo().unwrap().value, 2);
        assert_eq!(history.take_undo().unwrap().value, 1);
        assert!(history.take_undo().is_none());
    }
}
