//! `gh`-backed pull-request collector.

use std::collections::HashMap;
use std::path::Path;

use tt_store::{ChecksState, PrInput, PrState, ReviewState};

use crate::gh;

const PR_LIST_FIELDS: &str =
    "number,title,headRefName,baseRefName,state,statusCheckRollup,reviewDecision,url,updatedAt";

/// Page cap for the recently-merged authored PRs fetch — just enough to catch
/// a just-merged branch before its worktree is removed, without pulling a
/// repo's whole merge history.
const MERGED_LIST_LIMIT: &str = "20";

/// Collect and dedup the authored + review-requested open PRs, plus a handful
/// of recently-merged authored PRs, for one repo dir.
///
/// Returns the repo's `owner/name` alongside its PRs so callers know which repo
/// a (possibly empty) result belongs to, or an error string (never a panic).
/// Dedup is by PR number; a review-requested entry wins over an authored one
/// for the same PR.
pub(crate) fn collect_repo_prs(dir: &Path) -> Result<(String, Vec<PrInput>), String> {
    let repo = gh::repo_name_with_owner(dir)?;
    let mut open = open_prs_by_number(dir, &repo)?;
    let merged = gh_pr_list(dir, "merged", MERGED_LIST_LIMIT, &["--author", "@me"])?;
    for pr in map_pr_list(&merged, &repo, false) {
        open.entry(pr.number).or_insert(pr);
    }
    Ok((repo, open.into_values().collect()))
}

pub(crate) fn collect_repo_prs_open(dir: &Path) -> Result<(String, Vec<PrInput>), String> {
    let repo = gh::repo_name_with_owner(dir)?;
    let by_number = open_prs_by_number(dir, &repo)?;
    Ok((repo, by_number.into_values().collect()))
}

pub(crate) fn collect_repo_merged_prs(dir: &Path) -> Result<(String, Vec<PrInput>), String> {
    let repo = gh::repo_name_with_owner(dir)?;
    let merged = gh_pr_list(dir, "merged", MERGED_LIST_LIMIT, &["--author", "@me"])?;
    let prs = map_pr_list(&merged, &repo, false);
    Ok((repo, prs))
}

/// Fetch and dedup the authored + review-requested open PRs for one repo.
/// A review-requested entry wins over an authored one for the same PR number.
fn open_prs_by_number(dir: &Path, repo: &str) -> Result<HashMap<i64, PrInput>, String> {
    let authored = gh_pr_list(dir, "open", gh::LIST_LIMIT, &["--author", "@me"])?;
    let review = gh_pr_list(dir, "open", gh::LIST_LIMIT, &["--search", "review-requested:@me"])?;

    let mut by_number: HashMap<i64, PrInput> = HashMap::new();
    for pr in map_pr_list(&authored, repo, false) {
        by_number.insert(pr.number, pr);
    }
    for pr in map_pr_list(&review, repo, true) {
        by_number.insert(pr.number, pr);
    }
    Ok(by_number)
}

/// Targeted fetch of one PR by number: the sweeps carry open PRs plus a bounded
/// recently-merged list, so one that is closed unmerged or long merged needs an
/// explicit ask. The whole row, since the rail's badge is drawn from the row.
pub(crate) fn fetch_pr(dir: &Path, repo: &str, number: i64) -> Result<Option<PrInput>, String> {
    let value = gh::run_json(dir, &["pr", "view", &number.to_string(), "--json", PR_LIST_FIELDS])?;
    Ok(map_pr_list(&serde_json::Value::Array(vec![value]), repo, false).into_iter().next())
}

/// The PR for one branch, whatever state it is in — what a task asks about its
/// own worktree branch when no snapshot ever carried its PR.
///
/// `--state all`, since the case this exists for is a PR that merged before any
/// open sweep saw it; `--limit 1`, since `gh` lists newest first. `repo` is the
/// task's own `owner/name`, the key the branch join will look under.
pub(crate) fn fetch_branch_pr(
    dir: &Path,
    repo: &str,
    branch: &str,
) -> Result<Option<PrInput>, String> {
    let value = gh::run_json(
        dir,
        &[
            "pr",
            "list",
            "--head",
            branch,
            "--state",
            "all",
            "--limit",
            "1",
            "--json",
            PR_LIST_FIELDS,
        ],
    )?;
    Ok(map_pr_list(&value, repo, false).into_iter().next())
}

