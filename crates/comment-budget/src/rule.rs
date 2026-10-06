//! The whole policy: four numbers and the two checks they feed. A file is
//! judged against its own base, so old debt never fails a change; only growing
//! it, or adding a fresh wall of comment, does.

use std::collections::BTreeSet;

use crate::measure::{Counts, Lang, measure, opt_out};

/// Comment lines may be this share of a file's non-blank lines for free.
pub const BUDGET_PERCENT: usize = 15;
/// A file this far over budget, or less, never fails.
pub const FLOOR: usize = 10;
/// Growth in excess, in lines, that counts as this change adding to it.
pub const GROWTH: usize = 5;
/// An unbroken comment block this long reads as a wall.
pub const RUN: usize = 13;

#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    /// The change grew the file's excess by `GROWTH`+ and left it over `FLOOR`.
    Growth { base: usize, head: usize },
    /// A new `RUN`+ line block, or an old wall grown by `GROWTH`+. 1-based, inclusive.
    Run { start: usize, end: usize },
    /// `comment-budget: allow` with no reason.
    UnexplainedAllow,
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Growth { base, head } => write!(
                f,
                "{head} comment lines over the {BUDGET_PERCENT}% budget, up {} from {base}",
                head - base
            ),
            Failure::Run { start, end } => {
                write!(
                    f,
                    "a {}-line comment block, new or grown (a wall is {RUN}+)",
                    end - start + 1
                )
            }
            Failure::UnexplainedAllow => f.write_str("`comment-budget: allow()` names no reason"),
        }
    }
}

/// Judge `head` against what the same file held at the base; `None` is a file
/// the base did not have, whose excess starts at zero.
pub fn judge(lang: Lang, base: Option<&str>, head: &str) -> Vec<Failure> {
    match opt_out(head) {
        Some(reason) if reason.is_empty() => return vec![Failure::UnexplainedAllow],
        Some(_) => return Vec::new(),
        None => {}
    }
    let now = measure(lang, head);
    let then = base.map(|b| measure(lang, b));
    let before = then.as_ref().map_or(0, Counts::excess);
    let mut out = Vec::new();
    if now.excess() >= before + GROWTH && now.excess() > FLOOR {
        out.push(Failure::Growth { base: before, head: now.excess() });
    }
    let longest_before = |run| match (base, &then) {
        (Some(base), Some(then)) => longest_overlapping(then, &base_rows(base, head, run)),
        _ => 0,
    };
    out.extend(
        now.runs()
            .into_iter()
            .filter(|&(a, b)| {
                let (len, old) = (b - a + 1, longest_before((a, b)));
                len >= RUN && (old < RUN || len >= old + GROWTH)
            })
            .map(|(a, b)| Failure::Run { start: a + 1, end: b + 1 }),
    );
    out
}

/// The longest base run these base rows touch: what a head run is compared to,
/// so rewording or shrinking an old block passes.
fn longest_overlapping(then: &Counts, rows: &BTreeSet<usize>) -> usize {
    then.runs()
        .into_iter()
        .filter(|&(a, b)| rows.range(a..=b).next().is_some())
        .map(|(a, b)| b - a + 1)
        .max()
        .unwrap_or(0)
}

