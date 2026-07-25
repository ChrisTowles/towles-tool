//! In-process git, via [gitoxide](https://github.com/GitoxideLabs/gitoxide).
//!
//! Every *read* of a repository in this workspace goes through here instead of
//! spawning `git`. The Agentboard poll alone ran ~100k `git` subprocesses a day
//! — `rev-parse`, `merge-base`, `status`, `diff`, `rev-list` — each one a fork,
//! an exec, a config parse, and a ref-store load thrown away microseconds
//! later. Measured against this repo, the same answers come back 10–100× faster
//! from a cached [`Repo`] (`rev-parse HEAD`: 0.75ms spawned vs 0.01ms here).
//!
//! ## What is *not* here, and why
//!
//! Three operations still shell out to `git`, and none of them is an oversight:
//!
//! - **Worktree add/remove/prune.** gitoxide's worktree API is read-only
//!   ([`gix::worktree::Proxy`] and friends); there is no linked-worktree
//!   creation or removal. `tt task new`/`rm` keep using `tt_exec`.
//! - **`merge --ff-only`.** Fast-forwarding the base branch updates the working
//!   tree, and gitoxide has no working-tree checkout to do it with. (The one
//!   branch switch that *is* here, [`Repo::create_branch_at_head`], is a pure
//!   ref write precisely because its caller has proven the tree is clean.)
//! - **`fetch`.** gitoxide can fetch, but it is network-bound work where an
//!   in-process implementation buys nothing measurable, and moving it would put
//!   credential helpers, SSH, and a TLS stack (which must trust the OS root
//!   store — see the repo's CLAUDE.md) on the line for no gain.
//!
//! Everything else — every ref read, graph walk, status, diff, ignore check,
//! branch create/delete, and the patch-identity probing behind
//! `tt_tasks::landed` — is in-process.
//!
//! ## The cache
//!
//! Opening a repository is the expensive part of gitoxide (~0.3ms: config
//! discovery, ref store, ODB setup); the queries afterwards are microseconds.
//! [`RepoCache`] therefore holds one open repository **per folder**, keyed by
//! canonical path, and hands out cheap thread-local clones. A cached handle
//! stays correct on its own for refs and objects — gitoxide reads refs from
//! disk per query and refreshes the object database when a lookup misses — but
//! *not* for config, which is parsed once at open. So each [`RepoCache::open`]
//! stats the repo's `config` file and reopens on change: one `stat` against a
//! whole process spawn is not a trade worth agonizing over.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

mod diff;
mod graph;
mod patch;
mod status;

pub use diff::{CommitStat, DiffTotals, FileChange};

pub use patch::PatchId;
pub use status::{StatusEntry, StatusSummary};

/// The line-diff algorithm, applied everywhere lines are counted or compared.
///
/// Myers because that is git's default, and the numbers here sit next to
/// numbers the user gets from `git diff`. This is not a formality: on this
/// repo's own `Cargo.lock`, Histogram reports `+1226 −2` where git reports
/// `+1310 −86` — the same net change split into different hunks, and a rail
/// that disagreed with the terminal would read as a bug in the rail. Paired
/// with slider heuristics, which is git's default `diff.indentHeuristic`.
pub(crate) const DIFF_ALGORITHM: gix::diff::blob::Algorithm = gix::diff::blob::Algorithm::Myers;

/// A git read that did not answer.
///
/// Deliberately coarse: every caller in this workspace degrades to a
/// conservative default (empty stats, "work is present") rather than branching
/// on *why* git could not answer, so a rich error taxonomy would be typed
/// vocabulary nobody reads. What callers do need is the message, for the
/// telemetry log.
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    /// The path exists but is not inside a git repository.
    #[error("not a git repository: {0}")]
    NotARepo(String),
    /// Opening the repository failed (unreadable config, broken gitdir link).
    #[error("cannot open git repository at {path}: {detail}")]
    Open { path: String, detail: String },
    /// A ref, object, or index read failed.
    #[error("git read failed: {0}")]
    Read(String),
    /// A revspec that resolved to nothing — a branch that does not exist, a
    /// `origin/main` in a repo with no remote.
    #[error("no such revision: {0}")]
    NoSuchRev(String),
}

pub type Result<T> = std::result::Result<T, GitError>;

