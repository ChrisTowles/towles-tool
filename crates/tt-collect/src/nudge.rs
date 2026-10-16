//! The `tt task nudge` contract: which collectors an external process can
//! eagerly refresh, the nudge-dir filename each one touches, and the note left
//! inside it naming the caller.

use std::path::{Path, PathBuf};

/// A collector `tt task nudge` can refresh ahead of its normal poll cadence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NudgeTarget {
    Prs,
    Issues,
    SlackDm,
}

impl NudgeTarget {
    pub const ALL: [NudgeTarget; 3] = [NudgeTarget::Prs, NudgeTarget::Issues, NudgeTarget::SlackDm];

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

/// What a nudge note says about its caller. Every field is optional, and an absent
/// one widens what the app does rather than narrowing it: losing a refresh is worse
/// than running one more broadly than needed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Note {
    /// The caller's app PTY session (`TT_SESSION_ID`); `None` addresses every instance.
    pub session: Option<String>,
    /// The caller's cwd; the PR refresh covers only the tracked repo holding it.
    pub origin: Option<PathBuf>,
    /// The hook's `--trigger` label, e.g. `pr:create`.
    pub trigger: Option<String>,
}

impl Note {
    /// Whether the slow merged-PR half must run too. Only a merge moves a PR into the
    /// merged list; a create, comment or edit changes nothing there.
    pub fn refreshes_merged(&self) -> bool {
        self.trigger.as_deref().is_none_or(|t| t == "pr:merge")
    }
}

/// Write `target`'s nudge note: the timestamp, then one line per [`Note`] field.
pub fn write(dir: &Path, target: NudgeTarget, note: &Note, now_ms: i64) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let line = |v: Option<&str>| v.map(str::trim).unwrap_or_default().replace('\n', " ");
    let origin = note.origin.as_deref().map(|p| p.to_string_lossy().into_owned());
    std::fs::write(
        dir.join(target.file_name()),
        format!(
            "{now_ms}\n{}\n{}\n{}\n",
            line(note.session.as_deref()),
            line(origin.as_deref()),
            line(note.trigger.as_deref()),
        ),
    )
}

/// Parse a note; a missing or blank line reads as `None`.
pub fn parse(contents: &str) -> Note {
    let mut lines = contents.lines().skip(1).map(str::trim);
    let mut next = || lines.next().filter(|s| !s.is_empty()).map(str::to_string);
    Note { session: next(), origin: next().map(PathBuf::from), trigger: next() }
}

/// Read back `target`'s note. A missing or unreadable file is an empty note — "act".
pub fn read(dir: &Path, target: NudgeTarget) -> Note {
    std::fs::read_to_string(dir.join(target.file_name())).map(|c| parse(&c)).unwrap_or_default()
}

/// The tracked repo dir a nudge from `origin` is about: the deepest one holding it.
/// `None` when no origin was given or none holds it — the caller then sweeps them all.
pub fn origin_repo(repo_dirs: &[PathBuf], origin: Option<&Path>) -> Option<PathBuf> {
    let origin = origin?;
    repo_dirs.iter().filter(|d| origin.starts_with(d)).max_by_key(|d| d.as_os_str().len()).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slack_key_matches_the_collector_key_and_filename_stays_plain() {
        assert_eq!(NudgeTarget::SlackDm.key(), "slack:dm");
        assert_eq!(NudgeTarget::SlackDm.file_name(), "slack");
    }

    fn note(session: Option<&str>, origin: Option<&str>, trigger: Option<&str>) -> Note {
        Note {
            session: session.map(str::to_string),
            origin: origin.map(PathBuf::from),
            trigger: trigger.map(str::to_string),
        }
    }

    #[test]
    fn a_note_round_trips_every_field() {
        let dir = tempfile::tempdir().unwrap();
        let written = note(Some("sess-abc"), Some("/code/repo/sub"), Some("pr:create"));
        write(dir.path(), NudgeTarget::Prs, &written, 1_700_000_000_000).unwrap();
        assert_eq!(read(dir.path(), NudgeTarget::Prs), written);
    }

    #[test]
    fn blank_fields_and_short_notes_read_as_none() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), NudgeTarget::Issues, &note(Some("   "), None, None), 1).unwrap();
        assert_eq!(read(dir.path(), NudgeTarget::Issues), Note::default());
        assert_eq!(parse("1700000000000"), Note::default());
        assert_eq!(parse("1700000000000\nsess\n"), note(Some("sess"), None, None));
    }

    #[test]
    fn a_missing_note_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read(dir.path(), NudgeTarget::Prs), Note::default());
    }

    #[test]
    fn only_a_merge_or_an_unlabelled_nudge_refreshes_merged_prs() {
        assert!(note(None, None, Some("pr:merge")).refreshes_merged());
        assert!(note(None, None, None).refreshes_merged());
        for t in [
            "pr:create",
            "pr:comment",
            "pr:edit",
            "pr:close",
            "pr:review",
        ] {
            assert!(!note(None, None, Some(t)).refreshes_merged(), "{t}");
        }
    }

    #[test]
    fn origin_repo_picks_the_deepest_tracked_dir_holding_the_cwd() {
        let dirs = [
            PathBuf::from("/c/repo"),
            PathBuf::from("/c/repo/.claude/worktrees/t"),
            PathBuf::from("/c/other"),
        ];
        let at = |p: &str| origin_repo(&dirs, Some(Path::new(p)));
        assert_eq!(at("/c/repo/src"), Some(PathBuf::from("/c/repo")));
        assert_eq!(
            at("/c/repo/.claude/worktrees/t/x"),
            Some(PathBuf::from("/c/repo/.claude/worktrees/t"))
        );
        assert_eq!(at("/c/repo-two"), None, "a sibling sharing a prefix is not inside");
        assert_eq!(origin_repo(&dirs, None), None);
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
