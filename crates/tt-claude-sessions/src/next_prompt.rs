//! Next-prompt suggestions from the user's own history. The transcripts say what the user
//! typed after a turn that ended the way this one did; those prompts and a profile of their
//! work are the context of one Haiku question, assembled here and run by the app.
//!
//! A frequency lookup alone (no model) was measured over 30 days of real transcripts and
//! guessed the next prompt about 1% of the time, so it is context, never a suggestion.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use tt_claude_code::{TranscriptEntry, parse_transcript_file, session_is_programmatic};

use crate::ledger::{Candidate, collect_candidates};

/// Only short single-line prompts are kept as examples; long ones still count toward a bucket.
const SUGGESTABLE_MAX_CHARS: usize = 120;
/// Of the agent's last message, what the question carries.
pub const ANSWER_MAX_CHARS: usize = 2_000;

/// Housekeeping commands, never a next step worth suggesting.
const SKIPPED_COMMANDS: &[&str] = &[
    "/login",
    "/logout",
    "/exit",
    "/resume",
    "/model",
    "/config",
    "/plugin",
    "/mcp",
    "/status",
    "/cost",
    "/help",
    "/doctor",
    "/usage",
    "/permissions",
    "/hooks",
    "/ide",
];

/// What one agent turn did: reported live by the Claude mod, rebuilt from a transcript after.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TurnFacts {
    pub tools: Vec<String>,
    /// The Bash commands the turn ran.
    pub commands: Vec<String>,
    /// The agent's final visible text.
    pub answer: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    PrOpened,
    Committed,
    Previewed,
    Edited,
    Ran,
    Talked,
}

impl Action {
    fn label(self) -> &'static str {
        match self {
            Action::PrOpened => "open a PR",
            Action::Committed => "commit",
            Action::Previewed => "show a preview",
            Action::Edited => "edit code",
            Action::Ran => "run commands",
            Action::Talked => "only talk",
        }
    }
}

/// How a turn ended, which is what the next prompt depends on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub action: Action,
    /// The agent's last paragraph asked something.
    pub asked: bool,
}

