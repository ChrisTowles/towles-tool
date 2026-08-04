//! The `comment-budget.toml` schema, and finding the file itself.
//!
//! Everything the tool measures, how hard, and why each surface sits where it
//! does lives in that file rather than in this crate — the same binary gates a
//! Rust workspace and a TSX app by reading a different config.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::CommentBudgetError;

pub const CONFIG_FILE: &str = "comment-budget.toml";

/// Glob semantics: `*` stops at a path separator, `**` crosses it. Without this
/// `crates/*/src/**` would also claim `crates/a/b/c/src`.
const GLOB: glob::MatchOptions = glob::MatchOptions {
    case_sensitive: true,
    require_literal_separator: true,
    require_literal_leading_dot: false,
};

#[derive(Debug, serde::Deserialize)]
pub struct Config {
    #[serde(default)]
    pub skip: Vec<String>,
    pub kinds: BTreeMap<String, Kind>,
    #[serde(rename = "surface")]
    pub surfaces: Vec<Surface>,
    pub escape: Escape,
}

/// How one family of files is read. `exempt` prefixes are invisible to every
/// signal — neither comment nor code — so a Rust `//!` header can hold the
/// decision it records without paying for it.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Kind {
    pub grammar: Grammar,
    pub extensions: Vec<String>,
    #[serde(default)]
    pub exempt: Vec<String>,
    /// Exempt lines a file gets for free; the rest count like any other comment,
    /// so `exempt` is a carve-out and not a hiding place. `None` leaves them
    /// uncapped, which is only safe for a kind that exempts nothing.
    #[serde(default)]
    pub exempt_free: Option<usize>,
    #[serde(default)]
    pub counted: Vec<String>,
}

impl Kind {
    /// Whether a comment's own syntax exempts it. Longest prefix wins, so `//!`
    /// beats the `//` that also matches it; a comment matching neither list
    /// counts, so a syntax nobody listed can't slip through unmeasured.
    pub fn is_exempt(&self, text: &str) -> bool {
        let longest = |set: &[String]| {
            set.iter().filter(|p| text.starts_with(p.as_str())).map(String::len).max().unwrap_or(0)
        };
        longest(&self.exempt) > longest(&self.counted)
    }
}

#[derive(Debug, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Grammar {
    Rust,
    Typescript,
    Tsx,
    Hcl,
    /// Parsed by nothing and measured by length.
    Prose,
}

impl Grammar {
    pub fn language(&self) -> Option<tree_sitter::Language> {
        match self {
            Grammar::Rust => Some(tree_sitter_rust::LANGUAGE.into()),
            Grammar::Typescript => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
            Grammar::Tsx => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
            Grammar::Hcl => Some(tree_sitter_hcl::LANGUAGE.into()),
            Grammar::Prose => None,
        }
    }
}

#[derive(Debug, serde::Deserialize)]
pub struct Surface {
    pub name: String,
    pub paths: Vec<String>,
    pub goal: String,
    pub target: Option<Target>,
    pub file: Option<Tiers<FileTier>>,
    pub run: Option<Tiers<usize>>,
    pub warn: Option<LinesTier>,
    pub error: Option<LinesTier>,
    /// Compiled once rather than per file: `claims` is called for every surface
    /// on every file in the tree, and recompiling there is the whole walk's cost.
    #[serde(skip)]
    patterns: std::sync::OnceLock<Vec<glob::Pattern>>,
}

impl Surface {
    pub fn claims(&self, rel: &str) -> bool {
        self.patterns
            .get_or_init(|| self.paths.iter().filter_map(|p| glob::Pattern::new(p).ok()).collect())
            .iter()
            .any(|g| g.matches_with(rel, GLOB))
    }

    /// The length band a prose surface enforces, `None` for a code one.
    pub fn doc_tiers(&self) -> Option<Tiers<usize>> {
        match (&self.warn, &self.error) {
            (Some(w), Some(e)) => Some(Tiers { warn: w.lines, error: e.lines }),
            _ => None,
        }
    }
}

/// What the surface aims at — a ratio for code, a length for prose. Reported
/// against what was measured; never enforced, which is what warn/error are for.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(untagged)]
pub enum Target {
    Ratio(f64),
    Lines { lines: usize },
}

#[derive(Debug, serde::Deserialize)]
pub struct FileTier {
    pub ratio: f64,
    pub lines: usize,
}

