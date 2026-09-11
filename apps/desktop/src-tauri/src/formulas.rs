//! Spreadsheet expression parsing and reference transformations. Never executes Python.
use rustpython_parser::{
    Parse,
    ast::{self, Ranged},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

pub const FORMULA_LIMIT: usize = 16 * 1024;
pub type Position = (usize, usize);
pub fn key(p: Position) -> String {
    format!("{},{}", p.0, p.1)
}
pub fn position(k: &str) -> Option<Position> {
    let (r, c) = k.split_once(',')?;
    Some((r.parse().ok()?, c.parse().ok()?))
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CellType {
    #[default]
    Auto,
    Text,
    Number,
    Boolean,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Scalar {
    pub kind: String,
    pub text: String,
}
impl Scalar {
    pub fn blank() -> Self {
        Self {
            kind: "blank".into(),
            text: String::new(),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CalcError {
    pub code: String,
    pub message: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CellResult {
    pub value: Option<Scalar>,
    pub error: Option<CalcError>,
    pub display: String,
}
impl CellResult {
    pub fn error(code: &str, message: impl Into<String>) -> Self {
        Self {
            value: None,
            error: Some(CalcError {
                code: code.into(),
                message: message.into(),
            }),
            display: code.into(),
        }
    }
    pub fn scalar(value: Scalar) -> Self {
        Self {
            display: value.text.clone(),
            value: Some(value),
            error: None,
        }
    }
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CellMeta {
    pub formula: bool,
    pub source: String,
    pub escaped: bool,
    pub cell_type: CellType,
    pub cached: Option<CellResult>,
    pub pending: bool,
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SheetData {
    pub cells: BTreeMap<String, CellMeta>,
    pub functions_revision: u64,
}
impl SheetData {
    pub fn formulas(&self) -> impl Iterator<Item = (&String, &CellMeta)> {
        self.cells.iter().filter(|(_, m)| m.formula)
    }
    pub fn invalidate_all(&mut self) {
        for m in self.cells.values_mut().filter(|m| m.formula) {
            m.pending = true;
        }
    }
    pub fn is_ready(&self) -> bool {
        self.formulas()
            .all(|(_, m)| !m.pending && m.cached.as_ref().is_some_and(|r| r.error.is_none()))
    }
}

pub fn literal(raw: &str, cell_type: CellType, escaped: bool) -> CellResult {
    let text = if escaped {
        raw.strip_prefix('\'').unwrap_or(raw)
    } else {
        raw
    };
    let scalar = |kind: &str, text: String| {
        CellResult::scalar(Scalar {
            kind: kind.into(),
            text,
        })
    };
    if text.is_empty() {
        return CellResult::scalar(Scalar::blank());
    }
    if escaped || cell_type == CellType::Text {
        return scalar("text", text.into());
    }
    if matches!(text, "True" | "False") && matches!(cell_type, CellType::Auto | CellType::Boolean) {
        return scalar("boolean", text.into());
    }
    if cell_type == CellType::Boolean {
        return CellResult::error("#VALUE!", "Expected True or False");
    }
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    let integer_part = unsigned.split(['.', 'e', 'E']).next().unwrap_or("");
    let leading_zero = integer_part.len() > 1 && integer_part.starts_with('0');
    let lexical = text
        .bytes()
        .all(|b| b.is_ascii_digit() || b"+-.eE".contains(&b))
        && text.bytes().any(|b| b.is_ascii_digit());
    if lexical && (!leading_zero || cell_type == CellType::Number) {
        if !text.contains(['.', 'e', 'E']) {
            // Transport integers as decimal strings to avoid JavaScript precision loss.
            if unsigned.bytes().all(|b| b.is_ascii_digit()) {
                return scalar("integer", text.into());
            }
        } else if text.parse::<f64>().is_ok_and(f64::is_finite) {
            return scalar("decimal", text.into());
        }
    }
    if cell_type == CellType::Number {
        CellResult::error("#VALUE!", "Expected an unambiguous finite number")
    } else {
        scalar("text", text.into())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Address {
    pub row: usize,
    pub column: usize,
    pub fixed_row: bool,
    pub fixed_column: bool,
}
impl Address {
    pub fn parse(s: &str) -> Option<Self> {
        let bytes = s.as_bytes();
        let mut i = 0;
        let fixed_column = bytes.first() == Some(&b'$');
        if fixed_column {
            i += 1;
        }
        let start = i;
        let mut column = 0usize;
        while i < bytes.len() && bytes[i].is_ascii_uppercase() {
            column = column
                .checked_mul(26)?
                .checked_add((bytes[i] - b'A' + 1) as usize)?;
            i += 1;
        }
        if i == start {
            return None;
        }
        let fixed_row = bytes.get(i) == Some(&b'$');
        if fixed_row {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if start == i || i != bytes.len() || bytes[start] == b'0' {
            return None;
        }
        let row = s[start..].parse::<usize>().ok()?.checked_sub(1)?;
        if row > 9_999_999 || column > 100_000 {
            return None;
        }
        Some(Self {
            row,
            column: column - 1,
            fixed_row,
            fixed_column,
        })
    }
    pub fn text(self) -> String {
        let mut n = self.column + 1;
        let mut letters = Vec::new();
        while n > 0 {
            n -= 1;
            letters.push((b'A' + (n % 26) as u8) as char);
            n /= 26;
        }
        format!(
            "{}{}{}{}",
            if self.fixed_column { "$" } else { "" },
            letters.into_iter().rev().collect::<String>(),
            if self.fixed_row { "$" } else { "" },
            self.row + 1
        )
    }
    pub fn pos(self) -> Position {
        (self.row, self.column)
    }
}
#[derive(Debug, Clone)]
pub struct Reference {
    pub start: Address,
    pub end: Address,
    pub span: (usize, usize),
    pub quoted: bool,
}
impl Reference {
    pub fn contains(&self, p: Position) -> bool {
        p.0 >= self.start.row.min(self.end.row)
            && p.0 <= self.start.row.max(self.end.row)
            && p.1 >= self.start.column.min(self.end.column)
            && p.1 <= self.start.column.max(self.end.column)
    }
}
#[derive(Debug, Clone)]
pub struct ParsedFormula {
    pub tree: Value,
    pub references: Vec<Reference>,
}
fn normalize(source: &str) -> String {
    let mut bytes = source.as_bytes().to_vec();
    let mut i = 0;
    while i < bytes.len() {
        if matches!(bytes[i], b'\'' | b'"') {
            let quote = bytes[i];
            let triple = bytes.get(i..i + 3) == Some(&[quote, quote, quote]);
            let size = if triple { 3 } else { 1 };
            i += size;
            while i < bytes.len() {
                if bytes[i] == b'\\' {
                    i = (i + 2).min(bytes.len());
                    continue;
                }
                if bytes.get(i..i + size) == Some(vec![quote; size].as_slice()) {
                    i += size;
                    break;
                }
                i += 1;
            }
        } else {
            if bytes[i] == b'$' {
                bytes[i] = b'_';
            }
            i += 1;
        }
    }
    String::from_utf8(bytes).expect("ASCII replacement preserves UTF-8")
}
pub fn parse(source: &str) -> Result<ParsedFormula, String> {
    if source.len() > FORMULA_LIMIT {
        return Err("Formula exceeds 16 KiB".into());
    }
    let source = source
        .strip_prefix('=')
        .ok_or("Formula must begin with =")?;
    let normalized = normalize(source);
    let expression = ast::Expr::parse(&normalized, "<cell>").map_err(|e| e.to_string())?;
    let mut references = Vec::new();
    let mut nodes = 0;
    let tree = convert(&expression, source, &mut references, &mut nodes, 0)?;
    Ok(ParsedFormula { tree, references })
}
fn convert(
    e: &ast::Expr,
    source: &str,
    refs: &mut Vec<Reference>,
    nodes: &mut usize,
    depth: usize,
) -> Result<Value, String> {
    *nodes += 1;
    if *nodes > 2048 || depth > 64 {
        return Err("Formula is too complex".into());
    }
    let mut child = |e: &ast::Expr| convert(e, source, refs, nodes, depth + 1);
    Ok(match e {
        ast::Expr::Constant(v) => match &v.value {
            ast::Constant::None => json!({"op":"literal","value":Scalar::blank()}),
            ast::Constant::Bool(v) => {
                json!({"op":"literal","value":{"kind":"boolean","text":if *v {"True"}else{"False"}}})
            }
            ast::Constant::Str(v) => json!({"op":"literal","value":{"kind":"text","text":v}}),
            ast::Constant::Int(v) => {
                json!({"op":"literal","value":{"kind":"integer","text":v.to_string()}})
            }
            ast::Constant::Float(v) if v.is_finite() => {
                json!({"op":"literal","value":{"kind":"decimal","text":v.to_string()}})
            }
            _ => return Err("Unsupported literal".into()),
        },
        ast::Expr::Name(v) => {
            let span = (e.start().to_usize(), e.end().to_usize());
            let a = Address::parse(&source[span.0..span.1])
                .ok_or_else(|| format!("Unknown reference {}", v.id))?;
            refs.push(Reference {
                start: a,
                end: a,
                span,
                quoted: false,
            });
            json!({"op":"cell","key":key(a.pos())})
        }
        ast::Expr::BinOp(v) => {
            let op = match v.op {
                ast::Operator::Add => "add",
                ast::Operator::Sub => "sub",
                ast::Operator::Mult => "mul",
                ast::Operator::Div => "div",
                ast::Operator::FloorDiv => "floordiv",
                ast::Operator::Mod => "mod",
                ast::Operator::Pow => "pow",
                _ => return Err("Unsupported operator".into()),
            };
            json!({"op":op,"left":child(&v.left)?,"right":child(&v.right)?})
        }
        ast::Expr::UnaryOp(v) => {
            let op = match v.op {
                ast::UnaryOp::UAdd => "pos",
                ast::UnaryOp::USub => "neg",
                ast::UnaryOp::Not => "not",
                _ => return Err("Unsupported unary operator".into()),
            };
            json!({"op":op,"value":child(&v.operand)?})
        }
        ast::Expr::BoolOp(v) => {
            json!({"op":if v.op==ast::BoolOp::And {"and"}else{"or"},"values":v.values.iter().map(&mut child).collect::<Result<Vec<_>,_>>()?})
        }
        ast::Expr::IfExp(v) => {
            json!({"op":"if","test":child(&v.test)?,"yes":child(&v.body)?,"no":child(&v.orelse)?})
        }
        ast::Expr::Compare(v) => {
            let ops = v
                .ops
                .iter()
                .map(|op| match op {
                    ast::CmpOp::Eq => Ok("eq"),
                    ast::CmpOp::NotEq => Ok("ne"),
                    ast::CmpOp::Lt => Ok("lt"),
                    ast::CmpOp::LtE => Ok("le"),
                    ast::CmpOp::Gt => Ok("gt"),
                    ast::CmpOp::GtE => Ok("ge"),
                    _ => Err("Unsupported comparison"),
                })
                .collect::<Result<Vec<_>, _>>()?;
            json!({"op":"compare","left":child(&v.left)?,"ops":ops,"values":v.comparators.iter().map(&mut child).collect::<Result<Vec<_>,_>>()?})
        }
        ast::Expr::Call(v) => {
            let ast::Expr::Name(function) = v.func.as_ref() else {
                return Err("Call a built-in or project function by name".into());
            };
            let name = function.id.as_str();
            if name == "_ref_error" && v.args.is_empty() && v.keywords.is_empty() {
                json!({"op":"refError"})
            } else if name == "cells" {
                if v.args.len() != 1 || !v.keywords.is_empty() {
                    return Err("cells() requires a literal cell range".into());
                }
                let ast::Expr::Constant(value) = &v.args[0] else {
                    return Err("cells() requires a literal cell range".into());
                };
                let ast::Constant::Str(text) = &value.value else {
                    return Err("cells() requires a literal cell range".into());
                };
                if text == "#REF!" {
                    return Ok(json!({"op":"refError"}));
                }
                let (first, last) = text.split_once(':').unwrap_or((text, text));
                let start = Address::parse(first).ok_or("Invalid range start")?;
                let end = Address::parse(last).ok_or("Invalid range end")?;
                let span = (v.args[0].start().to_usize(), v.args[0].end().to_usize());
                refs.push(Reference {
                    start,
                    end,
                    span,
                    quoted: true,
                });
                json!({"op":"range","start":start.pos(),"end":end.pos()})
            } else {
                if name.starts_with('_') || Address::parse(name).is_some() {
                    return Err("Reserved function name".into());
                }
                let args = v
                    .args
                    .iter()
                    .map(&mut child)
                    .collect::<Result<Vec<_>, _>>()?;
                let kwargs = v
                    .keywords
                    .iter()
                    .map(|k| {
                        Ok((
                            k.arg
                                .as_ref()
                                .ok_or("Keyword expansion is not supported")?
                                .to_string(),
                            child(&k.value)?,
                        ))
                    })
                    .collect::<Result<BTreeMap<_, _>, String>>()?;
                json!({"op":"call","name":name,"args":args,"kwargs":kwargs})
            }
        }
        _ => {
            return Err(
                "Use literals, references, arithmetic, comparisons, conditionals or function calls"
                    .into(),
            );
        }
    })
}
#[derive(Debug, Clone, Copy)]
pub enum Shift {
    Copy {
        rows: isize,
        columns: isize,
    },
    Structure {
        rows: bool,
        index: usize,
        count: usize,
        delete: bool,
    },
}
pub fn shift_formula(source: &str, shift: Shift) -> String {
    let Ok(mut parsed) = parse(source) else {
        return source.into();
    };
    let mut result = source.to_string();
    // AST traversal order differs from source order for conditional expressions.
    parsed.references.sort_by_key(|reference| reference.span.0);
    for reference in parsed.references.iter().rev() {
        let mut a = reference.start;
        let mut b = reference.end;
        let mut valid = true;
        match shift {
            Shift::Copy { rows, columns } => {
                for p in [&mut a, &mut b] {
                    if !p.fixed_row {
                        if let Some(v) = p.row.checked_add_signed(rows) {
                            p.row = v;
                        } else {
                            valid = false;
                        }
                    }
                    if !p.fixed_column {
                        if let Some(v) = p.column.checked_add_signed(columns) {
                            p.column = v;
                        } else {
                            valid = false;
                        }
                    }
                }
            }
            Shift::Structure {
                rows,
                index,
                count,
                delete,
            } => {
                let (x, y) = if rows {
                    (&mut a.row, &mut b.row)
                } else {
                    (&mut a.column, &mut b.column)
                };
                if delete {
                    let end = index.saturating_add(count);
                    let low = (*x).min(*y);
                    let high = (*x).max(*y);
                    if low >= index && high < end {
                        valid = false;
                    } else {
                        let new_low = if low >= end {
                            low - count
                        } else {
                            low.min(index)
                        };
                        let new_high = if high >= end {
                            high - count
                        } else if high < index {
                            high
                        } else {
                            index.saturating_sub(1)
                        };
                        if *x <= *y {
                            *x = new_low;
                            *y = new_high;
                        } else {
                            *x = new_high;
                            *y = new_low;
                        }
                    }
                } else {
                    if *x >= index {
                        *x += count;
                    }
                    if *y >= index {
                        *y += count;
                    }
                }
            }
        }
        valid &= [a, b]
            .iter()
            .all(|p| p.row < 10_000_000 && p.column < 100_000);
        let replacement = if valid {
            let text = if reference.quoted {
                format!("{}:{}", a.text(), b.text())
            } else {
                a.text()
            };
            if reference.quoted {
                serde_json::to_string(&text).unwrap()
            } else {
                text
            }
        } else if reference.quoted {
            // Replace the entire cells(...) call using the enclosing expression on the next parse.
            "\"#REF!\"".into()
        } else {
            "_ref_error()".into()
        };
        result.replace_range(reference.span.0 + 1..reference.span.1 + 1, &replacement);
    }
    result
}

#[derive(Debug, Clone, Default)]
pub struct DependencyGraph {
    pub parsed: HashMap<String, Result<ParsedFormula, String>>,
    sources: HashMap<String, String>,
    direct: HashMap<String, Vec<String>>,
    ranges: Vec<(String, Reference)>,
}
impl DependencyGraph {
    pub fn refresh(&mut self, sheet: &SheetData) {
        let mut previous = std::mem::take(&mut self.parsed);
        let sources = std::mem::take(&mut self.sources);
        self.direct.clear();
        self.ranges.clear();
        for (k, meta) in sheet.formulas() {
            let parsed = if sources.get(k) == Some(&meta.source) {
                previous.remove(k).unwrap_or_else(|| parse(&meta.source))
            } else {
                parse(&meta.source)
            };
            if let Ok(p) = &parsed {
                for r in &p.references {
                    if r.start.pos() == r.end.pos() {
                        self.direct
                            .entry(key(r.start.pos()))
                            .or_default()
                            .push(k.clone());
                    } else {
                        self.ranges.push((k.clone(), r.clone()));
                    }
                }
            }
            self.sources.insert(k.clone(), meta.source.clone());
            self.parsed.insert(k.clone(), parsed);
        }
    }
    pub fn affected(&self, changed: impl IntoIterator<Item = String>) -> HashSet<String> {
        let mut pending: VecDeque<_> = changed.into_iter().collect();
        let mut seen = HashSet::new();
        while let Some(k) = pending.pop_front() {
            if !seen.insert(k.clone()) {
                continue;
            }
            if let Some(next) = self.direct.get(&k) {
                pending.extend(next.iter().cloned());
            }
            if let Some(p) = position(&k) {
                pending.extend(
                    self.ranges
                        .iter()
                        .filter(|(_, r)| r.contains(p))
                        .map(|(k, _)| k.clone()),
                );
            }
        }
        seen
    }
    pub fn order(&self, sheet: &SheetData) -> (Vec<String>, Vec<String>) {
        let pending: HashSet<_> = sheet
            .formulas()
            .filter(|(_, m)| m.pending)
            .map(|(k, _)| k.clone())
            .collect();
        let positions: BTreeMap<_, _> = pending.iter().map(|k| (position(k).unwrap(), k)).collect();
        let mut indegree = HashMap::new();
        let mut reverse: HashMap<String, Vec<String>> = HashMap::new();
        for k in &pending {
            let mut deps = HashSet::new();
            if let Some(Ok(parsed)) = self.parsed.get(k) {
                for r in &parsed.references {
                    if r.start.pos() == r.end.pos() {
                        if let Some(target) = positions.get(&r.start.pos()) {
                            deps.insert((*target).clone());
                        }
                        continue;
                    }
                    let low = (r.start.row.min(r.end.row), 0);
                    let high = (r.start.row.max(r.end.row), usize::MAX);
                    for (p, target) in positions.range(low..=high) {
                        if r.contains(*p) {
                            deps.insert((*target).clone());
                        }
                    }
                }
            }
            indegree.insert(k.clone(), deps.len());
            for dep in deps {
                reverse.entry(dep).or_default().push(k.clone());
            }
        }
        let mut ready: VecDeque<_> = indegree
            .iter()
            .filter(|(_, n)| **n == 0)
            .map(|(k, _)| k.clone())
            .collect();
        let mut order = Vec::new();
        while let Some(k) = ready.pop_front() {
            order.push(k.clone());
            for dependent in reverse.get(&k).into_iter().flatten() {
                let count = indegree.get_mut(dependent).unwrap();
                *count -= 1;
                if *count == 0 {
                    ready.push_back(dependent.clone());
                }
            }
        }
        let blocked = indegree
            .into_iter()
            .filter(|(_, n)| *n > 0)
            .map(|(k, _)| k)
            .collect();
        (order, blocked)
    }
}

pub fn validate_result(result: &CellResult) -> Result<(), String> {
    match (&result.value, &result.error) {
        (Some(v), None) => {
            let valid = match v.kind.as_str() {
                "blank" => v.text.is_empty(),
                "text" => true,
                "boolean" => matches!(v.text.as_str(), "True" | "False"),
                "integer" => {
                    let text = v.text.strip_prefix(['+', '-']).unwrap_or(&v.text);
                    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
                }
                "decimal" => v.text.parse::<f64>().is_ok_and(f64::is_finite),
                _ => false,
            };
            if valid && v.text == result.display {
                Ok(())
            } else {
                Err("Invalid calculated scalar".into())
            }
        }
        (None, Some(e))
            if [
                "#VALUE!",
                "#REF!",
                "#NAME?",
                "#SYNTAX!",
                "#CYCLE!",
                "#DIV/0!",
                "#PYTHON!",
                "#PENDING!",
            ]
            .contains(&e.code.as_str())
                && result.display == e.code =>
        {
            Ok(())
        }
        _ => Err("Invalid calculated cell result".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn formulas_are_parsed_without_running_code() {
        let p = parse("=round($B$1 / C1, 2) if C1 != 0 else 0").unwrap();
        assert_eq!(p.references.len(), 3);
        assert!(parse("=__import__('os').system('x')").is_err());
        assert!(parse("=cells(B1)").is_err());
        assert!(parse("=[x for x in B1]").is_err());
    }
    #[test]
    fn copies_and_structural_edits_preserve_references() {
        assert_eq!(
            shift_formula(
                "=$B$1+B1+B$1+$B1",
                Shift::Copy {
                    rows: 2,
                    columns: 1
                }
            ),
            "=$B$1+C3+C$1+$B3"
        );
        assert_eq!(
            shift_formula(
                "=sum(cells(\"B2:B10\"))",
                Shift::Structure {
                    rows: true,
                    index: 4,
                    count: 2,
                    delete: false
                }
            ),
            "=sum(cells(\"B2:B12\"))"
        );
        assert_eq!(
            shift_formula(
                "=B2+C1",
                Shift::Structure {
                    rows: true,
                    index: 1,
                    count: 1,
                    delete: true
                }
            ),
            "=_ref_error()+C1"
        );
        assert_eq!(
            shift_formula(
                "='B1' + str(B1)",
                Shift::Copy {
                    rows: 1,
                    columns: 0
                }
            ),
            "='B1' + str(B2)"
        );
    }
    #[test]
    fn conservative_numbers_keep_original_text() {
        assert_eq!(
            literal("00123", CellType::Auto, false).value.unwrap().kind,
            "text"
        );
        assert_eq!(
            literal("12.5", CellType::Auto, false).value.unwrap().kind,
            "decimal"
        );
        assert_eq!(
            literal("10", CellType::Auto, false).value.unwrap().kind,
            "integer"
        );
        assert_eq!(
            literal("'10", CellType::Auto, true).value.unwrap().text,
            "10"
        );
        assert_eq!(
            literal("", CellType::Auto, false).value.unwrap().kind,
            "blank"
        );
        assert!(literal("1,000", CellType::Number, false).error.is_some());
    }
    #[test]
    fn deletion_only_changes_ranges_that_intersect_or_follow_it() {
        let shift = Shift::Structure {
            rows: true,
            index: 5,
            count: 2,
            delete: true,
        };
        assert_eq!(
            shift_formula("=sum(cells(\"B1:B3\"))", shift),
            "=sum(cells(\"B1:B3\"))"
        );
        assert_eq!(
            shift_formula("=sum(cells(\"B4:B8\"))", shift),
            "=sum(cells(\"B4:B6\"))"
        );
        assert_eq!(
            shift_formula("=sum(cells(\"B8:B10\"))", shift),
            "=sum(cells(\"B6:B8\"))"
        );
        assert_eq!(
            shift_formula("=sum(cells(\"B6:B7\"))", shift),
            "=sum(cells(\"#REF!\"))"
        );
    }
    #[test]
    fn conditional_reference_rewrites_follow_source_spans() {
        assert_eq!(
            shift_formula(
                "=B9 if C9 > 0 else D9",
                Shift::Copy {
                    rows: 1,
                    columns: 0
                }
            ),
            "=B10 if C10 > 0 else D10"
        );
    }
}