/// One open repository per folder, shared across polls.
///
/// Cheap to clone handles out of, safe to share across threads, and self-
/// healing: a folder whose checkout is removed or whose config changes is
/// reopened on next use rather than serving a stale handle forever.
#[derive(Debug, Default)]
pub struct RepoCache {
    entries: Mutex<HashMap<PathBuf, Entry>>,
}

#[derive(Debug)]
struct Entry {
    repo: gix::ThreadSafeRepository,
    /// Modification time of the repository's `config` at open. gitoxide parses
    /// config once per open, so a `remote set-url` (or any other config edit)
    /// would otherwise be invisible to a long-lived handle.
    config_stamp: Option<std::time::SystemTime>,
}

impl RepoCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open `dir`'s repository, reusing the cached handle when one is valid.
    ///
    /// Returns [`GitError::NotARepo`] for a plain directory and for a missing
    /// one — callers treat both as "no git info", and distinguishing them is
    /// the *caller's* job via the filesystem (see `GitInfo::dir_missing`),
    /// since a git error cannot tell them apart either.
    pub fn open(&self, dir: &Path) -> Result<Repo> {
        let key = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        let mut entries = self.lock();
        if let Some(entry) = entries.get(&key)
            && config_stamp(&entry.repo) == entry.config_stamp
        {
            return Ok(Repo { repo: entry.repo.to_thread_local() });
        }
        let repo = gix::open(&key).map_err(|e| match e {
            gix::open::Error::NotARepository { .. } => {
                GitError::NotARepo(key.display().to_string())
            }
            other => GitError::Open { path: key.display().to_string(), detail: other.to_string() },
        })?;
        let repo = repo.into_sync();
        let handle = repo.to_thread_local();
        entries.insert(key, Entry { config_stamp: config_stamp(&repo), repo });
        Ok(Repo { repo: handle })
    }

    /// Drop `dir`'s cached handle. For a checkout that has just been removed —
    /// nothing breaks if it is skipped (the next `open` re-validates anyway),
    /// but holding an open ODB against a deleted worktree keeps file handles
    /// alive for no reason.
    pub fn forget(&self, dir: &Path) {
        let key = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        self.lock().remove(&key);
    }

    /// Number of cached repositories. For tests and diagnostics.
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// A poisoned mutex here means another thread panicked mid-cache-write.
    /// The map is a pure memoization of on-disk state — nothing it holds can be
    /// left logically inconsistent by an interrupted write — so recovering the
    /// guard is strictly better than propagating a panic into a status poll.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, Entry>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn config_stamp(repo: &gix::ThreadSafeRepository) -> Option<std::time::SystemTime> {
    std::fs::metadata(repo.to_thread_local().common_dir().join("config"))
        .and_then(|m| m.modified())
        .ok()
}

/// The process-wide cache.
///
/// One cache rather than one per caller is the point: the Agentboard poll, the
/// task machinery, and the CLI all read the same handful of checkouts, and a
/// per-caller cache would reopen each of them once per caller. Folders are
/// bounded by how many checkouts a person has open, so this never grows
/// meaningfully; [`forget`] trims a removed one anyway.
pub fn cache() -> &'static RepoCache {
    static CACHE: std::sync::OnceLock<RepoCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(RepoCache::new)
}

/// Open `dir` through the process-wide [`cache`]. The entry point for
/// essentially every caller.
pub fn open(dir: &Path) -> Result<Repo> {
    cache().open(dir)
}

/// Drop `dir` from the process-wide [`cache`] — for a checkout being removed.
pub fn forget(dir: &Path) {
    cache().forget(dir);
}

/// A handle to one repository. Cheap to create from [`RepoCache::open`], not
/// `Send` — hold it for the duration of one folder's work, not across threads.
pub struct Repo {
    repo: gix::Repository,
}

impl std::fmt::Debug for Repo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Repo").field("git_dir", &self.repo.git_dir()).finish()
    }
}

impl Repo {
    /// Open a repository directly, without a cache. For one-shot callers (the
    /// CLI, a test) where a cache would outlive nothing.
    pub fn open(dir: &Path) -> Result<Self> {
        let repo = gix::open(dir).map_err(|e| match e {
            gix::open::Error::NotARepository { .. } => {
                GitError::NotARepo(dir.display().to_string())
            }
            other => GitError::Open { path: dir.display().to_string(), detail: other.to_string() },
        })?;
        Ok(Self { repo })
    }

