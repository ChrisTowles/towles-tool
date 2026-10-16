//! The Claude mod's end-of-turn clipboard question: which strings of the agent's last
//! message the user would paste next. The question is the user's; this is its context
//! and the guard that keeps every offered string one the agent actually printed.

/// The question's answer contract.
pub const CLIP_SCHEMA: &str = r#"{"type":"object","properties":{"items":{"type":"array","items":{"type":"object","properties":{"label":{"type":"string"},"text":{"type":"string"}},"required":["label","text"]}}},"required":["items"]}"#;

pub const MAX_ITEMS: usize = 3;
const ANSWER_MAX_CHARS: usize = 4000;
const LABEL_MAX_CHARS: usize = 40;

#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct ClipItem {
    pub label: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct ClipAnswer {
    pub items: Vec<ClipItem>,
}

fn tail(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.trim().chars().collect();
    chars[chars.len().saturating_sub(max)..].iter().collect()
}

/// The user's question (editable in settings) followed by what it is asked about.
pub fn clip_prompt(question: &str, goal: Option<&str>, answer: &str) -> String {
    let mut out = question.trim().to_string();
    if let Some(goal) = goal.map(str::trim).filter(|g| !g.is_empty()) {
        out.push_str(&format!("\n\n## The task\n\n{goal}"));
    }
    out.push_str(&format!("\n\n## The agent's last message\n\n{}", tail(answer, ANSWER_MAX_CHARS)));
    out
}

/// Whether a message holds anything a clipboard question could find: a code span, a link,
/// a path or an issue ref. Plain prose skips the model call.
pub fn worth_asking(answer: &str) -> bool {
    answer.contains('`')
        || answer.contains("://")
        || answer.split_whitespace().any(|w| {
            w.starts_with('/') && w.len() > 1
                || w.starts_with('#') && w[1..].starts_with(|c: char| c.is_ascii_digit())
        })
}

/// Only strings that appear verbatim in the message survive, deduplicated, at most
/// [`MAX_ITEMS`]: a model that paraphrases a command must not put the paraphrase on the
/// clipboard.
pub fn grounded(items: Vec<ClipItem>, answer: &str) -> Vec<ClipItem> {
    let mut kept: Vec<ClipItem> = Vec::new();
    for item in items {
        let text = item.text.trim().to_string();
        if text.is_empty() || !answer.contains(&text) || kept.iter().any(|k| k.text == text) {
            continue;
        }
        let label: String = item.label.trim().chars().take(LABEL_MAX_CHARS).collect();
        let label =
            if label.is_empty() { text.chars().take(LABEL_MAX_CHARS).collect() } else { label };
        kept.push(ClipItem { label, text });
        if kept.len() == MAX_ITEMS {
            break;
        }
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(label: &str, text: &str) -> ClipItem {
        ClipItem { label: label.to_string(), text: text.to_string() }
    }

    #[test]
    fn prose_skips_the_call_and_anything_copyable_asks() {
        assert!(!worth_asking("Done. The tests pass and nothing else changed."));
        assert!(worth_asking("Run `cargo test -p tt-store`."));
        assert!(worth_asking("Opened https://github.com/o/r/pull/9"));
        assert!(worth_asking("See PR #745 for the rest."));
        assert!(worth_asking("Wrote /tmp/out/report.html"));
        assert!(!worth_asking("Tagged as # and / alone"));
    }

    #[test]
    fn only_verbatim_strings_survive_deduped_and_capped() {
        let answer =
            "Run `bun run e2e` then open https://x.dev/pr/1 and https://x.dev/pr/2 and /tmp/a";
        let items = vec![
            item("e2e", " bun run e2e "),
            item("paraphrase", "bun run test:e2e"),
            item("again", "bun run e2e"),
            item("", "https://x.dev/pr/1"),
            item("pr 2", "https://x.dev/pr/2"),
            item("path", "/tmp/a"),
        ];
        let kept = grounded(items, answer);
        let texts: Vec<&str> = kept.iter().map(|k| k.text.as_str()).collect();
        assert_eq!(texts, ["bun run e2e", "https://x.dev/pr/1", "https://x.dev/pr/2"]);
        assert_eq!(kept[1].label, "https://x.dev/pr/1");
    }

    #[test]
    fn the_prompt_leads_with_the_question_then_the_goal_and_message() {
        let prompt = clip_prompt(" Which? ", Some("ship the mod"), "x".repeat(5000).as_str());
        assert!(prompt.starts_with("Which?\n\n## The task\n\nship the mod"));
        assert!(prompt.ends_with(&"x".repeat(ANSWER_MAX_CHARS)));
        assert!(!clip_prompt("Q", Some("  "), "a").contains("## The task"));
    }
}
