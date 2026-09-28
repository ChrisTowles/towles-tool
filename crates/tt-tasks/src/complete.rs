//! Google-style completion for the new-task goal: finish the word being typed, or
//! guess the next one, from the user's own Claude Code prompt history. Words and
//! word pairs are counted once per build; a prompt typed in this repo counts more.

use std::collections::HashMap;
use tt_claude_code::history::HistoryPrompt;

const SAME_REPO_WEIGHT: f32 = 3.0;
const PAIR_BOOST: f32 = 25.0;
const MIN_NEXT_WEIGHT: f32 = 2.0;
const EXTEND_MIN_WEIGHT: f32 = 4.0;
const EXTEND_MIN_SHARE: f32 = 0.5;
const EXTEND_MAX_WORDS: usize = 2;
const MAX_WORD_CHARS: usize = 40;
const TRIM: &[char] = &[
    '.', ',', ';', ':', '!', '?', '(', ')', '[', ']', '{', '}', '"', '\'', '`', '<', '>', '*',
];

struct Word {
    display: String,
    weight: f32,
}

pub struct Completer {
    /// Sorted, so a prefix is one contiguous range.
    keys: Vec<String>,
    words: HashMap<String, Word>,
    next: HashMap<String, HashMap<String, f32>>,
    out_total: HashMap<String, f32>,
}

/// `None` for anything not worth offering back: numbers, URLs, pasted blobs.
fn clean(raw: &str) -> Option<&str> {
    let t = raw.trim_matches(TRIM);
    let ok = !t.is_empty()
        && t.chars().count() <= MAX_WORD_CHARS
        && !t.contains("://")
        && t.chars().any(char::is_alphabetic);
    ok.then_some(t)
}

fn ends_sentence(raw: &str) -> bool {
    raw.ends_with(['.', '!', '?', ';', ':'])
}

impl Completer {
    /// `repo_dir` matches prompts run in the repo or any of its worktrees.
    pub fn build(prompts: &[HistoryPrompt], repo_dir: &str) -> Self {
        let mut variants: HashMap<String, HashMap<String, f32>> = HashMap::new();
        let mut next: HashMap<String, HashMap<String, f32>> = HashMap::new();
        for p in prompts {
            let weight = match &p.project {
                Some(proj) if !repo_dir.is_empty() && proj.starts_with(repo_dir) => {
                    SAME_REPO_WEIGHT
                }
                _ => 1.0,
            };
            let mut prev: Option<String> = None;
            for raw in p.text.split_whitespace() {
                let Some(word) = clean(raw) else {
                    prev = None;
                    continue;
                };
                let key = word.to_lowercase();
                *variants.entry(key.clone()).or_default().entry(word.to_string()).or_default() +=
                    weight;
                if let Some(prev) = prev.take() {
                    *next.entry(prev).or_default().entry(key.clone()).or_default() += weight;
                }
                prev = (!ends_sentence(raw)).then_some(key);
            }
        }
        let words: HashMap<String, Word> = variants
            .into_iter()
            .map(|(key, forms)| {
                let weight = forms.values().sum();
                let display = forms
                    .into_iter()
                    .max_by(|a, b| a.1.total_cmp(&b.1).then_with(|| b.0.cmp(&a.0)))
                    .map(|(form, _)| form)
                    .unwrap_or_else(|| key.clone());
                (key, Word { display, weight })
            })
            .collect();
        let mut keys: Vec<String> = words.keys().cloned().collect();
        keys.sort();
        let out_total = next.iter().map(|(k, m)| (k.clone(), m.values().sum())).collect();
        Self { keys, words, next, out_total }
    }

    fn pair(&self, prev: Option<&str>, key: &str) -> f32 {
        prev.and_then(|p| self.next.get(p)).and_then(|m| m.get(key)).copied().unwrap_or(0.0)
    }

    /// Runs on only while one follower clearly dominates, so a guess stays a guess.
    fn extension(&self, from: &str) -> String {
        let mut out = String::new();
        let mut cur = from.to_string();
        for _ in 0..EXTEND_MAX_WORDS {
            let Some(best) = self.next.get(&cur).and_then(|m| {
                m.iter().max_by(|a, b| a.1.total_cmp(b.1).then_with(|| b.0.cmp(a.0)))
            }) else {
                break;
            };
            let total = self.out_total.get(&cur).copied().unwrap_or(0.0);
            if *best.1 < EXTEND_MIN_WEIGHT || *best.1 < total * EXTEND_MIN_SHARE {
                break;
            }
            out.push(' ');
            out.push_str(&self.words[best.0].display);
            cur = best.0.clone();
        }
        out
    }

