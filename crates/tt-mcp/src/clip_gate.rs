//! What a finished turn offers the clipboard: only the `! <command>` lines Claude hands
//! the user to run in the Claude Code prompt, and never again for a session whose last
//! offers went unused.

use std::collections::HashMap;

/// Offers a session may leave uncopied before `clip_suggest` goes quiet for it.
const IGNORED_LIMIT: u32 = 3;
/// How long a quiet session stays quiet before one probe offer is allowed through, so a
/// copy (which needs an offer) can still reset it.
const QUIET_MS: i64 = 30 * 60 * 1000;
const MAX_OFFERS: usize = 3;
const LABEL_MAX_CHARS: usize = 40;

/// One command to copy, `text` as it is pasted into the Claude Code prompt.
#[derive(Debug, PartialEq)]
pub(crate) struct Offer {
    pub label: String,
    pub text: String,
}

/// The `! <command>` the answer hands the user, in order, deduplicated, at most three. A
/// command is a line (indented, or inside a fence) that opens with `! `, or an inline code
/// span that does; a trailing `\` continues it onto the next line. The text is the command
/// alone: the prompt is already in bash mode when it is pasted, so a pasted `! ` would stack.
pub(crate) fn offers(answer: &str) -> Vec<Offer> {
    let mut found: Vec<String> = Vec::new();
    let mut lines = answer.lines();
    while let Some(line) = lines.next() {
        let line = line.trim();
        if line.starts_with("```") || line.starts_with("~~~") {
            continue;
        }
        if let Some(mut command) = bang(line).map(str::to_string) {
            while command.ends_with('\\') {
                let Some(next) = lines.next() else { break };
                command.push('\n');
                command.push_str(next.trim_end());
            }
            found.push(command);
        } else {
            found.extend(line.split('`').skip(1).step_by(2).filter_map(bang).map(str::to_string));
        }
    }
    let mut out: Vec<Offer> = Vec::new();
    for command in found {
        let text = command.trim_end().to_string();
        if out.len() < MAX_OFFERS && !out.iter().any(|o| o.text == text) {
            out.push(Offer { label: label(&text), text });
        }
    }
    out
}

/// The command after a leading `! `, or `None` when `text` does not open with one.
fn bang(text: &str) -> Option<&str> {
    let command = text.trim_start().strip_prefix("! ")?.trim();
    (!command.is_empty()).then_some(command)
}

/// The program and its first argument, past any `cd dir &&` that only sets the stage.
fn label(command: &str) -> String {
    let step = command
        .split(['&', ';', '|'])
        .map(str::trim)
        .find(|s| !s.is_empty() && !s.starts_with("cd "))
        .unwrap_or(command);
    let label: Vec<&str> = step.split_whitespace().take(2).collect();
    label.join(" ").chars().take(LABEL_MAX_CHARS).collect()
}

/// Per-session count of offers that went uncopied.
#[derive(Default)]
pub(crate) struct Backoff {
    sessions: HashMap<String, Ignored>,
}

struct Ignored {
    offers: u32,
    last_ms: i64,
}

impl Backoff {
    /// Whether `session` has ignored its last offers and the quiet spell is still running.
    pub(crate) fn quiet(&self, session: &str, now_ms: i64) -> bool {
        self.sessions
            .get(session)
            .is_some_and(|i| i.offers >= IGNORED_LIMIT && now_ms - i.last_ms < QUIET_MS)
    }

    /// An offer reached the user.
    pub(crate) fn offered(&mut self, session: &str, now_ms: i64) {
        let entry = self
            .sessions
            .entry(session.to_string())
            .or_insert(Ignored { offers: 0, last_ms: now_ms });
        entry.offers += 1;
        entry.last_ms = now_ms;
    }

    /// The user copied from `session`.
    pub(crate) fn copied(&mut self, session: &str) {
        self.sessions.remove(session);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(answer: &str) -> Vec<String> {
        offers(answer).into_iter().map(|o| o.text).collect()
    }

    #[test]
    fn a_status_report_with_identifiers_offers_nothing() {
        let report = "Merged as 58f357dd (#783).\n\nThe `clip_suggest.skipped` and \
`clip_suggest.asked` events fire from crates/tt-mcp/src/suggest.rs, see \
https://github.com/o/r/pull/783 and ~/code/p/notes.md.\n```sh\ncargo test --all\n```";
        assert_eq!(texts(report), Vec::<String>::new());
    }

    #[test]
    fn a_bang_line_in_a_fence_is_offered_without_its_bang() {
        let reply = "Run this:\n\n```sh\n! cd ~/x && gh pr merge 780 --squash --admin\n```\n";
        let got = offers(reply);
        assert_eq!(
            got,
            vec![Offer {
                label: "gh pr".to_string(),
                text: "cd ~/x && gh pr merge 780 --squash --admin".to_string()
            }]
        );
    }

    #[test]
    fn indented_and_inline_bang_commands_are_offered() {
        assert_eq!(texts("Sign in:\n    ! gcloud auth login\n"), ["gcloud auth login"]);
        assert_eq!(texts("Type `! gcloud auth login` first."), ["gcloud auth login"]);
        assert_eq!(label("gcloud auth login"), "gcloud auth");
    }

    #[test]
    fn no_offer_text_starts_with_a_bang() {
        let reply = "! a one\n`! b two`\n    ! c three";
        assert!(offers(reply).iter().all(|o| !o.text.starts_with('!')));
    }

    #[test]
    fn a_bang_elsewhere_is_not_a_command() {
        for text in [
            "Done! All green.",
            "Skip it ! really",
            "```rust\nif a != b {}\n```",
            "![img](x.png)",
            "Use `a != b` here and `!x` there.",
            "",
        ] {
            assert_eq!(texts(text), Vec::<String>::new(), "{text:?}");
        }
    }

    #[test]
    fn continued_lines_stay_one_command() {
        let reply = "```\n! cargo test \\\n  -p tt-mcp\n```";
        assert_eq!(texts(reply), ["cargo test \\\n  -p tt-mcp"]);
    }

    #[test]
    fn offers_are_deduplicated_and_capped_at_three() {
        let reply = "! a one\n! a one\n`! b two`\n! c three\n! d four";
        assert_eq!(texts(reply), ["a one", "b two", "c three"]);
    }

    #[test]
    fn backoff_trips_after_three_ignored_resets_on_a_copy_and_probes_after_a_quiet_spell() {
        let mut backoff = Backoff::default();
        for n in 0..3 {
            assert!(!backoff.quiet("s", n), "offer {n} is allowed");
            backoff.offered("s", n);
        }
        assert!(backoff.quiet("s", 3));
        assert!(!backoff.quiet("other", 3), "per session");
        assert!(!backoff.quiet("s", 2 + QUIET_MS), "one probe after the quiet spell");
        backoff.offered("s", 2 + QUIET_MS);
        assert!(backoff.quiet("s", 3 + QUIET_MS));
        backoff.copied("s");
        assert!(!backoff.quiet("s", 3 + QUIET_MS));
    }
}
