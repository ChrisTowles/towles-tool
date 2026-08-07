//! Fixtures are written to a temp tree at test time rather than committed, so
//! the deliberately over-commented ones can't be measured by the repo's own gate.

use std::fs;
use std::path::PathBuf;

use comment_budget::{Config, Rule, Severity, analyze, judge};

const CONFIG: &str = r##"
skip = ["skipped"]

[kinds.rust]
grammar     = "rust"
extensions  = ["rs"]
exempt      = ["//!"]
exempt_free = 4
counted     = ["///", "//"]

[kinds.terraform]
grammar    = "hcl"
extensions = ["tf"]
counted    = ["#", "//", "/*"]

[kinds.markdown]
grammar    = "prose"
extensions = ["md"]

[[surface]]
name   = "code"
paths  = ["src/**/*.rs"]
goal   = "test surface"
budget = 0.20
over   = { warn = 2, error = 4 }
run    = { warn = 3, error = 5 }

[[surface]]
name   = "docs"
paths  = ["**/*.md"]
goal   = "test prose surface"
over   = { warn = 3, error = 6 }

[[surface]]
name   = "infra"
paths  = ["infra/**/*.tf"]
goal   = "test hcl surface"
budget = 0.08
over   = { warn = 2, error = 4 }
run    = { warn = 3, error = 5 }

[escape]
directive = "comment-budget: allow(<reason>)"
"##;

/// Where throwaway trees go — under `target/`, so a fixture tree is never
/// somewhere the repo's own gate would walk into it.
fn scratch_root() -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
}

/// A throwaway tree, named for the test that owns it.
struct Tree(PathBuf);

impl Tree {
    fn new(name: &str) -> Self {
        let dir = scratch_root().join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create fixture tree");
        fs::write(dir.join("comment-budget.toml"), CONFIG).expect("write config");
        Tree(dir)
    }

    fn file(self, rel: &str, body: &str) -> Self {
        let path = self.0.join(rel);
        fs::create_dir_all(path.parent().expect("fixture path has a parent")).expect("mkdir");
        fs::write(path, body).expect("write fixture");
        self
    }

    /// Every finding for this tree, measured whole (no git involved).
    fn findings(&self) -> Vec<comment_budget::Finding> {
        let (cfg, root) = Config::discover(&self.0).expect("discover config");
        let analysis = analyze(&root, &cfg, None).expect("analyze");
        let mut out = judge(&cfg, &analysis.stats);
        out.extend(comment_budget::unclaimed_findings(&analysis.unclaimed));
        out
    }