    /// Text to append at the caret, best first. `before` is the goal up to the caret.
    pub fn complete(&self, before: &str, limit: usize) -> Vec<String> {
        let mut toks: Vec<&str> = before.split_whitespace().collect();
        let at_word = !before.is_empty() && !before.ends_with(char::is_whitespace);
        let partial = if at_word { toks.pop().unwrap_or("") } else { "" };
        let prev_raw = toks.last().copied();
        let prev = prev_raw.filter(|r| !ends_sentence(r)).and_then(clean).map(str::to_lowercase);
        let prev = prev.as_deref();

        let mut scored: Vec<(f32, &str)> = if partial.is_empty() {
            let Some(followers) = prev.and_then(|p| self.next.get(p)) else {
                return Vec::new();
            };
            followers
                .iter()
                .filter(|(_, w)| **w >= MIN_NEXT_WEIGHT)
                .map(|(k, w)| (*w, k.as_str()))
                .collect()
        } else {
            if !partial.chars().all(|c| c.is_alphanumeric() || "-_'.".contains(c)) {
                return Vec::new();
            }
            let p = partial.to_lowercase();
            let typed = p.chars().count();
            let start = self.keys.partition_point(|k| k.as_str() < p.as_str());
            self.keys[start..]
                .iter()
                .take_while(|k| k.starts_with(&p))
                .filter(|k| k.chars().count() >= typed + 2)
                .filter(|k| k.chars().nth(typed).is_some_and(char::is_alphanumeric))
                .filter_map(|k| {
                    let pair = self.pair(prev, k);
                    // One letter matches too much to guess from frequency alone.
                    (typed > 1 || pair > 0.0)
                        .then(|| (self.words[k].weight + PAIR_BOOST * pair, k.as_str()))
                })
                .collect()
        };
        scored.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(b.1)));

        let typed = partial.chars().count();
        let mut out: Vec<String> = Vec::new();
        for (_, key) in scored {
            let rest: String = self.words[key].display.chars().skip(typed).collect();
            let suffix = format!("{rest}{}", self.extension(key));
            if !out.contains(&suffix) {
                out.push(suffix);
            }
            if out.len() == limit {
                break;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompts(texts: &[(&str, &str)]) -> Vec<HistoryPrompt> {
        texts
            .iter()
            .map(|(t, p)| HistoryPrompt { text: t.to_string(), project: Some(p.to_string()) })
            .collect()
    }

    fn corpus() -> Completer {
        Completer::build(
            &prompts(&[
                ("update the plugin marketplace", "/r"),
                ("update the plugin marketplace docs", "/r"),
                ("check the plugin marketplace", "/r"),
                ("plan the release", "/other"),
                ("the platform is slow", "/other"),
            ]),
            "/r",
        )
    }

    #[test]
    fn finishes_the_word_being_typed_preferring_what_follows_the_previous_word() {
        let c = corpus();
        assert_eq!(c.complete("fix the pl", 5)[0], "ugin marketplace");
        assert!(c.complete("fix the pl", 5).contains(&"atform".to_string()));
    }

    #[test]
    fn guesses_the_next_word_after_a_space() {
        assert_eq!(corpus().complete("update the ", 3)[0], "plugin marketplace");
    }

    #[test]
    fn stays_quiet_without_evidence() {
        let c = corpus();
        assert!(c.complete("", 5).is_empty());
        assert!(c.complete("zzz", 5).is_empty());
        assert!(c.complete("unknownword ", 5).is_empty());
        assert!(c.complete("x p", 5).is_empty(), "one letter needs a pair to go on");
    }

    #[test]
    fn never_continues_a_word_with_punctuation() {
        let c = Completer::build(&prompts(&[("rail's rail/task rails", "/r")]), "/r");
        assert!(c.complete("the rail", 5).is_empty());
    }

    #[test]
    fn a_sentence_break_is_not_a_word_pair() {
        let c = Completer::build(&prompts(&[("done. then", "/r"), ("done. then", "/r")]), "/r");
        assert!(c.complete("done ", 3).is_empty());
    }

    #[test]
    fn keeps_the_most_common_casing() {
        let c = Completer::build(
            &prompts(&[("GitHub", "/r"), ("GitHub", "/r"), ("github", "/r")]),
            "/r",
        );
        assert_eq!(c.complete("Gi", 1), vec!["tHub".to_string()]);
    }
}
