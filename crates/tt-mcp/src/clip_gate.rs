//! When a finished turn is worth a clipboard question at all: the message must hold
//! something copyable, and a session whose last offers went unused is left alone.

use std::collections::HashMap;

/// Offers a session may leave uncopied before `clip_suggest` goes quiet for it.
const IGNORED_LIMIT: u32 = 3;
/// How long a quiet session stays quiet before one probe offer is allowed through, so a
/// copy (which needs an offer) can still reset it.
const QUIET_MS: i64 = 30 * 60 * 1000;

const COMMANDS: &[&str] = &[
    "git", "cargo", "bun", "bunx", "npm", "npx", "pnpm", "yarn", "gh", "tt", "docker", "kubectl",
    "curl", "ssh", "sudo", "brew", "apt", "pip", "python", "python3", "node", "rustup", "jq",
    "grep", "chmod", "export", "cd", "ls", "rm", "mv", "cp", "mkdir", "just", "tsc",
];

/// Whether `answer` holds a fenced block, a useful inline code span, a URL, an absolute or
/// `~/` path, a command line, a git SHA or a `#123` ref. Plain prose holds none.
pub(crate) fn copyable(answer: &str) -> bool {
    has_fence(answer)
        || has_code_span(answer)
        || answer.lines().any(command_line)
        || answer.split_whitespace().any(|raw| {
            let word = raw.trim_matches(is_wrapper);
            url(word) || path(word) || issue_ref(word)
        })
        || answer.split(|c: char| !c.is_ascii_alphanumeric()).any(sha)
}

fn has_fence(answer: &str) -> bool {
    answer.lines().any(|l| {
        let l = l.trim_start();
        l.starts_with("```") || l.starts_with("~~~")
    })
}

/// Backtick spans that read as a command, path or identifier rather than an emphasised word.
fn has_code_span(answer: &str) -> bool {
    answer.lines().any(|line| line.split('`').skip(1).step_by(2).any(code_like))
}

fn code_like(span: &str) -> bool {
    let span = span.trim();
    if span.chars().count() < 3 {
        return false;
    }
    let symbolic = span.chars().any(|c| !c.is_ascii_alphanumeric());
    let camel = span.chars().skip(1).any(|c| c.is_ascii_uppercase())
        && span.chars().any(|c| c.is_ascii_lowercase());
    symbolic || camel
}

fn is_wrapper(c: char) -> bool {
    matches!(c, '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | '"' | '\'' | '`' | '*')
        || matches!(c, ',' | ';' | ':' | '.' | '!' | '?')
}

fn url(word: &str) -> bool {
    word.split_once("://").is_some_and(|(scheme, rest)| {
        !rest.is_empty()
            && !scheme.is_empty()
            && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    })
}

fn path(word: &str) -> bool {
    let rest = word.strip_prefix("~/").or_else(|| word.strip_prefix('/'));
    rest.is_some_and(|r| r.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '.' || c == '_'))
}

fn issue_ref(word: &str) -> bool {
    let digits = word.rsplit_once('#').map(|(_, n)| n);
    digits.is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

/// 7–40 hex digits with both a digit and a letter, so counts and words like `defaced`
/// are not SHAs.
fn sha(piece: &str) -> bool {
    (7..=40).contains(&piece.len())
        && piece.chars().all(|c| c.is_ascii_hexdigit())
        && piece.chars().any(|c| c.is_ascii_digit())
        && piece.chars().any(|c| c.is_ascii_alphabetic())
}

/// A `$ ` prompt line, or a line opening with a well-known tool and an argument and not
/// closing like a sentence.
fn command_line(line: &str) -> bool {
    let line = line.trim().trim_start_matches(['-', '*', ' ']);
    if line.starts_with("$ ") {
        return true;
    }
    let mut words = line.split_whitespace();
    let (Some(first), Some(_)) = (words.next(), words.next()) else {
        return false;
    };
    COMMANDS.contains(&first) && !line.ends_with(['.', '?'])
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

    #[test]
    fn prose_holds_nothing_copyable() {
        for prose in [
            "Done. The tests pass and nothing else changed.",
            "I looked at the `config` and the `main` branch, and it is fine.",
            "Tagged as # and / alone, and and/or either.",
            "The 1234567 items took 100 ms, a defaced page.",
            "Make sure it works. Cargo is great.",
            "",
        ] {
            assert!(!copyable(prose), "{prose:?}");
        }
    }

    #[test]
    fn each_kind_of_copyable_is_found() {
        for text in [
            "Try:\n```sh\nbun run e2e\n```",
            "Run `cargo test -p tt-store` now.",
            "It lives in `Dispatcher::clip_suggest`.",
            "Rename `clipGate` first.",
            "Open https://github.com/o/r/pull/9.",
            "(see https://x.dev)",
            "Wrote /tmp/out/report.html",
            "Saved to ~/code/p/notes.md.",
            "$ tt task ls",
            "- git push -u origin main",
            "cargo test --all",
            "Fixed in 3bb216b9 upstream.",
            "range 9ff29d3..e615ca3",
            "See PR #745 for the rest.",
            "Merged (#779)",
            "o/r#12 is related",
        ] {
            assert!(copyable(text), "{text:?}");
        }
    }

    #[test]
    fn sentences_that_start_like_commands_are_prose() {
        assert!(!copyable("git is a version control system."));
        assert!(!copyable("cd"));
        assert!(!copyable("Did you run cargo test?"));
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
