//! Dev tasks (`cargo xtask <task>`). One task today: `comment-lint`, a linter for
//! comment volume across every language here — nothing else measures it (oxlint
//! implements no such rule at all). Warnings are the standing hit list; errors
//! fail CI. What it measures and how hard, including what each signal is for,
//! lives in `comment-lint.toml` at the repo root.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::{env, fs};

const MARKER: &str = "verbose-ok:";
const CONFIG_FILE: &str = "comment-lint.toml";

/// Every threshold, read from [`CONFIG_FILE`] at the repo root. Tightening the
/// gate is an edit to that file, not to this source — but it holds thresholds
/// and paths only. It must never grow per-file exceptions or a baseline: a list
/// of files allowed to fail turns a linter into a ledger of debt nobody pays.
#[derive(serde::Deserialize)]
struct Config {
    /// Source trees measured for comments, and paths skipped inside them.
    trees: Vec<String>,
    skip: Vec<String>,
    languages: Vec<LanguageSpec>,
    block: Tiers<usize>,
    #[serde(rename = "heavy-file")]
    heavy_file: Tiers<HeavyFile>,
    doc: Tiers<usize>,
}

impl Config {
    fn load(root: &Path) -> Result<Self, String> {
        let path = root.join(CONFIG_FILE);
        let text = fs::read_to_string(&path)
            .map_err(|e| format!("could not read {}: {e}", path.display()))?;
        toml::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
    }

    /// How a file is read, by extension — `None` for one no `[[languages]]`
    /// entry claims, which is simply not measured.
    fn language_for(&self, name: &str) -> Option<&LanguageSpec> {
        let ext = name.rsplit_once('.')?.1;
        self.languages.iter().find(|l| l.extensions.iter().any(|e| e == ext))
    }
}

/// One `[[languages]]` entry: which extensions it claims, how they're read, and
/// where they're looked for.
#[derive(serde::Deserialize)]
struct LanguageSpec {
    grammar: Grammar,
    extensions: Vec<String>,
    #[serde(default)]
    scan: Scan,
}

#[derive(serde::Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Grammar {
    Rust,
    Typescript,
    Tsx,
    /// Parsed by nothing and measured by length — see [`Config::doc`].
    Prose,
}

impl Grammar {
    /// `None` for [`Grammar::Prose`], which has no grammar to parse with.
    fn language(&self) -> Option<tree_sitter::Language> {
        match self {
            Grammar::Rust => Some(tree_sitter_rust::LANGUAGE.into()),
            Grammar::Typescript => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
            Grammar::Tsx => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
            Grammar::Prose => None,
        }
    }
}

/// Where an extension is looked for.
#[derive(serde::Deserialize, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Scan {
    /// Only under `trees` (the default).
    #[default]
    Trees,
    /// The whole checkout.
    Repo,
}

/// Warn/error cutoffs for one rule.
#[derive(serde::Deserialize)]
struct Tiers<T> {
    warn: T,
    error: T,
}

impl<T> Tiers<T> {
    /// The highest tier `reached` is true for, error first.
    fn hit(&self, reached: impl Fn(&T) -> bool) -> Option<(Severity, &T)> {
        if reached(&self.error) {
            Some((Severity::Error, &self.error))
        } else if reached(&self.warn) {
            Some((Severity::Warning, &self.warn))
        } else {
            None
        }
    }
}

#[derive(serde::Deserialize)]
struct HeavyFile {
    lines: usize,
    ratio: f64,
}

struct Block {
    /// 1-based, inclusive.
    start: usize,
    end: usize,
    overridden: bool,
}

impl Block {
    fn lines(&self) -> usize {
        self.end - self.start + 1
    }
}

struct FileStats {
    file: String,
    /// `Some` for markdown, which is measured by length instead.
    doc_lines: Option<usize>,
    comment_lines: usize,
    code_lines: usize,
    blocks: Vec<Block>,
}

enum Severity {
    Warning,
    Error,
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("comment-lint") {
        eprintln!("usage: cargo xtask comment-lint");
        return ExitCode::from(2);
    }
    let root = repo_root();
    let run = Config::load(&root).and_then(|cfg| {
        let stats = measure(&root, &cfg)?;
        Ok((cfg, stats))
    });
    let (cfg, stats) = match run {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };

    let (mut errors, mut warnings) = (0usize, 0usize);
    let mut findings: Vec<(Severity, String)> = Vec::new();

    for s in &stats {
        if let Some(lines) = s.doc_lines {
            if let Some((sev, cap)) = cfg.doc.hit(|&n| lines >= n) {
                findings.push((
                    sev,
                    format!("[long-doc] {} — {lines}-line doc (threshold {cap})", s.file),
                ));
            }
            continue;
        }
        for b in &s.blocks {
            if b.overridden {
                continue;
            }
            if let Some((sev, cap)) = cfg.block.hit(|&n| b.lines() >= n) {
                findings.push((
                    sev,
                    format!(
                        "[comment-block] {}:{}-{} — {}-line comment block (threshold {cap})",
                        s.file,
                        b.start,
                        b.end,
                        b.lines()
                    ),
                ));
            }
        }

        let ratio =
            if s.code_lines == 0 { 0.0 } else { s.comment_lines as f64 / s.code_lines as f64 };
        let heavy = cfg.heavy_file.hit(|t| s.comment_lines >= t.lines && ratio >= t.ratio);
        if let Some((sev, t)) = heavy {
            findings.push((
                sev,
                format!(
                    "[comment-heavy-file] {} — {} comment lines against {} code lines ({:.0}%; \
                     threshold {}+ lines at {:.0}%+)",
                    s.file,
                    s.comment_lines,
                    s.code_lines,
                    100.0 * ratio,
                    t.lines,
                    100.0 * t.ratio,
                ),
            ));
        }
    }

