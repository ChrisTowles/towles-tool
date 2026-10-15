//! Where a checkout's work lands, read off its PR.
//!
//! A task's `.tt-task` marker records the branch it was *cut from* — whatever
//! the checkout had out at creation — but `gh pr create` targets the repo
//! default unless told otherwise. Compared against the marker, a squash-merged
//! PR reads as unlanded forever, so the PR's own base wins.

use tt_store::PrItem;

/// The base of the PR on `branch` in the repo `origin_url` points at: an open PR
/// over a merged one (it is the work in flight), then the newest. Closed-unmerged
/// PRs and rows swept before the base was recorded answer nothing.
pub fn pr_base_for<'a>(
    prs: &'a [PrItem],
    origin_url: Option<&str>,
    branch: &str,
) -> Option<&'a str> {
    let origin = origin_url?.to_ascii_lowercase();
    if branch.is_empty() {
        return None;
    }
    prs.iter()
        .filter(|p| p.branch == branch && !p.base_branch.is_empty())
        .filter(|p| matches!(p.state.as_str(), "open" | "merged"))
        .filter(|p| origin.contains(&p.repo.to_ascii_lowercase()))
        .max_by_key(|p| (p.state == "open", p.number))
        .map(|p| p.base_branch.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: Option<&str> = Some("git@github.com:Owner/Repo.git");

    fn pr(number: i64, state: &str, branch: &str, base: &str) -> PrItem {
        PrItem {
            repo: "owner/repo".to_string(),
            number,
            title: String::new(),
            branch: branch.to_string(),
            state: state.to_string(),
            checks: String::new(),
            review_state: String::new(),
            url: String::new(),
            updated_ts: 0,
            dismissed_ts: 0,
            base_branch: base.to_string(),
        }
    }

    #[test]
    fn a_merged_pr_names_the_branch_it_landed_on() {
        let prs = [pr(83, "merged", "feat/wow", "main")];
        assert_eq!(pr_base_for(&prs, ORIGIN, "feat/wow"), Some("main"));
    }

    #[test]
    fn an_open_pr_outranks_an_older_merged_one_on_the_same_branch() {
        let prs = [
            pr(9, "open", "feat/x", "release/2.0"),
            pr(12, "merged", "feat/x", "main"),
        ];
        assert_eq!(pr_base_for(&prs, ORIGIN, "feat/x"), Some("release/2.0"));
    }

    #[test]
    fn closed_unrecorded_and_foreign_prs_answer_nothing() {
        let prs = [
            pr(1, "closed", "feat/x", "main"),
            pr(2, "open", "feat/x", ""),
        ];
        assert_eq!(pr_base_for(&prs, ORIGIN, "feat/x"), None);
        let foreign = [pr(3, "open", "feat/x", "main")];
        assert_eq!(pr_base_for(&foreign, Some("git@github.com:other/repo.git"), "feat/x"), None);
        assert_eq!(pr_base_for(&foreign, None, "feat/x"), None);
    }
}
