//! Model → context-window lookup. The table lives in
//! [`context_windows.json`](./context_windows.json), embedded at build time.
//! **Updating a window is a data edit in that file, not a code change** — a
//! window is a property of the model *and* its platform.
//! [`resolve_window`] returns the count *and* how it was determined, so an
//! unrecognized model is an explicit guess rather than a silent default.
//!
//! Precedence (first match wins):
//! 1. An explicit `[1m]` marker on the model string → the marker window.
//! 2. A **Bedrock** id (`anthropic.<id>`, or `us.`/`eu.`/`apac.`/`global.`-prefixed).
//! 3. A known **family** substring (case-insensitive), else the default window.

use serde::Deserialize;
use std::sync::LazyLock;

/// The base 200K context window.
pub const CONTEXT_200K: i64 = 200_000;
/// The extended 1M context window.
pub const CONTEXT_1M: i64 = 1_000_000;

/// The maintained model → context-window table, embedded at build time.
const TABLE_JSON: &str = include_str!("context_windows.json");

/// One family entry: a case-insensitive `contains` needle and its window.
#[derive(Debug, Deserialize)]
struct Family {
    contains: String,
    window: i64,
}

/// The parsed table. Unknown keys (`$comment`, `note`, `lastReviewed`) are
/// ignored so the data file can stay self-documenting.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowTable {
    default_window: i64,
    bedrock_window: i64,
    marker_window: i64,
    families: Vec<Family>,
}

/// Parsed once on first use. The embedded JSON is a build-time constant, so a
/// parse failure is a programmer error — hence `expect`, not a fallible API.
static TABLE: LazyLock<WindowTable> = LazyLock::new(|| {
    serde_json::from_str(TABLE_JSON).expect("embedded context_windows.json must parse")
});

/// How a model's context window was determined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowSource {
    /// An explicit `[1m]` opt-in marker on the model id forced the window.
    Marker,
    /// A Bedrock id (bare `anthropic.` or a region-prefixed inference profile).
    Bedrock,
    /// Matched a known model family; carries the matched `contains` needle.
    Family(String),
    /// No rule matched: the conservative default, and callers should flag it.
    Unknown,
}

/// A resolved context window plus how it was determined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedWindow {
    pub tokens: i64,
    pub source: WindowSource,
}

impl ResolvedWindow {
    /// `true` when a rule recognized the model, `false` on the default fallback.
    pub fn is_known(&self) -> bool {
        !matches!(self.source, WindowSource::Unknown)
    }
}

/// Resolve a model id to its context window *and* how we got there. Prefer this
/// over [`context_window`] to distinguish a recognized model from a guess.
pub fn resolve_window(model: &str) -> ResolvedWindow {
    let table = &*TABLE;
    let m = model.to_ascii_lowercase();

    // 1. Explicit 1M opt-in marker (Sonnet 4/4.5 era) always wins.
    if m.ends_with("[1m]") {
        return ResolvedWindow { tokens: table.marker_window, source: WindowSource::Marker };
    }
    // 2. Bedrock: match the `anthropic.` segment so region-prefixed inference
    //    profiles don't fall through to a 1M family match below.
    if m.starts_with("anthropic.") || m.contains(".anthropic.") {
        return ResolvedWindow { tokens: table.bedrock_window, source: WindowSource::Bedrock };
    }
    // 3. Known family (first match wins).
    for fam in &table.families {
        if m.contains(&fam.contains) {
            return ResolvedWindow {
                tokens: fam.window,
                source: WindowSource::Family(fam.contains.clone()),
            };
        }
    }
    // 4. Unrecognized — a guess, surfaced as Unknown.
    ResolvedWindow { tokens: table.default_window, source: WindowSource::Unknown }
}

/// Context-window size (in tokens) for a model id, per the maintained table.
/// Unrecognized models get the conservative default silently — use
/// [`resolve_window`] or [`model_known`] to detect that case.
pub fn context_window(model: &str) -> i64 {
    resolve_window(model).tokens
}

