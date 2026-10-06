//! `comment-budget`: a zero-config ratchet on comment volume. The policy is
//! [`rule`]; this file is arguments, the walk, and printing.

mod git;
mod measure;
mod rule;

use std::process::ExitCode;

use rule::{BUDGET_PERCENT, FLOOR, Failure, GROWTH, RUN};

const USAGE: &str = "comment-budget — a ratchet on comment volume. No config file.

usage: comment-budget [<base>]    judge what changed since the merge-base with <base>
       comment-budget --all       judge every file as if it were new: the backlog

<base> defaults to $GITHUB_BASE_REF, else `main`. The comparison includes
uncommitted and untracked work, so a local run judges what you are about to push.";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = match args.as_slice() {
        [h] if h == "-h" || h == "--help" => {
            println!("{USAGE}\n\n{}", rule_text());
            return ExitCode::SUCCESS;
        }
        [v] if v == "-V" || v == "--version" => {
            println!("comment-budget {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        [all] if all == "--all" => None,
        [rev] if !rev.starts_with('-') => Some(rev.clone()),
        [] => Some(default_base()),
        _ => {
            eprintln!("unexpected arguments: {}\n\n{USAGE}", args.join(" "));
            return ExitCode::from(2);
        }
    };
    match run(mode.as_deref()) {
        Ok(failed) if failed => ExitCode::FAILURE,
        Ok(_) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("comment-budget: {e}");
            ExitCode::from(2)
        }
    }
}

fn default_base() -> String {
    std::env::var("GITHUB_BASE_REF").ok().filter(|b| !b.is_empty()).unwrap_or("main".into())
}

fn rule_text() -> String {
    format!(
        "A touched file fails when this change grew its comment excess (comment lines past \
         a {BUDGET_PERCENT}% share) by {GROWTH}+ lines and it ends more than {FLOOR} over, or \
         when it adds an unbroken comment block of {RUN}+ lines or grows an existing one by \
         {GROWTH}+. A new file starts from 0. \
         Opt a file out with `comment-budget: allow(<reason>)` in its header."
    )
}

fn run(base_rev: Option<&str>) -> Result<bool, String> {
    let cwd = std::env::current_dir().map_err(|e| format!("current directory: {e}"))?;
    let repo = git::Repo::discover(&cwd)?;
    let root = repo.workdir();
    let base = base_rev.map(|rev| repo.base(rev)).transpose()?;

    let (mut judged, mut failures) = (0, 0);
    for rel in repo.candidates()? {
        let Ok(bytes) = std::fs::read(root.join(&rel)) else {
            continue;
        };
        let Ok(head) = String::from_utf8(bytes) else {
            continue;
        };
        let lang = measure::Lang::for_path(&rel).expect("candidates are all readable");
        let before = match &base {
            None => None,
            Some(base) => {
                // Unchanged, or moved without an edit: nothing this change wrote.
                if repo.hash(head.as_bytes()).is_some_and(|id| base.has(&id)) {
                    continue;
                }
                base.path(&rel).and_then(|id| repo.blob(id))
            }
        };
        judged += 1;
        for failure in rule::judge(lang, before.as_deref(), &head) {
            failures += 1;
            let locus = match failure {
                Failure::Run { start, end } => format!("{rel}:{start}-{end}"),
                _ => rel.clone(),
            };
            println!("error {locus}: {failure}");
        }
    }

    let scope = match base_rev {
        Some(rev) => format!("changed since the merge-base with `{rev}`"),
        None => "in the repository".to_string(),
    };
    println!("comment-budget: {judged} file(s) {scope}, {failures} failure(s)");
    if failures > 0 {
        println!("\n{}\nFix by deleting comment, not by reflowing it.", rule_text());
    }
    Ok(failures > 0)
}
