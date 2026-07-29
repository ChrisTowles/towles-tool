//! Dev tasks (`cargo xtask <task>`). One task today: `comment-budget`, the gate on
//! comment volume — nothing else measures it (oxlint implements no such rule at all).
//! Warnings are the standing hit list; errors fail CI. What is measured, how hard,
//! and why each surface is set where it is all live in `comment-budget.toml`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::{env, fs};

const CONFIG_FILE: &str = "comment-budget.toml";

/// Glob semantics: `*` stops at a path separator, `**` crosses it. Without this
/// `crates/*/src/**` would also claim `crates/a/b/c/src`.
const GLOB: glob::MatchOptions = glob::MatchOptions {
    case_sensitive: true,
    require_literal_separator: true,
    require_literal_leading_dot: false,
};

#[derive(serde::Deserialize)]
struct Config {
    skip: Vec<String>,
    kinds: BTreeMap<String, Kind>,
    #[serde(rename = "surface")]
    surfaces: Vec<Surface>,
    escape: Escape,
}

/// How one family of files is read. `exempt` prefixes are invisible to every
/// signal — neither comment nor code — so a Rust `//!` header can be as long as
/// the decision it records.
#[derive(serde::Deserialize)]
struct Kind {
    grammar: Grammar,
    extensions: Vec<String>,
    #[serde(default)]
    exempt: Vec<String>,
    #[serde(default)]
    counted: Vec<String>,
}

#[derive(serde::Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Grammar {
    Rust,
    Typescript,
    Tsx,
    /// Parsed by nothing and measured by length.
    Prose,
}

impl Grammar {
    fn language(&self) -> Option<tree_sitter::Language> {
        match self {
            Grammar::Rust => Some(tree_sitter_rust::LANGUAGE.into()),
            Grammar::Typescript => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
            Grammar::Tsx => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
            Grammar::Prose => None,
        }
    }
}

#[derive(serde::Deserialize)]
struct Surface {
    name: String,
    paths: Vec<String>,
    goal: String,
    target: Option<Target>,
    file: Option<Tiers<FileTier>>,
    run: Option<Tiers<usize>>,
    warn: Option<LinesTier>,
    error: Option<LinesTier>,
}

impl Surface {
    fn claims(&self, rel: &str) -> bool {
        self.paths.iter().any(|p| glob::Pattern::new(p).is_ok_and(|g| g.matches_with(rel, GLOB)))
    }

    /// The length band a prose surface enforces, `None` for a code one.
    fn doc_tiers(&self) -> Option<Tiers<usize>> {
        match (&self.warn, &self.error) {
            (Some(w), Some(e)) => Some(Tiers { warn: w.lines, error: e.lines }),
            _ => None,
        }
    }
}

/// What the surface aims at — a ratio for code, a length for prose. Reported
/// against what was measured; never enforced, which is what warn/error are for.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum Target {
    Ratio(f64),
    Lines { lines: usize },
}

#[derive(serde::Deserialize)]
struct FileTier {
    ratio: f64,
    lines: usize,
}

#[derive(serde::Deserialize)]
struct LinesTier {
    lines: usize,
}

#[derive(serde::Deserialize)]
struct Escape {
    directive: String,
}

impl Escape {
    /// The literal a file must carry, taken from the template's head — so the
    /// config states the directive once and the code can't drift from it.
    fn marker(&self) -> &str {
        self.directive.split('(').next().unwrap_or(&self.directive).trim()
    }
}

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

/// A contiguous run of counted comment lines. Exempt lines break a run rather
/// than joining it — they aren't part of the wading.
struct Run {
    /// 1-based, inclusive.
    start: usize,
    end: usize,
}

impl Run {
    fn lines(&self) -> usize {
        self.end - self.start + 1
    }
}

struct FileStats {
    file: String,
    surface: usize,
    /// `Some` for a prose file, which is measured by length instead.
    doc_lines: Option<usize>,
    counted: usize,
    code: usize,
    runs: Vec<Run>,
    /// The reason from a top-of-file opt-out; `Some("")` when it named none.
    allowed: Option<String>,
}

impl FileStats {
    fn ratio(&self) -> f64 {
        let total = self.counted + self.code;
        if total == 0 {
            0.0
        } else {
            self.counted as f64 / total as f64
        }
    }
}

#[derive(Clone, Copy)]
enum Severity {
    Warning,
    Error,
}

