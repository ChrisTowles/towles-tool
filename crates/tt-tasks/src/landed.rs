//! Has a task branch's work reached the base branch? The one answer for `tt task
//! ls`/`rm`/`clean` and the rail; each landing shape hides from the other two's checks:
//!
//! | landing        | reachability | per-commit patch id | cumulative patch id |
//! |----------------|--------------|---------------------|---------------------|
//! | merge commit   | yes          | all match           | —                   |
//! | rebase / cherry-pick | no     | all match           | misses              |
//! | squash         | no           | **none match**      | matches             |
//!
//! Squash matters most, since it is how this repo's PRs land: GitHub replaces the N
//! commits with one whose SHA *and* patch id differ from all, so the first two columns
//! report the branch unlanded. The cumulative probe closes it — the whole diff since the
//! merge-base as one patch, which is what a squash commit holds. Counting the remainder
//! scans newest-first, landedness not being monotonic.

/// How a branch's work reached the base branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LandedVia {
    /// Reachable from the base — a classic merge commit.
    Ancestor,
    /// Every commit is patch-identical to one already in the base — the
    /// branch was rebased or cherry-picked in.
    Patches,
    /// The branch's cumulative diff is in the base under a different SHA —
    /// a squash merge.
    Squash,
    /// The remote branch was deleted, the usual signature of a merged PR.
    /// Weakest signal: it is about the *remote*, not the local content, so it
    /// only applies when none of the content checks answered.
    UpstreamGone,
}

impl LandedVia {
    /// Short phrase for a one-line summary.
    pub fn label(self) -> &'static str {
        match self {
            Self::Ancestor => "merged",
            Self::Patches => "rebase-merged",
            Self::Squash => "squash-merged",
            Self::UpstreamGone => "upstream gone",
        }
    }

    /// Whether this answer is evidence the branch's *content* is in the base.
    ///
    /// All of them except [`Self::UpstreamGone`], which only observes that the
    /// remote branch disappeared. That is usually a merged PR, but it is also
    /// indistinguishable from a branch deleted while still unmerged — so it
    /// must never be taken as proof the commits are safe. Callers that destroy
    /// history (`clean` runs `git branch -D`) gate on this.
    pub fn is_content_proof(self) -> bool {
        !matches!(self, Self::UpstreamGone)
    }
}

/// What a task still holds, on two independent axes: work that was never
/// committed, and commits whose content never reached the base.
///
/// Kept as separate counts on purpose — collapsing them into one "dirty" flag
/// is what made the old output unreadable, because the two have different
/// consequences. Uncommitted work is destroyed by removal and exists nowhere
/// else; unlanded commits survive on the branch and can be pushed later.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorkState {
    /// `git status --porcelain` entries — changed or untracked paths.
    pub uncommitted: usize,
    /// Commits since the merge-base whose content is not in the base branch.
    pub unlanded: u64,
    /// Commits since the merge-base, landed or not.
    pub total_commits: u64,
    /// Set when *all* the branch's content is in the base.
    pub landed: Option<LandedVia>,
    /// Commits reachable from no branch and no remote — a detached HEAD's
    /// work, which removal really would destroy. Distinct from `unlanded`,
    /// which is safe on a branch.
    pub orphaned: u64,
}

impl WorkState {
    /// Whether removing this task would lose anything a user cannot recover.
    pub fn holds_work(&self) -> bool {
        self.uncommitted > 0 || self.unlanded > 0 || self.orphaned > 0
    }

    /// One line naming each axis that is non-zero, so the reason a task is
    /// held back is never guesswork. Empty string when there is nothing to
    /// report beyond how it landed.
    pub fn headline(&self) -> String {
        let mut parts = Vec::new();
        if self.uncommitted > 0 {
            parts.push(format!("{} uncommitted", self.uncommitted));
        }
        if self.unlanded > 0 {
            parts.push(format!("{} unlanded", self.unlanded));
        }
        if self.orphaned > 0 {
            parts.push(format!("{} orphaned", self.orphaned));
        }
        // A branch with no commits of its own is reported as such rather than
        // as "merged". The two are indistinguishable after the fact — an
        // absorbed branch and a task created from an older base both have
        // nothing since their merge-base — and "merged" on a task nobody ever
        // committed to reads as a claim about work that never existed. Either
        // way nothing is at stake, which is what the phrase needs to convey.
        if self.total_commits == 0 {
            if parts.is_empty() {
                return "no commits".to_string();
            }
            parts.push("no commits".to_string());
            return parts.join(", ");
        }
        if let Some(via) = self.landed {
            if parts.is_empty() {
                return via.label().to_string();
            }
            parts.push(via.label().to_string());
        }
        parts.join(", ")
    }
}

