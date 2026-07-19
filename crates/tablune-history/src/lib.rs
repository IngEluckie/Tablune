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
    use super::History;

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
}
