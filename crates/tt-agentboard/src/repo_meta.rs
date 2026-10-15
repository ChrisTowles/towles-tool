//! Persisted per-repo *identity*: the icon and color the user chose for a
//! tracked repo, so the same repo is recognizable at a glance in the rail, on
//! the Board's task cards, and anywhere else its work shows up. A color here is
//! a *pin*; every repo still has one, dealt by [`resolve_colors`].
//!
//! Stored in `<agentboard_shared_dir>/repo_meta.json`, keyed by the repo's
//! absolute dir — the same key `repos.json` lists. **Shared, not task-scoped**:
//! which repos exist and what they look like is a fact about the machine, the
//! same rationale as [`crate::repos`]. (Contrast [`crate::folder_meta`], which
//! is per-checkout state and therefore task-scoped.)
//!
//! Identity lives here rather than as fields on `repos.json`'s `repoPaths`
//! because that list is a plain `Vec<String>` read by three other crates; a
//! sibling keyed store adds the axis without churning every reader.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// A `#rrggbb` color, lowercased. Parsed at the edge so nothing downstream
/// has to re-check that the string is safe to interpolate into a style.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct HexColor(String);

impl HexColor {
    /// Parse `#rgb` or `#rrggbb` (leading `#` optional, case-insensitive) into
    /// the canonical `#rrggbb` form. `None` when it isn't a hex color.
    pub fn parse(raw: &str) -> Option<Self> {
        let body = raw.trim().trim_start_matches('#');
        if !body.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        let expanded = match body.len() {
            3 => body.chars().flat_map(|c| [c, c]).collect::<String>(),
            6 => body.to_string(),
            _ => return None,
        };
        Some(Self(format!("#{}", expanded.to_ascii_lowercase())))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The palette's first color — what a row holds until [`resolve_colors`] deals it one.
impl Default for HexColor {
    fn default() -> Self {
        Self(AUTO_PALETTE[0].to_string())
    }
}

/// The only colors a repo can be dealt or pinned: the app's one palette, owned
/// by the client's `lib/colors.ts` (every chart pulls from it too) and checked
/// against it by a test here. Why these colors is written down there. The order
/// breaks ties: earlier is preferred.
pub const AUTO_PALETTE: [&str; 12] = [
    "#718dba", "#818e9b", "#536992", "#787ca7", "#567786", "#8a697b", "#b08c9f", "#9d7a8d",
    "#6f7192", "#9b95a2", "#8d7f9f", "#78717d",
];

/// `color` as a pin, if it is one of [`AUTO_PALETTE`]'s — no other color is kept.
pub fn palette_pin(color: &HexColor) -> Option<&HexColor> {
    AUTO_PALETTE.contains(&color.as_str()).then_some(color)
}

/// Every repo's color, in order, the way a chart colors its series: a pinned
/// repo keeps its pin (a pin from outside the palette is ignored), and each other repo is dealt the palette color that
/// stands furthest (OKLab) from every color already held — a pin, or one dealt
/// before it — so a dealt color never lands beside a near-twin of a pin.
pub fn resolve_colors(pins: &[Option<&HexColor>]) -> Vec<HexColor> {
    let pins: Vec<Option<&HexColor>> = pins.iter().map(|p| p.and_then(palette_pin)).collect();
    let mut held: Vec<[f64; 3]> = pins.iter().flatten().map(|c| oklab(c.as_str())).collect();
    pins.iter()
        .map(|pin| match pin {
            Some(color) => (*color).clone(),
            None => {
                let nearest_held = |c: &&str| {
                    let lab = oklab(c);
                    held.iter().map(|h| distance(&lab, h)).fold(f64::INFINITY, f64::min)
                };
                // `max_by` keeps the *last* maximum, so walk the palette backwards
                // to let the earlier color win a tie.
                let dealt = AUTO_PALETTE
                    .iter()
                    .rev()
                    .max_by(|a, b| nearest_held(a).total_cmp(&nearest_held(b)))
                    .expect("the palette is not empty");
                held.push(oklab(dealt));
                HexColor(dealt.to_string())
            }
        })
        .collect()
}

fn distance(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    a.iter().zip(b).map(|(x, y)| (x - y).powi(2)).sum::<f64>().sqrt()
}

/// A canonical `#rrggbb` in OKLab, the space a perceived color difference is
/// a straight-line distance in.
fn oklab(hex: &str) -> [f64; 3] {
    let channel = |i: usize| {
        let c = f64::from(u8::from_str_radix(&hex[1 + 2 * i..3 + 2 * i], 16).unwrap_or(0)) / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    let (r, g, b) = (channel(0), channel(1), channel(2));
    let l = (0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b).cbrt();
    let m = (0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b).cbrt();
    let s = (0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b).cbrt();
    [
        0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s,
        1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s,
        0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s,
    ]
}

/// Identity for one repo. Every field optional: an untouched repo has no entry
/// at all, gets the generic icon, and is dealt its color.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoMeta {
    /// A lucide icon name from the client's allowlist (`REPO_ICONS`). Stored as
    /// a bare string because the icon set is a frontend concern — Rust only
    /// round-trips it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// The pinned color; absent ⇒ dealt one by [`resolve_colors`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<HexColor>,
}

impl RepoMeta {
    fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// On-disk shape: `{ "repos": { "<repoDir>": { "icon": "...", ... } } }`.
#[derive(Debug, Default, Serialize, Deserialize)]
struct RepoMetaConfig {
    #[serde(default)]
    repos: HashMap<String, RepoMeta>,
}

/// Default location: `<agentboard_shared_dir>/repo_meta.json`.
pub fn default_repo_meta_path() -> PathBuf {
    tt_config::agentboard_shared_dir_lossy().join("repo_meta.json")
}

/// Owns the repo→meta map plus its file path. Mirrors
/// [`crate::folder_meta::FolderMetaStore`], including its merge-on-save: this
/// file is shared across every Agentboard window, so a save only overwrites the
/// entries this instance actually touched.
#[derive(Debug, Default)]
pub struct RepoMetaStore {
    path: Option<PathBuf>,
    repos: HashMap<String, RepoMeta>,
    /// Repo dirs mutated since the last successful `save()`.
    dirty: HashSet<String>,
}

impl RepoMetaStore {
    /// Load from `path` (empty on missing/corrupt). `None` = in-memory only (tests).
    pub fn new(path: Option<PathBuf>) -> Self {
        let repos = match &path {
            Some(p) => load(p),
            None => HashMap::new(),
        };
        Self { path, repos, dirty: HashSet::new() }
    }

    /// This repo's identity, if the user has set any of it.
    pub fn meta_for(&self, dir: &str) -> Option<&RepoMeta> {
        self.repos.get(dir).filter(|m| !m.is_empty())
    }

    /// Replace a repo's identity wholesale — the picker always submits every
    /// field, and an all-empty `meta` clears the entry ("reset to default").
    /// Returns whether anything changed; caller persists on `true`.
    pub fn set_meta(&mut self, dir: &str, meta: RepoMeta) -> bool {
        // An empty `RepoMeta` is never stored (below), so "absent" and "empty"
        // are the same state — one comparison covers both.
        if self.repos.get(dir).map_or(meta.is_empty(), |m| *m == meta) {
            return false;
        }
        if meta.is_empty() {
            self.repos.remove(dir);
        } else {
            self.repos.insert(dir.to_string(), meta);
        }
        self.dirty.insert(dir.to_string());
        true
    }

    /// Forget one repo's identity, on an explicit user removal only.
    ///
    /// Deliberately not a poll-driven `prune(&dirs)` like the sibling stores:
    /// those hold derived state that regenerates, this holds a hand-picked
    /// choice with no undo, so a repo that merely goes missing keeps its
    /// identity. Returns whether anything was forgotten; caller persists.
    pub fn forget(&mut self, dir: &str) -> bool {
        if self.repos.remove(dir).is_none() {
            return false;
        }
        self.dirty.insert(dir.to_string());
        true
    }

    /// Persist the repos touched since the last save, rereading the file fresh
    /// so a concurrent window's edits to *other* repos survive.
    pub fn save(&mut self) -> std::io::Result<()> {
        let Some(path) = self.path.clone() else {
            return Ok(());
        };
        if self.dirty.is_empty() {
            return Ok(());
        }
        let dirty: Vec<String> = self.dirty.drain().collect();
        let merged = crate::persist::merge_on_save(
            &path,
            |p| RepoMetaConfig { repos: load(p) },
            |config| {
                for dir in &dirty {
                    match self.repos.get(dir) {
                        Some(meta) => {
                            config.repos.insert(dir.clone(), meta.clone());
                        }
                        None => {
                            config.repos.remove(dir);
                        }
                    }
                }
            },
        )?;
        // Adopt the merged result: another window's edits to repos we didn't
        // touch are now part of our view, so `meta_for` stops serving an icon
        // this instance never saw change. Only on a successful write — a failed
        // one must not make us believe we're in sync with a file we didn't
        // manage to update.
        self.repos = merged.repos;
        Ok(())
    }
}

/// Read the map, defaulting to empty on a missing or unparseable file.
fn load(path: &Path) -> HashMap<String, RepoMeta> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    serde_json::from_str::<RepoMetaConfig>(&text).map(|c| c.repos).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(icon: &str, color: &str) -> RepoMeta {
        RepoMeta { icon: Some(icon.to_string()), color: HexColor::parse(color) }
    }

    #[test]
    fn hex_color_parses_both_lengths_and_canonicalizes() {
        assert_eq!(HexColor::parse("#AbC").unwrap().as_str(), "#aabbcc");
        assert_eq!(HexColor::parse("7C3AED").unwrap().as_str(), "#7c3aed");
        assert_eq!(HexColor::parse("  #7c3aed  ").unwrap().as_str(), "#7c3aed");
    }

    #[test]
    fn with_nothing_held_the_palette_leads() {
        let got = resolve_colors(&[None]);
        assert_eq!(got[0].as_str(), AUTO_PALETTE[0]);
    }

    #[test]
    fn a_dealt_color_keeps_clear_of_every_pin() {
        let pin = HexColor::parse(AUTO_PALETTE[0]).unwrap();
        let got = resolve_colors(&[Some(&pin), None, None]);
        assert_eq!(got[0], pin, "a pin is kept as is");
        assert!(!got[1..].contains(&pin), "nothing dealt shares the pinned color");
        assert_ne!(got[1], got[2], "two dealt repos never share a color");
    }

    #[test]
    fn the_palette_is_the_clients() {
        let ts = include_str!("../../../apps/client/src/lib/colors.ts");
        let list = &ts[ts.find("PALETTE").unwrap()..];
        let list = &list[..list.find("];").unwrap()];
        let hexes: Vec<&str> = list.split('"').filter(|s| s.starts_with('#')).collect();
        assert_eq!(hexes, AUTO_PALETTE, "AUTO_PALETTE has drifted from lib/colors.ts");
    }

    #[test]
    fn a_pin_from_outside_the_palette_is_dealt_over() {
        let rose = HexColor::parse("#e11d48").unwrap();
        let got = resolve_colors(&[Some(&rose)]);
        assert_eq!(got[0].as_str(), AUTO_PALETTE[0]);
    }

    #[test]
    fn dealing_is_stable_for_the_same_repos() {
        let lime = HexColor::parse(AUTO_PALETTE[1]).unwrap();
        let pins = [None, Some(&lime), None, None];
        assert_eq!(resolve_colors(&pins), resolve_colors(&pins));
    }

    #[test]
    fn the_palette_is_canonical_hex() {
        for c in AUTO_PALETTE {
            assert_eq!(HexColor::parse(c).unwrap().as_str(), c);
        }
    }

    #[test]
    fn hex_color_rejects_non_colors() {
        for raw in ["", "#12", "#12345", "#gggggg", "red", "#7c3aed7c"] {
            assert!(HexColor::parse(raw).is_none(), "expected {raw:?} to be rejected");
        }
    }

    #[test]
    fn set_meta_reports_change_and_clears_on_empty() {
        let mut store = RepoMetaStore::new(None);
        assert!(store.set_meta("/r", meta("Rocket", "#7c3aed")));
        assert!(!store.set_meta("/r", meta("Rocket", "#7c3aed")), "no-op resave");
        assert_eq!(store.meta_for("/r").unwrap().icon.as_deref(), Some("Rocket"));

        assert!(store.set_meta("/r", RepoMeta::default()), "clearing is a change");
        assert!(store.meta_for("/r").is_none());
        assert!(!store.set_meta("/r", RepoMeta::default()), "clearing an absent repo is a no-op");
    }

    #[test]
    fn save_merges_with_a_concurrent_windows_edits() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("repo_meta.json");

        let mut a = RepoMetaStore::new(Some(path.clone()));
        a.set_meta("/a", meta("Rocket", "#7c3aed"));
        a.save().unwrap();

        // Second window loads, edits only its own repo, saves.
        let mut b = RepoMetaStore::new(Some(path.clone()));
        b.set_meta("/b", meta("Bug", "#f59e0b"));
        b.save().unwrap();

        // A's repo survives B's save.
        let reloaded = RepoMetaStore::new(Some(path));
        assert_eq!(reloaded.meta_for("/a").unwrap().icon.as_deref(), Some("Rocket"));
        assert_eq!(reloaded.meta_for("/b").unwrap().icon.as_deref(), Some("Bug"));
    }

    #[test]
    fn save_adopts_another_windows_edits_into_memory() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("repo_meta.json");

        let mut a = RepoMetaStore::new(Some(path.clone()));
        a.set_meta("/a", meta("Rocket", "#7c3aed"));
        a.save().unwrap();

        // Another window themes a repo A has never touched.
        let mut b = RepoMetaStore::new(Some(path.clone()));
        b.set_meta("/b", meta("Bug", "#f59e0b"));
        b.save().unwrap();

        // A's next save merges — and must leave A *reading* B's repo too,
        // rather than serving a view that predates it until restart.
        a.set_meta("/a", meta("Cloud", "#0ea5e9"));
        a.save().unwrap();
        assert_eq!(
            a.meta_for("/b").and_then(|m| m.icon.as_deref()),
            Some("Bug"),
            "a save must adopt the merged state, not just write it"
        );
    }

