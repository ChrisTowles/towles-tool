//! Optional filesystem-change accelerant. Isolated from the deterministic scan
//! core: polling (the bridge calling [`crate::watcher::AgentWatcher::scan`]) is
//! the reliable path; this just lets the bridge trigger an *eager* rescan when a
//! journal file changes, cutting latency.
//!
//! Events are debounced: a streaming agent appends its JSONL several times a
//! second (plus subagent/meta writes), and firing `on_change` per inotify event
//! made the host rescan back-to-back continuously — pegging a core exactly
//! while the user's agents were busiest. Bursts coalesce into at most one
//! callback per [`DEBOUNCE`] window; worst-case added latency is one window.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

/// Coalescing window for filesystem-event bursts.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// A path spelled the way the OS watcher will report it. macOS resolves every
/// symlink in a watched path (`/var` → `/private/var`, and any symlinked home
/// or checkout), so a registration keyed on the caller's spelling never matches
/// its own events and the accelerant silently dies back to the poll. Only the
/// deepest *existing* ancestor can be resolved: a pending file, and often its
/// parent, does not exist yet.
fn resolved(path: &Path) -> PathBuf {
    let mut missing: Vec<&std::ffi::OsStr> = Vec::new();
    let mut cursor = path;
    loop {
        if let Ok(real) = std::fs::canonicalize(cursor) {
            return missing.iter().rev().fold(real, |acc, part| acc.join(part));
        }
        match (cursor.parent(), cursor.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name);
                cursor = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// Watches a directory tree and invokes `on_change` (debounced) when anything
/// under it changes. Dropping it stops watching and ends the debounce thread.
pub struct DirNotifier {
    _watcher: RecommendedWatcher,
}

impl DirNotifier {
    /// Watch `dir` recursively, calling `on_change` once per debounce window.
    pub fn watch<F>(dir: &Path, on_change: F) -> notify::Result<Self>
    where
        F: Fn() + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<()>();
        std::thread::spawn(move || debounce_loop(&rx, move |_batch| on_change()));

        let mut watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if res.is_ok() {
                    let _ = tx.send(());
                }
            })?;
        watcher.watch(dir, RecursiveMode::Recursive)?;
        Ok(Self { _watcher: watcher })
    }
}

/// Like [`DirNotifier`], but watches a *changing set* of directories under one
/// root — built for `~/.claude/projects`, which every Claude Code session on the
/// machine writes into. A plain `DirNotifier` there fires the eager rescan for
/// *any* session's activity, reducing the accelerant to "rescan constantly".
///
/// A checkout with no sessions yet isn't watched: under-watching is a latency
/// tradeoff, never a staleness bug, since the poll loop stays the baseline.
pub struct ScopedDirNotifier {
    watcher: RecommendedWatcher,
    watched: HashSet<PathBuf>,
    /// The same set [`resolved`], shared with the callback so scoping is
    /// checked against the event's own path rather than trusted to whatever
    /// the platform backend chose to deliver.
    scope: Arc<Mutex<HashSet<PathBuf>>>,
}

impl ScopedDirNotifier {
    pub fn new<F>(on_change: F) -> notify::Result<Self>
    where
        F: Fn() + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<()>();
        std::thread::spawn(move || debounce_loop(&rx, move |_batch| on_change()));
        let scope: Arc<Mutex<HashSet<PathBuf>>> = Arc::default();
        let cb_scope = scope.clone();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                let scope = cb_scope.lock().unwrap();
                if event.paths.iter().any(|p| scope.iter().any(|dir| p.starts_with(dir))) {
                    let _ = tx.send(());
                }
            }
        })?;
        Ok(Self { watcher, watched: HashSet::new(), scope })
    }

    /// Recompute the watched set from `targets` (absolute checkout dirs), each
    /// mapped through [`crate::watchers::claude_code::encode_project_dir_name`].
    /// Idempotent and diffed, so calling it on every poll tick is intended.
    pub fn set_targets(&mut self, projects_dir: &Path, targets: &[String]) {
        let desired: HashSet<PathBuf> = targets
            .iter()
            .map(|dir| {
                projects_dir.join(crate::watchers::claude_code::encode_project_dir_name(dir))
            })
            .filter(|p| p.is_dir())
            .collect();
        for stale in self.watched.difference(&desired).cloned().collect::<Vec<_>>() {
            let _ = self.watcher.unwatch(&stale);
            self.watched.remove(&stale);
        }
        for fresh in desired.difference(&self.watched).cloned().collect::<Vec<_>>() {
            if self.watcher.watch(&fresh, RecursiveMode::Recursive).is_ok() {
                self.watched.insert(fresh);
            }
        }
        *self.scope.lock().unwrap() = self.watched.iter().map(|d| resolved(d)).collect();
    }

    /// The currently watched directories — test/diagnostic seam.
    pub fn watched(&self) -> &HashSet<PathBuf> {
        &self.watched
    }
}

