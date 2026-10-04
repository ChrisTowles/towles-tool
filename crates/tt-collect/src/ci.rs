//! `gh`-backed CI collector: the latest default-branch Actions run per workflow
//! for each tracked repo — what tells the Cockpit a nightly has been red for a
//! week. Rides the open-PR sweep's cadence. The JSON-to-[`CiRun`] mapping is pure
//! ([`latest_per_workflow`]) so it tests without `gh`.

use std::collections::BTreeMap;
use std::path::Path;

use tt_store::CiRun;

use crate::gh;
use crate::prs::{parse_iso_ms, str_field};

const RUN_LIST_FIELDS: &str =
    "workflowName,name,status,conclusion,createdAt,updatedAt,url,headSha,event";

/// Newest first from `gh`. Deep enough that a once-a-day workflow still shows up
/// behind a busy day's pushes; when it doesn't, the store keeps its last known run.
const RUN_LIST_LIMIT: &str = "50";

/// The latest run of every workflow on `dir`'s default branch, with the repo's
/// `owner/name`. A repo without Actions is an empty result, not an error.
pub(crate) fn collect_repo_ci(dir: &Path) -> Result<(String, Vec<CiRun>), String> {
    let repo = gh::repo_name_with_owner(dir)?;
    let branch = gh::repo_default_branch(dir)?;
    let args = [
        "run",
        "list",
        "--repo",
        &repo,
        "--branch",
        &branch,
        "--limit",
        RUN_LIST_LIMIT,
        "--json",
        RUN_LIST_FIELDS,
    ];
    match gh::run_json(dir, &args) {
        Ok(list) => {
            let runs = latest_per_workflow(&list, &repo);
            Ok((repo, runs))
        }
        Err(e) if no_actions(&e) => Ok((repo, Vec::new())),
        Err(e) => Err(e),
    }
}

/// GitHub answers a repo that never enabled Actions with a 404, which `gh` relays
/// as a failure; that is "no runs", not a broken sweep.
fn no_actions(error: &str) -> bool {
    let e = error.to_ascii_lowercase();
    e.contains("http 404") || e.contains("not found") || e.contains("could not find any workflows")
}

/// One [`CiRun`] per workflow name, keeping the most recently created run, sorted by
/// workflow. Rows without a workflow name are skipped; a run still in flight has an
/// empty `conclusion`.
pub(crate) fn latest_per_workflow(list: &serde_json::Value, repo: &str) -> Vec<CiRun> {
    let Some(items) = list.as_array() else {
        return Vec::new();
    };
    let mut latest: BTreeMap<String, CiRun> = BTreeMap::new();
    for item in items {
        let mut workflow = str_field(item, "workflowName");
        if workflow.is_empty() {
            workflow = str_field(item, "name");
        }
        if workflow.is_empty() {
            continue;
        }
        let run = CiRun {
            repo: repo.to_string(),
            workflow: workflow.clone(),
            status: str_field(item, "status").to_ascii_lowercase(),
            conclusion: str_field(item, "conclusion").to_ascii_lowercase(),
            created_ms: parse_iso_ms(&str_field(item, "createdAt")),
            updated_ms: parse_iso_ms(&str_field(item, "updatedAt")),
            url: str_field(item, "url"),
            head_sha: str_field(item, "headSha"),
            event: str_field(item, "event"),
        };
        match latest.get(&workflow) {
            Some(seen) if seen.created_ms >= run.created_ms => {}
            _ => {
                latest.insert(workflow, run);
            }
        }
    }
    latest.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(
        workflow: &str,
        created: &str,
        status: &str,
        conclusion: Option<&str>,
    ) -> serde_json::Value {
        json!({
            "workflowName": workflow,
            "name": workflow,
            "status": status,
            "conclusion": conclusion,
            "createdAt": created,
            "updatedAt": created,
            "url": format!("https://github.com/o/r/actions/runs/{}", created.len()),
            "headSha": "abc123",
            "event": "schedule"
        })
    }

    #[test]
    fn keeps_the_newest_run_per_workflow_sorted_by_name() {
        let list = json!([
            run("Nightly", "2026-10-03T06:00:00Z", "completed", Some("failure")),
            run("CI", "2026-10-03T05:00:00Z", "completed", Some("success")),
            run("Nightly", "2026-10-02T06:00:00Z", "completed", Some("success")),
            run("CI", "2026-10-03T07:00:00Z", "in_progress", None),
        ]);
        let runs = latest_per_workflow(&list, "o/r");
        assert_eq!(runs.len(), 2);
        assert_eq!((runs[0].workflow.as_str(), runs[0].status.as_str()), ("CI", "in_progress"));
        assert_eq!(runs[0].conclusion, "", "an in-flight run has no conclusion yet");
        assert_eq!(runs[0].created_ms, 1_791_010_800_000, "2026-10-03T07:00:00Z");
        assert_eq!(
            (runs[1].workflow.as_str(), runs[1].conclusion.as_str()),
            ("Nightly", "failure")
        );
        assert_eq!(runs[1].repo, "o/r");
        assert_eq!(runs[1].event, "schedule");
    }

    #[test]
    fn skips_rows_without_a_workflow_and_tolerates_a_non_array() {
        let list = json!([{ "status": "completed" }, run("CI", "2026-10-03T05:00:00Z", "completed", Some("SUCCESS"))]);
        let runs = latest_per_workflow(&list, "o/r");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].conclusion, "success", "GitHub casing is normalized");
        assert!(latest_per_workflow(&json!({ "message": "boom" }), "o/r").is_empty());
    }

    #[test]
    fn a_repo_without_actions_is_not_an_error() {
        assert!(no_actions(
            "gh run failed in /x: HTTP 404: Not Found (https://api.github.com/...)"
        ));
        assert!(!no_actions("gh run failed in /x: HTTP 401: Bad credentials"));
    }
}
