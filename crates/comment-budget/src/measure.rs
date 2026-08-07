//! Turning files into counts. Nothing here decides whether a count is too high;
//! that is [`crate::judge`].

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::CommentBudgetError;
use crate::config::{Config, Kind};
use crate::diff::{Diff, in_scope};

/// A contiguous run of counted comment lines. Exempt lines break a run rather
/// than joining it — they aren't part of the wading.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Run {
    /// 1-based, inclusive.
    pub start: usize,
    pub end: usize,
}

impl Run {
    pub fn lines(&self) -> usize {
        self.end - self.start + 1
    }
}

#[derive(Debug, serde::Serialize)]
pub struct FileStats {
    pub file: String,
    pub surface: usize,
    /// `Some` for a prose file, which is measured by length instead.
    pub doc_lines: Option<usize>,
    pub counted: usize,
    pub code: usize,
    pub runs: Vec<Run>,
    /// The reason from a top-of-file opt-out; `Some("")` when it named none.
    pub allowed: Option<String>,
    /// Whether the counts above cover only the lines a diff run added, which the
    /// findings have to say out loud — the same percentage means a different
    /// thing.
    pub scoped: bool,
}

impl FileStats {
    pub fn ratio(&self) -> f64 {
        let total = self.counted + self.code;
        if total == 0 { 0.0 } else { self.counted as f64 / total as f64 }
    }

    /// How many comment lines this file would have to lose to reach `ratio` —
    /// the thing that actually orders a cleanup, since a 90%-prose file of 20
    /// lines costs nothing to fix and a 40% one of 800 lines is a week.
    pub fn overshoot(&self, ratio: f64) -> usize {
        let keep = (ratio / (1.0 - ratio) * self.code as f64).floor() as usize;
        self.counted.saturating_sub(keep)
    }

    /// The lines past budget a reader wades through: overshoot for code, the
    /// whole file for prose, which has no code to earn any allowance.
    pub fn excess(&self, budget: f64) -> usize {
        match self.doc_lines {
            Some(lines) => lines,
            None => self.overshoot(budget),
        }
    }
}

/// A config glob that claims no files — it matches nothing, or an earlier
/// surface claims everything it matches.
#[derive(Debug)]
pub struct DeadGlob {
    pub surface: usize,
    pub glob: String,
}

#[derive(Debug)]
pub struct Analysis {
    pub stats: Vec<FileStats>,
    /// Files a kind can read that no surface claims.
    pub unclaimed: Vec<String>,
    pub dead_globs: Vec<DeadGlob>,
}

pub fn analyze(
    root: &Path,
    cfg: &Config,
    diff: Option<&Diff>,
) -> Result<Analysis, CommentBudgetError> {
    let mut files = Vec::new();
    collect_files(root, root, cfg, &mut files);
    files.sort();
    // From the full walk, before diff scoping: a glob is dead against the tree,
    // not against what this branch happened to touch.
    let dead_globs = dead_globs(root, cfg, &files);

    let mut parser = tree_sitter::Parser::new();
    let mut stats = Vec::new();
    let mut unclaimed = Vec::new();
    for (path, surface) in files {
        let rel = rel_path(root, &path);
        let content = std::fs::read_to_string(&path)
            .map_err(|source| CommentBudgetError::Read { path: path.clone(), source })?;
        // Out of scope entirely: a file this run didn't touch is neither measured
        // nor reported unclaimed, since adding it to a surface isn't its business.
        let scope = match diff {
            Some(d) => match d.scope_of(&rel, &content) {
                Some(ranges) => Some(ranges),
                None => continue,
            },
            None => None,
        };
        let scope = scope.as_deref();
        let Some(surface) = surface else {
            unclaimed.push(rel);
            continue;
        };
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let kind = cfg.kind_for(&name).expect("collect_files only pushes claimed extensions");
        let scoped = diff.is_some_and(|d| !d.whole_files);
        stats.push(match kind.grammar.language() {
            Some(lang) => {
                parser.set_language(&lang).map_err(|e| CommentBudgetError::Grammar {
                    file: rel.clone(),
                    message: e.to_string(),
                })?;
                fold_file(&mut parser, cfg, kind, rel, surface, &content, scope, scoped)?
            }
            None => FileStats {
                allowed: opt_out(cfg, content.lines().take_while(|l| !l.trim().is_empty())),
                file: rel,
                surface,
                // A prose file has no code to sit against, so in diff mode the
                // measure is how much prose this change *added*.
                doc_lines: Some(
                    (1..=content.lines().count()).filter(|&n| in_scope(scope, n)).count(),
                ),
                counted: 0,
                code: 0,
                runs: Vec::new(),
                scoped,
            },
        });
    }
    Ok(Analysis { stats, unclaimed, dead_globs })
}

