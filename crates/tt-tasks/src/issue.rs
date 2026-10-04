//! Issues as a task source: `tt task new --issue` branches new work for an open
//! issue, titled after it and linked to it on the board. `gh` answers what the
//! issue *is*; the naming rules live in [`crate::ops::IssueTask`]. The JSON mapping
//! is pure so it tests without `gh`.

use std::path::Path;

use serde::Serialize;

use crate::pr::{gh_json, repo_of, str_field};

const VIEW_FIELDS: &str = "number,title,url,state";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
}

impl Issue {
    /// `owner/name`, read off the issue's URL — the board's issue-link key.
    pub fn repo(&self) -> Option<String> {
        repo_of(&self.url)
    }

    pub fn is_open(&self) -> bool {
        self.state.eq_ignore_ascii_case("open")
    }
}

/// One `gh issue view` object. `None` without a number.
pub fn parse_issue(value: &serde_json::Value) -> Option<Issue> {
    let number = value.get("number")?.as_u64()?;
    Some(Issue {
        number,
        title: str_field(value, "title"),
        url: str_field(value, "url"),
        state: str_field(value, "state"),
    })
}

/// Look up issue `number` in the repo `checkout` belongs to.
pub fn view(checkout: &Path, number: u64) -> Result<Issue, String> {
    let n = number.to_string();
    let value = gh_json(checkout, &["issue", "view", &n, "--json", VIEW_FIELDS])?;
    parse_issue(&value).ok_or_else(|| format!("gh returned no issue #{number}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_an_open_issue_and_its_repo() {
        let issue = parse_issue(&json!({
            "number": 7,
            "title": "Do the thing",
            "url": "https://github.com/o/r/issues/7",
            "state": "OPEN"
        }))
        .unwrap();
        assert_eq!(issue.number, 7);
        assert!(issue.is_open());
        assert_eq!(issue.repo().as_deref(), Some("o/r"));
    }

    #[test]
    fn closed_is_not_open_and_a_missing_number_is_no_issue() {
        let closed = parse_issue(&json!({ "number": 1, "state": "CLOSED" })).unwrap();
        assert!(!closed.is_open());
        assert!(parse_issue(&json!({ "title": "no number" })).is_none());
    }
}
