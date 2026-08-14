//! The git index as a mutable surface: stage a whole path, stage a caller-built
//! buffer (how a single hunk is staged — the caller synthesizes "index content
//! plus this hunk" and hands it over, VS Code's model), and undo either.
//!
//! Everything goes through gitoxide: blob written to the ODB, entry upserted in
//! the index, index written back under its own lock file. No `git` subprocess,
//! and no patch application — a staged hunk arrives as the full resulting file.

use std::collections::BTreeMap;
use std::path::Path;

use gix::bstr::{BStr, ByteSlice};

use super::{GitError, Repo, Result};

/// Where one path sits relative to HEAD, index and working tree.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StageState {
    /// Index differs from HEAD: something is staged.
    pub staged: bool,
    /// Working tree differs from index: something is not staged.
    pub unstaged: bool,
}

impl Repo {
    /// A path's content in the index (stage 0) — `git show :0:<path>`. `None`
    /// when the path has no stage-0 entry there.
    pub fn file_in_index(&self, path: &str) -> Option<Vec<u8>> {
        let index = self.inner().index_or_empty().ok()?;
        let entry =
            index.entry_by_path_and_stage(bstr(path), gix::index::entry::Stage::Unconflicted)?;
        let object = self.inner().find_object(entry.id).ok()?;
        object.try_into_blob().ok().map(|blob| blob.data.clone())
    }

    /// Whether `path` carries conflict stages — a merge in progress there.
    pub fn is_unmerged(&self, path: &str) -> bool {
        self.inner().index_or_empty().is_ok_and(|index| has_conflict_stages(&index, path))
    }

    /// Stage `content` as the index version of `path`, leaving the working tree
    /// alone — `git hash-object -w` + `git update-index`. Stats are zeroed so
    /// git re-reads content rather than trusting the worktree file's stat.
    ///
    /// `expected_index` is the stage-0 content the caller computed `content`
    /// from (`None` = no entry): this is a whole-file replace, and applying it
    /// over an index another writer moved — a racing hunk click, a terminal's
    /// `git add -p` — would silently revert that writer's staging. The entry
    /// keeps its existing mode (a chmod is its own change, never a content
    /// hunk's to move), falling back to HEAD's, then the worktree's.
    pub fn stage_buffer(
        &self,
        path: &str,
        content: &[u8],
        expected_index: Option<&[u8]>,
    ) -> Result<()> {
        let mut index = self.open_index_for_write(path)?;
        let current_entry = index
            .entry_by_path_and_stage(bstr(path), gix::index::entry::Stage::Unconflicted)
            .map(|e| (e.id, e.mode));
        let current = current_entry.and_then(|(id, _)| self.blob_bytes(id));
        if current.as_deref() != expected_index {
            return Err(GitError::Write(format!(
                "{path}: the index changed under this action; re-run it on the refreshed diff"
            )));
        }
        let filtered = self.clean_filter(path, content, &index)?;
        let id = self.write_blob(&filtered)?;
        let mode = current_entry
            .map(|(_, mode)| mode)
            .or_else(|| self.head_entry(path).map(|(_, mode)| mode))
            .or_else(|| self.worktree_mode(path))
            .unwrap_or(gix::index::entry::Mode::FILE);
        upsert(&mut index, path, id, mode, gix::index::entry::Stat::default());
        write_index(&mut index)
    }

    /// Stage `path` as it is on disk — `git add <path>`, including a vanished
    /// file becoming a staged deletion.
    pub fn stage_path(&self, path: &str) -> Result<()> {
        let mut index = self.open_index_for_write(path)?;
        let Some((content, mode, stat)) = self.worktree_content(path)? else {
            // Vanished is a staged deletion; present-but-unstageable (a
            // directory, a socket) must fail loudly instead of "succeeding"
            // by rewriting the index with nothing changed.
            let present =
                self.inner().workdir().is_some_and(|dir| dir.join(path).symlink_metadata().is_ok());
            if present {
                return Err(GitError::Write(format!("{path} is not a stageable file")));
            }
            index.remove_entries(|_, entry_path, _| entry_path == bstr(path));
            return write_index(&mut index);
        };
        let filtered = match mode {
            gix::index::entry::Mode::SYMLINK => content,
            _ => self.clean_filter(path, &content, &index)?,
        };
        let id = self.write_blob(&filtered)?;
        upsert(&mut index, path, id, mode, stat);
        write_index(&mut index)
    }