fn dead_globs(root: &Path, cfg: &Config, files: &[(PathBuf, Option<usize>)]) -> Vec<DeadGlob> {
    let compiled: Vec<Vec<Option<glob::Pattern>>> = cfg
        .surfaces
        .iter()
        .map(|s| s.paths.iter().map(|p| glob::Pattern::new(p).ok()).collect())
        .collect();
    let mut used: Vec<Vec<bool>> = compiled.iter().map(|p| vec![false; p.len()]).collect();
    for (path, surface) in files {
        let Some(i) = *surface else {
            continue;
        };
        let rel = rel_path(root, path);
        for (j, pat) in compiled[i].iter().enumerate() {
            if pat.as_ref().is_some_and(|p| p.matches_with(&rel, crate::config::GLOB)) {
                used[i][j] = true;
            }
        }
    }
    used.into_iter()
        .enumerate()
        .flat_map(|(i, hits)| {
            let paths = &cfg.surfaces[i].paths;
            hits.into_iter()
                .enumerate()
                .filter(|(_, hit)| !hit)
                .map(move |(j, _)| DeadGlob { surface: i, glob: paths[j].clone() })
        })
        .collect()
}

pub fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

/// Recurse `dir`, collecting every file a kind can read, paired with the surface
/// claiming it — `None` when none does, which is reported rather than skipped.
fn collect_files(root: &Path, dir: &Path, cfg: &Config, out: &mut Vec<(PathBuf, Option<usize>)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let rel = rel_path(root, &path);
        if name.starts_with('.') || cfg.skip.iter().any(|s| s == &rel || s == name.as_ref()) {
            continue;
        }
        // `file_type` does not follow the link, so a symlink is neither dir nor
        // file here and falls through unmeasured. That is the point: a link
        // names a file that already has a real path, so following one measures
        // it twice, and a cycle never terminates at all.
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            collect_files(root, &path, cfg, out);
        } else if kind.is_file() && cfg.kind_for(&name).is_some() {
            out.push((path, cfg.surface_for(&rel)));
        }
    }
}

