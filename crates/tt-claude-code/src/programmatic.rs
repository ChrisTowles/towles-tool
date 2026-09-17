//! Whether a session was started by a program rather than a person — the
//! sessions Claude Code's VS Code panel leaves out of its list, and so cannot
//! resume. Mirrors that extension's own test (2.1.274).

use crate::types::TranscriptEntry;

const PROGRAMMATIC_ENTRYPOINTS: [&str; 3] = ["sdk-cli", "sdk-ts", "sdk-py"];
const DAEMON_KINDS: [&str; 2] = ["daemon", "daemon-worker"];

/// The first `entrypoint` and the first `sessionKind` decide, as they do there.
pub fn session_is_programmatic(entries: &[TranscriptEntry]) -> bool {
    let entrypoint = entries.iter().find_map(|e| e.entrypoint.as_deref());
    let kind = entries.iter().find_map(|e| e.session_kind.as_deref());
    entrypoint.is_some_and(|e| PROGRAMMATIC_ENTRYPOINTS.contains(&e))
        || kind.is_some_and(|k| DAEMON_KINDS.contains(&k))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::parse_transcript;

    fn programmatic(content: &str) -> bool {
        session_is_programmatic(&parse_transcript(content))
    }

    #[test]
    fn sdk_and_daemon_sessions_are_programmatic() {
        assert!(programmatic("{\"entrypoint\":\"sdk-cli\"}"));
        assert!(programmatic("{\"entrypoint\":\"cli\",\"sessionKind\":\"daemon\"}"));
    }

    #[test]
    fn a_terminal_session_is_not() {
        assert!(!programmatic("{\"entrypoint\":\"cli\",\"sessionKind\":\"bg\"}"));
        assert!(!programmatic("{\"cwd\":\"/a\"}"));
    }
}
