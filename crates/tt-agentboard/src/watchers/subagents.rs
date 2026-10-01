//! Sub-agent token accounting for the claude-code watcher.
//!
//! A sub-agent runs its own requests against its own thread, so none of its
//! spend appears in the parent transcript's `usage` — the pane's context
//! readout is blind to it. Each one keeps a `<session>/subagents/agent-<id>.jsonl`
//! transcript of the same shape as the parent's, so the same tail extraction
//! answers "what is this thread carrying". Which of them are running is the
//! parent journal's answer ([`super::ledger`]), never these files' mtimes.
//!
//! Transcripts are re-read only when `(mtime, len)` moves, so a steady state of
//! finished sub-agents costs one `stat` each per scan rather than a tail read.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use tt_claude_code::parse_transcript;

use super::claude_code::{TAIL_WINDOW, read_window};
use super::claude_usage::extract_usage_summary;
use crate::watchers::claude_code::JSONL_SUFFIX;

/// What one scan of a session's `subagents/` dir found.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SubagentRollup {
    /// Every sub-agent transcript, finished ones included.
    pub threads: Vec<SubagentThread>,
    /// Context across every thread: a total that shed finished sub-agents
    /// would fall as work completed.
    pub total_context: i64,
}

impl SubagentRollup {
    /// The transcript of the agent the ledger knows by either id.
    pub fn thread(
        &self,
        agent_id: Option<&str>,
        tool_use_id: Option<&str>,
    ) -> Option<&SubagentThread> {
        self.threads.iter().find(|t| {
            agent_id.is_some_and(|id| t.agent_id == id)
                || tool_use_id.is_some_and(|id| t.meta.tool_use_id.as_deref() == Some(id))
        })
    }
}

/// One `agent-<agent_id>.jsonl` and its sibling `.meta.json`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SubagentThread {
    pub agent_id: String,
    pub meta: SubagentMeta,
    pub context: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMeta {
    #[serde(default)]
    pub agent_type: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// The parent's `Agent` tool call — the join for a foreground agent, whose
    /// agent id the parent journal only states once it has finished.
    #[serde(default)]
    pub tool_use_id: Option<String>,
}

/// One transcript's last-known context, keyed by the file identity it was read
/// from.
#[derive(Debug, Clone, PartialEq)]
struct Cached {
    mtime: i64,
    len: u64,
    context: i64,
    /// Read once: the sibling `.meta.json` never changes.
    meta: SubagentMeta,
}

/// Per-session memo of every sub-agent transcript's context. Lives on the
/// watcher's session state, so it dies with the session.
#[derive(Debug, Clone, Default)]
pub struct SubagentUsage {
    seen: HashMap<PathBuf, Cached>,
}

impl SubagentUsage {
    pub fn scan(&mut self, dir: &Path) -> SubagentRollup {
        let Ok(entries) = std::fs::read_dir(dir) else {
            self.seen.clear();
            return SubagentRollup::default();
        };
        let mut rollup = SubagentRollup::default();
        let mut present: HashSet<PathBuf> = HashSet::new();

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(agent_id) =
                name.strip_prefix("agent-").and_then(|n| n.strip_suffix(JSONL_SUFFIX))
            else {
                continue;
            };
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            let Some(mtime) = mtime_ms(&meta) else {
                continue;
            };
            let cached = self.cached(&path, mtime, meta.len());
            rollup.total_context += cached.context;
            rollup.threads.push(SubagentThread {
                agent_id: agent_id.to_string(),
                meta: cached.meta.clone(),
                context: cached.context,
            });
            present.insert(path);
        }

        self.seen.retain(|path, _| present.contains(path));
        rollup
    }

    /// Cached context for `path`, re-reading the tail only when the file moved.
    fn cached(&mut self, path: &Path, mtime: i64, len: u64) -> &Cached {
        let stale = self.seen.get(path).is_none_or(|hit| hit.mtime != mtime || hit.len != len);
        if stale {
            let context = tail_context(path, len);
            let meta = match self.seen.remove(path) {
                Some(c) => c.meta,
                None => read_meta(path),
            };
            self.seen.insert(path.to_path_buf(), Cached { mtime, len, context, meta });
        }
        &self.seen[path]
    }
}

