//! The search box's grammar: whitespace-separated terms, all of which must
//! appear (case-insensitively), plus `is:image` / `is:text` to filter by kind.

use crate::Kind;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Query {
    pub terms: Vec<String>,
    pub kind: Option<Kind>,
}

impl Query {
    pub fn parse(raw: &str) -> Self {
        let mut q = Query::default();
        for word in raw.split_whitespace() {
            match word.to_ascii_lowercase().as_str() {
                "is:image" | "is:img" => q.kind = Some(Kind::Image),
                "is:text" => q.kind = Some(Kind::Text),
                _ => q.terms.push(word.to_string()),
            }
        }
        q
    }
}

/// `term` as a `LIKE` pattern matching it anywhere, with `\` as the escape.
pub(crate) fn like_pattern(term: &str) -> String {
    let mut out = String::with_capacity(term.len() + 2);
    out.push('%');
    for c in term.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_terms_and_pulls_out_kind_filters() {
        let q = Query::parse("  foo IS:IMAGE  bar ");
        assert_eq!(q.terms, ["foo", "bar"]);
        assert_eq!(q.kind, Some(Kind::Image));
        assert_eq!(Query::parse(""), Query::default());
    }

    #[test]
    fn like_wildcards_are_escaped() {
        assert_eq!(like_pattern("50%_a\\b"), "%50\\%\\_a\\\\b%");
    }
}