    /// The underlying gitoxide repository, for operations this wrapper has no
    /// reason to name.
    pub fn inner(&self) -> &gix::Repository {
        &self.repo
    }

    /// This checkout's own git directory — `.git` for a main worktree,
    /// `<repo>/.git/worktrees/<name>` for a linked one.
    pub fn git_dir(&self) -> PathBuf {
        self.repo.git_dir().to_path_buf()
    }

    /// The repository's shared git directory: identical across every linked
    /// worktree of one repo and nowhere else, which is what makes it the
    /// Folder Rail's grouping key. Canonicalized, because gitoxide reports it
    /// as a path *relative to* the worktree's gitdir
    /// (`…/worktrees/<name>/../..`) and two spellings of one directory must
    /// never read as two repos.
    pub fn common_dir(&self) -> PathBuf {
        let raw = self.repo.common_dir();
        std::fs::canonicalize(raw).unwrap_or_else(|_| raw.to_path_buf())
    }

    /// Whether this checkout is a linked worktree rather than the main one.
    pub fn is_linked_worktree(&self) -> bool {
        self.repo.worktree().is_some_and(|wt| wt.id().is_some())
    }

    /// The checked-out branch's short name, or `None` on a detached HEAD.
    pub fn head_branch(&self) -> Option<String> {
        self.repo.head_name().ok().flatten().map(|name| name.shorten().to_string())
    }

    /// `HEAD`'s commit id, or `None` on an unborn branch (a fresh `git init`
    /// with no commit).
    pub fn head_id(&self) -> Option<gix::ObjectId> {
        self.repo.head_id().ok().map(|id| id.detach())
    }

    /// Resolve a revspec (`origin/main`, `HEAD`, a sha, `main^{tree}`) to a
    /// single object id. `None` when it names nothing — the in-process
    /// equivalent of `git rev-parse --verify --quiet`.
    pub fn resolve(&self, spec: &str) -> Option<gix::ObjectId> {
        self.repo.rev_parse_single(spec).ok().map(|id| id.detach())
    }

    /// Whether `spec` resolves at all.
    pub fn has_rev(&self, spec: &str) -> bool {
        self.resolve(spec).is_some()
    }

    /// `git remote get-url origin`, or `None` when the repo has no origin.
    pub fn origin_url(&self) -> Option<String> {
        let remote = self.repo.find_remote("origin").ok()?;
        let url = remote.url(gix::remote::Direction::Fetch)?;
        Some(url.to_bstring().to_string())
    }

    /// Whether the branch's upstream is *gone* — configured but no longer
    /// present on the remote, the `[gone]` of `%(upstream:track)`. The weakest
    /// landing signal there is (see [`crate::repo::graph`] callers), and
    /// deliberately distinct from "no upstream configured", which is `false`:
    /// a branch that was never pushed has not had anything deleted.
    pub fn upstream_gone(&self, branch: &str) -> bool {
        let Ok(Some(reference)) = self.repo.try_find_reference(branch) else {
            return false;
        };
        let Some(Ok(upstream)) = self
            .repo
            .branch_remote_tracking_ref_name(reference.name(), gix::remote::Direction::Fetch)
        else {
            return false;
        };
        // Configured, but the remote-tracking ref it names is not in the repo:
        // a `git fetch --prune` after the remote branch was deleted.
        self.repo.try_find_reference(upstream.as_ref().as_bstr()).ok().flatten().is_none()
    }

    /// Every local branch's short name, unordered — `git for-each-ref
    /// refs/heads --format=%(refname:short)`.
    pub fn local_branches(&self) -> Vec<String> {
        let Ok(platform) = self.repo.references() else {
            return Vec::new();
        };
        let Ok(branches) = platform.prefixed("refs/heads/") else {
            return Vec::new();
        };
        branches
            .flatten()
            .filter_map(|r| r.name().category_and_short_name().map(|(_, name)| name.to_string()))
            .collect()
    }

