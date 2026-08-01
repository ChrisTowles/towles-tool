//! `comment-budget`, the gate on comment volume — nothing else measures it (oxlint
//! implements no such rule at all, skipping stylistic rules by design). One question:
//! how much prose must a reader wade through to reach the code, as
//! `comment / (comment + code)`, plus an over-long run of it and an over-long `.md`.
//! Warnings are the standing hit list; errors fail the run. What is measured, how
//! hard, and why each surface sits where it does all live in `comment-budget.toml`.
//!
//! **The default judges only the lines a branch adds**; `--all` is the repo-wide
//! backlog, and the budgets are not the thing to lower. A *run* is the exception:
//! measured whole, reported if it touches an added line, because a reader wades
//! through all of it however much of it you wrote.
//!
//! The diff comes from `gix` and compares the *working tree* to the base, so a
//! local run judges what you are about to push, not only what you committed.

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
/// signal — neither comment nor code — but only for the first `exempt_free`
/// lines of a file; see [`spill_exempt_overflow`] for why that cap exists.
#[derive(serde::Deserialize)]
struct Kind {
    grammar: Grammar,
    extensions: Vec<String>,
    #[serde(default)]
    exempt: Vec<String>,
    /// Exempt lines a file gets for free. `None` leaves them uncapped, which is
    /// only safe for a kind that exempts nothing.
    #[serde(default)]
    exempt_free: Option<usize>,
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
    /// Whether the counts above cover only the lines a `--new-from-*` run added,
    /// which the findings have to say out loud — the same percentage means a
    /// different thing.
    scoped: bool,
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

/// SGR codes, or empty strings when the output isn't a terminal a human is
/// reading — a redirect to a file and `NO_COLOR` both mean plain text. Resolved
/// once at startup rather than per-line so a piped run can't emit half of each.
struct Paint {
    dim: &'static str,
    bold: &'static str,
    over: &'static str,
    warn: &'static str,
    name: &'static str,
    off: &'static str,
}

impl Paint {
    fn resolve() -> Self {
        use std::io::IsTerminal;
        if env::var_os("NO_COLOR").is_some() || !std::io::stdout().is_terminal() {
            return Paint { dim: "", bold: "", over: "", warn: "", name: "", off: "" };
        }
        Paint {
            dim: "\x1b[2m",
            bold: "\x1b[1m",
            // Red for over-target and errors, yellow for warnings, cyan for the
            // names you scan by — the terminal's own palette, so it stays legible
            // against whatever theme the user actually runs.
            over: "\x1b[31m",
            warn: "\x1b[33m",
            name: "\x1b[36m",
            off: "\x1b[0m",
        }
    }
}

const USAGE: &str = "usage: cargo xtask comment-budget [--all] [--report] [--surface <name>]
                                  [--new-from-merge-base [<ref>] | --new-from-rev <ref>]
                                  [--whole-files]

  (no flags)                    only the lines this branch adds over `main` — the gate
  --report                      the surface table and the worst files, no finding list
  --surface <name>              restrict to one surface, for a session spent fixing it

