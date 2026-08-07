//! The `comment-budget` CLI. Argument parsing and printing only; every decision
//! it reports comes from the library.

use std::path::PathBuf;
use std::process::ExitCode;

use comment_budget::report::{self, Paint};
use comment_budget::{
    CommentBudgetError, Config, DEFAULT_BASE, Diff, Finding, Severity, Since, analyze,
    dead_glob_findings, judge, unclaimed_findings,
};

const USAGE: &str = "comment-budget — a budget for comment volume, for a codebase an AI writes most
of. A model writes comments faster than anyone can review them and keeps adding
until nobody can read the file; this caps how much commentary a reader wades
through to reach the code. It measures how much comment there is, never what it
says.

usage: comment-budget [--all] [--report] [--surface <name>] [--format <fmt>]
                      [--new-from-merge-base [<ref>] | --new-from-rev <ref>]
                      [--whole-files] [--root <dir>] [--config <file>]
       comment-budget init [--root <dir>]

  (no flags)                    only the lines this branch adds over `main` — the gate
  init                          write a starter comment-budget.toml, budgets seeded
                                from the tree's own p75 (warn) / p90 (error)
  --report                      the thresholds in effect, the surface table and the
                                worst files, no finding list
  --surface <name>              restrict to one surface, for a session spent fixing it
  --format text|json            json prints the findings as an array, for CI to consume

  --new-from-merge-base [<ref>] change the branch the default compares against
  --new-from-rev <ref>          compare against <ref> itself rather than a
                                merge-base (`HEAD~1`, a tag, a sha)
  --whole-files                 judge each touched file whole, not only its added lines
  --all                         every file in the repo — the standing backlog, not a gate

  --root <dir>                  measure this tree (default: search upward from cwd)
  --config <file>               use this config instead of the discovered one

The new-from flag names are golangci-lint's, which is where this idea is best
known from. Every mode includes uncommitted work, so a local run judges what you
are about to push, not only what you have committed.";