    /// Put the index entry back to HEAD's version — `git reset -- <path>`. A
    /// path HEAD doesn't have loses its entry (undoing a staged add).
    pub fn unstage_path(&self, path: &str) -> Result<()> {
        let mut index = self.open_index_for_write(path)?;
        match self.head_entry(path) {
            Some((id, mode)) => {
                upsert(&mut index, path, id, mode, gix::index::entry::Stat::default());
            }
            None => index.remove_entries(|_, entry_path, _| entry_path == bstr(path)),
        }
        write_index(&mut index)
    }

    /// [`StageState`] for each of `paths` — the per-file checkboxes' backing.
    /// Content comparisons hash the worktree bytes rather than trusting stat,
    /// because [`Repo::stage_buffer`] deliberately writes unusable stats.
    pub fn stage_states<'a>(
        &self,
        paths: impl IntoIterator<Item = &'a str>,
    ) -> Result<BTreeMap<String, StageState>> {
        let index = self.inner().index_or_empty().map_err(read_err)?;
        let mut out = BTreeMap::new();
        for path in paths {
            let entry = index.entry_by_path(bstr(path));
            let indexed = entry.map(|e| (e.id, e.mode));
            let staged = self.head_entry(path) != indexed;
            let unstaged = match indexed {
                None => self.worktree_mode(path).is_some(),
                Some((id, mode)) => !self.worktree_matches(path, id, mode, &index),
            };
            out.insert(path.to_string(), StageState { staged, unstaged });
        }
        Ok(out)
    }

    /// HEAD vs index — `git diff --cached --numstat`, as [`super::Changes`]
    /// with `A`/`D`/`M` statuses. No rename detection: a staged rename reports
    /// as its add/delete pair.
    pub fn staged_changes(&self) -> Result<super::Changes> {
        let index = self.inner().index_or_empty().map_err(read_err)?;
        let mut sides: BTreeMap<String, (Option<gix::ObjectId>, Option<gix::ObjectId>)> =
            BTreeMap::new();
        if let Some(head) = self.head_id() {
            let head_index =
                self.inner().index_from_tree(&self.tree_id_of(head)?).map_err(read_err)?;
            for entry in head_index.entries() {
                let path = entry.path(&head_index).to_string();
                sides.entry(path).or_default().0 = Some(entry.id);
            }
        }
        let mut conflicted: Vec<String> = Vec::new();
        for entry in index.entries() {
            let path = entry.path(&index).to_string();
            if entry.stage() != gix::index::entry::Stage::Unconflicted {
                conflicted.push(path);
                continue;
            }
            sides.entry(path).or_default().1 = Some(entry.id);
        }
        // An unmerged path has no stage 0, which would read as "staged
        // deletion" below — but `git commit` refuses it, so it isn't staged
        // anything. It stays the uncommitted view's problem.
        for path in conflicted {
            sides.remove(&path);
        }

        let mut files = Vec::new();
        for (path, (before_id, after_id)) in sides {
            if before_id == after_id {
                continue;
            }
            let before = before_id.and_then(|id| self.blob_bytes(id));
            let after = after_id.and_then(|id| self.blob_bytes(id));
            let (lines_added, lines_removed, binary) =
                super::diff::count_lines(before.as_deref(), after.as_deref());
            let status = match (before_id.is_some(), after_id.is_some()) {
                (false, _) => 'A',
                (_, false) => 'D',
                _ => 'M',
            };
            files.push(super::FileChange {
                path,
                status,
                lines_added,
                lines_removed,
                binary,
                ..Default::default()
            });
        }
        Ok(super::Changes { files, untracked_cap: None })
    }

    /// A fresh-from-disk index, with the unmerged-path guard every mutation
    /// shares: hunk staging has no answer for conflict stages.
    fn open_index_for_write(&self, path: &str) -> Result<gix::index::File> {
        if self.inner().workdir().is_none() {
            return Err(GitError::Read("bare repository has no working tree".to_string()));
        }
        let index = match self.inner().open_index() {
            Ok(index) => index,
            // No index yet (fresh repo): start one, at the path git would use.
            Err(gix::worktree::open_index::Error::IndexFile(
                gix::index::file::init::Error::Io(_),
            )) => gix::index::File::from_state(
                gix::index::State::new(self.inner().object_hash()),
                self.inner().index_path(),
            ),
            Err(e) => return Err(read_err(e)),
        };
        if has_conflict_stages(&index, path) {
            return Err(GitError::Write(format!("{path} is unmerged; resolve the conflict first")));
        }
        Ok(index)
    }

    fn write_blob(&self, content: &[u8]) -> Result<gix::ObjectId> {
        Ok(self.inner().write_blob(content).map_err(write_err)?.detach())
    }

    /// Worktree bytes → what the blob should hold, honoring clean filters and
    /// CRLF config the way `git add` does. Identity when none are configured.
    fn clean_filter(
        &self,
        path: &str,
        content: &[u8],
        index: &gix::index::State,
    ) -> Result<Vec<u8>> {
        let (mut pipeline, _) = self.inner().filter_pipeline(None).map_err(write_err)?;
        let mut outcome =
            pipeline.convert_to_git(content, Path::new(path), index).map_err(write_err)?;
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut outcome, &mut buf).map_err(write_err)?;
        Ok(buf)
    }

    /// HEAD's (id, mode) for a path, `None` when absent or HEAD is unborn.
    fn head_entry(&self, path: &str) -> Option<(gix::ObjectId, gix::index::entry::Mode)> {
        let tree = self.inner().find_object(self.head_id()?).ok()?.peel_to_tree().ok()?;
        let entry = tree.lookup_entry_by_path(path).ok().flatten()?;
        let mode = match entry.mode().kind() {
            gix::object::tree::EntryKind::BlobExecutable => {
                gix::index::entry::Mode::FILE_EXECUTABLE
            }
            gix::object::tree::EntryKind::Link => gix::index::entry::Mode::SYMLINK,
            gix::object::tree::EntryKind::Commit => gix::index::entry::Mode::COMMIT,
            _ => gix::index::entry::Mode::FILE,
        };
        Some((entry.object_id(), mode))
    }

    /// (content, index mode, stat) of the worktree file, `None` when absent.
    /// A symlink's content is its target, as git stores it.
    fn worktree_content(
        &self,
        path: &str,
    ) -> Result<Option<(Vec<u8>, gix::index::entry::Mode, gix::index::entry::Stat)>> {
        let Some(workdir) = self.inner().workdir() else {
            return Ok(None);
        };
        let full = workdir.join(path);
        let Ok(meta) = std::fs::symlink_metadata(&full) else {
            return Ok(None);
        };
        let stat = gix::index::entry::Stat::from_fs(
            &gix::index::fs::Metadata::from_path_no_follow(&full).map_err(write_err)?,
        )
        .map_err(write_err)?;
        if meta.is_symlink() {
            let target = std::fs::read_link(&full).map_err(write_err)?;
            let bytes =
                gix::path::os_str_into_bstr(target.as_os_str()).map_err(write_err)?.to_owned();
            return Ok(Some((bytes.into(), gix::index::entry::Mode::SYMLINK, stat)));
        }
        if !meta.is_file() {
            return Ok(None);
        }
        let content = std::fs::read(&full).map_err(write_err)?;
        let mode = if is_executable(&meta) {
            gix::index::entry::Mode::FILE_EXECUTABLE
        } else {
            gix::index::entry::Mode::FILE
        };
        Ok(Some((content, mode, stat)))
    }

    /// The worktree file's index mode, `None` when it's absent (or not a
    /// stageable kind).
    fn worktree_mode(&self, path: &str) -> Option<gix::index::entry::Mode> {
        self.worktree_content(path).ok().flatten().map(|(_, mode, _)| mode)
    }

    /// Whether the worktree file would hash to exactly the index entry —
    /// filtered content and mode both.
    fn worktree_matches(
        &self,
        path: &str,
        id: gix::ObjectId,
        mode: gix::index::entry::Mode,
        index: &gix::index::State,
    ) -> bool {
        let Ok(Some((content, disk_mode, _))) = self.worktree_content(path) else {
            return false;
        };
        if disk_mode != mode {
            return false;
        }
        let filtered = match disk_mode {
            gix::index::entry::Mode::SYMLINK => content,
            _ => match self.clean_filter(path, &content, index) {
                Ok(bytes) => bytes,
                Err(_) => return false,
            },
        };
        gix::objs::compute_hash(id.kind(), gix::objs::Kind::Blob, &filtered)
            .map(|hash| hash == id)
            .unwrap_or(false)
    }

    fn blob_bytes(&self, id: gix::ObjectId) -> Option<Vec<u8>> {
        let object = self.inner().find_object(id).ok()?;
        object.try_into_blob().ok().map(|blob| blob.data.clone())
    }

    fn tree_id_of(&self, id: gix::ObjectId) -> Result<gix::ObjectId> {
        Ok(self
            .inner()
            .find_object(id)
            .map_err(read_err)?
            .peel_to_tree()
            .map_err(read_err)?
            .id()
            .detach())
    }
}