/// Like [`DirNotifier`], but reports *which* paths changed — what a file tree
/// needs to refresh precisely — with a caller filter so build churn (`target`,
/// `node_modules`) never reaches the debounce batch at all.
pub struct DirPathsNotifier {
    _watcher: RecommendedWatcher,
}

impl DirPathsNotifier {
    /// Watch `dir` recursively; `keep` decides per event path, `on_change`
    /// receives the deduplicated batch once per debounce window.
    pub fn watch<K, F>(dir: &Path, keep: K, on_change: F) -> notify::Result<Self>
    where
        K: Fn(&Path) -> bool + Send + 'static,
        F: Fn(Vec<PathBuf>) + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<PathBuf>();
        std::thread::spawn(move || debounce_loop(&rx, on_change));
        let mut watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res {
                    for path in event.paths {
                        if keep(&path) {
                            let _ = tx.send(path);
                        }
                    }
                }
            })?;
        watcher.watch(dir, RecursiveMode::Recursive)?;
        Ok(Self { _watcher: watcher })
    }
}

/// Watches a *set of files* with **one** OS watcher instance, debounced like
/// [`DirNotifier`]. One per checkout, not per file: inotify *instances* are
/// scarce per-user (128 by default), while directory *watches* on one are the
/// cheap plural resource. Each file's *parent directory* is what gets watched,
/// since every well-behaved writer retires the file's inode and an inode watch
/// goes permanently silent after the first replace. A deleted watched *parent*
/// is the known gap.
pub struct MultiFileNotifier {
    watcher: RecommendedWatcher,
    /// What the watcher callback matches events against — shared with it.
    targets: Arc<Mutex<Targets>>,
    /// Watched directory → number of registrations held on it. Usually a
    /// file's own parent; the nearest existing ancestor for a pending one.
    parents: HashMap<PathBuf, u32>,
    /// Registered file → the directory actually watched on its behalf. Kept
    /// because [`MultiFileNotifier::remove`] can't re-derive it: a pending
    /// file's real parent may exist by then, releasing the wrong watch.
    watched_for: HashMap<PathBuf, PathBuf>,
}

/// How many missing levels [`MultiFileNotifier::add`] walks up before giving
/// up. One covers every real control file; four leaves room for a `feat/a/b/c`
/// branch name without reaching a directory broad enough to be a problem.
const MAX_MISSING_ANCESTORS: usize = 4;

/// The callback's view of what's registered: exact paths with refcounts, plus
/// the pending ones matched by ancestry (see [`MultiFileNotifier`]'s doc).
/// Keyed by [`resolved`] path — what events carry — while every value keeps
/// the caller's spelling, which is what `on_change` reports back.
#[derive(Default)]
struct Targets {
    files: HashMap<PathBuf, Registration>,
    /// Files whose parent didn't exist at registration.
    pending: HashMap<PathBuf, PathBuf>,
}

struct Registration {
    as_given: PathBuf,
    count: u32,
}

impl Targets {
    /// The registered files an event on `path` should report: exactly `path`
    /// when registered, otherwise every pending file `path` is an ancestor of.
    fn hits(&self, path: &Path) -> Vec<PathBuf> {
        if let Some(reg) = self.files.get(path) {
            return vec![reg.as_given.clone()];
        }
        self.pending
            .iter()
            .filter(|(res, _)| res.starts_with(path))
            .map(|(_, given)| given.clone())
            .collect()
    }
}