fn main() -> ExitCode {
    if env::args().nth(1).as_deref() != Some("comment-budget") {
        eprintln!("usage: cargo xtask comment-budget");
        return ExitCode::from(2);
    }
    let root = repo_root();
    let run = Config::load(&root).and_then(|cfg| {
        let (stats, unclaimed) = measure(&root, &cfg)?;
        Ok((cfg, stats, unclaimed))
    });
    let (cfg, stats, unclaimed) = match run {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };

    let mut findings = judge(&cfg, &stats);
    findings.extend(unclaimed_findings(&unclaimed));
    for (sev, msg) in &findings {
        match sev {
            Severity::Error => println!("error{msg}"),
            Severity::Warning => println!("warning{msg}"),
        }
    }
    let errors = findings.iter().filter(|(s, _)| matches!(s, Severity::Error)).count();

    report_surfaces(&cfg, &stats);
    println!(
        "\ncomment-budget: {} file(s), {errors} error(s), {} warning(s)",
        stats.len(),
        findings.len() - errors
    );
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

impl Config {
    fn load(root: &Path) -> Result<Self, String> {
        let path = root.join(CONFIG_FILE);
        let text = fs::read_to_string(&path)
            .map_err(|e| format!("could not read {}: {e}", path.display()))?;
        let cfg: Config = toml::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        for s in &cfg.surfaces {
            if s.file.is_none() && s.doc_tiers().is_none() {
                return Err(format!(
                    "{}: surface `{}` enforces nothing — give it [surface.file]/[surface.run], \
                     or warn/error line counts for a prose surface",
                    path.display(),
                    s.name
                ));
            }
        }
        Ok(cfg)
    }

    /// The kind claiming an extension — `None` for a file no kind reads.
    fn kind_for(&self, name: &str) -> Option<&Kind> {
        let ext = name.rsplit_once('.')?.1;
        self.kinds.values().find(|k| k.extensions.iter().any(|e| e == ext))
    }

    /// The first surface claiming a path. First match wins, so order in the
    /// config is the precedence; an unclaimed file is not measured at all.
    fn surface_for(&self, rel: &str) -> Option<usize> {
        self.surfaces.iter().position(|s| s.claims(rel))
    }
}

/// Every finding, worst-first per file in config order.
fn judge<'a>(cfg: &'a Config, stats: &'a [FileStats]) -> Vec<(Severity, String)> {
    let mut out = Vec::new();
    for s in stats {
        let surface = &cfg.surfaces[s.surface];
        if let Some(reason) = &s.allowed {
            if reason.is_empty() {
                out.push((
                    Severity::Error,
                    format!(
                        "[unexplained-opt-out] {} — `{}` with no reason; an unexplained \
                         opt-out is the failure mode it exists to prevent",
                        s.file,
                        cfg.escape.marker()
                    ),
                ));
            }
            continue;
        }

        if let Some(lines) = s.doc_lines {
            if let Some(tiers) = surface.doc_tiers() {
                if let Some((sev, cap)) = tiers.hit(|&n| lines >= n) {
                    out.push((
                        sev,
                        format!(
                            "[long-doc] {} — {lines} lines (threshold {cap}, surface {})",
                            s.file, surface.name
                        ),
                    ));
                }
            }
            continue;
        }

        if let Some(tiers) = &surface.run {
            for r in &s.runs {
                if let Some((sev, cap)) = tiers.hit(|&n| r.lines() >= n) {
                    out.push((
                        sev,
                        format!(
                            "[comment-run] {}:{}-{} — {} counted comment lines \
                             (threshold {cap}, surface {})",
                            s.file,
                            r.start,
                            r.end,
                            r.lines(),
                            surface.name
                        ),
                    ));
                }
            }
        }

        if let Some(tiers) = &surface.file {
            let hit = tiers.hit(|t| s.ratio() >= t.ratio && s.counted >= t.lines);
            if let Some((sev, t)) = hit {
                out.push((
                    sev,
                    format!(
                        "[comment-budget] {} — {:.0}% prose ({} comment lines against {} code; \
                         threshold {:.0}% at {}+ lines, surface {})",
                        s.file,
                        100.0 * s.ratio(),
                        s.counted,
                        s.code,
                        100.0 * t.ratio,
                        t.lines,
                        surface.name
                    ),
                ));
            }
        }
    }
    out
}

/// A file some kind can read that no surface claims. An error rather than a
/// quiet skip: under first-match-wins the failure mode of this whole design is
/// a tree nobody noticed was exempt, and that reads exactly like passing.
fn unclaimed_findings(unclaimed: &[String]) -> Vec<(Severity, String)> {
    unclaimed
        .iter()
        .map(|f| {
            (
                Severity::Error,
                format!(
                    "[unclaimed] {f} — no surface claims this file, so nothing measures it; \
                     add a path to a surface in {CONFIG_FILE}"
                ),
            )
        })
        .collect()
}

