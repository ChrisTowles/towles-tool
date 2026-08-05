//! Counts to findings.
//!
//! A [`Finding`] keeps its fields rather than only a rendered line, so a
//! consumer can emit JSON, GitHub annotations, or an editor diagnostic without
//! parsing text back out.

use crate::config::{Config, Surface};
use crate::measure::FileStats;
use crate::{CONFIG_FILE, Severity};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Rule {
    /// Too much commentary against the code in one file.
    CommentBudget,
    /// One unbroken block of comment too long to wade through.
    CommentRun,
    /// A prose file past its length band.
    LongDoc,
    /// An opt-out directive that named no reason.
    UnexplainedOptOut,
    /// A readable file no surface claims, so nothing measures it.
    Unclaimed,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Finding {
    pub severity: Severity,
    pub rule: Rule,
    pub file: String,
    /// 1-based inclusive line span, for the rules that point at one.
    pub span: Option<(usize, usize)>,
    pub surface: Option<String>,
    pub message: String,
}

impl std::fmt::Display for Finding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let rule = serde_json::to_value(self.rule).ok();
        let rule = rule.as_ref().and_then(|v| v.as_str()).unwrap_or("finding");
        write!(f, "[{rule}] {}", self.locus())?;
        write!(f, " — {}", self.message)
    }
}

impl Finding {
    /// `file:start-end` where the rule points at lines, bare `file` otherwise.
    pub fn locus(&self) -> String {
        match self.span {
            Some((a, b)) => format!("{}:{a}-{b}", self.file),
            None => self.file.clone(),
        }
    }
}

/// Every finding, worst-first per file in config order.
pub fn judge(cfg: &Config, stats: &[FileStats]) -> Vec<Finding> {
    let mut out = Vec::new();
    for s in stats {
        let surface = &cfg.surfaces[s.surface];
        if let Some(reason) = &s.allowed {
            if reason.is_empty() {
                out.push(Finding {
                    severity: Severity::Error,
                    rule: Rule::UnexplainedOptOut,
                    file: s.file.clone(),
                    span: None,
                    surface: Some(surface.name.clone()),
                    message: format!(
                        "`{}` with no reason; an unexplained opt-out is the failure mode it \
                         exists to prevent",
                        cfg.escape.marker()
                    ),
                });
            }
            continue;
        }
        // A prose file on a ratio surface (or a code file on a length one) has no
        // tier that can fire, so it is claimed, unmeasured, and reads exactly
        // like passing — the same failure `unclaimed` exists to catch.
        if !enforced(s, surface) {
            out.push(Finding {
                severity: Severity::Error,
                rule: Rule::Unclaimed,
                file: s.file.clone(),
                span: None,
                surface: Some(surface.name.clone()),
                message: format!(
                    "surface `{}` has no tier that applies to this file, so nothing measures it; \
                     move it to a surface of the right shape in {CONFIG_FILE}",
                    surface.name
                ),
            });
        } else if s.doc_lines.is_some() {
            out.extend(long_doc(s, surface));
        } else {
            out.extend(comment_runs(s, surface));
            out.extend(comment_budget(s, surface));
        }
    }
    out
}

/// Whether the surface carries a tier of the shape this file is measured in.
fn enforced(s: &FileStats, surface: &Surface) -> bool {
    if s.doc_lines.is_some() {
        surface.doc_tiers().is_some()
    } else {
        surface.file.is_some() || surface.run.is_some()
    }
}

fn long_doc(s: &FileStats, surface: &Surface) -> Option<Finding> {
    let lines = s.doc_lines?;
    let tiers = surface.doc_tiers()?;
    let (severity, cap) = tiers.hit(|&n| lines >= n)?;
    let what = if s.scoped { "lines added" } else { "lines" };
    Some(Finding {
        severity,
        rule: Rule::LongDoc,
        file: s.file.clone(),
        span: None,
        surface: Some(surface.name.clone()),
        message: format!("{lines} {what} (threshold {cap}, surface {})", surface.name),
    })
}

fn comment_runs(s: &FileStats, surface: &Surface) -> Vec<Finding> {
    let Some(tiers) = &surface.run else {
        return Vec::new();
    };
    s.runs
        .iter()
        .filter_map(|r| {
            let (severity, cap) = tiers.hit(|&n| r.lines() >= n)?;
            Some(Finding {
                severity,
                rule: Rule::CommentRun,
                file: s.file.clone(),
                span: Some((r.start, r.end)),
                surface: Some(surface.name.clone()),
                message: format!(
                    "{} counted comment lines (threshold {cap}, surface {})",
                    r.lines(),
                    surface.name
                ),
            })
        })
        .collect()
}

fn comment_budget(s: &FileStats, surface: &Surface) -> Option<Finding> {
    let tiers = surface.file.as_ref()?;
    let (severity, t) = tiers.hit(|t| s.ratio() >= t.ratio && s.counted >= t.lines)?;
    let what = if s.scoped { "% of added lines are comment" } else { "% comment" };
    Some(Finding {
        severity,
        rule: Rule::CommentBudget,
        file: s.file.clone(),
        span: None,
        surface: Some(surface.name.clone()),
        message: format!(
            "{:.0}{what} ({} comment lines against {} code; threshold {:.0}% at {}+ lines, \
             surface {})",
            100.0 * s.ratio(),
            s.counted,
            s.code,
            100.0 * t.ratio,
            t.lines,
            surface.name
        ),
    })
}

/// A file some kind can read that no surface claims. An error rather than a
/// quiet skip: under first-match-wins the failure mode of this whole design is a
/// tree nobody noticed was exempt, and that reads exactly like passing.
pub fn unclaimed_findings(unclaimed: &[String]) -> Vec<Finding> {
    unclaimed
        .iter()
        .map(|f| Finding {
            severity: Severity::Error,
            rule: Rule::Unclaimed,
            file: f.clone(),
            span: None,
            surface: None,
            message: format!(
                "no surface claims this file, so nothing measures it; add a path to a surface \
                 in {CONFIG_FILE}"
            ),
        })
        .collect()
}