/// Decide how a branch landed, given each independently-gathered signal.
///
/// Ordering is by strength of evidence: reachability and patch identity are facts about
/// content in the base, the tree probe is a synthesised equivalent, and a gone upstream
/// is only circumstantial — *usually* a merged PR, but also what a branch deleted
/// unmerged looks like. It answers last, and only when nothing about content did.
///
/// `tip_equals_base` suppresses the ancestor answer for a freshly created task: a branch
/// still on the base tip is trivially reachable from it, and calling that "merged" would
/// invite cleaning a task someone is about to work in.
///
/// One label is fuzzy by nature: squashing a *single* commit is patch-identical, so it
/// answers [`LandedVia::Patches`] and reads as "rebase-merged". Nothing in the
/// repository could tell the two apart, and both mean the same for every decision here.
pub fn classify(
    ancestor: bool,
    tip_equals_base: bool,
    cherry_plus: u64,
    total_commits: u64,
    tree_landed: bool,
    upstream_gone: bool,
) -> Option<LandedVia> {
    if tip_equals_base || total_commits == 0 {
        return None;
    }
    if ancestor {
        return Some(LandedVia::Ancestor);
    }
    if cherry_plus == 0 {
        return Some(LandedVia::Patches);
    }
    if tree_landed {
        return Some(LandedVia::Squash);
    }
    if upstream_gone {
        return Some(LandedVia::UpstreamGone);
    }
    None
}

/// Cap on per-commit probes. Each probe is a tree diff against the merge-base
/// — no longer the three subprocesses it once was, but not free either, and
/// this runs on the Agentboard's poll. A task branch is short-lived by
/// construction; one past this many commits falls back to the plain
/// patch-identity count rather than paying an unbounded cost for a number
/// nobody is reading closely. The scan also stops at the first landed commit,
/// so the cap only binds on branches where nothing has landed at all.
const MAX_PROBES: usize = 64;