fn bstr(path: &str) -> &BStr {
    path.as_bytes().as_bstr()
}

fn has_conflict_stages(index: &gix::index::State, path: &str) -> bool {
    use gix::index::entry::Stage;
    [Stage::Base, Stage::Ours, Stage::Theirs]
        .iter()
        .any(|stage| index.entry_by_path_and_stage(bstr(path), *stage).is_some())
}

fn upsert(
    index: &mut gix::index::File,
    path: &str,
    id: gix::ObjectId,
    mode: gix::index::entry::Mode,
    stat: gix::index::entry::Stat,
) {
    if let Some(pos) =
        index.entry_index_by_path_and_stage(bstr(path), gix::index::entry::Stage::Unconflicted)
    {
        let entry = &mut index.entries_mut()[pos];
        entry.id = id;
        entry.mode = mode;
        entry.stat = stat;
        return;
    }
    index.dangerously_push_entry(stat, id, gix::index::entry::Flags::empty(), mode, bstr(path));
    index.sort_entries();
}

/// Write under git's own `index.lock`, failing fast if another writer holds it.
/// The stale tree-cache extension must go first — left in place it makes a
/// later `git commit` capture pre-staging subtree content.
fn write_index(index: &mut gix::index::File) -> Result<()> {
    index.remove_tree();
    index.write(gix::index::write::Options::default()).map_err(write_err)
}

