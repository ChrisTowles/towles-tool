//! What the repository says: which files exist to judge, and what each held
//! at the base. Read in-process with `gix`, so the binary needs no `git`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use gix::bstr::ByteSlice;

use crate::measure::Lang;

const SKIP_ATTRS: [&str; 2] = ["linguist-generated", "linguist-vendored"];

pub struct Repo {
    repo: gix::Repository,
}

/// The base tree, flattened once: path to blob, plus every blob id, so a file
/// that only moved is recognised as unchanged.
pub struct Base {
    by_path: HashMap<String, gix::ObjectId>,
    blobs: HashSet<gix::ObjectId>,
}

impl Repo {
    pub fn discover(dir: &Path) -> Result<Self, String> {
        let repo = gix::discover(dir).map_err(|e| format!("not in a git repository: {e}"))?;
        if repo.workdir().is_none() {
            return Err("a bare repository has no files to judge".into());
        }
        Ok(Repo { repo })
    }

    pub fn workdir(&self) -> PathBuf {
        self.repo.workdir().expect("checked in discover").to_path_buf()
    }

    /// Tracked and untracked files in a language this reads, minus what
    /// `.gitignore` excludes and `.gitattributes` marks generated or vendored.
    /// Nested repositories, such as worktrees inside the checkout, are skipped.
    pub fn candidates(&self) -> Result<Vec<String>, String> {
        let err = |e: &dyn std::fmt::Display| format!("walk the work tree: {e}");
        let index = self.repo.index_or_empty().map_err(|e| err(&e))?;
        let options = self
            .repo
            .dirwalk_options()
            .map_err(|e| err(&e))?
            .emit_tracked(true)
            .emit_untracked(gix::dir::walk::EmissionMode::Matching)
            .emit_ignored(None)
            .recurse_repositories(false);
        let mut collect = gix::dir::walk::delegate::Collect::default();
        let interrupt = std::sync::atomic::AtomicBool::new(false);
        self.repo
            .dirwalk(&index, None::<&str>, &interrupt, options, &mut collect)
            .map_err(|e| err(&e))?;

        let mut attrs = self
            .repo
            .attributes_only(
                &index,
                gix::worktree::stack::state::attributes::Source::WorktreeThenIdMapping,
            )
            .map_err(|e| err(&e))?;
        let mut outcome = attrs.selected_attribute_matches(SKIP_ATTRS);
        let mut out = Vec::new();
        for (entry, _) in collect.unorded_entries {
            let tracked_or_new = matches!(
                entry.status,
                gix::dir::entry::Status::Tracked | gix::dir::entry::Status::Untracked
            );
            if !tracked_or_new || entry.disk_kind != Some(gix::dir::entry::Kind::File) {
                continue;
            }
            let Ok(rel) = entry.rela_path.to_str() else {
                continue;
            };
            if Lang::for_path(rel).is_none() {
                continue;
            }
            let platform =
                attrs.at_entry(rel, Some(gix::index::entry::Mode::FILE)).map_err(|e| err(&e))?;
            platform.matching_attributes(&mut outcome);
            let skipped = outcome.iter_selected().any(|m| attr_is_true(m.assignment.state));
            if !skipped {
                out.push(rel.to_string());
            }
        }
        out.sort();
        Ok(out)
    }

    /// The merge-base of `rev` and `HEAD`. A CI checkout is detached with no
    /// local branches, so `origin/<rev>` is tried too.
    pub fn base(&self, rev: &str) -> Result<Base, String> {
        let resolve = |spec: &str| {
            self.repo
                .rev_parse_single(spec)
                .or_else(|_| self.repo.rev_parse_single(format!("origin/{spec}").as_str()))
                .map(|id| id.detach())
                .map_err(|_| format!("no such revision `{spec}` (nor `origin/{spec}`)"))
        };
        let head = resolve("HEAD")?;
        let id = self
            .repo
            .merge_base(resolve(rev)?, head)
            .map_err(|e| format!("no merge-base with `{rev}`: {e}"))?;
        let read = |e: &dyn std::fmt::Display| format!("read the base tree: {e}");
        let tree = self.repo.find_commit(id).map_err(|e| read(&e))?.tree().map_err(|e| read(&e))?;
        let mut recorder = gix::traverse::tree::Recorder::default();
        tree.traverse().breadthfirst(&mut recorder).map_err(|e| format!("walk the base: {e}"))?;
        let mut base = Base { by_path: HashMap::new(), blobs: HashSet::new() };
        for entry in recorder.records.into_iter().filter(|e| e.mode.is_blob()) {
            base.blobs.insert(entry.oid);
            base.by_path.insert(entry.filepath.to_string(), entry.oid);
        }
        Ok(base)
    }

    pub fn blob(&self, id: gix::ObjectId) -> Option<String> {
        let blob = self.repo.find_blob(id).ok()?;
        String::from_utf8(blob.data.clone()).ok()
    }

    pub fn hash(&self, content: &[u8]) -> Option<gix::ObjectId> {
        gix::objs::compute_hash(self.repo.object_hash(), gix::objs::Kind::Blob, content).ok()
    }
}

impl Base {
    pub fn path(&self, rel: &str) -> Option<gix::ObjectId> {
        self.by_path.get(rel).copied()
    }

    pub fn has(&self, id: &gix::ObjectId) -> bool {
        self.blobs.contains(id)
    }
}

fn attr_is_true(state: gix::attrs::StateRef<'_>) -> bool {
    match state {
        gix::attrs::StateRef::Set => true,
        gix::attrs::StateRef::Value(v) => v.as_bstr() == "true",
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tree(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("comment-budget-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        gix::init(&dir).expect("init");
        for (rel, body) in files {
            let path = dir.join(rel);
            fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
            fs::write(path, body).expect("write");
        }
        dir
    }

    #[test]
    fn ignored_generated_vendored_and_foreign_files_are_skipped() {
        let dir = tree(
            "skips",
            &[
                (".gitignore", "build/\n"),
                (".gitattributes", "gen/** linguist-generated\nui/** linguist-vendored=true\n"),
                ("src/a.rs", "fn a() {}\n"),
                ("src/b.ts", "let b = 1;\n"),
                ("build/out.js", "x\n"),
                ("gen/types.ts", "x\n"),
                ("ui/button.tsx", "x\n"),
                ("README.md", "# hi\n"),
            ],
        );
        let files = Repo::discover(&dir).expect("repo").candidates().expect("walk");
        assert_eq!(files, vec!["src/a.rs", "src/b.ts"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_attribute_can_be_unset_again() {
        let dir = tree(
            "unset",
            &[
                (".gitattributes", "gen/** linguist-generated\ngen/keep.rs -linguist-generated\n"),
                ("gen/drop.rs", "x\n"),
                ("gen/keep.rs", "x\n"),
            ],
        );
        let files = Repo::discover(&dir).expect("repo").candidates().expect("walk");
        assert_eq!(files, vec!["gen/keep.rs"]);
        let _ = fs::remove_dir_all(&dir);
    }
}