/// The reason on a file's top-of-file opt-out — `Some("")` when the directive is
/// there but names none, which is itself reported.
fn opt_out<'a>(cfg: &Config, leading: impl Iterator<Item = &'a str>) -> Option<String> {
    let marker = cfg.escape.marker();
    for line in leading {
        let Some(rest) = line.split_once(marker) else {
            continue;
        };
        let reason = rest.1.trim().trim_start_matches('(').trim_end_matches(')').trim();
        return Some(reason.to_string());
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn fold_file(
    parser: &mut tree_sitter::Parser,
    cfg: &Config,
    kind: &Kind,
    file: String,
    surface: usize,
    content: &str,
    scope: Option<&[(usize, usize)]>,
    scoped: bool,
) -> Result<FileStats, CommentBudgetError> {
    let tree = parser.parse(content, None).ok_or_else(|| CommentBudgetError::Grammar {
        file: file.clone(),
        message: "parse failed".into(),
    })?;
    let lines: Vec<&str> = content.lines().collect();

    let mut nodes = Vec::new();
    collect_comment_nodes(tree.root_node(), &mut nodes);

    // 0-based rows that are entirely comment, split by whether the node's own
    // prefix is exempt. A trailing `//` on a code line stays code; a node
    // spanning lines claims them all, exempt or counted as one unit.
    let (mut counted_rows, mut exempt_rows) = (BTreeSet::new(), BTreeSet::new());
    for node in nodes {
        let (start, end) = (node.start_position(), node.end_position());
        let prefix = lines.get(start.row).map_or("", |l| &l[..start.column.min(l.len())]);
        if !prefix.trim().is_empty() {
            continue;
        }
        let last_row = if end.column == 0 { end.row.saturating_sub(1) } else { end.row };
        let text = lines.get(start.row).map_or("", |l| l.trim_start());
        let rows = if kind.is_exempt(text) { &mut exempt_rows } else { &mut counted_rows };
        // A blank line inside a block comment is nothing to wade through, and
        // counting it as both blank and comment makes `code` underflow.
        rows.extend(
            (start.row..=last_row).filter(|&r| lines.get(r).is_some_and(|l| !l.trim().is_empty())),
        );
    }
    spill_exempt_overflow(kind, &mut exempt_rows, &mut counted_rows);

    // Runs are whole-file — an added line in the middle of a long block still
    // makes a reader wade through all of it — but only those the run may judge
    // are reported.
    let mut runs: Vec<Run> = Vec::new();
    for row in counted_rows.iter().copied() {
        match runs.last_mut() {
            // `end` is 1-based, so equality means `row` is the very next line.
            Some(cur) if cur.end == row => cur.end = row + 1,
            _ => runs.push(Run { start: row + 1, end: row + 1 }),
        }
    }
    runs.retain(|r| (r.start..=r.end).any(|n| in_scope(scope, n)));

    let judged = |row: usize| in_scope(scope, row + 1);
    Ok(FileStats {
        allowed: opt_out(cfg, lines.iter().copied().take_while(|l| !l.trim().is_empty())),
        file,
        surface,
        doc_lines: None,
        counted: counted_rows.iter().filter(|&&r| judged(r)).count(),
        // Counted rather than subtracted: every non-blank line that is neither
        // counted nor exempt comment is code.
        code: (0..lines.len())
            .filter(|&r| {
                judged(r)
                    && !lines[r].trim().is_empty()
                    && !counted_rows.contains(&r)
                    && !exempt_rows.contains(&r)
            })
            .count(),
        runs,
        scoped,
    })
}

/// Spill exempt lines past the kind's `exempt_free` allowance into the counted
/// set, so `exempt` is a carve-out rather than a hiding place: without it the
/// cheapest way to pass is to move prose from `///` into `//!`, which shortens
/// nothing for a reader.
pub(crate) fn spill_exempt_overflow(
    kind: &Kind,
    exempt_rows: &mut BTreeSet<usize>,
    counted_rows: &mut BTreeSet<usize>,
) {
    let Some(free) = kind.exempt_free else {
        return;
    };
    // BTreeSet iterates ascending, so this keeps the top-of-file header and
    // spills what trails it — the direction prose grows.
    for row in exempt_rows.iter().copied().skip(free).collect::<Vec<_>>() {
        exempt_rows.remove(&row);
        counted_rows.insert(row);
    }
}

fn collect_comment_nodes<'t>(node: tree_sitter::Node<'t>, out: &mut Vec<tree_sitter::Node<'t>>) {
    // Rust's grammar names them `line_comment`/`block_comment`; TS/TSX's, just `comment`.
    if node.kind() == "comment" || node.kind().ends_with("_comment") {
        out.push(node);
        return;
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_comment_nodes(child, out);
    }
}

#[cfg(test)]
mod tests {
    use super::spill_exempt_overflow;
    use crate::config::{Grammar, Kind};
    use std::collections::BTreeSet;

    fn spill(exempt_free: Option<usize>, exempt: &[usize]) -> (Vec<usize>, Vec<usize>) {
        let kind = Kind {
            grammar: Grammar::Rust,
            extensions: vec!["rs".into()],
            exempt: vec!["//!".into()],
            exempt_free,
            counted: vec!["///".into(), "//".into()],
        };
        let mut exempt_rows: BTreeSet<usize> = exempt.iter().copied().collect();
        let mut counted_rows = BTreeSet::new();
        spill_exempt_overflow(&kind, &mut exempt_rows, &mut counted_rows);
        (exempt_rows.into_iter().collect(), counted_rows.into_iter().collect())
    }

    #[test]
    fn the_header_keeps_the_allowance_and_the_tail_spills() {
        let (exempt, counted) = spill(Some(3), &[0, 1, 2, 3, 4, 5]);
        assert_eq!(exempt, vec![0, 1, 2], "the first `exempt_free` lines are free");
        assert_eq!(counted, vec![3, 4, 5], "the rest are bloat like any other");
    }

    #[test]
    fn no_allowance_configured_leaves_exempt_lines_uncapped() {
        let (exempt, counted) = spill(None, &[0, 1, 2, 3, 4, 5]);
        assert_eq!(exempt, vec![0, 1, 2, 3, 4, 5]);
        assert!(counted.is_empty());
    }
}