    /// Delete a local branch — `git branch -D <branch>`.
    ///
    /// Force semantics, like the `-D` it replaces: whether the branch has
    /// landed is the caller's decision, and in this workspace only
    /// content-based landing proof justifies calling it (see
    /// `tt_tasks::landed::LandedVia::is_content_proof`). Deleting a ref does
    /// not delete commits; they survive until git's own gc.
    pub fn delete_branch(&self, branch: &str) -> Result<()> {
        let full = format!("refs/heads/{branch}");
        let name = gix::refs::FullName::try_from(full.as_str())
            .map_err(|e| GitError::Read(e.to_string()))?;
        self.repo
            .edit_reference(gix::refs::transaction::RefEdit {
                change: gix::refs::transaction::Change::Delete {
                    expected: gix::refs::transaction::PreviousValue::MustExist,
                    log: gix::refs::transaction::RefLog::AndReference,
                },
                name,
                deref: false,
            })
            .map_err(|e| GitError::Read(e.to_string()))?;
        Ok(())
    }

    /// Is `relative_path` excluded by the repository's ignore rules — the
    /// `git check-ignore -q` this replaces.
    ///
    /// `false` when the rules cannot be loaded, which keeps the one caller
    /// (`tt task init`, asking whether `.env` is already ignored) on the side
    /// of *offering* to add the entry rather than silently assuming it is
    /// covered.
    pub fn is_ignored(&self, relative_path: &str) -> bool {
        let Ok(index) = self.repo.index_or_empty() else {
            return false;
        };
        let Ok(mut excludes) = self.repo.excludes(
            &index,
            None,
            gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped,
        ) else {
            return false;
        };
        excludes
            .at_path(relative_path, Some(gix::index::entry::Mode::FILE))
            .ok()
            .and_then(|platform| platform.excluded_kind())
            .is_some()
    }

    /// Number of stash entries — `git stash list`'s line count.
    ///
    /// The stash is the reflog of `refs/stash`, so an empty count and a missing
    /// ref are the same answer: nothing stashed.
    pub fn stash_count(&self) -> usize {
        let Ok(Some(stash)) = self.repo.try_find_reference("refs/stash") else {
            return 0;
        };
        stash.log_iter().all().ok().flatten().map(|log| log.flatten().count()).unwrap_or(0)
    }

    /// Create `branch` at the current `HEAD` and switch to it — `git checkout
    /// -b <branch>` for the one case this workspace performs it in: a checkout
    /// the caller has already verified is **clean**.
    ///
    /// That precondition is what makes this two ref writes rather than a
    /// checkout. Creating a branch at `HEAD` and pointing `HEAD` at it changes
    /// no file: the commit is the same one already checked out, so index and
    /// working tree are correct by construction. gitoxide has no working-tree
    /// checkout to fall back on, so a caller that has *not* established a clean
    /// tree must not use this — it would silently skip the file updates a real
    /// switch performs.
    ///
    /// Fails when `branch` already exists, matching `git checkout -b`.
    pub fn create_branch_at_head(&self, branch: &str) -> Result<()> {
        let head = self.head_id().ok_or_else(|| GitError::NoSuchRev("HEAD".to_string()))?;
        let full = format!("refs/heads/{branch}");
        if self.has_rev(&full) {
            return Err(GitError::Read(format!("branch {branch} already exists")));
        }
        let name = gix::refs::FullName::try_from(full.as_str())
            .map_err(|e| GitError::Read(e.to_string()))?;
        self.repo
            .edit_reference(gix::refs::transaction::RefEdit {
                change: gix::refs::transaction::Change::Update {
                    log: gix::refs::transaction::LogChange {
                        mode: gix::refs::transaction::RefLog::AndReference,
                        force_create_reflog: false,
                        message: "branch: Created from HEAD".into(),
                    },
                    expected: gix::refs::transaction::PreviousValue::MustNotExist,
                    new: gix::refs::Target::Object(head),
                },
                name: name.clone(),
                deref: false,
            })
            .map_err(|e| GitError::Read(e.to_string()))?;
        // Point HEAD at the new branch. Symbolic, exactly as a checkout leaves
        // it — an object target here would detach HEAD instead.
        self.repo
            .edit_reference(gix::refs::transaction::RefEdit {
                change: gix::refs::transaction::Change::Update {
                    log: gix::refs::transaction::LogChange {
                        mode: gix::refs::transaction::RefLog::AndReference,
                        force_create_reflog: false,
                        message: format!("checkout: moving to {branch}").into(),
                    },
                    expected: gix::refs::transaction::PreviousValue::Any,
                    new: gix::refs::Target::Symbolic(name),
                },
                name: gix::refs::FullName::try_from("HEAD")
                    .map_err(|e| GitError::Read(e.to_string()))?,
                deref: false,
            })
            .map_err(|e| GitError::Read(e.to_string()))?;
        Ok(())
    }

