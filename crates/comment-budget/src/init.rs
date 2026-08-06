//! `comment-budget init`: a starter config seeded from the tree it will govern.
//!
//! The blank page is the adoption wall — nobody new to the tool knows what a
//! defensible budget is. So the seed is measured rather than guessed: each
//! code surface's budget sits at the 75th percentile of the tree's own file
//! ratios, prose lengths at p75/p90, and the generated file says so, inviting
//! tightening rather than faith.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::Path;

use crate::config::Config;
use crate::measure::FileStats;
use crate::{CONFIG_FILE, CommentBudgetError};

const SKIP: [&str; 3] = ["node_modules", "target", "dist"];

struct Lang {
    kind: &'static str,
    grammar: &'static str,
    extensions: &'static [&'static str],
    counted: &'static [&'static str],
    goal: &'static str,
}

const LANGS: [Lang; 5] = [
    Lang {
        kind: "rust",
        grammar: "rust",
        extensions: &["rs"],
        counted: &["///", "//"],
        goal: "Comment the surprise, never the signature.",
    },
    Lang {
        kind: "typescript",
        grammar: "typescript",
        extensions: &["ts", "js", "mjs", "cjs"],
        counted: &["//", "/*", "/**"],
        goal: "Types are the documentation; prose only for what they cannot say.",
    },
    Lang {
        kind: "tsx",
        grammar: "tsx",
        extensions: &["tsx"],
        counted: &["//", "/*", "/**"],
        goal: "JSX describes itself; a file-top block only for a non-obvious rule.",
    },
    Lang {
        kind: "terraform",
        grammar: "hcl",
        extensions: &["tf"],
        counted: &["#", "//", "/*"],
        goal: "Say why the resource is shaped this way, not what it is.",
    },
    Lang {
        kind: "markdown",
        grammar: "prose",
        extensions: &["md"],
        counted: &[],
        goal: "Prose has no code to sit against, so length is the only signal it offers.",
    },
];

enum Seed {
    Ratio { budget: f64 },
    Length { warn: usize, error: usize },
}

impl Seed {
    fn default_for(lang: &Lang) -> Seed {
        match lang.grammar {
            "prose" => Seed::Length { warn: 150, error: 250 },
            _ => Seed::Ratio { budget: 0.15 },
        }
    }
}

pub fn init(root: &Path) -> Result<String, CommentBudgetError> {
    let target = root.join(CONFIG_FILE);
    if target.exists() {
        return Err(CommentBudgetError::Config {
            path: target,
            message: "already exists; delete it to re-init".into(),
        });
    }
    let mut seen = BTreeSet::new();
    scan(root, &mut seen);
    let langs: Vec<&Lang> =
        LANGS.iter().filter(|l| l.extensions.iter().any(|e| seen.contains(*e))).collect();
    if langs.is_empty() {
        return Err(CommentBudgetError::Config {
            path: target,
            message: format!(
                "nothing to measure under {} — no files with a known extension",
                root.display()
            ),
        });
    }

    // Measure with placeholder tiers first; the real numbers come from the tree.
    let provisional = render(&langs, &seen, &BTreeMap::new());
    let cfg = Config::parse(&provisional, &target)?;
    let analysis = crate::analyze(root, &cfg, None)?;
    let mut seeds = BTreeMap::new();
    for (i, lang) in langs.iter().enumerate() {
        let mine: Vec<&FileStats> = analysis.stats.iter().filter(|s| s.surface == i).collect();
        seeds.insert(lang.kind, seed(lang, &mine));
    }

    let text = render(&langs, &seen, &seeds);
    Config::parse(&text, &target)?;
    std::fs::write(&target, &text)
        .map_err(|source| CommentBudgetError::Write { path: target.clone(), source })?;
    Ok(format!(
        "wrote {CONFIG_FILE} — {} kind(s), {} file(s) measured; budgets seeded at this tree's \
         own 75th percentile. Tighten deliberately; run `comment-budget --all` to see where \
         you stand.",
        langs.len(),
        analysis.stats.len(),
    ))
}

fn scan(dir: &Path, seen: &mut BTreeSet<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || SKIP.contains(&name.as_ref()) {
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            scan(&entry.path(), seen);
        } else if kind.is_file()
            && let Some((_, ext)) = name.rsplit_once('.')
        {
            seen.insert(ext.to_string());
        }
    }
}

