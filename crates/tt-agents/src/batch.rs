//! Burst debounce: messages for one key collect until the burst goes quiet or hits a
//! cap, so an agent never answers half of what Chris typed in three quick messages.

use std::collections::HashMap;
use std::hash::Hash;

struct Pending<T> {
    first_ms: i64,
    last_ms: i64,
    items: Vec<T>,
}

pub struct Batcher<K, T> {
    quiet_ms: i64,
    cap_ms: i64,
    pending: HashMap<K, Pending<T>>,
}

impl<K: Eq + Hash + Clone, T> Batcher<K, T> {
    pub fn new(quiet_ms: u64, cap_ms: u64) -> Self {
        Self { quiet_ms: quiet_ms as i64, cap_ms: cap_ms as i64, pending: HashMap::new() }
    }

    pub fn push(&mut self, key: K, item: T, now_ms: i64) {
        let p = self.pending.entry(key).or_insert_with(|| Pending {
            first_ms: now_ms,
            last_ms: now_ms,
            items: Vec::new(),
        });
        p.last_ms = now_ms;
        p.items.push(item);
    }

    fn deadline(&self, p: &Pending<T>) -> i64 {
        (p.last_ms + self.quiet_ms).min(p.first_ms + self.cap_ms)
    }

    /// Remove and return every batch whose deadline has passed.
    pub fn due(&mut self, now_ms: i64) -> Vec<(K, Vec<T>)> {
        let ready: Vec<K> = self
            .pending
            .iter()
            .filter(|(_, p)| self.deadline(p) <= now_ms)
            .map(|(k, _)| k.clone())
            .collect();
        ready.into_iter().filter_map(|k| self.pending.remove(&k).map(|p| (k, p.items))).collect()
    }

    /// When the timer should next wake, if anything is pending.
    pub fn next_deadline(&self) -> Option<i64> {
        self.pending.values().map(|p| self.deadline(p)).min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_burst_dispatches_once_it_goes_quiet() {
        let mut b = Batcher::new(800, 5000);
        b.push("atlas", 1, 0);
        b.push("atlas", 2, 500);
        assert_eq!(b.next_deadline(), Some(1300));
        assert!(b.due(1299).is_empty());
        assert_eq!(b.due(1300), vec![("atlas", vec![1, 2])]);
        assert_eq!(b.next_deadline(), None);
    }

    #[test]
    fn a_steady_stream_is_cut_at_the_cap() {
        let mut b = Batcher::new(800, 5000);
        for t in (0..=4900).step_by(700) {
            b.push("atlas", t, t);
        }
        assert_eq!(b.next_deadline(), Some(5000));
        assert_eq!(b.due(5000)[0].1.len(), 8);
    }

    #[test]
    fn keys_batch_independently() {
        let mut b = Batcher::new(800, 5000);
        b.push("a", 1, 0);
        b.push("b", 2, 600);
        assert_eq!(b.due(800), vec![("a", vec![1])]);
        assert_eq!(b.due(1400), vec![("b", vec![2])]);
    }
}