impl MultiFileNotifier {
    /// Create an empty notifier. `on_change` receives the deduplicated batch of
    /// registered files touched in a window, leaving "what changed" to the
    /// caller's re-read.
    pub fn new<F>(on_change: F) -> notify::Result<Self>
    where
        F: Fn(Vec<PathBuf>) + Send + 'static,
    {
        let targets: Arc<Mutex<Targets>> = Arc::default();
        let (tx, rx) = mpsc::channel::<PathBuf>();
        std::thread::spawn(move || debounce_loop(&rx, on_change));

        let cb_targets = targets.clone();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                // A rename lists both halves (tmp name and final name) in
                // `paths`, so a tmp+rename replace still matches its target.
                let hits: Vec<PathBuf> = {
                    let targets = cb_targets.lock().unwrap();
                    event.paths.iter().flat_map(|p| targets.hits(p)).collect()
                };
                for path in hits {
                    let _ = tx.send(path);
                }
            }
        })?;
        Ok(Self { watcher, targets, parents: HashMap::new(), watched_for: HashMap::new() })
    }

    /// Register `file` (absolute path). Refcounted, so a second registration
    /// needs a matching [`remove`](Self::remove). The parent need not exist —
    /// see [`rewatch_pending`](Self::rewatch_pending).
    pub fn add(&mut self, file: &Path) -> notify::Result<()> {
        let key = resolved(file);
        if let Some(reg) = self.targets.lock().unwrap().files.get_mut(&key) {
            reg.count += 1;
            return Ok(());
        }
        let parent = key.parent().unwrap_or(Path::new("/")).to_path_buf();
        let dir = watch_point(&parent)
            .ok_or_else(|| notify::Error::path_not_found().add_path(parent.clone()))?;
        self.hold(&dir)?;
        self.watched_for.insert(key.clone(), dir.clone());
        let mut targets = self.targets.lock().unwrap();
        targets.files.insert(key.clone(), Registration { as_given: file.to_path_buf(), count: 1 });
        if dir != parent {
            targets.pending.insert(key, file.to_path_buf());
        }
        Ok(())
    }

    /// Move every pending registration whose real parent now exists onto that
    /// parent, so its next change fires as an exact match rather than the
    /// one-shot ancestor hit. Cheap, so call it on the rebuild tick.
    ///
    /// They go pending because `git pack-refs --prune` removes the emptied
    /// `refs/heads/feat` too. Watching the ancestor *recursively* is not the
    /// fix: notify installs that watch after git has written the ref.
    pub fn rewatch_pending(&mut self) {
        let ready: Vec<PathBuf> = {
            let targets = self.targets.lock().unwrap();
            targets
                .pending
                .keys()
                .filter(|f| f.parent().is_some_and(Path::is_dir))
                .cloned()
                .collect()
        };
        for file in ready {
            // Re-resolved: the parent that just appeared may itself be a symlink.
            let parent = match file.parent() {
                Some(p) => resolved(p),
                None => continue,
            };
            if self.hold(&parent).is_err() {
                continue;
            }
            if let Some(old) = self.watched_for.insert(file.clone(), parent) {
                self.release(&old);
            }
            self.targets.lock().unwrap().pending.remove(&file);
        }
    }

    /// Take a reference on a directory watch, starting it if this is the first.
    fn hold(&mut self, dir: &Path) -> notify::Result<()> {
        match self.parents.get_mut(dir) {
            Some(n) => *n += 1,
            None => {
                self.watcher.watch(dir, RecursiveMode::NonRecursive)?;
                self.parents.insert(dir.to_path_buf(), 1);
            }
        }
        Ok(())
    }

    /// Drop a reference on a directory watch, stopping it at zero.
    fn release(&mut self, dir: &Path) {
        if let Some(n) = self.parents.get_mut(dir) {
            *n -= 1;
            if *n == 0 {
                self.parents.remove(dir);
                let _ = self.watcher.unwatch(dir);
            }
        }
    }

    /// Drop one reference to `file`; the last drop stops delivering it and
    /// releases its directory watch when no sibling needs it.
    pub fn remove(&mut self, file: &Path) {
        let key = resolved(file);
        {
            let mut targets = self.targets.lock().unwrap();
            let Some(reg) = targets.files.get_mut(&key) else {
                return;
            };
            reg.count -= 1;
            if reg.count > 0 {
                return;
            }
            targets.files.remove(&key);
            targets.pending.remove(&key);
        }
        if let Some(dir) = self.watched_for.remove(&key) {
            self.release(&dir);
        }
    }

    /// No files registered — the owner can drop the whole notifier.
    pub fn is_empty(&self) -> bool {
        self.targets.lock().unwrap().files.is_empty()
    }
}