/// Each surface measured against its own target — the direction of travel that
/// a pass/fail count can't show.
fn report_surfaces(cfg: &Config, stats: &[FileStats]) {
    println!("\nsurface                 files    measured   target");
    for (i, surface) in cfg.surfaces.iter().enumerate() {
        let mine: Vec<&FileStats> = stats.iter().filter(|s| s.surface == i).collect();
        if mine.is_empty() {
            println!("{:<22} {:>6}    (no files match)", surface.name, 0);
            continue;
        }
        let (measured, target) = match surface.target {
            Some(Target::Lines { lines }) => {
                let avg = mine.iter().filter_map(|s| s.doc_lines).sum::<usize>() / mine.len();
                (format!("{avg} lines"), format!("{lines} lines"))
            }
            _ => {
                let counted: usize = mine.iter().map(|s| s.counted).sum();
                let code: usize = mine.iter().map(|s| s.code).sum();
                let pct = if counted + code == 0 {
                    0.0
                } else {
                    100.0 * counted as f64 / (counted + code) as f64
                };
                let target = match surface.target {
                    Some(Target::Ratio(r)) => format!("{:.0}%", 100.0 * r),
                    _ => "—".to_string(),
                };
                (format!("{pct:.1}%"), target)
            }
        };
        println!("{:<22} {:>6}  {:>10}  {:>7}", surface.name, mine.len(), measured, target);
        println!("  {}", surface.goal);
    }
}

fn repo_root() -> PathBuf {
    // xtask/ sits at the workspace root, so the parent of this crate is it.
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("xtask has a parent dir").to_path_buf()
}

fn measure(root: &Path, cfg: &Config) -> Result<(Vec<FileStats>, Vec<String>), String> {
    let mut files = Vec::new();
    collect_files(root, root, cfg, &mut files);
    files.sort();

    let mut parser = tree_sitter::Parser::new();
    let mut stats = Vec::new();
    let mut unclaimed = Vec::new();
    for (path, surface) in files {
        let Some(surface) = surface else {
            unclaimed.push(rel_path(root, &path));
            continue;
        };
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("could not read {}: {e}", path.display()))?;
        let rel = rel_path(root, &path);
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let kind = cfg.kind_for(&name).expect("collect_files only pushes claimed extensions");
        stats.push(match kind.grammar.language() {
            Some(lang) => {
                parser
                    .set_language(&lang)
                    .map_err(|e| format!("tree-sitter language mismatch for {rel}: {e}"))?;
                fold_file(&mut parser, cfg, kind, rel, surface, &content)?
            }
            None => FileStats {
                allowed: opt_out(cfg, content.lines().take_while(|l| !l.trim().is_empty())),
                file: rel,
                surface,
                doc_lines: Some(content.lines().count()),
                counted: 0,
                code: 0,
                runs: Vec::new(),
            },
        });
    }
    Ok((stats, unclaimed))
}

fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

/// Recurse `dir`, collecting every file a kind can read, paired with the surface
/// claiming it — `None` when none does, which is reported rather than skipped.
fn collect_files(root: &Path, dir: &Path, cfg: &Config, out: &mut Vec<(PathBuf, Option<usize>)>) {
    let Ok(entries) = fs::read_dir(dir) else {
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
        if path.is_dir() {
            collect_files(root, &path, cfg, out);
        } else if cfg.kind_for(&name).is_some() {
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

fn fold_file(
    parser: &mut tree_sitter::Parser,
    cfg: &Config,
    kind: &Kind,
    file: String,
    surface: usize,
    content: &str,
) -> Result<FileStats, String> {
    let tree =
        parser.parse(content, None).ok_or_else(|| format!("tree-sitter could not parse {file}"))?;
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
        let rows = if is_exempt(kind, text) { &mut exempt_rows } else { &mut counted_rows };
        rows.extend(start.row..=last_row);
    }

    let mut runs: Vec<Run> = Vec::new();
    for row in counted_rows.iter().copied() {
        match runs.last_mut() {
            // `end` is 1-based, so equality means `row` is the very next line.
            Some(cur) if cur.end == row => cur.end = row + 1,
            _ => runs.push(Run { start: row + 1, end: row + 1 }),
        }
    }

    let blank = lines.iter().filter(|l| l.trim().is_empty()).count();
    Ok(FileStats {
        allowed: opt_out(cfg, lines.iter().copied().take_while(|l| !l.trim().is_empty())),
        file,
        surface,
        doc_lines: None,
        counted: counted_rows.len(),
        code: lines.len() - blank - counted_rows.len() - exempt_rows.len(),
        runs,
    })
}

/// Whether a comment's own syntax exempts it. Longest prefix wins, so `//!`
/// beats the `//` that also matches it; a comment matching neither list counts,
/// so a syntax nobody listed can't slip through unmeasured.
fn is_exempt(kind: &Kind, text: &str) -> bool {
    let longest = |set: &[String]| {
        set.iter().filter(|p| text.starts_with(p.as_str())).map(String::len).max().unwrap_or(0)
    };
    longest(&kind.exempt) > longest(&kind.counted)
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
