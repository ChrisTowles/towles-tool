//! Decides when a rebuilt [`StatePayload`] is worth waking the webview for.
//!
//! Every emit costs a deserialize and a React render, so a payload that differs
//! only by clock stamps stays home. `GitInfo::computed_at_ms` restamps on every
//! git recompute even when the result is identical and only feeds the "checked
//! N s ago" label, so a change confined to it re-emits at most once per
//! [`STAMP_REFRESH_MS`]. Anything else, status and liveness included, emits at
//! once. Time is passed in, never read.

use crate::bridge::StatePayload;

/// How stale a "checked N s ago" label may get before a stamp-only change is sent.
pub const STAMP_REFRESH_MS: i64 = 30_000;

#[derive(Debug, Default)]
pub struct EmitGate {
    /// Last emitted payload with `ts` and the git stamps zeroed.
    last: Option<StatePayload>,
    /// Every folder's `computed_at_ms` as the client last saw it.
    sent_stamps: Vec<i64>,
    emitted_ms: i64,
}

impl EmitGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// True when `payload` should be emitted; the gate then treats it as sent.
    pub fn should_emit(&mut self, payload: &StatePayload, now_ms: i64) -> bool {
        let stamps: Vec<i64> =
            payload.repos.iter().flat_map(|r| r.folders.iter().map(|f| f.computed_at_ms)).collect();
        let mut norm = payload.clone();
        norm.ts = 0;
        norm.repos.iter_mut().flat_map(|r| r.folders.iter_mut()).for_each(|f| f.computed_at_ms = 0);

        let visible = self.last.as_ref() != Some(&norm);
        let stale = stamps != self.sent_stamps && now_ms - self.emitted_ms >= STAMP_REFRESH_MS;
        if !visible && !stale {
            return false;
        }
        self.last = Some(norm);
        self.sent_stamps = stamps;
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
        assert!(EmitGate::new().should_emit(&payload(1, 0), 1));
    }

    #[test]
    fn stamp_only_change_inside_window_stays_home() {
        let mut gate = EmitGate::new();
        assert!(gate.should_emit(&payload(1_000, 0), 1_000));
        assert!(!gate.should_emit(&payload(5_000, 0), 5_000));
        assert!(!gate.should_emit(&payload(9_000, 0), 29_999));
    }

    #[test]
    fn visible_change_emits_immediately() {
        let mut gate = EmitGate::new();
        assert!(gate.should_emit(&payload(1_000, 0), 1_000));
        assert!(gate.should_emit(&payload(1_000, 1), 1_001));
    }

    #[test]
    fn stamp_only_change_emits_once_window_passes() {
        let mut gate = EmitGate::new();
        assert!(gate.should_emit(&payload(1_000, 0), 1_000));
        assert!(!gate.should_emit(&payload(5_000, 0), 5_000));
        assert!(gate.should_emit(&payload(31_000, 0), 31_000));
        assert!(!gate.should_emit(&payload(35_000, 0), 35_000), "window restarts at the emit");
    }

    #[test]
    fn unchanged_stamps_never_emit_however_old() {
        let mut gate = EmitGate::new();
        assert!(gate.should_emit(&payload(1_000, 0), 1_000));
        assert!(!gate.should_emit(&payload(1_000, 0), 500_000));
    }

    #[test]
    fn ts_alone_never_emits() {
        let mut gate = EmitGate::new();
        let mut a = payload(1_000, 0);
        assert!(gate.should_emit(&a, 1_000));
        a.ts = 99;
        assert!(!gate.should_emit(&a, 2_000));
    }
}
