//! One file's diff as hunks of lines, base tree against the working tree — what
//! `git diff <base> -- <path>` prints, structured for a read-only view.

use gix::diff::blob::{InternedInput, diff_with_slider_heuristics};

use super::diff::{blob_at, is_binary};
use super::{GitError, Repo, Result};

/// `git diff`'s default context.
const CONTEXT: u32 = 3;

/// Past this many emitted lines the rest of the file is dropped: a view, not a
/// tool for reading a regenerated lockfile.
const MAX_LINES: usize = 4_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HunkLine {
    pub kind: LineKind,
    /// Without its line ending.
    pub text: String,
}

/// `@@ -old_start +new_start @@`, 1-based like git's header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    pub old_start: u32,
    pub new_start: u32,
    pub lines: Vec<HunkLine>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FilePatch {
    pub hunks: Vec<Hunk>,
    pub binary: bool,
    /// [`MAX_LINES`] cut the hunks short.
    pub truncated: bool,
}

impl Repo {
    /// `path` in the working tree against `source` (its pre-rename path, else
    /// `path`) in `base`'s tree. A side that doesn't exist diffs as empty, so an
    /// added or untracked file is all `+` and a deleted one all `-`.
    pub fn file_patch(&self, base: &str, path: &str, source: Option<&str>) -> Result<FilePatch> {
        let base_id = self.resolve(base).ok_or_else(|| GitError::NoSuchRev(base.to_string()))?;
        let object =
            self.inner().find_object(base_id).map_err(|e| GitError::Read(e.to_string()))?;
        let tree = object.peel_to_tree().map_err(|e| GitError::Read(e.to_string()))?;
        let before = blob_at(&tree, source.unwrap_or(path)).unwrap_or_default();
        let after = self
            .inner()
            .workdir()
            .map(|dir| dir.join(path))
            .filter(|full| full.is_file())
            .and_then(|full| std::fs::read(full).ok())
            .unwrap_or_default();
        Ok(patch_between(&before, &after))
    }
}