/// Which directory to actually watch: `parent` when it exists, otherwise its
/// nearest existing ancestor within [`MAX_MISSING_ANCESTORS`] levels, where the
/// registration stays *pending*. `None` beyond that, which keeps a nonsense
/// path from escalating into a watch on `/` or a home directory.
fn watch_point(parent: &Path) -> Option<PathBuf> {
    if parent.is_dir() {
        return Some(parent.to_path_buf());
    }
    let mut current = parent;
    for _ in 0..MAX_MISSING_ANCESTORS {
        current = current.parent()?;
        if current.is_dir() {
            return Some(current.to_path_buf());
        }
    }
    None
}

/// Block for a first message, drain the rest of the window into a deduplicated
/// batch, then flush once. Exits when the sender drops. [`DirNotifier`] sends
/// `()` and ignores the payload; [`MultiFileNotifier`] sends changed paths.
fn debounce_loop<T: PartialEq, F: Fn(Vec<T>)>(rx: &mpsc::Receiver<T>, on_change: F) {
    while let Ok(first) = rx.recv() {
        let mut batch = vec![first];
        let deadline = Instant::now() + DEBOUNCE;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(remaining) {
                Ok(message) => {
                    if !batch.contains(&message) {
                        batch.push(message);
                    }
                }
                Err(_) => break,
            }
        }
        on_change(std::mem::take(&mut batch));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn burst_of_events_fires_once() {
        let (tx, rx) = mpsc::channel::<()>();
        let fired = Arc::new(AtomicUsize::new(0));
        let fired2 = fired.clone();
        let handle = std::thread::spawn(move || {
            debounce_loop(&rx, move |_batch| {
                fired2.fetch_add(1, Ordering::SeqCst);
            })
        });

        for _ in 0..25 {
            tx.send(()).unwrap();
        }
        drop(tx); // burst then disconnect: one coalesced callback, then exit
        handle.join().unwrap();
        assert_eq!(fired.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn debounce_loop_dedupes_within_a_window() {
        let (tx, rx) = mpsc::channel::<PathBuf>();
        let batches: Arc<Mutex<Vec<Vec<PathBuf>>>> = Arc::default();
        let batches2 = batches.clone();
        let handle = std::thread::spawn(move || {
            debounce_loop(&rx, move |batch| batches2.lock().unwrap().push(batch))
        });

        for _ in 0..5 {
            tx.send(PathBuf::from("/a")).unwrap();
            tx.send(PathBuf::from("/b")).unwrap();
        }
        drop(tx); // burst then disconnect: one deduped batch, then exit
        handle.join().unwrap();
        let flushed = batches.lock().unwrap();
        assert_eq!(flushed.as_slice(), &[vec![PathBuf::from("/a"), PathBuf::from("/b")]]);
    }

    /// The reason this type exists: a repo dropped from the tracked set must
    /// stop being watched, not just stop being added to.
    #[test]
    fn set_targets_watches_only_tracked_checkouts_and_drops_untracked_ones() {
        let root = tempfile::TempDir::new().unwrap();
        let projects = root.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        // Two on disk; the third checkout has no session yet, which is not an error.
        std::fs::create_dir_all(projects.join("-home-u-repo-a")).unwrap();
        std::fs::create_dir_all(projects.join("-home-u-repo-b")).unwrap();

        let mut n = ScopedDirNotifier::new(|| {}).unwrap();
        n.set_targets(&projects, &["/home/u/repo-a".into(), "/home/u/no-session-yet".into()]);
        assert_eq!(n.watched(), &HashSet::from([projects.join("-home-u-repo-a")]));

        // Swap the tracked set entirely: repo-a drops out, repo-b comes in.
        n.set_targets(&projects, &["/home/u/repo-b".into()]);
        assert_eq!(n.watched(), &HashSet::from([projects.join("-home-u-repo-b")]));
    }

    /// The literal dot in `.claude/worktrees/...` is what the naive `/`→`-`
    /// guess used to miss, silently leaving this app's own worktree tasks
    /// unwatched (see `watchers::claude_code::encode_project_dir_name`).
    #[test]
    fn set_targets_resolves_a_worktree_checkout_through_the_dot_in_its_path() {
        let root = tempfile::TempDir::new().unwrap();
        let projects = root.path().join("projects");
        let encoded = "-home-u-repo--claude-worktrees-fix-thing";
        std::fs::create_dir_all(projects.join(encoded)).unwrap();

        let mut n = ScopedDirNotifier::new(|| {}).unwrap();
        n.set_targets(&projects, &["/home/u/repo/.claude/worktrees/fix-thing".into()]);
        assert_eq!(n.watched(), &HashSet::from([projects.join(encoded)]));
    }

    /// An identical list must not touch the watcher at all — what makes it
    /// cheap enough to call on every 2s poll tick.
    #[test]
    fn set_targets_is_a_no_op_when_the_target_list_is_unchanged() {
        let root = tempfile::TempDir::new().unwrap();
        let projects = root.path().join("projects");
        std::fs::create_dir_all(projects.join("-home-u-repo-a")).unwrap();

        let mut n = ScopedDirNotifier::new(|| {}).unwrap();
        let targets = vec!["/home/u/repo-a".to_string()];
        n.set_targets(&projects, &targets);
        let watched_after_first = n.watched().clone();
        n.set_targets(&projects, &targets);
        assert_eq!(n.watched(), &watched_after_first);
    }

    /// End-to-end, not just set bookkeeping: another session's write must
    /// never fire the callback where a global `DirNotifier` would.
    #[test]
    fn only_a_tracked_checkouts_journal_write_fires_the_callback() {
        let root = tempfile::TempDir::new().unwrap();
        let projects = root.path().join("projects");
        let tracked = projects.join("-home-u-repo-a");
        let untracked = projects.join("-home-u-someone-elses-session");
        std::fs::create_dir_all(&tracked).unwrap();
        std::fs::create_dir_all(&untracked).unwrap();

        let (tx, rx) = mpsc::channel::<()>();
        let mut n = ScopedDirNotifier::new(move || {
            let _ = tx.send(());
        })
        .unwrap();
        n.set_targets(&projects, &["/home/u/repo-a".into()]);
        // macOS starts an FSEvents stream from an event id, not a hard "from
        // now", so the tracked directory's own creation a moment ago can still
        // arrive. Settle first — what this test is about is the *sibling*
        // write below, which stays refuted either way.
        while rx.recv_timeout(DEBOUNCE * 2).is_ok() {}

        std::fs::write(untracked.join("sid.jsonl"), "noise").unwrap();
        assert!(
            rx.recv_timeout(DEBOUNCE * 3).is_err(),
            "an untracked session's transcript write must not fire the accelerant"
        );

        std::fs::write(tracked.join("sid.jsonl"), "a message").unwrap();
        assert!(
            rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "a tracked checkout's own transcript write must still fire it"
        );
    }

    /// Real-filesystem check of what the viewer/diff pane depend on: sibling
    /// churn stays silent, a tmp+rename replace fires with the right path,
    /// subdirectories share the one instance, a removed registration goes quiet.
    #[test]
    fn multi_file_notifier_filters_and_routes_by_path() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("a")).unwrap();
        std::fs::create_dir(root.path().join("b")).unwrap();
        let one = root.path().join("a/one.txt");
        let two = root.path().join("b/two.txt");
        std::fs::write(&one, "v1").unwrap();
        std::fs::write(&two, "v1").unwrap();

        let (fired_tx, fired_rx) = mpsc::channel::<Vec<PathBuf>>();
        let mut notifier = MultiFileNotifier::new(move |batch| {
            let _ = fired_tx.send(batch);
        })
        .unwrap();
        notifier.add(&one).unwrap();
        notifier.add(&two).unwrap();
        // Same settle as the scoped-watch test: macOS can still deliver these
        // files' own creation after the watch is installed.
        while fired_rx.recv_timeout(DEBOUNCE * 2).is_ok() {}

        std::fs::write(root.path().join("a/noise.txt"), "noise").unwrap();
        assert!(
            fired_rx.recv_timeout(DEBOUNCE * 3).is_err(),
            "unregistered sibling write must not fire"
        );

        let tmp = root.path().join("a/.one.txt.tmp");
        std::fs::write(&tmp, "v2").unwrap();
        std::fs::rename(&tmp, &one).unwrap();
        let batch = fired_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(batch, vec![one.clone()], "tmp+rename replace fires with the replaced path");

        std::fs::write(&two, "v2").unwrap();
        let batch = fired_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(batch, vec![two.clone()], "second registered file routes independently");

        notifier.remove(&one);
        std::fs::write(&one, "v3").unwrap();
        assert!(
            fired_rx.recv_timeout(DEBOUNCE * 3).is_err(),
            "a removed registration must go silent"
        );
        assert!(!notifier.is_empty(), "the other file is still registered");
    }

    /// The git-info accelerant's failure mode: a slashed branch name in a
    /// packed repo has no `refs/heads/<prefix>` directory, so registering its
    /// ref used to fail and that ref quietly left the watch set.
    #[test]
    fn multi_file_notifier_registers_a_file_whose_parent_does_not_exist_yet() {
        let root = tempfile::tempdir().unwrap();
        let heads = root.path().join("refs/heads");
        std::fs::create_dir_all(&heads).unwrap();
        // `refs/heads/feat` is absent, exactly as `pack-refs --prune` leaves it.
        let branch_ref = heads.join("feat/x");

        let (fired_tx, fired_rx) = mpsc::channel::<Vec<PathBuf>>();
        let mut notifier = MultiFileNotifier::new(move |batch| {
            let _ = fired_tx.send(batch);
        })
        .unwrap();
        notifier.add(&branch_ref).expect("a missing parent must not fail the registration");

        std::fs::create_dir_all(branch_ref.parent().unwrap()).unwrap();
        std::fs::write(&branch_ref, "cafebabe\n").unwrap();
        let batch = fired_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(batch.contains(&branch_ref), "the ref going loose must fire: {batch:?}");

        // And the wider watch it took to see that must still be released.
        notifier.remove(&branch_ref);
        assert!(notifier.is_empty());
    }

    /// The second half: once the directory exists, the registration must stop
    /// depending on the one-shot ancestor hit, so the *next* write fires too.
    #[test]
    fn multi_file_notifier_promotes_a_pending_file_once_its_parent_appears() {
        let root = tempfile::tempdir().unwrap();
        let heads = root.path().join("refs/heads");
        std::fs::create_dir_all(&heads).unwrap();
        let branch_ref = heads.join("feat/x");

        let (fired_tx, fired_rx) = mpsc::channel::<Vec<PathBuf>>();
        let mut notifier = MultiFileNotifier::new(move |batch| {
            let _ = fired_tx.send(batch);
        })
        .unwrap();
        notifier.add(&branch_ref).unwrap();

        std::fs::create_dir_all(branch_ref.parent().unwrap()).unwrap();
        std::fs::write(&branch_ref, "one\n").unwrap();
        fired_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        notifier.rewatch_pending();
        assert!(
            notifier.targets.lock().unwrap().pending.is_empty(),
            "an existing parent means nothing is pending any more"
        );

        // No directory created this time, so only an exact-path watch sees it.
        std::fs::write(&branch_ref, "two\n").unwrap();
        let batch = fired_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(batch, vec![branch_ref]);
    }

    /// The bound on that walk: a path with no plausible ancestor must fail the
    /// registration rather than fall back onto some far-away directory.
    #[test]
    fn watch_point_gives_up_rather_than_watching_a_far_away_ancestor() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(watch_point(root.path()), Some(root.path().to_path_buf()));
        assert_eq!(
            watch_point(&root.path().join("a")),
            Some(root.path().to_path_buf()),
            "one missing level falls back to the existing parent"
        );
        assert_eq!(
            watch_point(&root.path().join("a/b/c/d/e/f")),
            None,
            "beyond the bound, no watch at all"
        );
    }

    /// What macOS made visible: it hands back a watched path with every symlink
    /// resolved, so a registration keyed on the caller's spelling would never
    /// match its own events.
    #[test]
    fn a_registration_through_a_symlink_still_matches_its_events() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        let link = root.path().join("link");
        std::fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        // Resolution reaches through a missing tail, which is how a pending
        // registration (its parent not created yet) is keyed at all.
        assert_eq!(resolved(&link.join("later/file.txt")), resolved(&real).join("later/file.txt"));

        let via_link = link.join("watched.txt");
        std::fs::write(&via_link, "v1").unwrap();

        let (fired_tx, fired_rx) = mpsc::channel::<Vec<PathBuf>>();
        let mut notifier = MultiFileNotifier::new(move |batch| {
            let _ = fired_tx.send(batch);
        })
        .unwrap();
        notifier.add(&via_link).unwrap();

        std::fs::write(real.join("watched.txt"), "v2").unwrap();
        let batch = fired_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(batch, vec![via_link.clone()], "reported as registered, not as resolved");

        notifier.remove(&via_link);
        std::fs::write(real.join("watched.txt"), "v3").unwrap();
        assert!(
            fired_rx.recv_timeout(DEBOUNCE * 3).is_err(),
            "removal has to find the same registration the spelling created"
        );
    }

    /// The filter runs before the debounce so an ignored subtree's churn can't
    /// even pad the batch; a kept write still reports its own path.
    #[test]
    fn dir_paths_notifier_reports_kept_paths_and_drops_filtered_ones() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("src")).unwrap();
        std::fs::create_dir(root.path().join("target")).unwrap();

        let (fired_tx, fired_rx) = mpsc::channel::<Vec<PathBuf>>();
        let _notifier = DirPathsNotifier::watch(
            root.path(),
            |p| !p.components().any(|c| c.as_os_str() == "target"),
            move |batch| {
                let _ = fired_tx.send(batch);
            },
        )
        .unwrap();
        while fired_rx.recv_timeout(DEBOUNCE * 2).is_ok() {}

        std::fs::write(root.path().join("target/noise.txt"), "noise").unwrap();
        assert!(
            fired_rx.recv_timeout(DEBOUNCE * 3).is_err(),
            "a filtered subtree's write must not fire"
        );

        let kept = root.path().join("src/kept.txt");
        std::fs::write(&kept, "v1").unwrap();
        let batch = fired_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            batch.iter().any(|p| p.ends_with("src/kept.txt")),
            "a kept write must report its path: {batch:?}"
        );
    }

    #[test]
    fn multi_file_notifier_refcounts_registrations() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("shared.txt");
        std::fs::write(&file, "v1").unwrap();

        let (fired_tx, fired_rx) = mpsc::channel::<Vec<PathBuf>>();
        let mut notifier = MultiFileNotifier::new(move |batch| {
            let _ = fired_tx.send(batch);
        })
        .unwrap();
        notifier.add(&file).unwrap();
        notifier.add(&file).unwrap();
        notifier.remove(&file);

        std::fs::write(&file, "v2").unwrap();
        assert!(
            fired_rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "one of two registrations dropped — the file must still fire"
        );
        assert!(!notifier.is_empty());
        notifier.remove(&file);
        assert!(notifier.is_empty(), "matched removes drain the registration");
    }
}