#[derive(Debug, serde::Deserialize)]
pub struct LinesTier {
    pub lines: usize,
}

#[derive(Debug, serde::Deserialize)]
pub struct Escape {
    pub directive: String,
}

impl Escape {
    /// The literal a file must carry, taken from the template's head — so the
    /// config states the directive once and the code can't drift from it.
    pub fn marker(&self) -> &str {
        self.directive.split('(').next().unwrap_or(&self.directive).trim()
    }
}

#[derive(Debug, serde::Deserialize)]
pub struct Tiers<T> {
    pub warn: T,
    pub error: T,
}

impl<T> Tiers<T> {
    /// The highest tier `reached` is true for, error first.
    pub fn hit(&self, reached: impl Fn(&T) -> bool) -> Option<(crate::Severity, &T)> {
        if reached(&self.error) {
            Some((crate::Severity::Error, &self.error))
        } else if reached(&self.warn) {
            Some((crate::Severity::Warning, &self.warn))
        } else {
            None
        }
    }
}

impl Config {
    /// Nearest `comment-budget.toml` at or above `start`, with the directory
    /// holding it as the root every path in the config is relative to.
    pub fn discover(start: &Path) -> Result<(Self, PathBuf), CommentBudgetError> {
        let start = start.canonicalize().unwrap_or_else(|_| start.to_path_buf());
        for dir in start.ancestors() {
            let path = dir.join(CONFIG_FILE);
            if path.is_file() {
                return Ok((Self::load(&path)?, dir.to_path_buf()));
            }
        }
        Err(CommentBudgetError::NoConfig { start })
    }

    pub fn load(path: &Path) -> Result<Self, CommentBudgetError> {
        let text = std::fs::read_to_string(path)
            .map_err(|source| CommentBudgetError::Read { path: path.to_path_buf(), source })?;
        let cfg: Config = toml::from_str(&text).map_err(|e| CommentBudgetError::Config {
            path: path.to_path_buf(),
            message: e.to_string(),
        })?;
        cfg.validate(path)?;
        Ok(cfg)
    }

    /// A surface that enforces nothing is the failure mode of the whole design:
    /// its files read as passing when nothing ever looked at them.
    fn validate(&self, path: &Path) -> Result<(), CommentBudgetError> {
        let bad =
            |message: String| CommentBudgetError::Config { path: path.to_path_buf(), message };
        for s in &self.surfaces {
            if s.file.is_none() && s.run.is_none() && s.doc_tiers().is_none() {
                return Err(bad(format!(
                    "surface `{}` enforces nothing — give it [surface.file]/[surface.run], \
                     or warn/error line counts for a prose surface",
                    s.name
                )));
            }
            // A malformed glob silently matches nothing, which turns a typo into
            // a pile of `unclaimed` errors pointing at the files instead of at
            // the line that is actually wrong.
            for p in &s.paths {
                glob::Pattern::new(p).map_err(|e| {
                    bad(format!("surface `{}` has an invalid path glob `{p}`: {e}", s.name))
                })?;
            }
            // A ratio at or past 1.0 can never fire (and `overshoot` divides by
            // `1 - ratio`), so the surface would read as passing forever.
            let ratios = [
                match s.target {
                    Some(Target::Ratio(r)) => Some(r),
                    _ => None,
                },
                s.file.as_ref().map(|t| t.warn.ratio),
                s.file.as_ref().map(|t| t.error.ratio),
            ];
            for r in ratios.into_iter().flatten() {
                if !(0.0..1.0).contains(&r) {
                    return Err(bad(format!(
                        "surface `{}` has ratio {r}, which must be at least 0 and below 1",
                        s.name
                    )));
                }
            }
        }
        Ok(())
    }

    /// The kind claiming an extension — `None` for a file no kind reads.
    pub fn kind_for(&self, name: &str) -> Option<&Kind> {
        let ext = name.rsplit_once('.')?.1;
        self.kinds.values().find(|k| k.extensions.iter().any(|e| e == ext))
    }

    /// The first surface claiming a path. First match wins, so order in the
    /// config is the precedence; an unclaimed file is not measured at all.
    pub fn surface_for(&self, rel: &str) -> Option<usize> {
        self.surfaces.iter().position(|s| s.claims(rel))
    }

    pub fn surface_names(&self) -> String {
        self.surfaces.iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(", ")
    }
}