/// Run `gh pr list` in `dir` for the given `--state`/`--limit` plus `extra` filters.
fn gh_pr_list(
    dir: &Path,
    state: &str,
    limit: &str,
    extra: &[&str],
) -> Result<serde_json::Value, String> {
    let mut args = vec![
        "pr",
        "list",
        "--state",
        state,
        "--limit",
        limit,
        "--json",
        PR_LIST_FIELDS,
    ];
    args.extend_from_slice(extra);
    gh::run_json(dir, &args)
}

pub(crate) fn map_pr_list(
    list: &serde_json::Value,
    repo: &str,
    review_requested: bool,
) -> Vec<PrInput> {
    let Some(items) = list.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let number = item.get("number").and_then(|v| v.as_i64())?;
            Some(PrInput {
                repo: repo.to_string(),
                number,
                title: str_field(item, "title"),
                branch: str_field(item, "headRefName"),
                state: PrState::parse(&str_field(item, "state")),
                checks: checks_status(
                    item.get("statusCheckRollup").unwrap_or(&serde_json::Value::Null),
                ),
                review_state: if review_requested {
                    ReviewState::Requested
                } else {
                    review_decision_state(
                        item.get("reviewDecision").and_then(|v| v.as_str()).unwrap_or_default(),
                    )
                },
                url: str_field(item, "url"),
                updated_ts: parse_iso_ms(
                    item.get("updatedAt").and_then(|v| v.as_str()).unwrap_or_default(),
                ),
                base_branch: str_field(item, "baseRefName"),
            })
        })
        .collect()
}

/// Map GitHub's `reviewDecision` to a stored `review_state` for an authored PR.
///
/// `reviewDecision` is `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or
/// empty (no reviews required). Anything else maps to no verdict, so an authored
/// PR with no verdict stays indistinguishable from a quiet one.
fn review_decision_state(decision: &str) -> ReviewState {
    match ReviewState::parse(decision) {
        verdict @ (ReviewState::Approved
        | ReviewState::ChangesRequested
        | ReviewState::ReviewRequired) => verdict,
        _ => ReviewState::None,
    }
}

pub(crate) fn str_field(item: &serde_json::Value, key: &str) -> String {
    item.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string()
}

/// Summarize a `statusCheckRollup` array into a [`ChecksState`].
///
/// Empty/absent rollup is `None`. Any failing conclusion wins. Any missing or
/// unrecognized (in-progress) conclusion is `Pending`. Otherwise all checks are
/// success-like and the rollup is `Passing`.
pub(crate) fn checks_status(rollup: &serde_json::Value) -> ChecksState {
    let Some(checks) = rollup.as_array() else {
        return ChecksState::None;
    };
    if checks.is_empty() {
        return ChecksState::None;
    }
    let mut any_pending = false;
    for check in checks {
        let verdict = check
            .get("conclusion")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| check.get("state").and_then(|v| v.as_str()));
        match verdict.map(str::to_ascii_uppercase).as_deref() {
            Some("SUCCESS") | Some("NEUTRAL") | Some("SKIPPED") => {}
            Some("FAILURE") | Some("ERROR") | Some("CANCELLED") | Some("TIMED_OUT") => {
                return ChecksState::Failing;
            }
            _ => any_pending = true,
        }
    }
    if any_pending { ChecksState::Pending } else { ChecksState::Passing }
}

