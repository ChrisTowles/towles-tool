//! Human-readable output. The JSON form is the serialized [`crate::Finding`]s,
//! so nothing here is on the machine-readable path.

use std::fmt::Write as _;

use crate::config::Config;
use crate::measure::FileStats;

/// SGR codes, or empty strings when the output isn't a terminal a human is
/// reading — a redirect to a file and `NO_COLOR` both mean plain text. Resolved
/// once at startup rather than per-line so a piped run can't emit half of each.
pub struct Paint {
    pub dim: &'static str,
    pub bold: &'static str,
    pub over: &'static str,
    pub warn: &'static str,
    pub name: &'static str,
    pub off: &'static str,
}

impl Paint {
    pub const PLAIN: Paint = Paint { dim: "", bold: "", over: "", warn: "", name: "", off: "" };

    pub fn resolve() -> Self {
        use std::io::IsTerminal;
        if std::env::var_os("NO_COLOR").is_some() || !std::io::stdout().is_terminal() {
            return Paint::PLAIN;
        }
        Paint {
            dim: "\x1b[2m",
            bold: "\x1b[1m",
            // Red for over-target and errors, yellow for warnings, cyan for the
            // names you scan by — the terminal's own palette, so it stays
            // legible against whatever theme the user actually runs.
            over: "\x1b[31m",
            warn: "\x1b[33m",
            name: "\x1b[36m",
            off: "\x1b[0m",
        }
    }
}

/// The thresholds each surface enforces. The table says how far past target a
/// surface sits; this says which rule decides that, so a number can be traced
/// to the line of config that produced it rather than taken on faith.
pub fn rules(cfg: &Config, only: Option<&str>, paint: &Paint) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "\n{}rules in effect{}", paint.bold, paint.off);
    for surface in cfg.surfaces.iter().filter(|s| only.is_none_or(|n| n == s.name)) {
        let _ = writeln!(
            out,
            "{}{}{} {}{}{}",
            paint.name,
            surface.name,
            paint.off,
            paint.dim,
            globs(&surface.paths),
            paint.off,
        );
        if let Some(t) = &surface.ratio {
            let band = |n: usize| format!("{n}+ lines over {:.0}%", 100.0 * t.budget);
            rule(&mut out, paint, "ratio", band(t.warn), band(t.error));
        }
        if let Some(t) = &surface.run {
            let band = |n: &usize| format!("{n}+ lines unbroken");
            rule(&mut out, paint, "run", band(&t.warn), band(&t.error));
        }
        if let Some(t) = &surface.length {
            let band = |n: &usize| format!("{n}+ lines");
            rule(&mut out, paint, "length", band(&t.warn), band(&t.error));
        }
    }
    let _ = writeln!(out, "{}every surface{}", paint.name, paint.off);
    tell(&mut out, paint, "a readable file no surface claims is an error");
    tell(&mut out, paint, &format!("`{}` at the top of a file opts it out", cfg.escape.directive));
    tell(&mut out, paint, "an opt-out naming no reason is an error");
    out
}

/// A surface can claim a dozen globs; the whole list wraps into noise, and the
/// config is where it is authoritative anyway.
fn globs(paths: &[String]) -> String {
    let shown = paths.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
    match paths.len().saturating_sub(3) {
        0 => shown,
        rest => format!("{shown}, +{rest} more"),
    }
}

fn rule(out: &mut String, paint: &Paint, label: &str, warn: String, error: String) {
    let _ = writeln!(
        out,
        "  {label:<7} {}warn{} {warn:<24} {}error{} {error}",
        paint.warn, paint.off, paint.over, paint.off,
    );
}

fn tell(out: &mut String, paint: &Paint, what: &str) {
    let _ = writeln!(out, "  {}{what}{}", paint.dim, paint.off);
}

