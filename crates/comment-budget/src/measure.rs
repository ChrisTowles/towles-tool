//! A file to counts: which lines are entirely comment, which are code. Nothing
//! here decides whether a count is too high; that is [`crate::rule`].

use std::collections::BTreeSet;

/// The grammar a file is read with, chosen by its extension alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Rust,
    TypeScript,
    Tsx,
    Hcl,
}

impl Lang {
    pub fn for_path(path: &str) -> Option<Lang> {
        let name = path.rsplit('/').next().unwrap_or(path);
        let (_, ext) = name.rsplit_once('.')?;
        Some(match ext {
            "rs" => Lang::Rust,
            "ts" | "mts" | "cts" | "js" | "mjs" | "cjs" => Lang::TypeScript,
            "tsx" | "jsx" => Lang::Tsx,
            "tf" | "tfvars" | "hcl" => Lang::Hcl,
            _ => return None,
        })
    }

    fn grammar(self) -> tree_sitter::Language {
        match self {
            Lang::Rust => tree_sitter_rust::LANGUAGE.into(),
            Lang::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Lang::Hcl => tree_sitter_hcl::LANGUAGE.into(),
        }
    }
}

#[derive(Debug, Default)]
pub struct Counts {
    pub code: usize,
    /// 0-based rows that hold nothing but comment. A trailing `//` on a code
    /// line is code; blank lines are neither.
    pub comment_rows: BTreeSet<usize>,
}

impl Counts {
    pub fn comment(&self) -> usize {
        self.comment_rows.len()
    }

    /// Comment lines past the budget's share of the file, which is the number a
    /// fix is measured in: lines to delete.
    pub fn excess(&self) -> usize {
        let pct = crate::rule::BUDGET_PERCENT;
        self.comment().saturating_sub(self.code * pct / (100 - pct))
    }

    /// Unbroken comment blocks as 0-based inclusive row ranges.
    pub fn runs(&self) -> Vec<(usize, usize)> {
        let mut runs: Vec<(usize, usize)> = Vec::new();
        for &row in &self.comment_rows {
            match runs.last_mut() {
                Some(run) if run.1 + 1 == row => run.1 = row,
                _ => runs.push((row, row)),
            }
        }
        runs
    }
}

pub fn measure(lang: Lang, content: &str) -> Counts {
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&lang.grammar()).expect("bundled grammar matches the runtime");
    let Some(tree) = parser.parse(content, None) else {
        return Counts::default();
    };
    let lines: Vec<&str> = content.lines().collect();
    let mut nodes = Vec::new();
    collect_comments(tree.root_node(), &mut nodes);

    let mut comment_rows = BTreeSet::new();
    for node in nodes {
        let (start, end) = (node.start_position(), node.end_position());
        let before = lines.get(start.row).map_or("", |l| &l[..start.column.min(l.len())]);
        if !before.trim().is_empty() {
            continue;
        }
        let last = if end.column == 0 { end.row.saturating_sub(1) } else { end.row };
        comment_rows.extend(
            (start.row..=last).filter(|&r| lines.get(r).is_some_and(|l| !l.trim().is_empty())),
        );
    }
    let code = (0..lines.len())
        .filter(|&r| !lines[r].trim().is_empty() && !comment_rows.contains(&r))
        .count();
    Counts { code, comment_rows }
}

fn collect_comments<'t>(node: tree_sitter::Node<'t>, out: &mut Vec<tree_sitter::Node<'t>>) {
    // Rust names them `line_comment`/`block_comment`; TS and HCL, plain `comment`.
    if node.kind() == "comment" || node.kind().ends_with("_comment") {
        out.push(node);
        return;
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_comments(child, out);
    }
}

const MARKER: &str = "comment-budget: allow";

/// The reason a file's header gives for opting out, `Some("")` when the marker
/// names none. Only the leading block, up to the first blank line, is read.
pub fn opt_out(content: &str) -> Option<String> {
    content.lines().take_while(|l| !l.trim().is_empty()).find_map(|line| {
        let (_, rest) = line.split_once(MARKER)?;
        let reason = rest.trim().strip_prefix('(').and_then(|r| r.rsplit_once(')'));
        Some(reason.map_or("", |(r, _)| r.trim()).to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_comes_from_the_extension() {
        assert_eq!(Lang::for_path("a/b/lib.rs"), Some(Lang::Rust));
        assert_eq!(Lang::for_path("x.mjs"), Some(Lang::TypeScript));
        assert_eq!(Lang::for_path("ui/button.tsx"), Some(Lang::Tsx));
        assert_eq!(Lang::for_path("infra/main.tf"), Some(Lang::Hcl));
        assert_eq!(Lang::for_path("README.md"), None);
        assert_eq!(Lang::for_path("dir.rs/Makefile"), None);
    }

    #[test]
    fn every_comment_syntax_counts_and_trailing_ones_do_not() {
        let src = "//! module\n/// item\n// line\n/* block\n   two */\nfn a() {} // trailing\n\n";
        let c = measure(Lang::Rust, src);
        assert_eq!(c.comment(), 5);
        assert_eq!(c.code, 1);
    }

    #[test]
    fn a_comment_marker_inside_a_string_is_code() {
        let c = measure(Lang::TypeScript, "const url = \"http://x\";\n// real\n");
        assert_eq!((c.comment(), c.code), (1, 1));
    }

    #[test]
    fn excess_is_comment_past_a_fifteen_percent_share() {
        let src = format!("{}{}", "// c\n".repeat(10), "let a = 1;\n".repeat(34));
        let c = measure(Lang::TypeScript, &src);
        // 34 code lines earn 6 comment lines (6 / 40 = 15%), so 4 are over.
        assert_eq!(c.excess(), 4);
    }

    #[test]
    fn runs_break_on_code_and_blank_lines() {
        let c = measure(Lang::Rust, "// a\n// b\nfn x() {}\n// c\n\n// d\n");
        assert_eq!(c.runs(), vec![(0, 1), (3, 3), (5, 5)]);
    }

    #[test]
    fn opt_out_reads_the_header_reason() {
        assert_eq!(
            opt_out("//! comment-budget: allow(clap help)\nfn a() {}"),
            Some("clap help".into())
        );
        assert_eq!(opt_out("// comment-budget: allow\n"), Some(String::new()));
        assert_eq!(opt_out("// comment-budget: allow()\n"), Some(String::new()));
        assert_eq!(opt_out("fn a() {}\n\n// comment-budget: allow(late)\n"), None);
    }
}
