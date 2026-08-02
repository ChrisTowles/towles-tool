//! The `tt task nudge` contract: which collectors an external process can
//! eagerly refresh, the nudge-dir filename each one touches, and the note left
//! inside it naming the caller.
//!
//! Tauri-free like the rest of this crate, so every half of the contract lives
//! in one place: the CLI (`tt task nudge <key>`) writes the file, and the app's
//! scheduler (`crates-tauri/tt-app/src/scheduler.rs`) watches the dir, diffs
//! each target's mtime and reads the note back. Keeping the key ↔ filename ↔
//! payload mapping here — rather than duplicated as string literals on each
//! side — is what stops the two from drifting.

use std::path::Path;

/// A collector `tt task nudge` can refresh ahead of its normal poll cadence.
/// The `SlackDm` target lets a running app refresh the watched Slack DM
/// immediately (e.g. after a manual poke) the same way `Prs`/`Issues` already
/// react to a `gh pr`/`gh issue` mutation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NudgeTarget {
    Prs,
    Issues,
    SlackDm,
}

impl NudgeTarget {
    /// Every nudge target, in a stable order (used to build the CLI's accepted
    /// value list and to drive exhaustive tests).
    pub const ALL: [NudgeTarget; 3] = [NudgeTarget::Prs, NudgeTarget::Issues, NudgeTarget::SlackDm];

    /// The collector key this target refreshes — the same stable string
    /// `Store::record_run` uses and the frontend matches on (`prs`, `issues`,
    /// `slack:dm`). This is also the value accepted on the CLI.
    pub fn key(self) -> &'static str {
        match self {
            NudgeTarget::Prs => "prs",
            NudgeTarget::Issues => "issues",
            NudgeTarget::SlackDm => "slack:dm",
        }
    }

    /// Filename inside the nudge dir this target touches. Kept free of the
    /// collector key's `:` so it's a plain, portable filename; the scheduler's
    /// `changed_nudge_batches` reads these exact names.
    pub fn file_name(self) -> &'static str {
        match self {
            NudgeTarget::Prs => "prs",
            NudgeTarget::Issues => "issues",
            NudgeTarget::SlackDm => "slack",
        }
    }
}

/// Write `target`'s nudge note: the timestamp, then the caller's app PTY
/// session (`TT_SESSION_ID`) when it has one.
///
/// The session lets several app instances share one nudge dir without all of
/// them sweeping `gh` for a mutation that happened in exactly one of their
/// terminals — see [`session_in`] for how the reader uses it.
pub fn write(
    dir: &Path,
    target: NudgeTarget,
    session: Option<&str>,
    now_ms: i64,
) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let session = session.map(str::trim).filter(|s| !s.is_empty()).unwrap_or_default();
    std::fs::write(dir.join(target.file_name()), format!("{now_ms}\n{session}\n"))
}

/// The app PTY session named by a nudge note, or `None` when it names nobody.
///
/// `None` means "every instance should act": it is what a caller outside an app
/// terminal writes (no `TT_SESSION_ID` to pass on), and what a note written by
/// an older `tt` looks like, so the broadcast behaviour is the safe default
/// rather than a silent no-op.
pub fn session_in(contents: &str) -> Option<&str> {
    contents.lines().nth(1).map(str::trim).filter(|s| !s.is_empty())
}

/// Read back the session named by `target`'s nudge note. `None` when the file
/// is missing, unreadable, or names nobody — all of which mean "act".
pub fn session_of(dir: &Path, target: NudgeTarget) -> Option<String> {
    let contents = std::fs::read_to_string(dir.join(target.file_name())).ok()?;
    session_in(&contents).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slack_key_matches_the_collector_key_and_filename_stays_plain() {
        assert_eq!(NudgeTarget::SlackDm.key(), "slack:dm");
        assert_eq!(NudgeTarget::SlackDm.file_name(), "slack");
    }

    #[test]
    fn a_note_round_trips_its_session() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), NudgeTarget::Prs, Some("sess-abc"), 1_700_000_000_000).unwrap();
        assert_eq!(session_of(dir.path(), NudgeTarget::Prs).as_deref(), Some("sess-abc"));
    }

    #[test]
    fn a_note_from_outside_an_app_terminal_names_nobody() {
        // `${TT_SESSION_ID:-}` expands to empty for a session Claude Code
        // started outside the app, and that has to read as "everyone acts"
        // rather than "nobody does".
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), NudgeTarget::Issues, Some("   "), 1).unwrap();
        assert_eq!(session_of(dir.path(), NudgeTarget::Issues), None);

        write(dir.path(), NudgeTarget::SlackDm, None, 1).unwrap();
        assert_eq!(session_of(dir.path(), NudgeTarget::SlackDm), None);
    }

    #[test]
    fn a_timestamp_only_note_names_nobody() {
        // What an older `tt` wrote. Must broadcast, not silently no-op.
        assert_eq!(session_in("1700000000000"), None);
        assert_eq!(session_in("1700000000000\n"), None);
    }

    #[test]
    fn a_missing_note_names_nobody() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(session_of(dir.path(), NudgeTarget::Prs), None);
    }

    #[test]
    fn file_names_are_distinct() {
        let names: Vec<_> = NudgeTarget::ALL.iter().map(|t| t.file_name()).collect();
        let mut deduped = names.clone();
        deduped.sort_unstable();
        deduped.dedup();
        assert_eq!(names.len(), deduped.len(), "nudge filenames must be unique");
    }
}