/// Run every probe against a real repository and assemble the state.
///
/// Best-effort by design: this feeds a status display and a removal guard, so an
/// unreadable repository degrades to the conservative answer — work is present, the
/// branch has not landed — rather than erroring. Reporting "nothing to lose" because
/// git did not answer is the one outcome that could destroy work.
///
/// The whole probe runs in-process against `repo`. The squash check used to need a
/// *real commit object* for `git cherry`, so it ran `commit-tree` to write one (with an
/// explicit identity, since CI runners have none) and deleted the loose object by hand
/// so the poll wouldn't accumulate thousands of dead objects a day.
pub fn probe_work_state(
    repo: &tt_git::repo::Repo,
    base: &str,
    branch: &str,
    uncommitted: usize,
    orphaned: u64,
    upstream_gone: bool,
) -> WorkState {
    let mut state =
        WorkState { uncommitted, orphaned, landed: None, unlanded: 0, total_commits: 0 };

    let (Some(base_id), Some(branch_id)) = (repo.resolve(base), repo.resolve(branch)) else {
        return state;
    };
    let Some(merge_base) = repo.merge_base(base, branch) else {
        return state;
    };

    let commits = repo.rev_list(merge_base, branch_id).unwrap_or_default();
    let total = commits.len() as u64;
    state.total_commits = total;

    let tip_equals_base = branch_id == base_id;
    let ancestor = repo.is_ancestor(branch, base);

    // Zero commits since the merge-base is ambiguous, and the two readings
    // have opposite consequences. A *fresh* task sits on the base tip and must
    // never read as merged — cleaning it would take a task someone is about to
    // work in. A *merged* branch also has nothing since its merge-base (the
    // merge-base is its own tip once the base absorbed it), but the base has
    // moved on past it, and it is exactly what `clean` should collect.
    if total == 0 {
        state.landed = (!tip_equals_base && ancestor).then_some(LandedVia::Ancestor);
        return state;
    }

    // The base's patch ids, computed once and reused by every check below —
    // the per-commit watermark scan included. Under the old shell-out each of
    // those probes re-ran `git cherry`, which recomputed this same set from
    // scratch every time.
    let landed_patches = repo.base_patch_ids(merge_base, base_id);
    let is_landed = |patch: Option<tt_git::repo::PatchId>| {
        patch.is_some_and(|patch| landed_patches.contains(&patch))
    };

    let cherry_plus =
        commits.iter().filter(|id| !is_landed(repo.patch_id_of_commit(**id))).count() as u64;
    let tree_landed = is_landed(repo.cumulative_patch_id(merge_base, branch_id));

    state.landed =
        classify(ancestor, tip_equals_base, cherry_plus, total, tree_landed, upstream_gone);

    // Only content-based evidence justifies claiming nothing is outstanding.
    // A gone upstream leaves the commits to be counted like any other.
    state.unlanded = if state.landed.is_some_and(LandedVia::is_content_proof) {
        0
    } else if total as usize > MAX_PROBES {
        cherry_plus
    } else {
        // The first entry is the branch tip, whose cumulative tree
        // `tree_landed` already probed; this arm only runs when that came back
        // false, so re-probing it would spend a tree diff to learn what we
        // know. Stop at the first landed commit rather than probing them all:
        // everything past the watermark is discarded by the count anyway.
        let landed_at = commits[1..]
            .iter()
            .position(|rev| is_landed(repo.cumulative_patch_id(merge_base, *rev)));
        1 + landed_at.unwrap_or(commits.len() - 1) as u64
    };

    state
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn squash_merge_is_recognised_when_reachability_and_cherry_both_miss() {
        // The headline case: GitHub squashed 2 commits, so the branch is not
        // an ancestor and per-commit patch identity matches neither.
        assert_eq!(
            classify(false, false, 2, 2, true, false),
            Some(LandedVia::Squash),
            "a squash-merged branch must not read as outstanding work"
        );
    }

    #[test]
    fn rebase_merge_is_recognised_by_patch_identity() {
        assert_eq!(classify(false, false, 0, 1, false, false), Some(LandedVia::Patches));
    }

    #[test]
    fn classic_merge_is_recognised_by_reachability() {
        assert_eq!(classify(true, false, 0, 3, false, false), Some(LandedVia::Ancestor));
    }

    #[test]
    fn genuinely_open_branch_is_not_landed() {
        assert_eq!(classify(false, false, 2, 2, false, false), None);
    }

    #[test]
    fn fresh_task_is_never_landed() {
        // Branch sitting on the base tip: trivially an ancestor, but cleaning
        // it would take a task someone is about to work in.
        assert_eq!(classify(true, true, 0, 0, false, false), None);
        assert_eq!(classify(true, true, 0, 0, false, true), None);
    }

    #[test]
    fn gone_upstream_answers_only_when_content_checks_do_not() {
        assert_eq!(classify(false, false, 1, 1, false, true), Some(LandedVia::UpstreamGone));
        // Content evidence outranks it.
        assert_eq!(classify(false, false, 2, 2, true, true), Some(LandedVia::Squash));
    }

    #[test]
    fn headline_separates_the_two_axes() {
        // total_commits must be set: `unlanded: 1` with no commits at all is
        // not a state the probe can produce, and defaulting it to 0 would
        // exercise the "no commits" wording instead of the two axes.
        let s = WorkState { uncommitted: 2, unlanded: 1, total_commits: 1, ..Default::default() };
        assert_eq!(s.headline(), "2 uncommitted, 1 unlanded");
    }

    #[test]
    fn headline_of_a_merged_clean_task_names_how_it_landed() {
        let s =
            WorkState { total_commits: 2, landed: Some(LandedVia::Squash), ..Default::default() };
        assert_eq!(s.headline(), "squash-merged");
        assert!(!s.holds_work());
    }

    #[test]
    fn headline_flags_work_added_after_a_squash_merge() {
        let s =
            WorkState { uncommitted: 0, unlanded: 1, total_commits: 3, landed: None, orphaned: 0 };
        assert_eq!(s.headline(), "1 unlanded");
        assert!(s.holds_work());
    }

    #[test]
    fn orphaned_commits_are_reported_separately_from_unlanded() {
        let s = WorkState { orphaned: 2, total_commits: 2, ..Default::default() };
        assert_eq!(s.headline(), "2 orphaned");
        assert!(s.holds_work());

        // A detached task whose commits are on no branch at all: nothing since
        // a merge-base, but the orphan axis still has to be reported — that is
        // the work removal really would destroy.
        let detached = WorkState { orphaned: 2, ..Default::default() };
        assert_eq!(detached.headline(), "2 orphaned, no commits");
        assert!(detached.holds_work());
    }
}
