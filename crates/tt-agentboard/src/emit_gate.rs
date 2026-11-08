//! Decides when a rebuilt [`StatePayload`] is worth waking the webview for.
//!
//! Every emit costs a deserialize and a React render, so a payload that differs
//! only by clock stamps stays home. `GitInfo::computed_at_ms` restamps on every
//! git recompute even when the result is identical and only feeds the "checked
//! N s ago" label, so a change confined to it re-emits at most once per
//! [`STAMP_REFRESH_MS`]. Anything else, status and liveness included, emits at
//! once. Time is passed in, never read.
//!
//! The payload is reduced to a [`Digest`] where it was built, so the gate keeps
//! a hash and a stamp list rather than a deep copy of the last payload.

use std::hash::Hasher;

use crate::bridge::StatePayload;

/// How stale a "checked N s ago" label may get before a stamp-only change is sent.
pub const STAMP_REFRESH_MS: i64 = 30_000;

/// What the gate remembers of a payload: a hash of everything but the clock
/// stamps, plus the stamps themselves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Digest {
    /// `None` when the payload would not serialize; such a digest never matches.
    visible: Option<u64>,
    /// Every folder's `computed_at_ms`, in payload order.
    stamps: Vec<i64>,
}

impl Digest {
    /// Hash `payload` without `ts` and the git stamps. Those are zeroed for the
    /// hash and put back, so the payload leaves exactly as it came in.
    pub fn of(payload: &mut StatePayload) -> Self {
        let ts = std::mem::take(&mut payload.ts);
        let stamps: Vec<i64> = payload
            .repos
            .iter_mut()
            .flat_map(|r| r.folders.iter_mut())
            .map(|f| std::mem::take(&mut f.computed_at_ms))
            .collect();

        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        let hashed = serde_json::to_writer(HashWriter(&mut hasher), &*payload).is_ok();
        let visible = hashed.then(|| hasher.finish());

        payload.ts = ts;
        let mut restore = stamps.iter();
        for folder in payload.repos.iter_mut().flat_map(|r| r.folders.iter_mut()) {
            folder.computed_at_ms = restore.next().copied().unwrap_or_default();
        }
        Self { visible, stamps }
    }
}

/// Feeds serialized bytes straight into a hasher, so no JSON string is built.
struct HashWriter<'a>(&'a mut std::collections::hash_map::DefaultHasher);

impl std::io::Write for HashWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.write(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct EmitGate {
    /// The last emitted payload's digest.
    last: Option<Digest>,
    emitted_ms: i64,
}

impl EmitGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// True when the payload behind `digest` should be emitted; the gate then
    /// treats it as sent.
    pub fn should_emit(&mut self, digest: Digest, now_ms: i64) -> bool {
        let (visible, stale) = match &self.last {
            None => (true, false),
            Some(last) => (
                last.visible.is_none() || last.visible != digest.visible,
                last.stamps != digest.stamps && now_ms - self.emitted_ms >= STAMP_REFRESH_MS,
            ),
        };
        if !visible && !stale {
            return false;
        }
        self.last = Some(digest);
        self.emitted_ms = now_ms;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{FolderData, RepoData};

    fn payload(stamp: i64, needs: i64) -> StatePayload {
        let folder = FolderData { computed_at_ms: stamp, needs, ..Default::default() };
        let repo = RepoData {
            key: String::new(),
            dir: String::new(),
            name: String::new(),
            origin_url: None,
            folders: vec![folder],
            needs: 0,
            meta: None,
            color: Default::default(),
            archived: false,
        };
        StatePayload {
            repos: vec![repo],
            compact_recommend_percent: 0,
            windows: Default::default(),
            collapsed: Default::default(),
            agent_scan_ok: true,
            ts: stamp,
        }
    }

    #[test]
    fn first_payload_emits() {
        assert!(EmitGate::new().should_emit(Digest::of(&mut payload(1, 0)), 1));
    }

    #[test]
    fn stamp_only_change_inside_window_stays_home() {
        let mut gate = EmitGate::new();
        assert!(gate.should_emit(Digest::of(&mut payload(1_000, 0)), 1_000));
        assert!(!gate.should_emit(Digest::of(&mut payload(5_000, 0)), 5_000));
        assert!(!gate.should_emit(Digest::of(&mut payload(9_000, 0)), 29_999));
    }

    #[test]
    fn visible_change_emits_immediately() {
        let mut gate = EmitGate::new();
        assert!(gate.should_emit(Digest::of(&mut payload(1_000, 0)), 1_000));
        assert!(gate.should_emit(Digest::of(&mut payload(1_000, 1)), 1_001));
    }

    #[test]
    fn stamp_only_change_emits_once_window_passes() {
        let mut gate = EmitGate::new();
        assert!(gate.should_emit(Digest::of(&mut payload(1_000, 0)), 1_000));
        assert!(!gate.should_emit(Digest::of(&mut payload(5_000, 0)), 5_000));
        assert!(gate.should_emit(Digest::of(&mut payload(31_000, 0)), 31_000));
        assert!(
            !gate.should_emit(Digest::of(&mut payload(35_000, 0)), 35_000),
            "window restarts at the emit"
        );
    }

    #[test]
    fn unchanged_stamps_never_emit_however_old() {
        let mut gate = EmitGate::new();
        assert!(gate.should_emit(Digest::of(&mut payload(1_000, 0)), 1_000));
        assert!(!gate.should_emit(Digest::of(&mut payload(1_000, 0)), 500_000));
    }

    #[test]
    fn ts_alone_never_emits() {
        let mut gate = EmitGate::new();
        let mut a = payload(1_000, 0);
        assert!(gate.should_emit(Digest::of(&mut a), 1_000));
        a.ts = 99;
        assert!(!gate.should_emit(Digest::of(&mut a), 2_000));
    }

    #[test]
    fn digest_leaves_the_payload_untouched() {
        let mut p = payload(1_234, 3);
        let before = p.clone();
        let _ = Digest::of(&mut p);
        assert_eq!(p, before);
    }

    #[test]
    fn digest_ignores_ts_and_stamps_but_not_content() {
        let a = Digest::of(&mut payload(1_000, 0));
        let b = Digest::of(&mut payload(9_000, 0));
        let c = Digest::of(&mut payload(1_000, 1));
        assert_eq!(a.visible, b.visible);
        assert_ne!(a.stamps, b.stamps);
        assert_ne!(a.visible, c.visible);
    }
}