    #[test]
    fn forget_drops_only_the_named_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("repo_meta.json");
        let mut store = RepoMetaStore::new(Some(path.clone()));
        store.set_meta("/keep", meta("Rocket", "#7c3aed"));
        store.set_meta("/drop", meta("Bug", "#f59e0b"));
        store.save().unwrap();

        assert!(store.forget("/drop"));
        assert!(!store.forget("/drop"), "forgetting an absent repo is a no-op");
        store.save().unwrap();

        let reloaded = RepoMetaStore::new(Some(path));
        assert!(reloaded.meta_for("/keep").is_some());
        assert!(reloaded.meta_for("/drop").is_none(), "a forgotten repo must not survive the save");
    }

    #[test]
    fn identity_survives_a_repo_going_missing() {
        // The regression this store's lack of a poll-driven prune exists to
        // prevent: a repo dropping out of the rail's dirs set (unmounted disk,
        // transient stat failure, untrack-then-retrack) must not cost the user
        // a hand-picked icon they can't get back with an undo.
        let mut store = RepoMetaStore::new(None);
        store.set_meta("/gone", meta("Rocket", "#7c3aed"));
        assert!(
            store.meta_for("/gone").is_some(),
            "only an explicit removal may forget an identity"
        );
    }

    #[test]
    fn serializes_to_the_shape_the_client_reads() {
        // The client types this as `{ icon?, color? }` and an unset field must
        // be *absent*, not null — pin both.
        let full = RepoMeta { icon: Some("Rocket".into()), color: HexColor::parse("#7c3aed") };
        assert_eq!(
            serde_json::to_string(&full).unwrap(),
            r##"{"icon":"Rocket","color":"#7c3aed"}"##
        );
        assert_eq!(serde_json::to_string(&RepoMeta::default()).unwrap(), "{}");

        // A file written while repos had a tint switch still loads.
        let old: RepoMeta = serde_json::from_str(r#"{"icon":"Bug","style":"tint"}"#).unwrap();
        assert_eq!(old.icon.as_deref(), Some("Bug"));
    }

    #[test]
    fn corrupt_file_loads_as_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("repo_meta.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(RepoMetaStore::new(Some(path)).meta_for("/a").is_none());
    }
}