/// The 0-based base rows that head rows `a..=b` line up with: unchanged rows
/// one to one, and the whole old side of any hunk that rewrote one of them.
fn base_rows(base: &str, head: &str, (a, b): (usize, usize)) -> BTreeSet<usize> {
    let input = gix::diff::blob::InternedInput::new(base.as_bytes(), head.as_bytes());
    let diff =
        gix::diff::blob::diff_with_slider_heuristics(gix::diff::blob::Algorithm::Myers, &input);
    let mut rows = BTreeSet::new();
    let (mut old, mut new) = (0usize, 0usize);
    let unchanged = |rows: &mut BTreeSet<usize>, old: usize, from: usize, to: usize| {
        rows.extend((from.max(a)..to.min(b + 1)).map(|r| old + r - from));
    };
    for h in diff.hunks() {
        let (before, after) = (h.before.start as usize..h.before.end as usize, h.after.clone());
        unchanged(&mut rows, old, new, after.start as usize);
        if (after.start as usize) <= b && (after.end as usize) > a {
            rows.extend(before.clone());
        }
        (old, new) = (before.end, after.end as usize);
    }
    unchanged(&mut rows, old, new, usize::MAX);
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rust(comments: usize, code: usize) -> String {
        format!("{}{}", "// c\n".repeat(comments), "fn a() {}\n".repeat(code))
    }

    /// `n` comment lines split into blocks too short to be a run.
    fn chunked(comments: usize, code: usize) -> String {
        let mut s = String::new();
        for i in 0..comments {
            s.push_str("// c\n");
            if i % 4 == 3 {
                s.push_str("fn a() {}\n");
            }
        }
        s + &"fn a() {}\n".repeat(code.saturating_sub(comments / 4))
    }

    #[test]
    fn growing_excess_past_the_floor_fails() {
        let base = chunked(20, 40); // 40 code earn 7: excess 13
        let head = chunked(28, 40); // excess 21, up 8
        assert_eq!(
            judge(Lang::Rust, Some(&base), &head),
            vec![Failure::Growth { base: 13, head: 21 }]
        );
    }

    #[test]
    fn growth_under_five_lines_passes() {
        let base = chunked(20, 40);
        let head = chunked(24, 40);
        assert!(judge(Lang::Rust, Some(&base), &head).is_empty());
    }

    #[test]
    fn growth_that_stays_under_the_floor_passes() {
        let base = chunked(4, 40);
        let head = chunked(16, 40); // excess 9: grew 9, but not over 10
        assert!(judge(Lang::Rust, Some(&base), &head).is_empty());
    }

    #[test]
    fn old_debt_alone_never_fails() {
        let base = chunked(60, 40);
        let head = format!("{base}fn b() {{}}\n");
        assert!(judge(Lang::Rust, Some(&base), &head).is_empty());
    }

    #[test]
    fn a_new_file_starts_from_zero() {
        let head = chunked(20, 20); // 20 code earn 3: excess 17
        assert_eq!(judge(Lang::Rust, None, &head), vec![Failure::Growth { base: 0, head: 17 }]);
        assert!(judge(Lang::Rust, None, &chunked(12, 20)).is_empty());
    }

    #[test]
    fn a_new_thirteen_line_block_fails_even_within_budget() {
        let head = rust(13, 200);
        assert_eq!(judge(Lang::Rust, None, &head), vec![Failure::Run { start: 1, end: 13 }]);
        assert!(judge(Lang::Rust, None, &rust(12, 200)).is_empty());
    }

    #[test]
    fn growing_a_short_block_into_a_wall_fails() {
        let base = rust(6, 200);
        let head = rust(14, 200);
        assert_eq!(judge(Lang::Rust, Some(&base), &head), vec![Failure::Run { start: 1, end: 14 }]);
    }

    #[test]
    fn editing_inside_an_existing_wall_passes() {
        let base = rust(20, 200);
        let head = base.replacen("// c\n", "// edited\n", 1);
        assert!(judge(Lang::Rust, Some(&base), &head).is_empty());
    }

    #[test]
    fn rewording_every_line_of_an_existing_wall_passes() {
        let base = format!("{}{}", "//! old\n".repeat(13), "fn a() {}\n".repeat(200));
        let head = base.replace("//! old", "//! new wording");
        assert!(judge(Lang::Rust, Some(&base), &head).is_empty());
    }

    #[test]
    fn a_block_growing_from_eleven_to_fourteen_fails() {
        let base = format!("{}{}", "//! h\n".repeat(11), "fn a() {}\n".repeat(200));
        let head = format!("{}{}", "//! h\n".repeat(14), "fn a() {}\n".repeat(200));
        assert_eq!(judge(Lang::Rust, Some(&base), &head), vec![Failure::Run { start: 1, end: 14 }]);
    }

    fn header(lines: usize) -> String {
        format!("{}{}", "//! h\n".repeat(lines), "fn a() {}\n".repeat(200))
    }

    #[test]
    fn an_old_wall_growing_under_five_lines_passes() {
        assert!(judge(Lang::Rust, Some(&header(14)), &header(15)).is_empty());
        assert!(judge(Lang::Rust, Some(&header(14)), &header(18)).is_empty());
    }

    #[test]
    fn an_old_wall_growing_five_lines_fails() {
        assert_eq!(
            judge(Lang::Rust, Some(&header(14)), &header(19)),
            vec![Failure::Run { start: 1, end: 19 }]
        );
    }

    #[test]
    fn a_wall_that_shrinks_passes() {
        let base = rust(20, 200);
        assert!(judge(Lang::Rust, Some(&base), &rust(15, 200)).is_empty());
    }

    #[test]
    fn allow_with_a_reason_skips_the_file() {
        let head = format!("// comment-budget: allow(generated table)\n{}", rust(40, 1));
        assert!(judge(Lang::Rust, None, &head).is_empty());
    }

    #[test]
    fn allow_without_a_reason_fails() {
        let head = format!("// comment-budget: allow\n{}", rust(1, 1));
        assert_eq!(judge(Lang::Rust, None, &head), vec![Failure::UnexplainedAllow]);
    }
}