    for (sev, msg) in &findings {
        match sev {
            Severity::Error => {
                errors += 1;
                println!("error{msg}");
            }
            Severity::Warning => {
                warnings += 1;
                println!("warning{msg}");
            }
        }
    }
    println!("comment-lint: {} file(s), {errors} error(s), {warnings} warning(s)", stats.len());
    if !findings.is_empty() {
        println!(
            "\nFix by deleting, not reflowing: cut history — git already holds it — and keep \
             only what looks forward: the *why*, and the *how* where the code leaves it \
             unclear. Squeezing under a threshold just moves an error onto the warning list."
        );
    }
    if errors > 0 {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn repo_root() -> PathBuf {
    // xtask/ sits at the workspace root, so the parent of this crate is it.
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("xtask has a parent dir").to_path_buf()
}

fn measure(root: &Path, cfg: &Config) -> Result<Vec<FileStats>, String> {
    let mut files = Vec::new();
    for tree in &cfg.trees {
        collect_files(root, &root.join(tree), cfg, &mut files);
    }
    // The second sweep is what a `scan = "repo"` language needs; a tree-scanned
    // one is filtered back out inside `collect_files`.
    collect_files(root, root, cfg, &mut files);
    files.sort();
    files.dedup();

    let mut parser = tree_sitter::Parser::new();
    let mut stats = Vec::new();
    for path in files {
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("could not read {}: {e}", path.display()))?;
        let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let spec = cfg.language_for(&name).expect("collect_files only pushes claimed extensions");
        stats.push(match spec.grammar.language() {
            Some(lang) => {
                parser
                    .set_language(&lang)
                    .map_err(|e| format!("tree-sitter language mismatch for {rel}: {e}"))?;
                fold_file(&mut parser, rel, &content)?
            }
            None => FileStats {
                file: rel,
                doc_lines: Some(content.lines().count()),
                comment_lines: 0,
                code_lines: 0,
                blocks: Vec::new(),
            },
        });
    }
    Ok(stats)
}

/// Recurse `dir`, collecting every file some `[[languages]]` entry claims and
/// whose `scan` mode allows it here.
fn collect_files(root: &Path, dir: &Path, cfg: &Config, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        if cfg.skip.iter().any(|s| s == &rel) || name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            collect_files(root, &path, cfg, out);
        } else if cfg
            .language_for(&name)
            .is_some_and(|l| l.scan == Scan::Repo || under_tree(cfg, &rel))
        {
            out.push(path);
        }
    }
}

fn under_tree(cfg: &Config, rel: &str) -> bool {
    cfg.trees.iter().any(|t| rel.starts_with(&format!("{t}/")))
}

fn fold_file(
    parser: &mut tree_sitter::Parser,
    file: String,
    content: &str,
) -> Result<FileStats, String> {
    let tree =
        parser.parse(content, None).ok_or_else(|| format!("tree-sitter could not parse {file}"))?;
    let lines: Vec<&str> = content.lines().collect();

    let mut nodes = Vec::new();
    collect_comment_nodes(tree.root_node(), &mut nodes);

    // 0-based line numbers that are entirely comment. A trailing `//` on a
    // code line stays code; a comment node spanning lines claims them all.
    let mut comment_line_nums = BTreeSet::new();
    for node in nodes {
        let (start, end) = (node.start_position(), node.end_position());
        let prefix = lines.get(start.row).map_or("", |l| &l[..start.column.min(l.len())]);
        if !prefix.trim().is_empty() {
            continue;
        }
        let last_row = if end.column == 0 { end.row.saturating_sub(1) } else { end.row };
        comment_line_nums.extend(start.row..=last_row);
    }

    let mut blocks: Vec<Block> = Vec::new();
    for row in comment_line_nums.iter().copied() {
        let overridden = is_override(lines.get(row).copied().unwrap_or(""));
        match blocks.last_mut() {
            // `end` is 1-based, so equality means `row` is the very next line.
            Some(cur) if cur.end == row => {
                cur.end = row + 1;
                cur.overridden |= overridden;
            }
            _ => blocks.push(Block { start: row + 1, end: row + 1, overridden }),
        }
    }

    let blank_lines = lines.iter().filter(|l| l.trim().is_empty()).count();
    Ok(FileStats {
        file,
        doc_lines: None,
        comment_lines: comment_line_nums.len(),
        code_lines: lines.len() - blank_lines - comment_line_nums.len(),
        blocks,
    })
}

/// Whether a comment line *is* the suppression directive, rather than prose that
/// happens to name it. The marker has to lead the line's text once its comment
/// syntax is stripped — a substring match let any sentence mentioning the escape
/// hatch silently claim it, which is how this linter's own module doc went
/// unmeasured.
fn is_override(line: &str) -> bool {
    let text = line.trim_start().trim_start_matches(['/', '!', '*', '#']).trim_start();
    text.starts_with(MARKER)
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
