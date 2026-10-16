//! Pull requests as a task source: a review task checks out an open PR's existing
//! head instead of branching new work. `gh` answers what the PR *is*; git does the
//! checkout ([`crate::ops::create_task`]). The JSON mapping is pure so it tests
//! without `gh`.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

const GH_TIMEOUT: Duration = Duration::from_secs(30);
const VIEW_FIELDS: &str = "number,title,url,state,isDraft,headRefName,baseRefName,isCrossRepository,headRepositoryOwner,author";
/// `gh`'s cheap GraphQL page band — see `tt_collect::gh::LIST_LIMIT`.
const LIST_LIMIT: &str = "60";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub is_draft: bool,
    pub head_branch: String,
    pub base_branch: String,
    /// Opened from a fork, so its head is not a branch of `origin`.
    pub cross_repository: bool,
    pub head_owner: String,
    pub author: String,
}

impl PullRequest {
    /// The local branch a review task checks out: the head's own name, so pushes
    /// and the board's PR matching line up. A fork's head is prefixed with its owner
    /// (`gh pr checkout`'s convention) — a fork's `main` must not become ours.
    pub fn local_branch(&self) -> String {
        if self.cross_repository && !self.head_owner.is_empty() {
            format!("{}/{}", self.head_owner, self.head_branch)
        } else {
            self.head_branch.clone()
        }
    }

    /// `owner/name`, read off the PR's URL — the board's PR-link key.
    pub fn repo(&self) -> Option<String> {
        repo_of(&self.url)
    }

    pub fn is_open(&self) -> bool {
        self.state.eq_ignore_ascii_case("open")
    }
}

/// `owner/name` from a GitHub item URL (`https://github.com/o/r/pull/42`, `.../issues/7`).
pub(crate) fn repo_of(url: &str) -> Option<String> {
    let path = url.split("://").nth(1)?.split_once('/')?.1;
    let mut parts = path.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    (!owner.is_empty() && !name.is_empty()).then(|| format!("{owner}/{name}"))
}

pub(crate) fn str_field(value: &serde_json::Value, key: &str) -> String {
    value.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string()
}

fn login(value: &serde_json::Value, key: &str) -> String {
    value.get(key).map(|v| str_field(v, "login")).unwrap_or_default()
}

/// One `gh pr view`/`gh pr list` object. `None` without a number or head branch —
/// nothing could be checked out.
pub fn parse_pr(value: &serde_json::Value) -> Option<PullRequest> {
    let number = value.get("number")?.as_u64()?;
    let head_branch = str_field(value, "headRefName");
    if head_branch.is_empty() {
        return None;
    }
    Some(PullRequest {
        number,
        title: str_field(value, "title"),
        url: str_field(value, "url"),
        state: str_field(value, "state"),
        is_draft: value.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false),
        head_branch,
        base_branch: str_field(value, "baseRefName"),
        cross_repository: value.get("isCrossRepository").and_then(|v| v.as_bool()).unwrap_or(false),
        head_owner: login(value, "headRepositoryOwner"),
        author: login(value, "author"),
    })
}

pub(crate) fn gh_json(checkout: &Path, args: &[&str]) -> Result<serde_json::Value, String> {
    let out = tt_exec::run_in_dir_with_timeout("gh", args, checkout, GH_TIMEOUT)
        .map_err(|e| format!("could not run gh: {e}"))?;
    if !out.ok() {
        return Err(format!("gh {}: {}", args[..2].join(" "), out.stderr.trim()));
    }
    serde_json::from_str(&out.stdout).map_err(|e| format!("invalid gh JSON: {e}"))
}

/// Look up PR `number` in the repo `checkout` belongs to.
pub fn view(checkout: &Path, number: u64) -> Result<PullRequest, String> {
    let n = number.to_string();
    let value = gh_json(checkout, &["pr", "view", &n, "--json", VIEW_FIELDS])?;
    parse_pr(&value).ok_or_else(|| format!("gh returned no usable head branch for PR #{number}"))
}

/// Open PRs, newest first — the review picker's list.
pub fn list_open(checkout: &Path) -> Result<Vec<PullRequest>, String> {
    let value = gh_json(
        checkout,
        &[
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            LIST_LIMIT,
            "--json",
            VIEW_FIELDS,
        ],
    )?;
    Ok(value.as_array().map(|list| list.iter().filter_map(parse_pr).collect()).unwrap_or_default())
}