/// `true` when the model id matched a rule (marker, Bedrock, or known family).
pub fn model_known(model: &str) -> bool {
    resolve_window(model).is_known()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_json_parses() {
        let table: WindowTable =
            serde_json::from_str(TABLE_JSON).expect("context_windows.json should parse");
        assert!(!table.families.is_empty());
        assert_eq!(table.default_window, CONTEXT_200K);
        assert_eq!(table.marker_window, CONTEXT_1M);
    }

    #[test]
    fn one_m_native_families() {
        assert_eq!(context_window("claude-opus-4-8"), CONTEXT_1M);
        assert_eq!(context_window("claude-opus-4-7"), CONTEXT_1M);
        assert_eq!(context_window("claude-opus-4-6"), CONTEXT_1M);
        assert_eq!(context_window("claude-sonnet-5"), CONTEXT_1M);
        assert_eq!(context_window("claude-sonnet-4-6"), CONTEXT_1M);
        assert_eq!(context_window("claude-fable-5"), CONTEXT_1M);
        assert_eq!(context_window("claude-mythos-5"), CONTEXT_1M);
    }

    #[test]
    fn family_match_reports_source_and_known() {
        let r = resolve_window("claude-opus-4-8-v1");
        assert_eq!(r.tokens, CONTEXT_1M);
        assert_eq!(r.source, WindowSource::Family("opus-4-8".to_string()));
        assert!(r.is_known());
        assert!(model_known("claude-opus-4-8-v1"));
    }

    #[test]
    fn two_hundred_k_families_and_unknown() {
        assert_eq!(context_window("claude-haiku-4-5"), CONTEXT_200K);
        assert_eq!(context_window("claude-opus-4-5"), CONTEXT_200K); // legacy Opus
        assert_eq!(context_window("claude-sonnet-4-5"), CONTEXT_200K); // 1M was beta-only
        assert_eq!(context_window("claude-opus-4-9-future"), CONTEXT_200K); // unrecognized → conservative
        assert_eq!(context_window(""), CONTEXT_200K);
    }

    #[test]
    fn unknown_model_is_flagged_not_silent() {
        let r = resolve_window("claude-opus-4-9-future");
        assert_eq!(r.tokens, CONTEXT_200K);
        assert_eq!(r.source, WindowSource::Unknown);
        assert!(!r.is_known());
        assert!(!model_known("claude-opus-4-9-future"));
        assert!(!model_known(""));
    }

    #[test]
    fn one_m_marker_forces_1m() {
        let r = resolve_window("claude-sonnet-4-5[1m]");
        assert_eq!(r.tokens, CONTEXT_1M);
        assert_eq!(r.source, WindowSource::Marker);
        assert!(r.is_known());
    }

    #[test]
    fn bedrock_prefix_caps_at_200k() {
        let r = resolve_window("anthropic.claude-opus-4-8");
        assert_eq!(r.tokens, CONTEXT_200K);
        assert_eq!(r.source, WindowSource::Bedrock);
        assert!(r.is_known());
        assert_eq!(context_window("claude-opus-4-8"), CONTEXT_1M);
    }

    #[test]
    fn bedrock_region_inference_profiles_cap_at_200k() {
        // These embed a 1M-native family, so `.anthropic.` must win the match.
        assert_eq!(context_window("us.anthropic.claude-opus-4-8-v1"), CONTEXT_200K);
        assert_eq!(context_window("eu.anthropic.claude-sonnet-5-v1"), CONTEXT_200K);
        assert_eq!(context_window("apac.anthropic.claude-opus-4-8"), CONTEXT_200K);
        assert_eq!(context_window("global.anthropic.claude-fable-5"), CONTEXT_200K);
        assert_eq!(context_window("claude-opus-4-8"), CONTEXT_1M);
    }

    #[test]
    fn distinguishes_sonnet_5_from_sonnet_4_5() {
        assert_eq!(context_window("claude-sonnet-5"), CONTEXT_1M);
        assert_eq!(context_window("claude-sonnet-4-5"), CONTEXT_200K);
    }
}
