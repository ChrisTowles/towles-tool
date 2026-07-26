//! One-shot structured-output calls to the `claude` CLI.
//!
//! Every caller in this workspace that wants a *machine-readable answer* from
//! `claude` goes through here, and gets it the way the CLI itself guarantees:
//!
//! ```text
//! claude -p <prompt> --output-format json --json-schema <schema>
//! ```
//!
//! `--json-schema` routes the model through a structured-output tool, so the
//! `--output-format json` envelope carries a validated `structured_output`
//! object. That is the difference between "we asked nicely for JSON in the
//! prompt" and "the CLI guarantees the shape" — there is no fence stripping and
//! no brace carving anywhere below this line, and the prompt no longer has to
//! spend sentences restating the element shape in English.
//!
//! The envelope also carries `is_error`, which is the other reason this exists:
//! a credit-balance failure, an expired MCP auth, or a rate limit are
//! *claude-side* failures with a message the user can act on, and they must not
//! read like the model merely answered in the wrong shape. [`Error`] keeps the
//! three outcomes apart — [`Error::Exec`] (never ran), [`Error::Failed`] (ran,
//! errored, here's why) and [`Error::Unparseable`] (ran, answered, wrong
//! shape) — and [`Error::brief`] renders any of them as the single line a
//! dialog note or a collector summary has room for.
//!
//! Tauri-free, like the rest of `crates/`. Only [`Ask::run`] spawns anything:
//! [`claude_args`] and [`parse_response`] are pure, and directly testable
//! without a `claude` on PATH.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use thiserror::Error;

/// What went wrong with a structured `claude -p` call.
#[derive(Debug, Error)]
pub enum Error {
    /// `claude` never ran to completion: missing binary, spawn failure, timeout.
    #[error("claude: {0}")]
    Exec(String),
    /// `claude` ran and reported a failure — a non-zero exit, or an envelope
    /// with `is_error: true`. The payload is the CLI's own message.
    #[error("claude -p failed:\n{0}")]
    Failed(String),
    /// `claude` answered, but not in the shape the schema promised.
    #[error("claude answered, but not in the expected shape: {0}")]
    Unparseable(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// The error as one short line, for a UI note or a collector summary.
    ///
    /// [`Error::Failed`] carries raw multi-line stderr — enough to blow out a
    /// form field or a run message — so only its first non-empty line survives;
    /// the full text is still in the event log. The other variants are already
    /// one line and pass through.
    pub fn brief(&self) -> String {
        let Error::Failed(text) = self else {
            return self.to_string();
        };
        match text.lines().map(str::trim).find(|line| !line.is_empty()) {
            Some(first) => format!("claude -p failed: {first}"),
            // A non-zero exit with silent stderr — `Display` would render a
            // bare "claude -p failed:" with nothing after the colon.
            None => "claude -p exited non-zero with no output".to_string(),
        }
    }
}

/// One structured question for `claude -p`.
///
/// `schema` is a JSON Schema *object* (structured output is an object at the
/// root, so an answer that is naturally a list is asked for as an object with
/// one array field).
pub struct Ask<'a> {
    prompt: &'a str,
    schema: &'a str,
    model: Option<&'a str>,
    cwd: Option<&'a Path>,
    timeout: Duration,
}

impl<'a> Ask<'a> {
    /// A call with no model pin (the user's `claude` default) and no cwd.
    ///
    /// The `timeout` is required rather than defaulted: a wedged `claude`
    /// (stuck on auth, a dead MCP server) blocks its caller forever, and how
    /// long *this* caller can afford to wait is the caller's own knowledge.
    pub fn new(prompt: &'a str, schema: &'a str, timeout: Duration) -> Self {
        Self { prompt, schema, model: None, cwd: None, timeout }
    }

    /// Pin the model instead of riding the user's `claude` default. Worth doing
    /// for cheap one-shot calls the user isn't directing.
    pub fn model(mut self, model: &'a str) -> Self {
        self.model = Some(model);
        self
    }

    /// Run with this working directory, so the session picks up that
    /// checkout's `CLAUDE.md` and conventions.
    pub fn cwd(mut self, cwd: &'a Path) -> Self {
        self.cwd = Some(cwd);
        self
    }

    /// Ask, and deserialize the envelope's validated `structured_output` into
    /// `T`. Never panics; every failure is an [`Error`].
    pub fn run<T: DeserializeOwned>(&self) -> Result<T> {
        let args = claude_args(self.prompt, self.schema, self.model);
        let out = match self.cwd {
            Some(dir) => crate::run_in_dir_with_timeout("claude", &args, dir, self.timeout),
            None => crate::run_with_timeout("claude", &args, self.timeout),
        }
        .map_err(|e| Error::Exec(e.to_string()))?;
        if !out.ok() {
            let stderr = out.stderr.trim();
            return Err(Error::Failed(if stderr.is_empty() {
                format!("exited with code {}", out.exit_code)
            } else {
                stderr.to_string()
            }));
        }
        parse_response(&out.stdout)
    }
}