pub(crate) fn patch_between(before: &[u8], after: &[u8]) -> FilePatch {
    if is_binary(before) || is_binary(after) {
        return FilePatch { binary: true, ..FilePatch::default() };
    }
    let before = String::from_utf8_lossy(before);
    let after = String::from_utf8_lossy(after);
    let input = InternedInput::new(before.as_ref(), after.as_ref());
    let diff = diff_with_slider_heuristics(super::DIFF_ALGORITHM, &input);
    let line = |kind, token: &gix::diff::blob::Token| HunkLine {
        kind,
        text: input.interner[*token].trim_end_matches(['\n', '\r']).to_string(),
    };

    let changes: Vec<_> = diff.hunks().collect();
    let mut out = FilePatch::default();
    let mut emitted = 0usize;
    let mut i = 0;
    while i < changes.len() {
        // Changes whose contexts would touch share one hunk, as in git.
        let mut j = i;
        while j + 1 < changes.len()
            && changes[j + 1].before.start - changes[j].before.end <= 2 * CONTEXT
        {
            j += 1;
        }
        let first = &changes[i];
        let lead = first.before.start.min(CONTEXT);
        let mut b = first.before.start - lead;
        let new_start = first.after.start - lead + 1;
        let mut hunk = Hunk { old_start: b + 1, new_start, lines: Vec::new() };
        for change in &changes[i..=j] {
            while b < change.before.start {
                hunk.lines.push(line(LineKind::Context, &input.before[b as usize]));
                b += 1;
            }
            for t in &input.before[change.before.start as usize..change.before.end as usize] {
                hunk.lines.push(line(LineKind::Removed, t));
            }
            for t in &input.after[change.after.start as usize..change.after.end as usize] {
                hunk.lines.push(line(LineKind::Added, t));
            }
            b = change.before.end;
        }
        let tail_end = (b + CONTEXT).min(input.before.len() as u32);
        while b < tail_end {
            hunk.lines.push(line(LineKind::Context, &input.before[b as usize]));
            b += 1;
        }
        // git names the line *before* an empty side's position.
        if !hunk.lines.iter().any(|l| l.kind != LineKind::Added) {
            hunk.old_start -= 1;
        }
        if !hunk.lines.iter().any(|l| l.kind != LineKind::Removed) {
            hunk.new_start -= 1;
        }
        emitted += hunk.lines.len();
        out.hunks.push(hunk);
        if emitted > MAX_LINES {
            out.truncated = j + 1 < changes.len();
            break;
        }
        i = j + 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::Repo;
    use crate::repo::testrepo::TestRepo;

    fn render(patch: &FilePatch) -> String {
        let mut s = String::new();
        for h in &patch.hunks {
            s.push_str(&format!("@@ -{} +{} @@\n", h.old_start, h.new_start));
            for l in &h.lines {
                let sigil = match l.kind {
                    LineKind::Context => ' ',
                    LineKind::Added => '+',
                    LineKind::Removed => '-',
                };
                s.push(sigil);
                s.push_str(&l.text);
                s.push('\n');
            }
        }
        s
    }

    /// git's own hunk bodies, headers reduced to the start lines this keeps.
    fn git_patch(repo: &TestRepo, base: &str, path: &str) -> String {
        let raw = repo.git(&["diff", "--no-color", "--no-ext-diff", base, "--", path]);
        raw.lines()
            .skip_while(|l| !l.starts_with("@@"))
            .filter(|l| !l.starts_with('\\'))
            .map(|l| {
                if let Some(rest) = l.strip_prefix("@@ ") {
                    let mut parts = rest.split(' ');
                    let old = parts.next().unwrap().trim_start_matches('-');
                    let new = parts.next().unwrap().trim_start_matches('+');
                    let start = |r: &str| r.split(',').next().unwrap().to_string();
                    format!("@@ -{} +{} @@\n", start(old), start(new))
                } else {
                    format!("{l}\n")
                }
            })
            .collect()
    }

    fn numbered(n: u32) -> String {
        (1..=n).map(|i| format!("line {i}\n")).collect()
    }

    #[test]
    fn hunks_match_git_diff_for_scattered_edits() {
        let repo = TestRepo::new();
        repo.commit_file("f.txt", &numbered(40));
        let base = repo.rev_parse("HEAD");
        let edited = numbered(40)
            .replace("line 2\n", "line two\n")
            .replace("line 5\n", "line five\n")
            .replace("line 30\n", "")
            .replace("line 40\n", "line 40\nline 41\n");
        repo.write("f.txt", &edited);

        let ours = Repo::open(repo.path()).unwrap().file_patch(&base, "f.txt", None).unwrap();
        assert_eq!(render(&ours), git_patch(&repo, &base, "f.txt"));
        assert!(!ours.truncated);
    }

    #[test]
    fn an_untracked_file_is_all_additions() {
        let repo = TestRepo::new();
        repo.commit_file("a.txt", "a\n");
        let base = repo.rev_parse("HEAD");
        repo.write("new.txt", "one\ntwo\n");

        let patch = Repo::open(repo.path()).unwrap().file_patch(&base, "new.txt", None).unwrap();
        assert_eq!(render(&patch), "@@ -0 +1 @@\n+one\n+two\n");
    }

    #[test]
    fn a_deleted_file_is_all_removals() {
        let repo = TestRepo::new();
        repo.commit_file("gone.txt", "x\ny\n");
        let base = repo.rev_parse("HEAD");
        std::fs::remove_file(repo.path().join("gone.txt")).unwrap();

        let patch = Repo::open(repo.path()).unwrap().file_patch(&base, "gone.txt", None).unwrap();
        assert_eq!(render(&patch), "@@ -1 +0 @@\n-x\n-y\n");
    }

    #[test]
    fn a_rename_diffs_against_its_source_path() {
        let repo = TestRepo::new();
        repo.commit_file("old.txt", "keep\nchange\n");
        let base = repo.rev_parse("HEAD");
        std::fs::remove_file(repo.path().join("old.txt")).unwrap();
        repo.write("new.txt", "keep\nchanged\n");

        let patch =
            Repo::open(repo.path()).unwrap().file_patch(&base, "new.txt", Some("old.txt")).unwrap();
        assert_eq!(render(&patch), "@@ -1 +1 @@\n keep\n-change\n+changed\n");
    }

    #[test]
    fn binary_content_has_no_hunks() {
        let patch = patch_between(b"a\0b", b"a\0c");
        assert!(patch.binary);
        assert!(patch.hunks.is_empty());
    }

    #[test]
    fn a_huge_rewrite_is_cut_short_and_says_so() {
        let before: String = (0..20_000).map(|i| format!("{i}\n\n\n\n\n\n\n\n")).collect();
        let after: String = (0..20_000).map(|i| format!("x{i}\n\n\n\n\n\n\n\n")).collect();
        let patch = patch_between(before.as_bytes(), after.as_bytes());
        assert!(patch.truncated);
        let lines: usize = patch.hunks.iter().map(|h| h.lines.len()).sum();
        assert!(lines <= MAX_LINES + 20);
    }
}