    /// Every checkout of this repository: the main worktree first, then each
    /// linked one.
    ///
    /// gitoxide reports the two separately — [`gix::Repository::worktrees`]
    /// covers *linked* worktrees only — so the main checkout is prepended here.
    /// A caller that dropped it would silently stop pulling a tracked task's
    /// primary into the Folder Rail.
    pub fn worktrees(&self) -> Vec<WorktreeEntry> {
        let mut out = Vec::new();
        let main = self
            .repo
            .main_repo()
            .ok()
            .and_then(|main| main.workdir().map(|w| w.to_path_buf()))
            .or_else(|| self.repo.workdir().map(|w| w.to_path_buf()));
        if let Some(dir) = main {
            out.push(WorktreeEntry { dir: canonical(&dir), is_main: true });
        }
        for proxy in self.repo.worktrees().into_iter().flatten() {
            if let Ok(base) = proxy.base() {
                out.push(WorktreeEntry { dir: canonical(&base), is_main: false });
            }
        }
        out
    }
}

/// One checkout of a repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeEntry {
    /// Absolute path to the working directory.
    pub dir: String,
    /// Whether this is the repository's main worktree.
    pub is_main: bool,
}

/// Canonicalize for comparison, falling back to the path as given. Worktree
/// paths are compared against caller-supplied directory strings, and a symlink
/// spelled two ways must not read as two checkouts.
fn canonical(path: &Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
pub(crate) mod testrepo;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::testrepo::TestRepo;

    #[test]
    fn open_reports_non_repo_directories() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cache = RepoCache::new();
        assert!(matches!(cache.open(dir.path()), Err(GitError::NotARepo(_))));
    }

    #[test]
    fn cache_reuses_one_handle_per_folder() {
        let repo = TestRepo::new();
        let cache = RepoCache::new();
        assert!(cache.open(repo.path()).is_ok());
        assert!(cache.open(repo.path()).is_ok());
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn cache_reopens_after_a_config_change() {
        let repo = TestRepo::new();
        let cache = RepoCache::new();
        assert!(cache.open(repo.path()).expect("open").origin_url().is_none());
        repo.git(&["remote", "add", "origin", "https://example.com/x.git"]);
        assert_eq!(
            cache.open(repo.path()).expect("open").origin_url().as_deref(),
            Some("https://example.com/x.git"),
            "a cached handle must not serve a stale remote"
        );
    }

    #[test]
    fn forget_drops_the_entry() {
        let repo = TestRepo::new();
        let cache = RepoCache::new();
        assert!(cache.open(repo.path()).is_ok());
        cache.forget(repo.path());
        assert!(cache.is_empty());
    }

    #[test]
    fn head_branch_and_id_track_the_checkout() {
        let repo = TestRepo::new();
        let git = Repo::open(repo.path()).expect("open");
        assert_eq!(git.head_branch().as_deref(), Some("main"));
        assert_eq!(git.head_id().map(|id| id.to_string()), Some(repo.rev_parse("HEAD")));
    }

    #[test]
    fn resolve_answers_none_for_missing_revisions() {
        let repo = TestRepo::new();
        let git = Repo::open(repo.path()).expect("open");
        assert!(git.has_rev("main"));
        assert!(!git.has_rev("origin/nope"));
    }

    #[test]
    fn worktrees_lists_the_main_checkout_first() {
        let repo = TestRepo::new();
        let linked = repo.add_worktree("task-a", "feature-a");
        let git = Repo::open(repo.path()).expect("open");
        let seen = git.worktrees();
        assert!(seen.first().is_some_and(|w| w.is_main), "main worktree must come first");
        assert!(
            seen.iter().any(|w| w.dir == canonical(&linked) && !w.is_main),
            "linked worktree missing from {seen:?}"
        );
    }

    #[test]
    fn worktrees_from_a_linked_checkout_still_include_the_main_one() {
        let repo = TestRepo::new();
        let linked = repo.add_worktree("task-b", "feature-b");
        let git = Repo::open(&linked).expect("open linked");
        assert!(git.is_linked_worktree());
        assert!(
            git.worktrees().iter().any(|w| w.is_main && w.dir == canonical(repo.path())),
            "a task must be able to discover its primary"
        );
    }

    #[test]
    fn delete_branch_removes_the_ref_and_nothing_else() {
        let repo = TestRepo::new();
        repo.git(&["branch", "doomed"]);
        let sha = repo.rev_parse("doomed");

        Repo::open(repo.path()).expect("open").delete_branch("doomed").expect("delete");

        assert!(
            !repo.git(&["branch", "--list", "doomed"]).contains("doomed"),
            "git must agree the branch is gone"
        );
        // The commit itself survives — deleting a ref is not deleting history.
        assert_eq!(repo.git(&["rev-parse", &sha]), sha);
    }

    #[test]
    fn delete_branch_reports_a_missing_branch() {
        let repo = TestRepo::new();
        assert!(Repo::open(repo.path()).expect("open").delete_branch("never-existed").is_err());
    }

    #[test]
    fn is_ignored_matches_git_check_ignore() {
        let repo = TestRepo::new();
        repo.write(".gitignore", ".env\nnode_modules/\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "--quiet", "-m", "ignore rules"]);

        let git = Repo::open(repo.path()).expect("open");
        assert!(git.is_ignored(".env"));
        assert!(!git.is_ignored("README.md"));
        assert!(!git.is_ignored("src/main.rs"));
    }

    #[test]
    fn stash_count_matches_git_stash_list() {
        let repo = TestRepo::new();
        let git = Repo::open(repo.path()).expect("open");
        assert_eq!(git.stash_count(), 0);

        repo.write("README.md", "hello\nchanged\n");
        repo.git(&["stash", "push", "-q", "-m", "one"]);
        repo.write("README.md", "hello\nagain\n");
        repo.git(&["stash", "push", "-q", "-m", "two"]);

        let expected = repo.git(&["stash", "list"]).lines().count();
        assert_eq!(Repo::open(repo.path()).expect("open").stash_count(), expected);
        assert_eq!(expected, 2, "fixture sanity");
    }

    #[test]
    fn create_branch_at_head_switches_like_checkout_b() {
        let repo = TestRepo::new();
        Repo::open(repo.path()).expect("open").create_branch_at_head("feat/new").expect("create");

        // Ask git itself what happened, not gix — the point is that a real
        // checkout is left in the state `git checkout -b` would leave.
        assert_eq!(repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]), "feat/new");
        assert_eq!(repo.rev_parse("feat/new"), repo.rev_parse("main"));
        assert_eq!(repo.git(&["status", "--porcelain"]), "", "the tree must be untouched");
    }

    #[test]
    fn create_branch_at_head_refuses_an_existing_branch() {
        let repo = TestRepo::new();
        let git = Repo::open(repo.path()).expect("open");
        assert!(git.create_branch_at_head("main").is_err());
        assert_eq!(repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    }

    #[test]
    fn upstream_gone_is_false_without_an_upstream() {
        let repo = TestRepo::new();
        let git = Repo::open(repo.path()).expect("open");
        assert!(!git.upstream_gone("refs/heads/main"));
    }

    #[test]
    fn upstream_gone_detects_a_deleted_remote_branch() {
        let repo = TestRepo::new();
        repo.git(&["checkout", "--quiet", "-b", "feature"]);
        repo.commit_file("f.txt", "work");
        // Configured upstream whose remote-tracking ref does not exist: exactly
        // the state `git fetch --prune` leaves after the PR branch is deleted.
        // The remote itself must exist for the upstream to resolve to a
        // remote-tracking ref name at all — that mapping comes from its
        // fetch refspec.
        repo.git(&["remote", "add", "origin", "https://example.com/x.git"]);
        repo.git(&["config", "branch.feature.remote", "origin"]);
        repo.git(&["config", "branch.feature.merge", "refs/heads/feature"]);
        let git = Repo::open(repo.path()).expect("open");
        assert!(git.upstream_gone("refs/heads/feature"));
    }
}
