//! One-shot repo onboarding (`tt task init`): template choice, `.gitignore`,
//! and the primary checkout's first render.

use std::fs;
use std::path::PathBuf;

use super::render::{RenderSummary, init_template_sidecar, render_task_env, template_sidecar_path};
use super::{OpsError, Result, TaskRoot};

/// What [`init_repo`] did (every step is idempotent, so re-runs report
/// mostly `false`/unchanged).
pub struct InitReport {
    /// The template tasks will render from: the repo's tokenized
    /// `.env.example`, or the `.claude/task-env.template` sidecar.
    pub template: PathBuf,
    pub sidecar_created: bool,
    /// `.env` was appended to the repo's `.gitignore`.
    pub gitignore_added: bool,
    /// The primary checkout's `.env` render (it claims ports like any task).
    pub render: RenderSummary,
}

/// Onboard a repo onto the task convention in one idempotent shot: pick (or
/// create) the env template, gitignore `.env`, and render the primary
/// checkout's `.env` so it claims its ports.
///
/// Nothing here touches `.claude/settings.json`. Tasks are created
/// deliberately — `tt task new` or the app's `+` — and never by a Claude Code
/// worktree hook; `claude --worktree` makes its own worktree, which this
/// machinery neither renders nor removes.
/// `now_ms` (epoch ms) stamps the port registry's `claimed_at_ms` for the
/// primary render — read at the CLI boundary, never here.
pub fn init_repo(sr: &TaskRoot, now_ms: i64) -> Result<InitReport> {
    // Template: the committed tokenized .env.example wins; otherwise make
    // sure the sidecar exists (empty-but-explained when freshly created).
    let repo_template = sr.checkout.join(".env.example");
    let has_tokenized_example =
        fs::read_to_string(&repo_template).is_ok_and(|text| text.contains("${tt:"));
    let (template, sidecar_created) = if has_tokenized_example {
        (repo_template, false)
    } else {
        let existed = template_sidecar_path(sr).is_file();
        (init_template_sidecar(sr)?, !existed)
    };

    // Gitignore `.env` only when the repo's ignore rules definitely do not
    // already cover it. An unreadable repository answers `false` (see
    // `Repo::is_ignored`), which appends an entry that was possibly redundant
    // — the harmless direction, unlike silently leaving `.env` committable.
    let mut gitignore_added = false;
    if crate::ops::repo_at(&sr.checkout).is_ok_and(|repo| !repo.is_ignored(".env")) {
        let gitignore = sr.checkout.join(".gitignore");
        let mut current = fs::read_to_string(&gitignore).unwrap_or_default();
        if !current.is_empty() && !current.ends_with('\n') {
            current.push('\n');
        }
        current.push_str(".env\n");
        fs::write(&gitignore, current)
            .map_err(|e| OpsError::Io(format!("cannot write {}: {e}", gitignore.display())))?;
        gitignore_added = true;
    }

    let render = render_task_env(sr, &sr.checkout, None, now_ms)?;
    Ok(InitReport { template, sidecar_created, gitignore_added, render })
}
