//! Sub-agent discovery and token accounting for the claude-code watcher.
//!
//! A sub-agent runs its own requests against its own thread, so none of its
//! spend appears in the parent transcript's `usage` — the pane's context
//! readout is blind to it. Each one keeps a `<session>/subagents/agent-<id>.jsonl`
//! transcript of the same shape as the parent's, so the same tail extraction
//! answers "what is this thread carrying".
//!
//! Two different questions, deliberately: `active` is what is running *now*
//! (the 2-minute window, listed individually), while `total_context` covers
//! every sub-agent thread the session ever spawned. A total that shed finished
//! sub-agents would fall as work completed, which is the opposite of what a
//! spend readout is for.
//!
//! Transcripts are re-read only when `(mtime, len)` moves, so a steady state of
//! finished sub-agents costs one `stat` each per scan rather than a tail read.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use tt_claude_code::parse_transcript;

use super::claude_code::{TAIL_WINDOW, read_window};
use super::claude_usage::extract_usage_summary;
use crate::types::SubagentInfo;
use crate::watcher::JSONL_SUFFIX;

/// What one scan of a session's `subagents/` dir found.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SubagentRollup {
    /// Recently-touched sub-agents, most-recent first.
    pub active: Vec<SubagentInfo>,
    /// Context across every sub-agent transcript, finished ones included.
    pub total_context: i64,
    /// How many threads `total_context` covers.
    pub count: i64,
}

#[derive(Deserialize)]
struct SubagentMeta {
    #[serde(rename = "agentType", default)]
    agent_type: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

/// One transcript's last-known context, keyed by the file identity it was read
/// from.
#[derive(Debug, Clone, PartialEq)]
struct Cached {
    mtime: i64,
    len: u64,
    context: i64,
    /// Read once: the sibling `.meta.json` never changes.
    info: Option<SubagentInfo>,
}

/// Per-session memo of every sub-agent transcript's context. Lives on the
/// watcher's session state, so it dies with the session.
#[derive(Debug, Clone, Default)]
pub struct SubagentUsage {
    seen: HashMap<PathBuf, Cached>,
}

impl SubagentUsage {
    /// Scan `dir` for sub-agent transcripts. `idle_timeout_ms` bounds which
    /// count as active.
    pub fn scan(&mut self, dir: &Path, now_ms: i64, idle_timeout_ms: i64) -> SubagentRollup {
        let Ok(entries) = std::fs::read_dir(dir) else {
            self.seen.clear();
            return SubagentRollup::default();
        };
        let mut rollup = SubagentRollup::default();
        let mut active: Vec<(SubagentInfo, i64)> = Vec::new();
        let mut present: HashSet<PathBuf> = HashSet::new();

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("agent-") || !name.ends_with(JSONL_SUFFIX) {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            let Some(mtime) = mtime_ms(&meta) else {
                continue;
            };
            let context = self.context_of(&path, mtime, meta.len());
            rollup.total_context += context;
            rollup.count += 1;

            if now_ms - mtime <= idle_timeout_ms {
                let cached = self.seen.get_mut(&path).expect("context_of cached it");
                let mut info = cached.info.get_or_insert_with(|| read_meta(&path)).clone();
                info.context_used = (context > 0).then_some(context);
                active.push((info, mtime));
            }
            present.insert(path);
        }

        self.seen.retain(|path, _| present.contains(path));
        active.sort_by_key(|(_, m)| std::cmp::Reverse(*m));
        rollup.active = active.into_iter().map(|(info, _)| info).collect();
        rollup
    }