/// The files whose cleanup moves the number most, per surface. Ranked by lines
/// over budget rather than by ratio alone, so the list is a work queue.
pub fn worst(cfg: &Config, stats: &[FileStats], only: Option<&str>, paint: &Paint) -> String {
    let mut out = String::new();
    for (i, surface) in cfg.surfaces.iter().enumerate() {
        if only.is_some_and(|n| n != surface.name) {
            continue;
        }
        let Some(budget) = surface.ratio.as_ref().map(|t| t.budget) else {
            continue;
        };
        let mut mine: Vec<&FileStats> = stats.iter().filter(|s| s.surface == i).collect();
        mine.sort_by_key(|s| std::cmp::Reverse(s.overshoot(budget)));
        let worth: Vec<_> = mine.iter().take(8).filter(|s| s.overshoot(budget) > 0).collect();
        if worth.is_empty() {
            continue;
        }
        let _ = writeln!(
            out,
            "\n{}{}{} {}— worst files (lines past the {:.0}% budget){}",
            paint.bold,
            surface.name,
            paint.off,
            paint.dim,
            100.0 * budget,
            paint.off,
        );
        for s in worth {
            let _ = writeln!(
                out,
                "  {}{:>5} over{}   {}{:>3.0}%{}   {}",
                paint.over,
                s.overshoot(budget),
                paint.off,
                paint.dim,
                100.0 * s.ratio(),
                paint.off,
                s.file,
            );
        }
    }
    out
}

/// Each surface measured against its budget — the direction of travel that a
/// pass/fail count can't show.
pub fn surfaces(cfg: &Config, stats: &[FileStats], only: Option<&str>, paint: &Paint) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "{}\nsurface                 files    measured   budget      over{}",
        paint.dim, paint.off
    );
    for (i, surface) in cfg.surfaces.iter().enumerate() {
        if only.is_some_and(|n| n != surface.name) {
            continue;
        }
        let mine: Vec<&FileStats> = stats.iter().filter(|s| s.surface == i).collect();
        if mine.is_empty() {
            let _ = writeln!(out, "{:<22} {:>6}    (no files match)", surface.name, 0);
            continue;
        }
        let (measured, budget, over, past_budget) = match &surface.length {
            Some(t) => {
                // Averaged over the prose files only. Dividing by every file the
                // surface claims would let one code file it also matches drag the
                // reported average below a band the prose is actually past.
                let counts: Vec<usize> = mine.iter().filter_map(|s| s.doc_lines).collect();
                let avg = counts.iter().sum::<usize>().checked_div(counts.len()).unwrap_or(0);
                let over: usize = counts.iter().map(|n| n.saturating_sub(t.warn)).sum();
                (format!("{avg} lines"), format!("{} lines", t.warn), over, avg >= t.warn)
            }
            None => {
                let counted: usize = mine.iter().map(|s| s.counted).sum();
                let code: usize = mine.iter().map(|s| s.code).sum();
                let pct = if counted + code == 0 {
                    0.0
                } else {
                    100.0 * counted as f64 / (counted + code) as f64
                };
                let (budget, over) = match surface.ratio.as_ref().map(|t| t.budget) {
                    Some(r) => (
                        format!("{:.0}%", 100.0 * r),
                        mine.iter().map(|s| s.overshoot(r)).sum::<usize>(),
                    ),
                    None => ("—".to_string(), 0),
                };
                let past = surface.ratio.as_ref().is_some_and(|t| pct >= 100.0 * t.budget);
                (format!("{pct:.1}%"), budget, over, past)
            }
        };
        // The measured figure and the backlog are judged separately: an average
        // can sit under budget while a long tail still owes lines, which is
        // exactly a markdown surface's shape.
        let hue = if past_budget { paint.over } else { "" };
        let over_hue = if over > 0 { paint.over } else { "" };
        let _ = writeln!(
            out,
            "{}{:<22}{} {:>6}  {hue}{:>10}{}  {:>7}  {over_hue}{:>8}{}",
            paint.name,
            surface.name,
            paint.off,
            mine.len(),
            measured,
            paint.off,
            budget,
            format!("{over} lines"),
            paint.off,
        );
        let _ = writeln!(out, "{}  {}{}", paint.dim, surface.goal, paint.off);
    }
    out
}

/// Printed whenever anything fired. The advice is the point of the tool: the
/// budgets are not the thing to lower.
pub const HOW_TO_FIX: &str = "Fix by deleting, not reflowing: cut history — git already holds it — and keep only what \
     looks forward: the *why*, and the *how* where the code leaves it unclear. Squeezing under \
     a threshold just moves an error onto the warning list.";