/// The argv that makes the answer's shape the CLI's problem.
///
/// Split out so a test can assert the flags themselves: asserting against a
/// caller's schema constant alone would still pass with `--json-schema` dropped
/// from the command.
pub fn claude_args<'a>(prompt: &'a str, schema: &'a str, model: Option<&'a str>) -> Vec<&'a str> {
    let mut args = vec![
        "-p",
        prompt,
        "--output-format",
        "json",
        "--json-schema",
        schema,
    ];
    if let Some(model) = model {
        args.extend(["--model", model]);
    }
    args
}

/// The `--output-format json` envelope. Only the three fields that decide the
/// outcome are named; everything else (usage, cost, session id) is ignored.
///
/// `structured_output` is held as a [`serde_json::Value`] rather than `T` so an
/// `is_error` envelope is still readable when whatever it carries doesn't fit
/// the caller's type — otherwise the real "claude errored, here's why" message
/// would be lost behind a shape complaint.
#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    structured_output: Option<serde_json::Value>,
    /// Only read for its error message, when `is_error`.
    #[serde(default)]
    result: Option<String>,
}

/// Read the envelope, and nothing else. A `claude` too old for these flags
/// exits non-zero on the unknown argument and never reaches here, so there is
/// no older-CLI text shape worth carrying — and a schema regression should
/// surface as an error the user can see, not be silently rescued by a lenient
/// re-read of the prose in `result`.
pub fn parse_response<T: DeserializeOwned>(stdout: &str) -> Result<T> {
    let env: Envelope = serde_json::from_str(stdout.trim())
        .map_err(|e| Error::Unparseable(format!("not a claude -p JSON envelope ({e})")))?;
    if env.is_error {
        return Err(Error::Failed(env.result.unwrap_or_default().trim().to_string()));
    }
    let value = env
        .structured_output
        .ok_or_else(|| Error::Unparseable("the envelope carried no structured output".into()))?;
    serde_json::from_value(value).map_err(|e| Error::Unparseable(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Deserialize, PartialEq)]
    struct Answer {
        branch: String,
    }

    #[test]
    fn the_call_makes_the_cli_enforce_the_schema() {
        let args = claude_args("the prompt", "{\"type\":\"object\"}", None);
        assert_eq!(args[0..2], ["-p", "the prompt"]);
        assert_eq!(args[2..4], ["--output-format", "json"]);
        assert_eq!(args[4..6], ["--json-schema", "{\"type\":\"object\"}"]);
        assert_eq!(args.len(), 6, "no model pin unless asked for");
    }

    #[test]
    fn a_pinned_model_is_appended() {
        let args = claude_args("p", "{}", Some("sonnet"));
        assert_eq!(args[6..8], ["--model", "sonnet"]);
    }

    #[test]
    fn reads_the_envelopes_validated_structured_output() {
        let raw = r#"{"type":"result","is_error":false,
            "result":"{\"branch\":\"ignored\"}",
            "structured_output":{"branch":"feat/a"},
            "total_cost_usd":0.28}"#;
        let answer: Answer = parse_response(raw).unwrap();
        assert_eq!(answer, Answer { branch: "feat/a".into() });
    }

    #[test]
    fn an_error_envelope_reports_the_clis_own_message() {
        // The whole point of the envelope: a credit-balance failure has to read
        // as itself, not as "the model answered badly".
        let raw = r#"{"type":"result","is_error":true,"result":"credit balance too low"}"#;
        let e = parse_response::<Answer>(raw).unwrap_err();
        assert!(matches!(e, Error::Failed(_)), "{e:?}");
        assert!(e.brief().contains("credit balance too low"), "{e}");
    }

    #[test]
    fn an_error_envelope_wins_over_an_unusable_payload() {
        // `structured_output` here can't be an `Answer`. The user still needs
        // the CLI's reason, not a shape complaint about the wreckage.
        let raw = r#"{"is_error":true,"result":"rate limit reached",
            "structured_output":{"branch":42}}"#;
        let e = parse_response::<Answer>(raw).unwrap_err();
        assert!(e.brief().contains("rate limit reached"), "{e}");
    }

    #[test]
    fn an_envelope_without_structured_output_is_unparseable() {
        // Deliberately not re-read out of `result`: that hedge would silently
        // paper over a schema regression.
        let raw = r#"{"type":"result","is_error":false,
            "result":"Sure! {\"branch\":\"fix/b\"}"}"#;
        let e = parse_response::<Answer>(raw).unwrap_err();
        assert!(matches!(e, Error::Unparseable(_)), "{e:?}");
    }

    #[test]
    fn a_structured_output_of_the_wrong_shape_is_unparseable() {
        let raw = r#"{"is_error":false,"structured_output":{"nope":1}}"#;
        assert!(matches!(parse_response::<Answer>(raw), Err(Error::Unparseable(_))));
    }

    #[test]
    fn prose_instead_of_an_envelope_is_unparseable() {
        let e = parse_response::<Answer>("I could not access your tools.").unwrap_err();
        assert!(matches!(e, Error::Unparseable(_)), "{e:?}");
    }

    #[test]
    fn brief_keeps_a_failure_to_one_line() {
        let e = Error::Failed("error: boom\n  at frame one\n  at frame two".into());
        assert_eq!(e.brief(), "claude -p failed: error: boom");
        assert_eq!(
            Error::Failed(String::new()).brief(),
            "claude -p exited non-zero with no output"
        );
        let unparseable = Error::Unparseable("no structured output".into());
        assert_eq!(unparseable.brief(), unparseable.to_string());
    }
}