const FLAGS: [&str; 9] = [
    "--all",
    "--report",
    "--surface",
    "--format",
    "--new-from-merge-base",
    "--new-from-rev",
    "--whole-files",
    "--root",
    "--config",
];

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if args.first().is_some_and(|a| a == "init") {
        return match run_init(&args[1..]) {
            Ok(msg) => {
                println!("{msg}");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("{e}");
                ExitCode::from(2)
            }
        };
    }
    match Args::parse(&args) {
        Ok(parsed) => match run(parsed) {
            Ok(code) => code,
            Err(e) => {
                eprintln!("{e}");
                ExitCode::from(2)
            }
        },
        Err(e) => {
            eprintln!("{e}\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

struct Args {
    report_only: bool,
    whole_files: bool,
    json: bool,
    only: Option<String>,
    since: Option<Since>,
    root: Option<PathBuf>,
    config: Option<PathBuf>,
}

impl Args {
    fn parse(args: &[String]) -> Result<Self, String> {
        check_flags(args)?;
        let value = |flag: &str| {
            args.iter()
                .position(|a| a == flag)
                .map(|i| args.get(i + 1).filter(|a| !a.starts_with("--")).map(String::as_str))
        };
        let required = |flag: &str| match value(flag) {
            Some(None) => Err(format!("{flag} needs a value")),
            other => Ok(other.flatten()),
        };
        let whole_files = args.iter().any(|a| a == "--whole-files");
        let json = match required("--format")? {
            None | Some("text") => false,
            Some("json") => true,
            Some(other) => return Err(format!("unknown format `{other}`; use text or json")),
        };
        let since = parse_since(args, &value)?;
        if whole_files && since.is_none() {
            return Err("--whole-files and --all are exclusive".into());
        }
        Ok(Args {
            report_only: args.iter().any(|a| a == "--report"),
            whole_files,
            json,
            only: required("--surface")?.map(str::to_string),
            since,
            root: required("--root")?.map(PathBuf::from),
            config: required("--config")?.map(PathBuf::from),
        })
    }
}

/// `None` only for `--all`. Comparing against a base is the default because the
/// repo-wide list is a backlog, not a gate: on any established repo it stands at
/// hundreds of errors, and a gate that fails every run is one nobody reads.
fn parse_since<'a>(
    args: &[String],
    value: &impl Fn(&str) -> Option<Option<&'a str>>,
) -> Result<Option<Since>, String> {
    let all = args.iter().any(|a| a == "--all");
    if all && args.iter().any(|a| a.starts_with("--new-from")) {
        return Err("--all and --new-from-* are exclusive".into());
    }
    match (value("--new-from-merge-base"), value("--new-from-rev")) {
        (Some(_), Some(_)) => Err("--new-from-merge-base and --new-from-rev are exclusive".into()),
        (None, Some(None)) => Err("--new-from-rev needs a revision".into()),
        (None, Some(Some(r))) => Ok(Some(Since::Rev(r.to_string()))),
        (Some(r), None) => Ok(Some(Since::MergeBase(r.unwrap_or(DEFAULT_BASE).to_string()))),
        (None, None) if all => Ok(None),
        (None, None) => Ok(Some(Since::MergeBase(DEFAULT_BASE.to_string()))),
    }
}

/// Reject a flag nobody reads. Silently ignoring one is how a typo'd
/// `--new-from-merge-base` passes CI against the default base instead: the run
/// looks healthy and measures the wrong thing.
fn check_flags(args: &[String]) -> Result<(), String> {
    // A flag's own value is the argument after it, and is not itself a flag.
    // Matched by position, not by text: `--surface web web` must still reject the
    // stray second `web` rather than let it pass because the first one is a value.
    for (i, arg) in args.iter().enumerate() {
        let is_value = i.checked_sub(1).and_then(|p| args.get(p)).is_some_and(|p| takes_value(p));
        if !is_value && !FLAGS.contains(&arg.as_str()) {
            return Err(format!("unknown argument `{arg}`"));
        }
    }
    Ok(())
}

fn run_init(rest: &[String]) -> Result<String, String> {
    let root = match rest {
        [] => std::env::current_dir().map_err(|e| e.to_string())?,
        [flag, dir] if flag == "--root" => PathBuf::from(dir),
        _ => return Err("init takes only --root <dir>".into()),
    };
    comment_budget::init::init(&root).map_err(|e| e.to_string())
}

fn takes_value(flag: &str) -> bool {
    matches!(
        flag,
        "--surface"
            | "--format"
            | "--new-from-merge-base"
            | "--new-from-rev"
            | "--root"
            | "--config"
    )
}

fn run(args: Args) -> Result<ExitCode, CommentBudgetError> {
    // JSON goes to a consumer, so it never carries escape codes.
    let paint = if args.json { Paint::PLAIN } else { Paint::resolve() };
    let start = match &args.root {
        Some(dir) => dir.clone(),
        None => std::env::current_dir().map_err(CommentBudgetError::CurrentDir)?,
    };
    let (cfg, root) = match &args.config {
        Some(path) => (Config::load(path)?, args.root.clone().unwrap_or(start)),
        None => Config::discover(&start)?,
    };

    let diff = args.since.as_ref().map(|s| Diff::open(&root, s, args.whole_files)).transpose()?;
    let analysis = analyze(&root, &cfg, diff.as_ref())?;

    if let Some(name) = &args.only
        && !cfg.surfaces.iter().any(|s| &s.name == name)
    {
        return Err(CommentBudgetError::Config {
            path: root.join(comment_budget::CONFIG_FILE),
            message: format!("no surface named `{name}`. Known: {}", cfg.surface_names()),
        });
    }
    let picked = |i: usize| args.only.as_ref().is_none_or(|n| &cfg.surfaces[i].name == n);
    let stats: Vec<_> = analysis.stats.into_iter().filter(|s| picked(s.surface)).collect();

    let mut findings = judge(&cfg, &stats);
    findings.extend(
        dead_glob_findings(&cfg, &analysis.dead_globs)
            .into_iter()
            .filter(|f| args.only.as_ref().is_none_or(|n| f.surface.as_deref() == Some(n))),
    );
    if args.only.is_none() {
        findings.extend(unclaimed_findings(&analysis.unclaimed));
    }
    let errors = findings.iter().filter(|f| f.severity == Severity::Error).count();

    if args.json {
        println!("{}", serde_json::to_string_pretty(&findings).expect("findings are plain data"));
        return Ok(exit_code(errors));
    }

    if !args.report_only {
        print_findings(&findings, &paint);
    }
    print!("{}", report::surfaces(&cfg, &stats, args.only.as_deref(), &paint));
    if args.report_only {
        print!("{}", report::rules(&cfg, args.only.as_deref(), &paint));
        print!("{}", report::worst(&cfg, &stats, args.only.as_deref(), &paint));
    }
    println!();
    if let Some(since) = &args.since {
        println!("{}{}{}", paint.dim, since.describe(args.whole_files), paint.off);
    }
    println!(
        "comment-budget: {} file(s), {errors} error(s), {} warning(s)",
        stats.len(),
        findings.len() - errors
    );
    if args.report_only && !findings.is_empty() {
        println!("Run without --report for the {} finding(s) in full.", findings.len());
    }
    if !findings.is_empty() {
        println!("\n{}", report::HOW_TO_FIX);
    }
    Ok(exit_code(errors))
}

fn print_findings(findings: &[Finding], paint: &Paint) {
    for f in findings {
        let hue = match f.severity {
            Severity::Error => paint.over,
            Severity::Warning => paint.warn,
        };
        println!("{hue}{}{} {f}", f.severity.as_str(), paint.off);
    }
}

fn exit_code(errors: usize) -> ExitCode {
    if errors > 0 { ExitCode::FAILURE } else { ExitCode::SUCCESS }
}