/// Parse an RFC 3339 / ISO-8601 timestamp to epoch milliseconds; 0 on failure.
pub(crate) fn parse_iso_ms(s: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(s).map(|dt| dt.timestamp_millis()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn checks_status_covers_each_state() {
        assert_eq!(checks_status(&json!([])), ChecksState::None);
        assert_eq!(checks_status(&serde_json::Value::Null), ChecksState::None);
        assert_eq!(
            checks_status(&json!([{"conclusion": "SUCCESS"}, {"conclusion": "SKIPPED"}])),
            ChecksState::Passing
        );
        assert_eq!(
            checks_status(&json!([{"conclusion": "SUCCESS"}, {"conclusion": "FAILURE"}])),
            ChecksState::Failing
        );
        assert_eq!(
            checks_status(&json!([{"conclusion": "SUCCESS"}, {"status": "IN_PROGRESS"}])),
            ChecksState::Pending
        );
        assert_eq!(
            checks_status(&json!([{"status": "IN_PROGRESS"}, {"conclusion": "ERROR"}])),
            ChecksState::Failing
        );
        assert_eq!(checks_status(&json!([{"state": "SUCCESS"}])), ChecksState::Passing);
    }

    #[test]
    fn map_pr_list_maps_fields_and_review_state() {
        let list = json!([{
            "number": 42,
            "title": "Fix the thing",
            "headRefName": "feat/thing",
            "baseRefName": "release/2.0",
            "state": "OPEN",
            "statusCheckRollup": [{"conclusion": "SUCCESS"}],
            "reviewDecision": "",
            "url": "https://github.com/o/r/pull/42",
            "updatedAt": "2024-01-02T03:04:05Z"
        }]);
        let prs = map_pr_list(&list, "o/r", false);
        assert_eq!(prs.len(), 1);
        let pr = &prs[0];
        assert_eq!(pr.repo, "o/r");
        assert_eq!(pr.number, 42);
        assert_eq!(pr.title, "Fix the thing");
        assert_eq!(pr.branch, "feat/thing");
        assert_eq!(pr.base_branch, "release/2.0");
        assert_eq!(pr.state, PrState::Open);
        assert_eq!(pr.checks, ChecksState::Passing);
        assert_eq!(pr.review_state, ReviewState::None);
        assert_eq!(pr.url, "https://github.com/o/r/pull/42");
        assert_eq!(pr.updated_ts, 1704164645000);

        let review = map_pr_list(&list, "o/r", true);
        assert_eq!(review[0].review_state, ReviewState::Requested);
    }

    #[test]
    fn map_pr_list_lowercases_a_merged_state() {
        let list = json!([{
            "number": 6,
            "title": "Merged thing",
            "headRefName": "feat/thing",
            "state": "MERGED",
            "statusCheckRollup": [{"conclusion": "SUCCESS"}],
            "reviewDecision": "",
            "url": "https://github.com/o/r/pull/6",
            "updatedAt": "2024-01-02T03:04:05Z"
        }]);
        assert_eq!(map_pr_list(&list, "o/r", false)[0].state, PrState::Merged);
    }

    #[test]
    fn review_decision_state_maps_each_verdict() {
        assert_eq!(review_decision_state("APPROVED"), ReviewState::Approved);
        assert_eq!(review_decision_state("CHANGES_REQUESTED"), ReviewState::ChangesRequested);
        assert_eq!(review_decision_state("REVIEW_REQUIRED"), ReviewState::ReviewRequired);
        assert_eq!(review_decision_state(""), ReviewState::None);
        assert_eq!(review_decision_state("SOMETHING_ELSE"), ReviewState::None);
    }

    #[test]
    fn map_pr_list_derives_authored_review_state_from_decision() {
        let row = |decision: &str| {
            json!([{
                "number": 1,
                "title": "t",
                "headRefName": "b",
                "state": "OPEN",
                "statusCheckRollup": [],
                "reviewDecision": decision,
                "url": "u",
                "updatedAt": "2024-01-02T03:04:05Z"
            }])
        };
        assert_eq!(
            map_pr_list(&row("APPROVED"), "o/r", false)[0].review_state,
            ReviewState::Approved
        );
        assert_eq!(
            map_pr_list(&row("CHANGES_REQUESTED"), "o/r", false)[0].review_state,
            ReviewState::ChangesRequested
        );
        assert_eq!(
            map_pr_list(&row("REVIEW_REQUIRED"), "o/r", false)[0].review_state,
            ReviewState::ReviewRequired
        );
        assert_eq!(
            map_pr_list(&row("APPROVED"), "o/r", true)[0].review_state,
            ReviewState::Requested
        );
    }

    #[test]
    fn map_pr_list_skips_entries_without_number_and_handles_non_array() {
        let list = json!([{"title": "no number"}, {"number": 7, "state": "OPEN"}]);
        let prs = map_pr_list(&list, "o/r", false);
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].number, 7);
        assert!(map_pr_list(&json!({"message": "boom"}), "o/r", false).is_empty());
    }

    #[test]
    fn parse_iso_ms_is_zero_on_garbage() {
        assert_eq!(parse_iso_ms("not a date"), 0);
        assert_eq!(parse_iso_ms(""), 0);
        assert_eq!(parse_iso_ms("2024-01-02T03:04:05Z"), 1704164645000);
    }
}