/// Open PRs whose head is `branch` — what still has to merge before a task is finished.
pub fn list_open_for_head(checkout: &Path, branch: &str) -> Result<Vec<PullRequest>, String> {
    let value = gh_json(
        checkout,
        &[
            "pr",
            "list",
            "--state",
            "open",
            "--head",
            branch,
            "--json",
            VIEW_FIELDS,
        ],
    )?;
    Ok(value.as_array().map(|list| list.iter().filter_map(parse_pr).collect()).unwrap_or_default())
}

const MERGED_HEADS_QUERY: &str = "query($owner:String!,$name:String!,$head:String!){repository(owner:$owner,name:$name){pullRequests(headRefName:$head,states:MERGED,first:10){nodes{headRefOid timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT],first:50){nodes{...on HeadRefForcePushedEvent{beforeCommit{oid}}}}}}}}";

/// Every head a merged PR from `branch` ever had: its final one, plus each one a
/// force-push replaced. A local tip reachable from any of them was part of a PR its
/// owner chose to merge, whatever the rebase before the squash did to the content.
pub fn merged_pr_heads(checkout: &Path, branch: &str) -> Result<Vec<String>, String> {
    let query = format!("query={MERGED_HEADS_QUERY}");
    let head = format!("head={branch}");
    let value = gh_json(
        checkout,
        &[
            "api",
            "graphql",
            "-f",
            &query,
            "-F",
            "owner={owner}",
            "-F",
            "name={repo}",
            "-f",
            &head,
        ],
    )?;
    Ok(parse_merged_heads(&value))
}

pub fn parse_merged_heads(value: &serde_json::Value) -> Vec<String> {
    let prs = value
        .pointer("/data/repository/pullRequests/nodes")
        .and_then(|v| v.as_array())
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut heads = Vec::new();
    for pr in prs {
        heads.push(str_field(pr, "headRefOid"));
        let pushes = pr
            .pointer("/timelineItems/nodes")
            .and_then(|v| v.as_array())
            .map(Vec::as_slice)
            .unwrap_or_default();
        heads.extend(pushes.iter().filter_map(|push| {
            push.pointer("/beforeCommit/oid").and_then(|v| v.as_str()).map(str::to_string)
        }));
    }
    heads.retain(|oid| !oid.is_empty());
    heads
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(cross: bool) -> serde_json::Value {
        json!({
            "number": 42,
            "title": "Fix the thing",
            "url": "https://github.com/o/r/pull/42",
            "state": "OPEN",
            "isDraft": true,
            "headRefName": "feat/thing",
            "baseRefName": "main",
            "isCrossRepository": cross,
            "headRepositoryOwner": { "login": "someone" },
            "author": { "login": "someone" }
        })
    }

    #[test]
    fn parses_a_same_repo_pr_onto_its_own_branch() {
        let pr = parse_pr(&fixture(false)).unwrap();
        assert_eq!(pr.number, 42);
        assert!(pr.is_open() && pr.is_draft);
        assert_eq!(pr.base_branch, "main");
        assert_eq!(pr.local_branch(), "feat/thing");
        assert_eq!(pr.repo().as_deref(), Some("o/r"));
    }

    #[test]
    fn prefixes_a_fork_head_with_its_owner() {
        let pr = parse_pr(&fixture(true)).unwrap();
        assert_eq!(pr.local_branch(), "someone/feat/thing");
    }

    #[test]
    fn rejects_a_pr_without_a_head_branch() {
        assert!(parse_pr(&json!({ "number": 1, "headRefName": "" })).is_none());
        assert!(parse_pr(&json!({ "headRefName": "x" })).is_none());
    }

    #[test]
    fn merged_is_not_open() {
        let mut value = fixture(false);
        value["state"] = json!("MERGED");
        assert!(!parse_pr(&value).unwrap().is_open());
    }

    #[test]
    fn merged_heads_include_every_force_pushed_before() {
        let value = json!({ "data": { "repository": { "pullRequests": { "nodes": [
            { "headRefOid": "final", "timelineItems": { "nodes": [
                { "beforeCommit": { "oid": "before1" } },
                {},
                { "beforeCommit": { "oid": "before2" } }
            ] } }
        ] } } } });
        assert_eq!(parse_merged_heads(&value), ["final", "before1", "before2"]);
    }

    #[test]
    fn no_merged_pr_yields_no_heads() {
        let value = json!({ "data": { "repository": { "pullRequests": { "nodes": [] } } } });
        assert!(parse_merged_heads(&value).is_empty());
        assert!(parse_merged_heads(&json!({})).is_empty());
    }
}