pub fn bucket(facts: &TurnFacts) -> Bucket {
    let ran = |needle: &str| facts.commands.iter().any(|c| c.contains(needle));
    let used = |names: &[&str]| facts.tools.iter().any(|t| names.contains(&t.as_str()));
    let action = if ran("gh pr create") {
        Action::PrOpened
    } else if ran("git commit") {
        Action::Committed
    } else if facts.tools.iter().any(|t| t.ends_with("preview_file")) {
        Action::Previewed
    } else if used(&["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
        Action::Edited
    } else if used(&["Bash"]) {
        Action::Ran
    } else {
        Action::Talked
    };
    let last_paragraph = facts.answer.trim_end().rsplit("\n\n").next().unwrap_or_default();
    Bucket { action, asked: last_paragraph.contains('?') }
}

/// The counting key: case and whitespace runs don't make two prompts different.
pub fn normalize(prompt: &str) -> String {
    prompt.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// One prompt the user typed, and how the turn before it ended.
#[derive(Debug, Clone, PartialEq)]
pub struct Example {
    pub bucket: Bucket,
    pub prompt: String,
}

/// A typed slash command as its transcript envelope records it, `/name args`.
fn slash_command(text: &str) -> Option<String> {
    let between = |open: &str, close: &str| {
        let start = text.find(open)? + open.len();
        let end = text[start..].find(close)? + start;
        Some(text[start..end].trim().to_string())
    };
    let name = between("<command-name>", "</command-name>")?;
    let args = between("<command-args>", "</command-args>").unwrap_or_default();
    Some(if args.is_empty() { name } else { format!("{name} {args}") })
}

/// The text the human typed on this line, if it is a human line at all.
fn human_text(entry: &TranscriptEntry) -> Option<String> {
    if entry.entry_type != "user"
        || entry.is_sidechain == Some(true)
        || entry.is_meta == Some(true)
        || entry.is_compact_summary == Some(true)
    {
        return None;
    }
    let message = entry.message.as_ref()?;
    if message.role.as_deref() != Some("user") {
        return None;
    }
    let content = message.content.as_ref()?;
    let text = match content.as_text() {
        Some(text) => text.to_string(),
        None => content.text_blocks().collect::<Vec<_>>().join("\n"),
    };
    if text.trim_start().starts_with("<command-") {
        return slash_command(&text);
    }
    (!tt_claude_code::prompts::is_noise(&text)).then(|| text.trim().to_string())
}

/// Each human prompt that followed an agent turn, with that turn's bucket.
pub fn examples_from_transcript(entries: &[TranscriptEntry]) -> Vec<Example> {
    let mut out = Vec::new();
    let mut facts = TurnFacts::default();
    let mut saw_agent = false;
    for entry in entries {
        if entry.entry_type == "assistant" && entry.is_sidechain != Some(true) {
            let Some(content) = entry.message.as_ref().and_then(|m| m.content.as_ref()) else {
                continue;
            };
            saw_agent = true;
            for tool in content.tool_uses() {
                let Some(name) = tool.name() else { continue };
                if name == "Bash"
                    && let Some(cmd) = tool.input().and_then(|i| i.get("command"))
                {
                    facts.commands.push(cmd.as_str().unwrap_or_default().to_string());
                }
                facts.tools.push(name.to_string());
            }
            if let Some(text) = content.text_blocks().last() {
                facts.answer = text.to_string();
            }
            continue;
        }
        let Some(prompt) = human_text(entry) else {
            continue;
        };
        if saw_agent && !prompt.is_empty() {
            out.push(Example { bucket: bucket(&facts), prompt });
        }
        facts = TurnFacts::default();
        saw_agent = false;
    }
    out
}

/// Every interactive session's examples from transcripts modified in the last `days`,
/// oldest session first.
pub fn corpus(projects_dir: &Path, days: f64, now_ms: i64) -> crate::Result<Vec<Example>> {
    let cutoff_ms = crate::parser::calculate_cutoff_ms(days, now_ms);
    let mut candidates: Vec<Candidate> = Vec::new();
    for project in std::fs::read_dir(projects_dir)? {
        let project = project?;
        if project.path().is_dir() {
            collect_candidates(&project.path(), cutoff_ms, &mut candidates)?;
        }
    }
    candidates.sort_by_key(|c| c.mtime);
    let mut out = Vec::new();
    for candidate in candidates {
        let entries = parse_transcript_file(&candidate.path);
        if !session_is_programmatic(&entries) {
            out.extend(examples_from_transcript(&entries));
        }
    }
    Ok(out)
}

fn suggestable(prompt: &str) -> bool {
    let first = prompt.split_whitespace().next().unwrap_or_default();
    prompt.chars().count() <= SUGGESTABLE_MAX_CHARS
        && !prompt.contains('\n')
        && !SKIPPED_COMMANDS.contains(&first)
}

#[derive(Debug, Default, Clone)]
struct BucketCounts {
    total: u32,
    /// Normalized prompt → (latest spelling, count).
    prompts: HashMap<String, (String, u32)>,
}

impl BucketCounts {
    fn ranked(&self) -> Vec<(&str, u32)> {
        let mut ranked: Vec<(&str, u32)> =
            self.prompts.values().map(|(text, n)| (text.as_str(), *n)).collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        ranked
    }
}

/// Per bucket, how often each short prompt followed it.
#[derive(Debug, Default, Clone)]
pub struct History {
    buckets: HashMap<Bucket, BucketCounts>,
}

impl History {
    pub fn from_examples(examples: &[Example]) -> History {
        let mut history = History::default();
        for example in examples {
            history.observe(example);
        }
        history
    }

    pub fn observe(&mut self, example: &Example) {
        let counts = self.buckets.entry(example.bucket).or_default();
        counts.total += 1;
        if suggestable(&example.prompt) {
            let entry =
                counts.prompts.entry(normalize(&example.prompt)).or_insert((String::new(), 0));
            entry.0 = example.prompt.clone();
            entry.1 += 1;
        }
    }

    /// The bucket's most frequent short prompts: examples of what this user tends to say next.
    pub fn similar(&self, bucket: Bucket, n: usize) -> Vec<String> {
        self.buckets.get(&bucket).map_or_else(Vec::new, |counts| {
            counts.ranked().into_iter().take(n).map(|(t, _)| t.to_string()).collect()
        })
    }
}

/// The kind of work the user does, from the same corpus; one line of the question's context.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkProfile {
    pub turns: u32,
    pub actions: Vec<(Action, u32)>,
    pub top_commands: Vec<(String, u32)>,
}

pub fn work_profile(examples: &[Example]) -> WorkProfile {
    let mut actions: HashMap<Action, u32> = HashMap::new();
    let mut commands: HashMap<String, u32> = HashMap::new();
    for example in examples {
        *actions.entry(example.bucket.action).or_default() += 1;
        if let Some(name) =
            example.prompt.strip_prefix('/').and_then(|p| p.split_whitespace().next())
            && suggestable(&example.prompt)
        {
            *commands.entry(format!("/{name}")).or_default() += 1;
        }
    }
    let mut actions: Vec<(Action, u32)> = actions.into_iter().collect();
    actions.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let mut top_commands: Vec<(String, u32)> = commands.into_iter().collect();
    top_commands.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    top_commands.truncate(5);
    WorkProfile { turns: examples.len() as u32, actions, top_commands }
}

impl WorkProfile {
    pub fn line(&self) -> String {
        if self.turns == 0 {
            return String::new();
        }
        let shares: Vec<String> = self
            .actions
            .iter()
            .take(3)
            .map(|(a, n)| format!("{}% {}", n * 100 / self.turns, a.label()))
            .collect();
        let mut line = format!("Of their agent turns, {}.", shares.join(", "));
        if !self.top_commands.is_empty() {
            let names: Vec<&str> = self.top_commands.iter().map(|(c, _)| c.as_str()).collect();
            line.push_str(&format!(" Commands they use most: {}.", names.join(", ")));
        }
        line
    }
}

/// The question's answer contract.
pub const SUGGEST_SCHEMA: &str = r#"{"type":"object","properties":{"prompt":{"type":"string"},"confidence":{"type":"number"}},"required":["prompt","confidence"]}"#;

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct SuggestAnswer {
    pub prompt: String,
    pub confidence: f64,
}

/// The user's question (editable in settings) followed by the context it is asked about.
pub fn suggest_prompt(
    question: &str,
    profile: &str,
    similar: &[String],
    goal: Option<&str>,
    answer: &str,
) -> String {
    let mut out = question.trim().to_string();
    if !profile.is_empty() {
        out.push_str(&format!("\n\n## Their recent work\n\n{profile}"));
    }
    if !similar.is_empty() {
        let list: Vec<String> = similar.iter().map(|s| format!("- {s}")).collect();
        out.push_str(&format!(
            "\n\n## Prompts they typed after similar turns\n\n{}",
            list.join("\n")
        ));
    }
    if let Some(goal) = goal.map(str::trim).filter(|g| !g.is_empty()) {
        out.push_str(&format!("\n\n## The task\n\n{goal}"));
    }
    let tail: String = {
        let chars: Vec<char> = answer.trim().chars().collect();
        chars[chars.len().saturating_sub(ANSWER_MAX_CHARS)..].iter().collect()
    };
    out.push_str(&format!("\n\n## The agent's last message\n\n{tail}"));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tt_claude_code::parse_transcript;

    fn facts(tools: &[&str], commands: &[&str], answer: &str) -> TurnFacts {
        TurnFacts {
            tools: tools.iter().map(|s| s.to_string()).collect(),
            commands: commands.iter().map(|s| s.to_string()).collect(),
            answer: answer.to_string(),
        }
    }

    fn ex(action: Action, prompt: &str) -> Example {
        Example { bucket: Bucket { action, asked: false }, prompt: prompt.to_string() }
    }

    #[test]
    fn a_turn_is_bucketed_by_its_most_telling_action() {
        let pr = facts(&["Bash", "Edit"], &["git commit -m x", "gh pr create --fill"], "Opened.");
        assert_eq!(bucket(&pr).action, Action::PrOpened);
        let preview = facts(&["mcp__plugin_x__preview_file", "Edit"], &[], "Shown.");
        assert_eq!(bucket(&preview).action, Action::Previewed);
        assert_eq!(bucket(&facts(&["Read"], &[], "Hi")).action, Action::Talked);
    }

    #[test]
    fn only_the_last_paragraph_decides_whether_it_asked() {
        assert!(bucket(&facts(&[], &[], "Done.\n\nShould I merge?")).asked);
        assert!(!bucket(&facts(&[], &[], "Why? Because.\n\nAll done.")).asked);
    }

    #[test]
    fn similar_ranks_short_prompts_and_skips_long_ones_and_housekeeping() {
        let long = "x".repeat(SUGGESTABLE_MAX_CHARS + 1);
        let mut examples = vec![ex(Action::Ran, &long); 5];
        examples.extend(vec![ex(Action::Ran, "/model"); 4]);
        examples.extend(vec![ex(Action::Ran, "run it again"); 2]);
        examples.push(ex(Action::Ran, "Run  it AGAIN"));
        examples.push(ex(Action::Ran, "ship"));
        let history = History::from_examples(&examples);
        let ran = Bucket { action: Action::Ran, asked: false };
        assert_eq!(history.similar(ran, 5), ["Run  it AGAIN", "ship"]);
    }

    #[test]
    fn a_transcript_yields_the_prompt_after_each_agent_turn() {
        let jsonl = [
            r#"{"type":"user","message":{"role":"user","content":"fix the bug"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"gh pr create --fill"}}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"PR opened. Merge it?"}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-message>done</command-message>\n<command-name>/towles-tool-app:done</command-name>"}}"#,
        ]
        .join("\n");
        let examples = examples_from_transcript(&parse_transcript(&jsonl));
        assert_eq!(
            examples,
            [Example {
                bucket: Bucket { action: Action::PrOpened, asked: true },
                prompt: "/towles-tool-app:done".into(),
            }]
        );
    }

    #[test]
    fn the_profile_line_names_shares_and_commands() {
        let examples = vec![
            ex(Action::Edited, "/commit"),
            ex(Action::Edited, "go on"),
            ex(Action::PrOpened, "/commit"),
            ex(Action::Talked, "ok"),
        ];
        assert_eq!(
            work_profile(&examples).line(),
            "Of their agent turns, 50% edit code, 25% open a PR, 25% only talk. Commands they use most: /commit."
        );
    }

    #[test]
    fn the_prompt_keeps_the_question_first_and_cuts_the_answer() {
        let answer = format!("{}END", "a".repeat(ANSWER_MAX_CHARS));
        let prompt =
            suggest_prompt("What next?", "", &["push it".into()], Some("ship it"), &answer);
        assert!(prompt.starts_with("What next?\n\n## Prompts they typed"));
        assert!(prompt.contains("## The task\n\nship it"));
        assert!(prompt.ends_with("END"));
        assert!(!prompt.contains(&"a".repeat(ANSWER_MAX_CHARS)));
    }
}
