//! `~/.claude/history.jsonl`: one line per prompt typed into Claude Code, across
//! every project — the user's own phrasing, which is what autocomplete learns from.

use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryPrompt {
    pub text: String,
    /// The directory `claude` ran in, when the line recorded one.
    pub project: Option<String>,
}

#[derive(Deserialize)]
struct Line {
    display: Option<String>,
    project: Option<String>,
}

/// Malformed lines and slash commands (`/clear`, `/model opus`) are skipped.
pub fn parse_history(jsonl: &str) -> Vec<HistoryPrompt> {
    jsonl
        .lines()
        .filter_map(|l| serde_json::from_str::<Line>(l).ok())
        .filter_map(|l| {
            let text = l.display?;
            let trimmed = text.trim_start();
            let typed = !trimmed.is_empty() && !trimmed.starts_with('/');
            typed.then_some(HistoryPrompt { text, project: l.project })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_typed_prompts_and_skips_commands_and_junk() {
        let jsonl = [
            r#"{"display":"fix the rail","project":"/r","timestamp":1}"#,
            r#"{"display":"/clear","project":"/r"}"#,
            "not json",
            r#"{"display":"no project"}"#,
        ]
        .join("\n");
        assert_eq!(
            parse_history(&jsonl),
            vec![
                HistoryPrompt { text: "fix the rail".into(), project: Some("/r".into()) },
                HistoryPrompt { text: "no project".into(), project: None },
            ]
        );
    }
}