  --new-from-merge-base [<ref>] change the branch the default compares against
  --new-from-rev <ref>          compare against <ref> itself rather than a
                                merge-base (`HEAD~1`, a tag, a sha)
  --whole-files                 judge each touched file whole, not only its added lines
  --all                         every file in the repo — the standing backlog, not a gate

The new-from flag names are golangci-lint's, which is where this idea is best
known from. Every mode includes uncommitted work, so a local run judges what you
are about to push, not only what you have committed.";

/// The branch a run compares against unless told otherwise. Resolved as
/// `origin/main` too, since a CI checkout often has only the remote ref.
const DEFAULT_BASE: &str = "main";

pub fn run(args: &[String]) -> ExitCode {
    if let Err(e) = check_flags(args) {
        eprintln!("{e}\n{USAGE}");
        return ExitCode::from(2);
    }
    let report_only = args.iter().any(|a| a == "--report");
    let whole_files = args.iter().any(|a| a == "--whole-files");
    let only = match args.iter().position(|a| a == "--surface") {
        Some(i) => match args.get(i + 1) {
            Some(name) => Some(name.clone()),
            None => {
                eprintln!("--surface needs a name\n{USAGE}");
                return ExitCode::from(2);
            }
        },
        None => None,
    };
    let since = match Since::parse(args) {
        Ok(since) => since,
        Err(e) => {
            eprintln!("{e}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    if whole_files && since.is_none() {
        eprintln!("--whole-files and --all are exclusive\n{USAGE}");
        return ExitCode::from(2);
    }
    let paint = Paint::resolve();
    let root = repo_root();
    let scope = since.as_ref().map(|s| s.describe(whole_files));
    let run = Config::load(&root).and_then(|cfg| {
        let diff = since.map(|s| Diff::open(&root, &s, whole_files)).transpose()?;
        let (stats, unclaimed) = measure(&root, &cfg, diff.as_ref())?;
        Ok((cfg, stats, unclaimed))
    });
    let (cfg, stats, unclaimed) = match run {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };

    if let Some(name) = &only {
        if !cfg.surfaces.iter().any(|s| &s.name == name) {
            eprintln!("no surface named `{name}`. Known: {}", surface_names(&cfg));
            return ExitCode::from(2);
        }
    }
    let picked = |i: usize| only.as_ref().is_none_or(|n| &cfg.surfaces[i].name == n);
    let stats: Vec<FileStats> = stats.into_iter().filter(|s| picked(s.surface)).collect();

    let mut findings = judge(&cfg, &stats);
    if only.is_none() {
        findings.extend(unclaimed_findings(&unclaimed));
    }
    if !report_only {
        for (sev, msg) in &findings {
            let (label, hue) = match sev {
                Severity::Error => ("error", paint.over),
                Severity::Warning => ("warning", paint.warn),
            };
            println!("{hue}{label}{}{msg}", paint.off);
        }
    }
    let errors = findings.iter().filter(|(s, _)| matches!(s, Severity::Error)).count();

    report_surfaces(&cfg, &stats, only.as_deref(), &paint);
    if report_only {
        report_worst(&cfg, &stats, only.as_deref(), &paint);
    }
    println!();
    if let Some(scope) = &scope {
        println!("{}{scope}{}", paint.dim, paint.off);
    }
    println!(
        "comment-budget: {} file(s), {errors} error(s), {} warning(s)",
        stats.len(),
        findings.len() - errors
    );
    if report_only && !findings.is_empty() {
        println!("Run without --report for the {} finding(s) in full.", findings.len());
    }
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

/// Reject a flag nobody reads. Silently ignoring one is how a typo'd
/// `--new-from-merge-base` passes CI against the default base instead: the run
/// looks healthy and measures the wrong thing.
fn check_flags(args: &[String]) -> Result<(), String> {
    const FLAGS: [&str; 6] = [
        "--all",
        "--report",
        "--surface",
        "--new-from-merge-base",
        "--new-from-rev",
        "--whole-files",
    ];
    // A flag's own value is the argument after it, and is not itself a flag.
    let values: Vec<&str> = args
        .iter()
        .enumerate()
        .filter(|(i, _)| i.checked_sub(1).and_then(|p| args.get(p)).is_some_and(|p| takes_value(p)))
        .map(|(_, a)| a.as_str())
        .collect();
    for arg in args {
        if !FLAGS.contains(&arg.as_str()) && !values.contains(&arg.as_str()) {
            return Err(format!("unknown argument `{arg}`"));
        }
    }
    Ok(())
}

fn takes_value(flag: &str) -> bool {
    matches!(flag, "--surface" | "--new-from-merge-base" | "--new-from-rev")
}

/// What a run compares against. Merge-base is the PR question — "what did this
/// branch add" — and survives the base branch moving underneath it; a plain rev
/// is for `HEAD~1` and other hand-picked comparisons.
enum Since {
    MergeBase(String),
    Rev(String),
}

impl Since {
    /// `None` only for `--all`. Comparing against a base is the default because
    /// the repo-wide list is a backlog, not a gate: it stands at hundreds of
    /// errors, and a gate that fails every run is one nobody reads.
    fn parse(args: &[String]) -> Result<Option<Self>, String> {
        let value = |flag: &str| {
            args.iter()
                .position(|a| a == flag)
                .map(|i| args.get(i + 1).filter(|a| !a.starts_with("--")).map(String::as_str))
        };
        let all = args.iter().any(|a| a == "--all");
        match (value("--new-from-merge-base"), value("--new-from-rev")) {
            _ if all && args.iter().any(|a| a.starts_with("--new-from")) => {
                Err("--all and --new-from-* are exclusive".into())
            }
            (Some(_), Some(_)) => {
                Err("--new-from-merge-base and --new-from-rev are exclusive".into())
            }
            (None, Some(None)) => Err("--new-from-rev needs a revision".into()),
            (None, Some(Some(r))) => Ok(Some(Since::Rev(r.to_string()))),
            (Some(r), None) => Ok(Some(Since::MergeBase(r.unwrap_or(DEFAULT_BASE).to_string()))),
            (None, None) if all => Ok(None),
            (None, None) => Ok(Some(Since::MergeBase(DEFAULT_BASE.to_string()))),
        }
    }

    fn describe(&self, whole_files: bool) -> String {
        let what = if whole_files { "whole files touched" } else { "lines added" };
        match self {
            Since::MergeBase(r) => format!("scope: {what} since the merge-base with `{r}`"),
            Since::Rev(r) => format!("scope: {what} since `{r}`"),
        }
    }
}

/// The whole of any file: what a new file adds, and what `--whole-files`
/// widens every touched file to.
const ALL: (usize, usize) = (1, usize::MAX);

/// Which lines a `--new-from-*` run may judge, answered per file against the
/// base tree. Asking per file rather than enumerating a diff up front is what
/// lets this compare the **working tree** to the base — committed and
/// uncommitted work alike, so a local run judges what is about to be pushed —
/// and it makes an untracked file fall out as "every line added" for free.
struct Diff {
    repo: gix::Repository,
    tree: gix::ObjectId,
    whole_files: bool,
}

impl Diff {
    fn open(root: &Path, since: &Since, whole_files: bool) -> Result<Self, String> {
        let repo = gix::open(root).map_err(|e| format!("could not open the repository: {e}"))?;
        // A CI checkout is detached with no local branch refs, so the base a PR
        // names only ever exists as the remote one.
        let rev = |spec: &str| {
            repo.rev_parse_single(spec)
                .or_else(|_| repo.rev_parse_single(format!("origin/{spec}").as_str()))
                .map(|id| id.detach())
                .map_err(|_| format!("no such revision `{spec}` (nor `origin/{spec}`)"))
        };
        let id = match since {
            Since::Rev(r) => rev(r)?,
            Since::MergeBase(r) => {
                let head = rev("HEAD")?;
                repo.merge_base(rev(r)?, head)
                    .map_err(|e| format!("no merge-base with `{r}`: {e}"))?
                    .detach()
            }
        };
        let tree = repo
            .find_object(id)
            .map_err(|e| format!("could not read the base commit: {e}"))?
            .peel_to_tree()
            .map_err(|e| format!("could not read the base tree: {e}"))?
            .id;
        Ok(Diff { repo, tree, whole_files })
    }

    /// The 1-based inclusive line ranges `content` adds over the base, or `None`
    /// when this file is out of scope — unchanged, or changed only by deletions,
    /// which add no line to judge.
    fn scope_of(&self, rel: &str, content: &str) -> Result<Option<Vec<(usize, usize)>>, String> {
        let before = self.blob(rel);
        let after = content.as_bytes();
        if before.as_deref() == Some(after) {
            return Ok(None);
        }
        let Some(before) = before.filter(|_| !self.whole_files) else {
            return Ok(Some(vec![ALL]));
        };
        let input = gix::diff::blob::InternedInput::new(before.as_slice(), after);
        let diff = gix::diff::blob::diff_with_slider_heuristics(DIFF_ALGORITHM, &input);
        // `Hunk::after` is a half-open range of 0-based line indices on the new
        // side, so its exclusive end is already the 1-based inclusive last line.
        let ranges: Vec<(usize, usize)> = diff
            .hunks()
            .filter(|h| !h.after.is_empty())
            .map(|h| (h.after.start as usize + 1, h.after.end as usize))
            .collect();
        Ok((!ranges.is_empty()).then_some(ranges))
    }

    fn blob(&self, rel: &str) -> Option<Vec<u8>> {
        let tree = self.repo.find_object(self.tree).ok()?.peel_to_tree().ok()?;
        let entry = tree.lookup_entry_by_path(rel).ok().flatten()?;
        entry.object().ok()?.try_into_blob().ok().map(|blob| blob.data.clone())
    }
}

/// Matches `tt_git::repo`'s, so a line this calls added is one the app's diff
/// pane would show added.
const DIFF_ALGORITHM: gix::diff::blob::Algorithm = gix::diff::blob::Algorithm::Myers;

/// Whether a 1-based line is one this run may judge. `None` ranges mean the
/// whole file, which is what a run with no `--new-from-*` measures.
fn in_scope(ranges: Option<&[(usize, usize)]>, line: usize) -> bool {
    ranges.is_none_or(|rs| rs.iter().any(|&(a, b)| line >= a && line <= b))
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
                    let what = if s.scoped { "lines added" } else { "lines" };
                    out.push((
                        sev,
                        format!(
                            "[long-doc] {} — {lines} {what} (threshold {cap}, surface {})",
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
                let what = if s.scoped { "% of added lines are prose" } else { "% prose" };
                out.push((
                    sev,
                    format!(
                        "[comment-budget] {} — {:.0}{what} ({} comment lines against {} code; \
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

fn surface_names(cfg: &Config) -> String {
    cfg.surfaces.iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(", ")
}

/// How many comment lines a file would have to lose to reach its surface's
/// target — the thing that actually orders a cleanup, since a 90%-prose file of
/// 20 lines costs nothing to fix and a 40% one of 800 lines is a week.
fn overshoot(s: &FileStats, target: f64) -> usize {
    let keep = (target / (1.0 - target) * s.code as f64).floor() as usize;
    s.counted.saturating_sub(keep)
}

/// The files whose cleanup moves the number most, per surface. Ranked by lines
/// over target rather than by ratio, so the list is a work queue.
fn report_worst(cfg: &Config, stats: &[FileStats], only: Option<&str>, paint: &Paint) {
    for (i, surface) in cfg.surfaces.iter().enumerate() {
        if only.is_some_and(|n| n != surface.name) {
            continue;
        }
        let Some(Target::Ratio(target)) = surface.target else {
            continue;
        };
        let mut mine: Vec<&FileStats> = stats.iter().filter(|s| s.surface == i).collect();
        mine.sort_by_key(|s| std::cmp::Reverse(overshoot(s, target)));
        let worth = mine.iter().take(8).filter(|s| overshoot(s, target) > 0).collect::<Vec<_>>();
        if worth.is_empty() {
            continue;
        }
        println!(
            "\n{}{}{} {}— worst files (over-target lines, {:.0}% target){}",
            paint.bold,
            surface.name,
            paint.off,
            paint.dim,
            100.0 * target,
            paint.off,
        );
        for s in worth {
            println!(
                "  {}{:>5} over{}   {}{:>3.0}%{}   {}",
                paint.over,
                overshoot(s, target),
                paint.off,
                paint.dim,
                100.0 * s.ratio(),
                paint.off,
                s.file,
            );
        }
    }
}

/// Each surface measured against its own target — the direction of travel that
/// a pass/fail count can't show.
fn report_surfaces(cfg: &Config, stats: &[FileStats], only: Option<&str>, paint: &Paint) {
    println!(
        "{}\nsurface                 files    measured   target      over{}",
        paint.dim, paint.off
    );
    for (i, surface) in cfg.surfaces.iter().enumerate() {
        if only.is_some_and(|n| n != surface.name) {
            continue;
        }
        let mine: Vec<&FileStats> = stats.iter().filter(|s| s.surface == i).collect();
        if mine.is_empty() {
            println!("{:<22} {:>6}    (no files match)", surface.name, 0);
            continue;
        }
        let (measured, target, over, past_target) = match surface.target {
            Some(Target::Lines { lines }) => {
                let avg = mine.iter().filter_map(|s| s.doc_lines).sum::<usize>() / mine.len();
                let over: usize =
                    mine.iter().filter_map(|s| s.doc_lines).map(|n| n.saturating_sub(lines)).sum();
                (format!("{avg} lines"), format!("{lines} lines"), over, avg >= lines)
            }
            _ => {
                let counted: usize = mine.iter().map(|s| s.counted).sum();
                let code: usize = mine.iter().map(|s| s.code).sum();
                let pct = if counted + code == 0 {
                    0.0
                } else {
                    100.0 * counted as f64 / (counted + code) as f64
                };
                let (target, over) = match surface.target {
                    Some(Target::Ratio(r)) => (
                        format!("{:.0}%", 100.0 * r),
                        mine.iter().map(|s| overshoot(s, r)).sum::<usize>(),
                    ),
                    _ => ("—".to_string(), 0),
                };
                let past = matches!(surface.target, Some(Target::Ratio(r)) if pct >= 100.0 * r);
                (format!("{pct:.1}%"), target, over, past)
            }
        };
        // The measured figure and the backlog are judged separately: an average
        // can sit under target while a long tail still owes lines, which is
        // exactly the markdown surface's shape.
        let hue = if past_target { paint.over } else { "" };
        let over_hue = if over > 0 { paint.over } else { "" };
        println!(
            "{}{:<22}{} {:>6}  {hue}{:>10}{}  {:>7}  {over_hue}{:>8}{}",
            paint.name,
            surface.name,
            paint.off,
            mine.len(),
            measured,
            paint.off,
            target,
            format!("{over} lines"),
            paint.off,
        );
        println!("{}  {}{}", paint.dim, surface.goal, paint.off);
    }
}

fn repo_root() -> PathBuf {
    // xtask/ sits at the workspace root, so the parent of this crate is it.
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("xtask has a parent dir").to_path_buf()
}

fn measure(
    root: &Path,
    cfg: &Config,
    diff: Option<&Diff>,
) -> Result<(Vec<FileStats>, Vec<String>), String> {
    let mut files = Vec::new();
    collect_files(root, root, cfg, &mut files);
    files.sort();

    let mut parser = tree_sitter::Parser::new();
    let mut stats = Vec::new();
    let mut unclaimed = Vec::new();
    for (path, surface) in files {
        let rel = rel_path(root, &path);
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("could not read {}: {e}", path.display()))?;
        // Out of scope entirely: a file this run didn't touch is neither measured
        // nor reported unclaimed, since adding it to a surface isn't its business.
        let scope = match diff {
            Some(d) => match d.scope_of(&rel, &content)? {
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
                parser
                    .set_language(&lang)
                    .map_err(|e| format!("tree-sitter language mismatch for {rel}: {e}"))?;
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
        // A blank line inside a block comment is nothing to wade through, and
        // counting it as both blank and comment used to make `code` underflow.
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
fn spill_exempt_overflow(
    kind: &Kind,
    exempt_rows: &mut BTreeSet<usize>,
    counted_rows: &mut BTreeSet<usize>,
) {
    let Some(free) = kind.exempt_free else {
        return;
    };
    // BTreeSet iterates ascending, so this keeps the top-of-file header and
    // spills what trails it — the direction prose grows.
    let overflow: Vec<usize> = exempt_rows.iter().copied().skip(free).collect();
    for row in overflow {
        exempt_rows.remove(&row);
        counted_rows.insert(row);
    }
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

#[cfg(test)]
mod tests {
    use super::{spill_exempt_overflow, Kind};
    use std::collections::BTreeSet;

    fn rust_kind(exempt_free: Option<usize>) -> Kind {
        Kind {
            grammar: super::Grammar::Rust,
            extensions: vec!["rs".into()],
            exempt: vec!["//!".into()],
            exempt_free,
            counted: vec!["///".into(), "//".into()],
        }
    }

    fn spill(free: Option<usize>, exempt: &[usize]) -> (Vec<usize>, Vec<usize>) {
        let mut exempt_rows: BTreeSet<usize> = exempt.iter().copied().collect();
        let mut counted_rows = BTreeSet::new();
        spill_exempt_overflow(&rust_kind(free), &mut exempt_rows, &mut counted_rows);
        (exempt_rows.into_iter().collect(), counted_rows.into_iter().collect())
    }

    #[test]
    fn header_within_the_allowance_stays_invisible() {
        let (exempt, counted) = spill(Some(12), &[0, 1, 2, 3]);
        assert_eq!(exempt, vec![0, 1, 2, 3]);
        assert!(counted.is_empty(), "a short header costs nothing");
    }

    /// The whole point: prose moved from `///` into `//!` has to stop paying off
    /// past the allowance, or the linter rewards relocating bloat over cutting it.
    #[test]
    fn overflow_past_the_allowance_counts_like_any_other_comment() {
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