fn seed(lang: &Lang, stats: &[&FileStats]) -> Seed {
    if stats.is_empty() {
        return Seed::default_for(lang);
    }
    if lang.grammar == "prose" {
        let mut lens: Vec<usize> = stats.iter().filter_map(|s| s.doc_lines).collect();
        lens.sort_unstable();
        if lens.is_empty() {
            return Seed::default_for(lang);
        }
        let warn = round_up_10(percentile(&lens, 0.75).max(100));
        let error = round_up_10(percentile(&lens, 0.90)).max(warn + 50);
        Seed::Length { warn, error }
    } else {
        let mut ratios: Vec<f64> = stats.iter().map(|s| s.ratio()).collect();
        ratios.sort_by(f64::total_cmp);
        let budget = round2(percentile(&ratios, 0.75).clamp(0.05, 0.60));
        Seed::Ratio { budget }
    }
}

fn percentile<T: Copy>(sorted: &[T], p: f64) -> T {
    let last = sorted.len() - 1;
    sorted[((p * last as f64).round() as usize).min(last)]
}

fn round_up_10(n: usize) -> usize {
    n.div_ceil(10) * 10
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

fn render(langs: &[&Lang], seen: &BTreeSet<String>, seeds: &BTreeMap<&str, Seed>) -> String {
    let mut out = String::from(
        "# comment-budget.toml — generated by `comment-budget init`\n\
         #\n\
         # A file's ratio is comment / (comment + code), blank lines ignored. `budget`\n\
         # is the share it gets for free; warn/error fire on comment lines *past* that\n\
         # (its overshoot), so a tiny stub can't be far over and a big lightly-commented\n\
         # file never is. Budgets sit at this tree's own 75th percentile as it stood at\n\
         # init. Tighten them deliberately; raising them is what the gate resists.\n\n",
    );
    let _ = writeln!(out, "skip = [\"node_modules\", \"target\", \"dist\"]\n");

    let quoted =
        |items: &[&str]| items.iter().map(|i| format!("\"{i}\"")).collect::<Vec<_>>().join(", ");
    for lang in langs {
        let exts: Vec<&str> =
            lang.extensions.iter().filter(|e| seen.contains(**e)).copied().collect();
        let _ = writeln!(out, "[kinds.{}]", lang.kind);
        let _ = writeln!(out, "grammar    = \"{}\"", lang.grammar);
        let _ = writeln!(out, "extensions = [{}]", quoted(&exts));
        if lang.kind == "rust" {
            let _ = writeln!(out, "exempt     = [\"//!\"]    # module docs are free...");
            let _ = writeln!(out, "exempt_free = 12        # ...for a file's first 12 lines");
        }
        if !lang.counted.is_empty() {
            let _ = writeln!(out, "counted    = [{}]", quoted(lang.counted));
        }
        let _ = writeln!(out);
    }

    for lang in langs {
        let paths: Vec<String> = lang
            .extensions
            .iter()
            .filter(|e| seen.contains(**e))
            .map(|e| format!("\"**/*.{e}\""))
            .collect();
        let _ = writeln!(out, "[[surface]]");
        let _ = writeln!(out, "name  = \"{}\"", lang.kind);
        let _ = writeln!(out, "paths = [{}]", paths.join(", "));
        let _ = writeln!(out, "goal  = \"{}\"", lang.goal);
        match seeds.get(lang.kind).unwrap_or(&Seed::default_for(lang)) {
            Seed::Ratio { budget } => {
                let _ = writeln!(out, "[surface.ratio]");
                let _ = writeln!(out, "budget = {budget:.2}   # comments may be this share, free");
                let _ = writeln!(out, "warn   = 20     # warn at 20 comment lines past that");
                let _ = writeln!(out, "error  = 60");
                let _ = writeln!(out, "[surface.run]");
                let _ = writeln!(out, "warn  = 8");
                let _ = writeln!(out, "error = 14");
            }
            Seed::Length { warn, error } => {
                let _ = writeln!(out, "[surface.length]");
                let _ = writeln!(out, "warn  = {warn}");
                let _ = writeln!(out, "error = {error}");
            }
        }
        let _ = writeln!(out);
    }

    let _ = writeln!(out, "[escape]");
    let _ = writeln!(out, "directive = \"comment-budget: allow(<reason>)\"");
    out
}