/// Context the thread in `path` is carrying, from its newest assistant entry.
fn tail_context(path: &Path, len: u64) -> i64 {
    let text = read_window(path, len.saturating_sub(TAIL_WINDOW), TAIL_WINDOW);
    extract_usage_summary(&parse_transcript(&text)).map(|u| u.context_used).unwrap_or(0)
}

/// Sibling `agent-<id>.meta.json`; missing or unreadable meta still counts (as `{}`).
fn read_meta(jsonl_path: &Path) -> SubagentMeta {
    let Some(base) = jsonl_path.to_str().and_then(|p| p.strip_suffix(JSONL_SUFFIX)) else {
        return SubagentMeta::default();
    };
    std::fs::read_to_string(format!("{base}.meta.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
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
                serde_json::json!({ "agentType": t, "description": "d", "toolUseId": format!("toolu_{id}") })
                    .to_string(),
            )
            .unwrap();
        }
        path
    }

    #[test]
    fn missing_dir_is_empty_not_an_error() {
        let tmp = TempDir::new().unwrap();
        let mut usage = SubagentUsage::default();
        assert_eq!(usage.scan(&tmp.path().join("nope")), SubagentRollup::default());
    }

    #[test]
    fn every_thread_carries_its_own_context_finished_or_not() {
        let tmp = TempDir::new().unwrap();
        write_subagent(tmp.path(), "a", &transcript(10, 90_000), Some("Explore"));
        write_subagent(tmp.path(), "b", &transcript(5, 40_000), None);
        let r = SubagentUsage::default().scan(tmp.path());
        assert_eq!(r.threads.len(), 2);
        assert_eq!(r.total_context, 90_010 + 40_005);
        let explore = r.thread(Some("a"), None).unwrap();
        assert_eq!(explore.meta.agent_type.as_deref(), Some("Explore"));
        assert_eq!(explore.context, 90_010);
    }

    #[test]
    fn a_thread_is_found_by_the_tool_call_that_spawned_it() {
        let tmp = TempDir::new().unwrap();
        write_subagent(tmp.path(), "a", &transcript(10, 90_000), Some("Explore"));
        let r = SubagentUsage::default().scan(tmp.path());
        assert_eq!(r.thread(None, Some("toolu_a")).map(|t| t.agent_id.as_str()), Some("a"));
        assert_eq!(r.thread(Some("zz"), Some("toolu_zz")), None);
    }

    #[test]
    fn unchanged_transcripts_are_not_re_read() {
        let tmp = TempDir::new().unwrap();
        let path = write_subagent(tmp.path(), "a", &transcript(10, 90_000), None);
        let mut usage = SubagentUsage::default();
        assert_eq!(usage.scan(tmp.path()).total_context, 90_010);

        // Truncating without touching (mtime, len) would change a fresh read's
        // answer; the cached one must stand.
        let meta = fs::metadata(&path).unwrap();
        let stamp = filetime::FileTime::from_last_modification_time(&meta);
        let len = meta.len();
        fs::write(&path, "x".repeat(len as usize)).unwrap();
        filetime::set_file_mtime(&path, stamp).unwrap();
        assert_eq!(usage.scan(tmp.path()).total_context, 90_010);
    }

    #[test]
    fn a_grown_transcript_is_re_read() {
        let tmp = TempDir::new().unwrap();
        let path = write_subagent(tmp.path(), "a", &transcript(10, 90_000), None);
        let mut usage = SubagentUsage::default();
        assert_eq!(usage.scan(tmp.path()).total_context, 90_010);

        fs::write(&path, transcript(10, 200_000)).unwrap();
        assert_eq!(usage.scan(tmp.path()).total_context, 200_010);
    }

    #[test]
    fn non_subagent_files_are_ignored() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("notes.txt"), "x").unwrap();
        fs::write(tmp.path().join("agent-a.meta.json"), "{}").unwrap();
        assert!(SubagentUsage::default().scan(tmp.path()).threads.is_empty());
    }
}
