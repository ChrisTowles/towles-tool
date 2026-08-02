//! Has a task branch's work reached the base branch? The one answer for `tt task
//! ls`/`rm`/`clean` and the rail; each landing shape hides from the other two's checks:
//!
//! | landing        | reachability | per-commit patch id | cumulative patch id |
//! |----------------|--------------|---------------------|---------------------|
//! | merge commit   | yes          | all match           | —                   |
//! | rebase / cherry-pick | no     | all match           | misses              |
//! | squash         | no           | **none match**      | matches             |
//!
//! Squash is how this repo's PRs land, and only the cumulative probe — the whole diff
//! since the merge-base as one patch — catches it. Counting the remainder scans
//! newest-first, landedness not being monotonic.

/// How a branch's work reached the base branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LandedVia {
    /// Reachable from the base — a classic merge commit.
    Ancestor,
    /// Every commit is patch-identical to one in the base — rebased or cherry-picked.
    Patches,
    /// The cumulative diff is in the base under a different SHA — a squash merge.
    Squash,
    /// The remote branch was deleted — about the *remote*, not the content, so it
    /// answers only when no content check did.
    UpstreamGone,
}

impl LandedVia {
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
    /// All but [`Self::UpstreamGone`]: a vanished remote branch is indistinguishable
    /// from one deleted while unmerged, so callers that destroy history gate on this.
    pub fn is_content_proof(self) -> bool {
        !matches!(self, Self::UpstreamGone)
    }
}

/// What a task still holds, on two axes kept separate on purpose: uncommitted work is
/// destroyed by removal and exists nowhere else, while commits whose content never
/// reached the base survive on the branch and can be pushed later.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorkState {
    /// `git status --porcelain` entries — changed or untracked paths.
    pub uncommitted: usize,
    /// Commits since the merge-base whose content is not in the base branch.
    pub unlanded: u64,
    pub total_commits: u64,
    /// Set when *all* the branch's content is in the base.
    pub landed: Option<LandedVia>,
    /// Commits reachable from no branch and no remote — a detached HEAD's work, which
    /// removal really would destroy. Distinct from `unlanded`, which is safe.
    pub orphaned: u64,
}

impl WorkState {
    /// Whether removing this task would lose anything a user cannot recover.
    pub fn holds_work(&self) -> bool {
        self.uncommitted > 0 || self.unlanded > 0 || self.orphaned > 0
    }

    /// One line naming each axis that is non-zero. Empty when there is nothing to
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
        // "merged" on a task nobody committed to would claim work that never existed,
        // and an absorbed branch is indistinguishable from one cut off an older base.
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

/// Decide how a branch landed, ordered by strength of evidence. `tip_equals_base`
/// suppresses the ancestor answer for a fresh task, which is trivially reachable from
/// the base and must not invite cleaning. Squashing a *single* commit is patch-identical
/// and so reads as "rebase-merged"; nothing in the repository can tell those apart.
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

/// Cap on per-commit probes. Each is a tree diff and this runs on the Agentboard's
/// poll; a branch past this many commits falls back to the plain patch-identity count.
/// The scan stops at the first landed commit, so the cap only binds when nothing landed.
const MAX_PROBES: usize = 64;

/// Run every probe against a real repository and assemble the state.
///
/// Best-effort by design: an unreadable repository degrades to the conservative answer
/// — work is present, the branch has not landed — rather than erroring. Reporting
/// "nothing to lose" because git did not answer is the one outcome that destroys work.
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

    // Zero commits since the merge-base is ambiguous with opposite consequences: a
    // *fresh* task sits on the base tip and must never read as merged, while a
    // *merged* branch also has nothing left, but the base has moved on past it.
    if total == 0 {
        state.landed = (!tip_equals_base && ancestor).then_some(LandedVia::Ancestor);
        return state;
    }

    // Computed once and reused by every check below, the watermark scan included.
    let landed_patches = repo.base_patch_ids(merge_base, base_id);
    let is_landed = |patch: Option<tt_git::repo::PatchId>| {
        patch.is_some_and(|patch| landed_patches.contains(&patch))
    };

    let cherry_plus =
        commits.iter().filter(|id| !is_landed(repo.patch_id_of_commit(**id))).count() as u64;
    let tree_landed = is_landed(repo.cumulative_patch_id(merge_base, branch_id));

    state.landed =
        classify(ancestor, tip_equals_base, cherry_plus, total, tree_landed, upstream_gone);

    // Only content evidence justifies zero; a gone upstream leaves them counted.
    state.unlanded = if state.landed.is_some_and(LandedVia::is_content_proof) {
        0
    } else if total as usize > MAX_PROBES {
        cherry_plus
    } else {
        // The tip's cumulative tree is what `tree_landed` already probed, and this arm
        // only runs when that was false. Everything past the first landed commit is
        // discarded by the count, so the scan stops there.
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
        // total_commits must be set, or this exercises the "no commits" wording.
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

        // Detached: nothing since a merge-base, but the orphan axis still reports.
        let detached = WorkState { orphaned: 2, ..Default::default() };
        assert_eq!(detached.headline(), "2 orphaned, no commits");
        assert!(detached.holds_work());
    }
}