    fn stats(&self) -> Vec<comment_budget::FileStats> {
        let (cfg, root) = Config::discover(&self.0).expect("discover config");
        analyze(&root, &cfg, None).expect("analyze").stats
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn module_docs_within_the_allowance_are_invisible_to_every_signal() {
    let tree = Tree::new("exempt")
        .file("src/lib.rs", "//! one\n//! two\n//! three\n//! four\nfn a() {}\nfn b() {}\n");
    let stats = tree.stats();
    let f = stats.first().expect("one file measured");
    assert_eq!(f.counted, 0, "`//!` is not comment");
    assert_eq!(f.code, 2, "`//!` is not code either");
    assert!(tree.findings().is_empty(), "a header inside the allowance costs nothing");
}

/// The whole point of `exempt_free`: prose moved from `///` into `//!` has to
/// stop paying off past the allowance, or the linter rewards relocating bloat
/// over cutting it.
#[test]
fn module_docs_past_the_allowance_count_like_any_other_comment() {
    let tree = Tree::new("exempt-overflow").file(
        "src/lib.rs",
        "//! one\n//! two\n//! three\n//! four\n//! five\n//! six\nfn a() {}\nfn b() {}\n",
    );
    let stats = tree.stats();
    let f = stats.first().expect("one file measured");
    assert_eq!(f.counted, 2, "the first 4 are free; lines 5 and 6 are bloat");
    assert_eq!(f.code, 2);
    assert!(
        tree.findings().iter().any(|f| f.rule == Rule::CommentBudget),
        "50% of the measured lines are prose, past the 20%-at-2-lines warn tier",
    );
}

/// Terraform's `#` is the idiomatic one and `//` is legal too, so a budget that
/// read only one of them would be a budget on style.
#[test]
fn hcl_counts_both_comment_syntaxes() {
    let stats = Tree::new("hcl")
        .file(
            "infra/main.tf",
            "# why\n// also why\nresource \"aws_kms_key\" \"k\" {\n  enable_key_rotation = true\n}\n",
        )
        .stats();
    let f = stats.first().expect("one file measured");
    assert_eq!((f.counted, f.code), (2, 3));
}

#[test]
fn a_trailing_comment_stays_code() {
    let stats = Tree::new("trailing").file("src/lib.rs", "fn a() {} // why\nfn b() {}\n").stats();
    let f = stats.first().expect("one file measured");
    assert_eq!((f.counted, f.code), (0, 2));
}

#[test]
fn overshoot_needs_both_mass_and_density() {
    // 50% prose, but 1 comment line is only 1 over the 20% budget — under warn.
    let tiny = Tree::new("tiny").file("src/lib.rs", "/// doc\nfn a() {}\n");
    assert!(tiny.findings().is_empty(), "a tiny stub is not the thing being hunted");

    let big = Tree::new("big").file(
        "src/lib.rs",
        "// a\n// b\n// c\nfn a() {}\nfn b() {}\nfn c() {}\nfn d() {}\nfn e() {}\n",
    );
    let f = big.findings();
    assert_eq!(f.len(), 2, "the run and the file budget both fire: {f:?}");
    assert!(f.iter().any(|f| f.rule == Rule::CommentBudget && f.severity == Severity::Warning));
}

#[test]
fn a_blank_line_inside_a_block_comment_is_neither() {
    let stats = Tree::new("block").file("src/lib.rs", "/* one\n\n   two */\nfn a() {}\n").stats();
    let f = stats.first().expect("one file measured");
    assert_eq!((f.counted, f.code), (2, 1), "the blank row counts as nothing");
}

#[test]
fn a_run_reports_its_own_span() {
    let tree = Tree::new("run").file(
        "src/lib.rs",
        "// a\n// b\n// c\n// d\n// e\n// f\nfn a() {}\nfn b() {}\nfn c() {}\nfn d() {}\n\
         fn e() {}\nfn f() {}\nfn g() {}\nfn h() {}\nfn i() {}\nfn j() {}\n",
    );
    let findings = tree.findings();
    let run = findings.iter().find(|f| f.rule == Rule::CommentRun).expect("the run fires");
    assert_eq!(run.span, Some((1, 6)));
    assert_eq!(run.severity, Severity::Error, "6 lines is past the 5-line error tier");
}

#[test]
fn an_exempt_line_breaks_a_run() {
    let tree = Tree::new("split")
        .file("src/lib.rs", "// a\n// b\n// c\n//! break\n// d\n// e\n// f\nfn a() {}\n");
    assert!(
        !tree
            .findings()
            .iter()
            .any(|f| f.rule == Rule::CommentRun && f.severity == Severity::Error),
        "two runs of 3, not one of 6",
    );
}

#[test]
fn an_opt_out_needs_a_reason() {
    let bare = Tree::new("bare-opt-out")
        .file("src/lib.rs", "// comment-budget: allow\n// a\n// b\n// c\n// d\nfn a() {}\n");
    let f = bare.findings();
    assert_eq!(f.len(), 1, "the opt-out replaces every other finding: {f:?}");
    assert_eq!(f[0].rule, Rule::UnexplainedOptOut);
    assert_eq!(f[0].severity, Severity::Error);

    let given = Tree::new("explained-opt-out").file(
        "src/lib.rs",
        "// comment-budget: allow(generated table)\n// a\n// b\n// c\n// d\nfn a() {}\n",
    );
    assert!(given.findings().is_empty(), "a reason silences the file");
}

/// A link names a file that already has a real path, so following one measures
/// it twice — and a cycle never terminates at all.
#[cfg(unix)]
#[test]
fn a_symlinked_directory_is_not_followed() {
    let tree = Tree::new("symlink").file("src/lib.rs", "fn a() {}\n");
    std::os::unix::fs::symlink(tree.0.join("src"), tree.0.join("linked")).expect("create the link");
    let stats = tree.stats();
    assert_eq!(stats.len(), 1, "the file is measured once, by its real path: {stats:?}");
    assert_eq!(stats[0].file, "src/lib.rs");
    assert!(tree.findings().is_empty(), "and the link is not reported unclaimed either");
}

#[test]
fn an_unclaimed_file_is_an_error_not_a_skip() {
    let tree = Tree::new("unclaimed").file("elsewhere/stray.rs", "fn a() {}\n");
    let f = tree.findings();
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!(f[0].rule, Rule::Unclaimed);
    assert_eq!(f[0].file, "elsewhere/stray.rs");
}

#[test]
fn a_skipped_directory_is_not_even_unclaimed() {
    let tree = Tree::new("skipped").file("skipped/stray.rs", "fn a() {}\n");
    assert!(tree.findings().is_empty());
}

/// Prose has no code to earn a budget, so the whole file is its excess and the
/// one gate covers it — no separate length rule.
#[test]
fn prose_is_measured_by_length() {
    let tree = Tree::new("prose").file("notes.md", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
    let f = tree.findings();
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!(f[0].rule, Rule::CommentBudget);
    assert_eq!(f[0].severity, Severity::Error, "7 lines is past the 6-line error tier");
}

#[test]
fn first_surface_wins() {
    // `src/**/*.rs` precedes `**/*.md`, and a .md under src/ is claimed by docs
    // because the code surface's glob does not match it.
    let stats = Tree::new("precedence").file("src/readme.md", "one\n").stats();
    let f = stats.first().expect("one file measured");
    assert_eq!(f.surface, 1, "the docs surface, not the code one");
}

#[test]
fn overshoot_orders_the_work_queue() {
    let stats = Tree::new("overshoot")
        .file("src/lib.rs", "// a\n// b\n// c\n// d\nfn a() {}\nfn b() {}\n")
        .stats();
    let f = stats.first().expect("one file measured");
    // At a 50% ratio, 2 code lines earn 2 comment lines; 4 were written.
    assert_eq!(f.overshoot(0.5), 2);
}

#[test]
fn a_surface_that_enforces_nothing_is_rejected() {
    let dir = scratch_root().join("toothless");
    fs::create_dir_all(&dir).expect("mkdir");
    let cfg = dir.join("comment-budget.toml");
    fs::write(
        &cfg,
        "[kinds.rust]\ngrammar = \"rust\"\nextensions = [\"rs\"]\n\n\
         [[surface]]\nname = \"toothless\"\npaths = [\"**/*.rs\"]\ngoal = \"nothing\"\n\n\
         [escape]\ndirective = \"comment-budget: allow(<reason>)\"\n",
    )
    .expect("write config");
    let err = Config::load(&cfg).expect_err("a surface with no tiers is rejected");
    assert!(err.to_string().contains("enforces nothing"), "{err}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_ratio_that_can_never_fire_is_rejected() {
    let dir = scratch_root().join("unreachable-ratio");
    fs::create_dir_all(&dir).expect("mkdir");
    let cfg = dir.join("comment-budget.toml");
    fs::write(
        &cfg,
        "[kinds.rust]\ngrammar = \"rust\"\nextensions = [\"rs\"]\n\n\
         [[surface]]\nname = \"impossible\"\npaths = [\"**/*.rs\"]\ngoal = \"nothing\"\n\
         budget = 1.0\nover = { warn = 20, error = 60 }\n\n\
         [escape]\ndirective = \"comment-budget: allow(<reason>)\"\n",
    )
    .expect("write config");
    let err = Config::load(&cfg).expect_err("a ratio at 1.0 is rejected");
    assert!(err.to_string().contains("must be at least 0 and below 1"), "{err}");
    let _ = fs::remove_dir_all(&dir);
}

/// Error is checked before warn, so an inverted pair leaves warn unreachable —
/// a config that looks stricter than it is.
#[test]
fn warn_above_error_is_rejected() {
    let dir = scratch_root().join("inverted");
    fs::create_dir_all(&dir).expect("mkdir");
    let cfg = dir.join("comment-budget.toml");
    fs::write(
        &cfg,
        "[kinds.rust]\ngrammar = \"rust\"\nextensions = [\"rs\"]\n\n\
         [[surface]]\nname = \"inverted\"\npaths = [\"**/*.rs\"]\ngoal = \"nothing\"\n\
         [surface.run]\nwarn = 10\nerror = 5\n\n\
         [escape]\ndirective = \"comment-budget: allow(<reason>)\"\n",
    )
    .expect("write config");
    let err = Config::load(&cfg).expect_err("warn above error is rejected");
    assert!(err.to_string().contains("warn can never fire"), "{err}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn warn_without_error_is_rejected() {
    let dir = scratch_root().join("half-pair");
    fs::create_dir_all(&dir).expect("mkdir");
    let cfg = dir.join("comment-budget.toml");
    fs::write(
        &cfg,
        "[kinds.rust]\ngrammar = \"rust\"\nextensions = [\"rs\"]\n\n\
         [[surface]]\nname = \"half\"\npaths = [\"**/*.rs\"]\ngoal = \"nothing\"\n\
         budget = 0.2\nover = { warn = 10 }\n\n\
         [escape]\ndirective = \"comment-budget: allow(<reason>)\"\n",
    )
    .expect("write config");
    let err = Config::load(&cfg).expect_err("warn without error is rejected");
    assert!(err.to_string().contains("missing field `error`"), "{err}");
    let _ = fs::remove_dir_all(&dir);
}

/// Excess is 0 for a file at its budget, so `warn = 0` would fire on every
/// file the surface claims.
#[test]
fn a_zero_warn_threshold_is_rejected() {
    let dir = scratch_root().join("zero-warn");
    fs::create_dir_all(&dir).expect("mkdir");
    let cfg = dir.join("comment-budget.toml");
    fs::write(
        &cfg,
        "[kinds.rust]\ngrammar = \"rust\"\nextensions = [\"rs\"]\n\n\
         [[surface]]\nname = \"zero\"\npaths = [\"**/*.rs\"]\ngoal = \"nothing\"\n\
         budget = 0.2\nover = { warn = 0, error = 4 }\n\n\
         [escape]\ndirective = \"comment-budget: allow(<reason>)\"\n",
    )
    .expect("write config");
    let err = Config::load(&cfg).expect_err("a zero warn threshold is rejected");
    assert!(err.to_string().contains("fires on everything"), "{err}");
    let _ = fs::remove_dir_all(&dir);
}

/// A stale key — like the removed `target` — must fail loudly, not sit in the
/// config silently enforcing nothing.
#[test]
fn an_unknown_surface_key_is_rejected() {
    let dir = scratch_root().join("stale-key");
    fs::create_dir_all(&dir).expect("mkdir");
    let cfg = dir.join("comment-budget.toml");
    fs::write(
        &cfg,
        "[kinds.rust]\ngrammar = \"rust\"\nextensions = [\"rs\"]\n\n\
         [[surface]]\nname = \"stale\"\npaths = [\"**/*.rs\"]\ngoal = \"nothing\"\ntarget = 0.15\n\
         [surface.run]\nwarn = 5\nerror = 10\n\n\
         [escape]\ndirective = \"comment-budget: allow(<reason>)\"\n",
    )
    .expect("write config");
    let err = Config::load(&cfg).expect_err("an unknown key is rejected");
    assert!(err.to_string().contains("target"), "{err}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_glob_that_claims_nothing_is_flagged() {
    let tree = Tree::new("dead-globs").file("src/lib.rs", "fn a() {}\n");
    let (cfg, root) = Config::discover(&tree.0).expect("discover config");
    let analysis = analyze(&root, &cfg, None).expect("analyze");
    let f = comment_budget::dead_glob_findings(&cfg, &analysis.dead_globs);
    assert_eq!(f.len(), 2, "the docs and infra globs claim nothing: {f:?}");
    assert!(f.iter().all(|f| f.rule == Rule::DeadGlob && f.severity == Severity::Warning));

    let full = Tree::new("live-globs")
        .file("src/lib.rs", "fn a() {}\n")
        .file("notes.md", "one\n")
        .file("infra/main.tf", "resource \"a\" \"b\" {}\n");
    let (cfg, root) = Config::discover(&full.0).expect("discover config");
    let analysis = analyze(&root, &cfg, None).expect("analyze");
    assert!(comment_budget::dead_glob_findings(&cfg, &analysis.dead_globs).is_empty());
}

/// Under first-match-wins a glob can match plenty and still claim nothing.
#[test]
fn a_fully_shadowed_glob_is_flagged() {
    let dir = scratch_root().join("shadowed");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("src")).expect("mkdir");
    fs::write(dir.join("src/lib.rs"), "fn a() {}\n").expect("write fixture");
    fs::write(
        dir.join("comment-budget.toml"),
        "[kinds.rust]\ngrammar = \"rust\"\nextensions = [\"rs\"]\n\n\
         [[surface]]\nname = \"first\"\npaths = [\"**/*.rs\"]\ngoal = \"wins\"\n\
         [surface.run]\nwarn = 5\nerror = 10\n\n\
         [[surface]]\nname = \"second\"\npaths = [\"src/**/*.rs\"]\ngoal = \"shadowed\"\n\
         [surface.run]\nwarn = 5\nerror = 10\n\n\
         [escape]\ndirective = \"comment-budget: allow(<reason>)\"\n",
    )
    .expect("write config");
    let (cfg, root) = Config::discover(&dir).expect("discover config");
    let analysis = analyze(&root, &cfg, None).expect("analyze");
    let f = comment_budget::dead_glob_findings(&cfg, &analysis.dead_globs);
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!(f[0].surface.as_deref(), Some("second"));
    assert!(f[0].message.contains("src/**/*.rs"), "{}", f[0].message);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn init_writes_a_config_the_tool_accepts() {
    let dir = scratch_root().join("init");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("src")).expect("mkdir");
    fs::write(dir.join("src/lib.rs"), "// a\nfn a() {}\nfn b() {}\n").expect("write fixture");
    fs::write(dir.join("README.md"), "hello\n").expect("write fixture");
    let msg = comment_budget::init::init(&dir).expect("init succeeds");
    assert!(msg.contains("2 kind(s)"), "{msg}");

    let (cfg, root) = Config::discover(&dir).expect("the generated config parses and validates");
    let analysis = analyze(&root, &cfg, None).expect("analyze");
    assert!(analysis.unclaimed.is_empty(), "every readable file is claimed");
    assert!(analysis.dead_globs.is_empty(), "every generated glob claims something");
    let text = fs::read_to_string(dir.join("comment-budget.toml")).expect("read config");
    assert!(text.contains("budget = "), "{text}");

    let err = comment_budget::init::init(&dir).expect_err("refuses to overwrite");
    assert!(err.to_string().contains("already exists"), "{err}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn discovery_walks_upward() {
    let tree = Tree::new("discover").file("src/deep/nested/lib.rs", "fn a() {}\n");
    let (_, root) = Config::discover(&tree.0.join("src/deep/nested")).expect("found upward");
    assert_eq!(root.canonicalize().ok(), tree.0.canonicalize().ok());
}

#[test]
fn the_report_states_every_threshold_it_enforces() {
    let tree = Tree::new("rules");
    let (cfg, _) = Config::discover(&tree.0).expect("discover config");
    let out = comment_budget::report::rules(&cfg, None, &comment_budget::report::Paint::PLAIN);
    // A threshold the report omits is one nobody knows is running.
    for band in [
        "warn 2+ lines over 20%",
        "error 4+ lines over 20%",
        "warn 3+ lines unbroken",
        "error 5+ lines unbroken",
        "warn 3+ lines",
        "error 6+ lines",
        "comment-budget: allow(<reason>)",
    ] {
        assert!(out.contains(band), "`{band}` missing from:\n{out}");
    }
}

#[test]
fn one_surface_reports_only_its_own_rules() {
    let tree = Tree::new("rules-filtered");
    let (cfg, _) = Config::discover(&tree.0).expect("discover config");
    let out =
        comment_budget::report::rules(&cfg, Some("docs"), &comment_budget::report::Paint::PLAIN);
    assert!(out.contains("error 6+ lines"), "{out}");
    assert!(!out.contains("unbroken"), "the code surface's run rule is not in scope:\n{out}");
}
