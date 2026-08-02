//! One-shot structured-output calls to the `claude` CLI: every caller wanting a
//! machine-readable answer goes through here, via
//! `claude -p <prompt> --output-format json --json-schema <schema>`.
//!
//! `--json-schema` routes the model through a structured-output tool, so the envelope
//! carries a validated `structured_output` object — the difference between asking
//! nicely for JSON and the CLI guaranteeing the shape. No fence stripping or brace
//! carving exists below this line.
//!
//! The envelope also carries `is_error`: a credit balance, expired MCP auth or rate
//! limit are *claude-side* failures with a message the user can act on, and must not
//! read like a wrong-shaped answer. [`Error`] keeps the three apart — never ran, ran
//! and errored, ran and unparseable. Only [`Ask::run`] spawns.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    /// Never ran to completion: missing binary, spawn failure, timeout.
    #[error("claude: {0}")]
    Exec(String),
    /// Ran and reported a failure — a non-zero exit, or `is_error: true`. The
    /// payload is the CLI's own message.
    #[error("claude -p failed:\n{0}")]
    Failed(String),
    #[error("claude answered, but not in the expected shape: {0}")]
    Unparseable(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// One short line, for a UI note or a collector summary. [`Error::Failed`]
    /// carries raw multi-line stderr, so only its first non-empty line
    /// survives; the full text is still in the event log.
    pub fn brief(&self) -> String {
        let Error::Failed(text) = self else {
            return self.to_string();
        };
        match text.lines().map(str::trim).find(|line| !line.is_empty()) {
            Some(first) => format!("claude -p failed: {first}"),
            // `Display` would render a bare "claude -p failed:" here.
            None => "claude -p exited non-zero with no output".to_string(),
        }
    }
}

/// One structured question for `claude -p`. `schema` is a JSON Schema *object*
/// — structured output is an object at the root, so a naturally-list answer is
/// asked for as an object with one array field.
pub struct Ask<'a> {
    prompt: &'a str,
    schema: &'a str,
    model: Option<&'a str>,
    cwd: Option<&'a Path>,
    timeout: Duration,
}

impl<'a> Ask<'a> {
    /// The `timeout` is required rather than defaulted: a wedged `claude`
    /// blocks its caller forever, and how long *this* caller can afford to wait
    /// is the caller's own knowledge.
    pub fn new(prompt: &'a str, schema: &'a str, timeout: Duration) -> Self {
        Self { prompt, schema, model: None, cwd: None, timeout }
    }

    /// Worth pinning for cheap one-shot calls the user isn't directing.
    pub fn model(mut self, model: &'a str) -> Self {
        self.model = Some(model);
        self
    }

    /// So the session picks up that checkout's `CLAUDE.md` and conventions.
    pub fn cwd(mut self, cwd: &'a Path) -> Self {
        self.cwd = Some(cwd);
        self
    }

    /// Deserializes the envelope's validated `structured_output` into `T`.
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

/// The argv that makes the answer's shape the CLI's problem. Split out so a
/// test can assert the flags themselves — asserting against a caller's schema
/// constant alone would still pass with `--json-schema` dropped.
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

/// `structured_output` is held as a [`serde_json::Value`] rather than `T` so an
/// `is_error` envelope stays readable when what it carries doesn't fit the
/// caller's type — otherwise the real reason is lost behind a shape complaint.
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

/// Reads the envelope, and nothing else: a schema regression should surface as
/// an error the user can see, not be rescued by re-reading the prose in
/// `result`.
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
        let raw = r#"{"type":"result","is_error":true,"result":"credit balance too low"}"#;
        let e = parse_response::<Answer>(raw).unwrap_err();
        assert!(matches!(e, Error::Failed(_)), "{e:?}");
        assert!(e.brief().contains("credit balance too low"), "{e}");
    }

    #[test]
    fn an_error_envelope_wins_over_an_unusable_payload() {
        // The user needs the CLI's reason, not a shape complaint.
        let raw = r#"{"is_error":true,"result":"rate limit reached",
            "structured_output":{"branch":42}}"#;
        let e = parse_response::<Answer>(raw).unwrap_err();
        assert!(e.brief().contains("rate limit reached"), "{e}");
    }

    #[test]
    fn an_envelope_without_structured_output_is_unparseable() {
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