    /// Cached context for `path`, re-reading the tail only when the file moved.
    fn context_of(&mut self, path: &Path, mtime: i64, len: u64) -> i64 {
        if let Some(hit) = self.seen.get(path)
            && hit.mtime == mtime
            && hit.len == len
        {
            return hit.context;
        }
        let context = tail_context(path, len);
        let info = self.seen.remove(path).and_then(|c| c.info);
        self.seen.insert(path.to_path_buf(), Cached { mtime, len, context, info });
        context
    }
}

/// Context the thread in `path` is carrying, from its newest assistant entry.
fn tail_context(path: &Path, len: u64) -> i64 {
    let text = read_window(path, len.saturating_sub(TAIL_WINDOW), TAIL_WINDOW);
    extract_usage_summary(&parse_transcript(&text)).map(|u| u.context_used).unwrap_or(0)
}

/// Sibling `agent-<id>.meta.json`; missing or unreadable meta still counts (as `{}`).
fn read_meta(jsonl_path: &Path) -> SubagentInfo {
    let Some(path) = meta_path(jsonl_path) else {
        return SubagentInfo::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<SubagentMeta>(&t).ok())
        .map(|m| SubagentInfo {
            agent_type: m.agent_type,
            description: m.description,
            context_used: None,
        })
        .unwrap_or_default()
}

fn meta_path(jsonl_path: &Path) -> Option<PathBuf> {
    let base = jsonl_path.to_str()?.strip_suffix(JSONL_SUFFIX)?;
    Some(PathBuf::from(format!("{base}.meta.json")))
}

fn mtime_ms(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    const IDLE_MS: i64 = 120_000;

    /// A transcript whose last assistant entry states `input`/`cache_read`.
    fn transcript(input: i64, cache_read: i64) -> String {
        format!(
            "{}\n{}\n",
            serde_json::json!({
                "type": "assistant", "timestamp": "2026-04-12T00:00:00Z",
                "message": { "role": "assistant", "model": "claude-opus-4-8",
                             "usage": { "input_tokens": 1, "output_tokens": 1 } }
            }),
            serde_json::json!({
                "type": "assistant", "timestamp": "2026-04-12T00:01:00Z",
                "message": { "role": "assistant", "model": "claude-opus-4-8",
                             "usage": { "input_tokens": input, "cache_read_input_tokens": cache_read } }
            })
        )
    }

    fn write_subagent(dir: &Path, id: &str, body: &str, agent_type: Option<&str>) -> PathBuf {
        let path = dir.join(format!("agent-{id}.jsonl"));
        fs::write(&path, body).unwrap();
        if let Some(t) = agent_type {
            fs::write(
                dir.join(format!("agent-{id}.meta.json")),
                serde_json::json!({ "agentType": t, "description": "d" }).to_string(),
            )
            .unwrap();
        }
        path
    }

    /// `now` far enough ahead that nothing written "now" counts as active.
    fn stale_now(dir: &Path) -> i64 {
        let newest = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter_map(|e| mtime_ms(&e.metadata().ok()?))
            .max()
            .unwrap_or(0);
        newest + IDLE_MS + 1
    }

    #[test]
    fn missing_dir_is_empty_not_an_error() {
        let tmp = TempDir::new().unwrap();
        let mut usage = SubagentUsage::default();
        assert_eq!(usage.scan(&tmp.path().join("nope"), 0, IDLE_MS), SubagentRollup::default());
    }

    #[test]
    fn active_subagents_carry_their_own_context() {
        let tmp = TempDir::new().unwrap();
        write_subagent(tmp.path(), "a", &transcript(10, 90_000), Some("Explore"));
        write_subagent(tmp.path(), "b", &transcript(5, 40_000), None);
        let mut usage = SubagentUsage::default();
        let now = mtime_ms(&fs::metadata(tmp.path().join("agent-a.jsonl")).unwrap()).unwrap();

        let r = usage.scan(tmp.path(), now, IDLE_MS);
        assert_eq!(r.count, 2);
        assert_eq!(r.total_context, 90_010 + 40_005);
        assert_eq!(r.active.len(), 2);
        let explore = r.active.iter().find(|s| s.agent_type.as_deref() == Some("Explore")).unwrap();
        assert_eq!(explore.context_used, Some(90_010));
    }

    #[test]
    fn finished_subagents_leave_the_active_list_but_stay_in_the_total() {
        let tmp = TempDir::new().unwrap();
        write_subagent(tmp.path(), "a", &transcript(10, 90_000), None);
        let mut usage = SubagentUsage::default();

        let r = usage.scan(tmp.path(), stale_now(tmp.path()), IDLE_MS);
        assert!(r.active.is_empty());
        assert_eq!(r.count, 1);
        assert_eq!(r.total_context, 90_010);
    }

    #[test]
    fn unchanged_transcripts_are_not_re_read() {
        let tmp = TempDir::new().unwrap();
        let path = write_subagent(tmp.path(), "a", &transcript(10, 90_000), None);
        let mut usage = SubagentUsage::default();
        let now = stale_now(tmp.path());
        assert_eq!(usage.scan(tmp.path(), now, IDLE_MS).total_context, 90_010);

        // Truncating without touching (mtime, len) would change a fresh read's
        // answer; the cached one must stand.
        let meta = fs::metadata(&path).unwrap();
        let stamp = filetime::FileTime::from_last_modification_time(&meta);
        let len = meta.len();
        fs::write(&path, "x".repeat(len as usize)).unwrap();
        filetime::set_file_mtime(&path, stamp).unwrap();
        assert_eq!(usage.scan(tmp.path(), now, IDLE_MS).total_context, 90_010);
    }

    #[test]
    fn a_grown_transcript_is_re_read() {
        let tmp = TempDir::new().unwrap();
        let path = write_subagent(tmp.path(), "a", &transcript(10, 90_000), None);
        let mut usage = SubagentUsage::default();
        assert_eq!(usage.scan(tmp.path(), stale_now(tmp.path()), IDLE_MS).total_context, 90_010);

        fs::write(&path, transcript(10, 200_000)).unwrap();
        assert_eq!(usage.scan(tmp.path(), stale_now(tmp.path()), IDLE_MS).total_context, 200_010);
    }

    #[test]
    fn non_subagent_files_are_ignored() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("notes.txt"), "x").unwrap();
        fs::write(tmp.path().join("agent-a.meta.json"), "{}").unwrap();
        let mut usage = SubagentUsage::default();
        assert_eq!(usage.scan(tmp.path(), 0, IDLE_MS).count, 0);
    }
}