fn read_err(e: impl std::fmt::Display) -> GitError {
    GitError::Read(e.to_string())
}

fn write_err(e: impl std::fmt::Display) -> GitError {
    GitError::Write(e.to_string())
}

#[cfg(unix)]
fn is_executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &std::fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::testrepo::TestRepo;

    fn porcelain(repo: &TestRepo) -> String {
        repo.git(&["status", "--porcelain"])
    }

    fn cached_numstat(repo: &TestRepo) -> String {
        repo.git(&["diff", "--cached", "--numstat"])
    }

    #[test]
    fn stage_buffer_stages_the_buffer_not_the_worktree() {
        let repo = TestRepo::new();
        repo.commit_file("f.txt", "one\ntwo\nthree\n");
        repo.write("f.txt", "ONE\ntwo\nTHREE\n");

        // The buffer holds only the first of the two edits — a staged hunk.
        let git = Repo::open(repo.path()).expect("open");
        git.stage_buffer("f.txt", b"ONE\ntwo\nthree\n", Some(b"one\ntwo\nthree\n")).expect("stage");

        assert_eq!(porcelain(&repo), "MM f.txt", "one edit staged, one not");
        assert_eq!(cached_numstat(&repo), "1\t1\tf.txt");
        assert_eq!(repo.git(&["show", ":0:f.txt"]), "ONE\ntwo\nthree");
        assert_eq!(repo.git(&["diff", "--numstat"]), "1\t1\tf.txt", "second edit still unstaged");
    }

    #[test]
    fn stage_buffer_creates_an_entry_for_an_untracked_path() {
        let repo = TestRepo::new();
        repo.write("new.txt", "fresh\n");
        let git = Repo::open(repo.path()).expect("open");
        git.stage_buffer("new.txt", b"fresh\n", None).expect("stage");
        assert_eq!(porcelain(&repo), "A  new.txt");
    }

    #[test]
    fn a_commit_after_staging_captures_the_staged_content() {
        // Guards the tree-cache removal: with a stale `tree` extension left in
        // the index, this commit would silently capture the old subtree.
        let repo = TestRepo::new();
        repo.commit_file("sub/dir/f.txt", "old\n");
        repo.git(&[
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "prime tree cache",
        ]);
        repo.write("sub/dir/f.txt", "new\n");

        let git = Repo::open(repo.path()).expect("open");
        git.stage_buffer("sub/dir/f.txt", b"new\n", Some(b"old\n")).expect("stage");
        repo.git(&["commit", "--quiet", "-m", "capture"]);
        assert_eq!(repo.git(&["show", "HEAD:sub/dir/f.txt"]), "new");
    }

    #[test]
    fn stage_buffer_refuses_a_moved_index() {
        let repo = TestRepo::new();
        repo.commit_file("f.txt", "one\ntwo\n");
        repo.write("f.txt", "ONE\ntwo\nTHREE\n");
        let git = Repo::open(repo.path()).expect("open");
        // First hunk lands; the second click still carries the pre-first-hunk
        // index as its base — the race that silently reverted hunk one.
        git.stage_buffer("f.txt", b"ONE\ntwo\n", Some(b"one\ntwo\n")).expect("first hunk");
        let stale = git.stage_buffer("f.txt", b"one\ntwo\nTHREE\n", Some(b"one\ntwo\n"));
        assert!(stale.expect_err("stale base must refuse").to_string().contains("changed under"));
        assert_eq!(repo.git(&["show", ":0:f.txt"]), "ONE\ntwo", "first hunk must survive");
        // Re-run from the refreshed base: exactly what the retried click sends.
        git.stage_buffer("f.txt", b"ONE\ntwo\nTHREE\n", Some(b"ONE\ntwo\n")).expect("retry");
        assert_eq!(repo.git(&["show", ":0:f.txt"]), "ONE\ntwo\nTHREE");
    }

    #[test]
    fn stage_buffer_leaves_an_unstaged_chmod_unstaged() {
        use std::os::unix::fs::PermissionsExt;
        let repo = TestRepo::new();
        repo.write("run.sh", "#!/bin/sh\none\n");
        let path = repo.path().join("run.sh");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        repo.git(&["add", "run.sh"]);
        repo.git(&["commit", "--quiet", "-m", "executable"]);
        // The user un-chmods (not staged) and edits content.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("chmod");
        repo.write("run.sh", "#!/bin/sh\nONE\n");

        let git = Repo::open(repo.path()).expect("open");
        git.stage_buffer("run.sh", b"#!/bin/sh\nONE\n", Some(b"#!/bin/sh\none\n"))
            .expect("stage content hunk");
        assert!(
            repo.git(&["ls-files", "--stage", "run.sh"]).starts_with("100755"),
            "a content hunk must not stage the chmod"
        );
    }

    #[test]
    fn stage_buffer_keeps_a_staged_chmod_staged() {
        use std::os::unix::fs::PermissionsExt;
        let repo = TestRepo::new();
        repo.commit_file("run.sh", "#!/bin/sh\none\ntwo\n");
        let path = repo.path().join("run.sh");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        repo.write("run.sh", "#!/bin/sh\nONE\nTWO\n");
        repo.git(&["add", "run.sh"]);

        // Unstage one content hunk (the staged-view − button): index minus it.
        let git = Repo::open(repo.path()).expect("open");
        git.stage_buffer("run.sh", b"#!/bin/sh\none\nTWO\n", Some(b"#!/bin/sh\nONE\nTWO\n"))
            .expect("unstage hunk");
        assert!(
            repo.git(&["ls-files", "--stage", "run.sh"]).starts_with("100755"),
            "unstaging a content hunk must not discard the staged chmod"
        );
    }

    #[test]
    fn stage_path_matches_git_add() {
        let repo = TestRepo::new();
        repo.commit_file("f.txt", "a\n");
        repo.write("f.txt", "a\nb\n");
        repo.write("new.txt", "n\n");

        let git = Repo::open(repo.path()).expect("open");
        git.stage_path("f.txt").expect("stage modified");
        git.stage_path("new.txt").expect("stage untracked");

        assert_eq!(porcelain(&repo), "M  f.txt\nA  new.txt");
        assert_eq!(repo.git(&["diff", "--numstat"]), "", "nothing left unstaged");
    }

    #[test]
    fn stage_path_records_a_deletion() {
        let repo = TestRepo::new();
        repo.commit_file("gone.txt", "bye\n");
        std::fs::remove_file(repo.path().join("gone.txt")).expect("rm");
        let git = Repo::open(repo.path()).expect("open");
        git.stage_path("gone.txt").expect("stage deletion");
        assert_eq!(porcelain(&repo), "D  gone.txt");
    }

    #[test]
    fn stage_path_preserves_the_executable_bit() {
        use std::os::unix::fs::PermissionsExt;
        let repo = TestRepo::new();
        repo.write("run.sh", "#!/bin/sh\n");
        let path = repo.path().join("run.sh");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        let git = Repo::open(repo.path()).expect("open");
        git.stage_path("run.sh").expect("stage");
        assert!(
            repo.git(&["ls-files", "--stage", "run.sh"]).starts_with("100755"),
            "mode must be executable"
        );
    }

    #[test]
    fn stage_path_refuses_a_directory() {
        let repo = TestRepo::new();
        repo.write("node_modules/pkg/a.js", "x\n");
        let git = Repo::open(repo.path()).expect("open");
        let err = git.stage_path("node_modules").expect_err("a directory is not stageable");
        assert!(err.to_string().contains("not a stageable file"), "{err}");
    }

    #[test]
    fn unstage_path_matches_git_reset() {
        let repo = TestRepo::new();
        repo.commit_file("f.txt", "a\n");
        repo.write("f.txt", "a\nb\n");
        repo.git(&["add", "f.txt"]);
        repo.write("fresh.txt", "new\n");
        repo.git(&["add", "fresh.txt"]);

        let git = Repo::open(repo.path()).expect("open");
        git.unstage_path("f.txt").expect("unstage modified");
        git.unstage_path("fresh.txt").expect("unstage added");

        // `TestRepo::git` trims output, costing porcelain's leading space.
        let status = porcelain(&repo);
        let lines: Vec<&str> = status.lines().map(str::trim).collect();
        assert_eq!(lines, vec!["M f.txt", "?? fresh.txt"]);
        assert_eq!(cached_numstat(&repo), "");
    }

    #[test]
    fn mutations_refuse_an_unmerged_path() {
        let repo = TestRepo::new();
        repo.commit_file("f.txt", "base\n");
        repo.git(&["checkout", "--quiet", "-b", "left"]);
        repo.commit_file("f.txt", "left\n");
        repo.git(&["checkout", "--quiet", "main"]);
        repo.commit_file("f.txt", "right\n");
        let merge = std::process::Command::new("git")
            .args(["-C", repo.path().to_str().unwrap(), "merge", "left"])
            .output()
            .expect("merge runs");
        assert!(!merge.status.success(), "fixture needs a conflict");

        let git = Repo::open(repo.path()).expect("open");
        assert!(git.stage_buffer("f.txt", b"resolved\n", None).is_err());
        assert!(git.stage_path("f.txt").is_err());
    }

    #[test]
    fn file_in_index_reads_the_staged_version() {
        let repo = TestRepo::new();
        repo.commit_file("f.txt", "committed\n");
        repo.write("f.txt", "staged\n");
        repo.git(&["add", "f.txt"]);
        repo.write("f.txt", "worktree\n");

        let git = Repo::open(repo.path()).expect("open");
        assert_eq!(git.file_in_index("f.txt").as_deref(), Some(&b"staged\n"[..]));
        assert_eq!(git.file_in_index("absent.txt"), None);
    }

    #[test]
    fn stage_states_sees_all_three_shapes() {
        let repo = TestRepo::new();
        repo.commit_file("both.txt", "a\n");
        repo.commit_file("staged.txt", "b\n");
        repo.commit_file("unstaged.txt", "c\n");
        repo.write("both.txt", "a\nstaged\n");
        repo.git(&["add", "both.txt"]);
        repo.write("both.txt", "a\nstaged\nmore\n");
        repo.write("staged.txt", "b\nstaged\n");
        repo.git(&["add", "staged.txt"]);
        repo.write("unstaged.txt", "c\nedited\n");
        repo.write("untracked.txt", "new\n");

        let git = Repo::open(repo.path()).expect("open");
        let states = git
            .stage_states(["both.txt", "staged.txt", "unstaged.txt", "untracked.txt"])
            .expect("states");
        let get = |p: &str| *states.get(p).expect(p);
        assert_eq!(get("both.txt"), StageState { staged: true, unstaged: true });
        assert_eq!(get("staged.txt"), StageState { staged: true, unstaged: false });
        assert_eq!(get("unstaged.txt"), StageState { staged: false, unstaged: true });
        assert_eq!(get("untracked.txt"), StageState { staged: false, unstaged: true });
    }

    #[test]
    fn stage_states_trusts_content_over_stat_after_buffer_staging() {
        let repo = TestRepo::new();
        repo.commit_file("f.txt", "one\ntwo\n");
        repo.write("f.txt", "ONE\ntwo\nTHREE\n");
        let git = Repo::open(repo.path()).expect("open");
        git.stage_buffer("f.txt", b"ONE\ntwo\n", Some(b"one\ntwo\n")).expect("stage");
        let states = git.stage_states(["f.txt"]).expect("states");
        assert_eq!(states["f.txt"], StageState { staged: true, unstaged: true });
    }

    #[test]
    fn staged_changes_match_git_diff_cached_numstat() {
        let repo = TestRepo::new();
        repo.commit_file("mod.txt", "a\nb\n");
        repo.commit_file("del.txt", "x\n");
        repo.write("mod.txt", "a\nB\nc\n");
        repo.write("add.txt", "new\n");
        repo.git(&["add", "mod.txt", "add.txt"]);
        repo.git(&["rm", "--quiet", "del.txt"]);
        repo.write("mod.txt", "a\nB\nc\nunstaged\n");

        let git = Repo::open(repo.path()).expect("open");
        let changes = git.staged_changes().expect("staged");
        let observed: Vec<String> = changes
            .files
            .iter()
            .map(|f| format!("{}\t{}\t{}", f.lines_added, f.lines_removed, f.path))
            .collect();
        let expected: Vec<String> = cached_numstat(&repo).lines().map(|l| l.to_string()).collect();
        assert_eq!(observed, expected);
        let by_path = |p: &str| changes.files.iter().find(|f| f.path == p).expect(p).status;
        assert_eq!((by_path("mod.txt"), by_path("add.txt"), by_path("del.txt")), ('M', 'A', 'D'));
    }

    #[test]
    fn staged_changes_skip_unmerged_paths() {
        let repo = TestRepo::new();
        repo.commit_file("f.txt", "base\n");
        repo.git(&["checkout", "--quiet", "-b", "left"]);
        repo.commit_file("f.txt", "left\n");
        repo.git(&["checkout", "--quiet", "main"]);
        repo.commit_file("f.txt", "right\n");
        let merge = std::process::Command::new("git")
            .args(["-C", repo.path().to_str().unwrap(), "merge", "left"])
            .output()
            .expect("merge runs");
        assert!(!merge.status.success(), "fixture needs a conflict");

        // `git diff --cached` calls it unmerged, not a staged deletion.
        let git = Repo::open(repo.path()).expect("open");
        let changes = git.staged_changes().expect("staged");
        assert!(
            !changes.files.iter().any(|f| f.path == "f.txt"),
            "an unmerged path is not staged anything: {:?}",
            changes.files
        );
        assert!(git.is_unmerged("f.txt"));
        assert!(!git.is_unmerged("other.txt"));
    }

    #[test]
    fn staged_changes_are_empty_when_nothing_is_staged() {
        let repo = TestRepo::new();
        repo.write("f.txt", "unstaged edit\n");
        let git = Repo::open(repo.path()).expect("open");
        assert!(git.staged_changes().expect("staged").files.is_empty());
    }
}
