//! Task templates: user presets ([`tt_config::TaskTemplate`]) picked when a task is
//! created — a goal to start from, an improver to run, and a command run after the
//! repo's own setup.

use std::path::Path;

use tt_config::TaskTemplate;

use crate::ops::{self, SETUP_TIMEOUT};

/// Whether `t` is offered for the repo the rail calls `name` at `dir`.
pub fn applies_to(t: &TaskTemplate, name: &str, dir: &str) -> bool {
    let repo = t.repo.trim();
    repo.is_empty() || repo == name || Path::new(repo) == Path::new(dir)
}

/// The templates offered for a repo, in settings order. A template with no id can't be
/// picked by `--template`, so it is never offered at all.
pub fn for_repo<'a>(all: &'a [TaskTemplate], name: &str, dir: &str) -> Vec<&'a TaskTemplate> {
    all.iter().filter(|t| !t.id.trim().is_empty() && applies_to(t, name, dir)).collect()
}

/// `--template <id>` for a repo; the error names what *is* offered there.
pub fn find<'a>(
    all: &'a [TaskTemplate],
    id: &str,
    name: &str,
    dir: &str,
) -> Result<&'a TaskTemplate, String> {
    let offered = for_repo(all, name, dir);
    if let Some(t) = offered.iter().find(|t| t.id == id) {
        return Ok(t);
    }
    let ids: Vec<&str> = offered.iter().map(|t| t.id.as_str()).collect();
    Err(if ids.is_empty() {
        format!("no task template {id:?} — none apply to {name}; add one in Settings → Agent Board")
    } else {
        format!("no task template {id:?} for {name} — available: {}", ids.join(", "))
    })
}

/// The goal a task starts with: the template's, then what was typed, a blank line
/// between. `None` when both are empty.
pub fn compose_goal(t: &TaskTemplate, given: Option<&str>) -> Option<String> {
    let parts: Vec<&str> = [t.goal.trim(), given.unwrap_or_default().trim()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

/// Run a template's `setup` in `dir`, whitespace-split like `TT_TASK_SETUP`. `Ok(Some)`
/// is a warning: the task is kept either way.
pub fn run_setup(dir: &Path, setup: &str) -> ops::Result<Option<String>> {
    let argv: Vec<&str> = setup.split_whitespace().collect();
    let Some((cmd, args)) = argv.split_first() else {
        return Ok(None);
    };
    let warning = match tt_exec::run_in_dir_with_timeout(cmd, args, dir, SETUP_TIMEOUT) {
        Ok(out) if out.ok() => None,
        Ok(out) => Some(format!(
            "template setup `{setup}` failed (exit {}) — task kept\n{}",
            out.exit_code,
            out.stderr.trim()
        )),
        Err(e) => Some(format!("template setup `{setup}` failed — task kept: {e}")),
    };
    Ok(warning)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tpl(id: &str, repo: &str, goal: &str) -> TaskTemplate {
        TaskTemplate {
            id: id.into(),
            label: id.into(),
            repo: repo.into(),
            goal: goal.into(),
            ..Default::default()
        }
    }

    #[test]
    fn empty_repo_applies_everywhere_named_repo_only_there() {
        let all = [
            tpl("bug", "", ""),
            tpl("ui", "towles-tool", ""),
            tpl("blog", "/home/u/blog", ""),
        ];
        let ids =
            |name, dir| for_repo(&all, name, dir).iter().map(|t| t.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids("towles-tool", "/home/u/code/towles-tool"), ["bug", "ui"]);
        assert_eq!(ids("blog", "/home/u/blog"), ["bug", "blog"]);
    }

    #[test]
    fn an_idless_template_is_never_offered() {
        let all = [tpl("", "", "x")];
        assert!(for_repo(&all, "r", "/r").is_empty());
    }

    #[test]
    fn find_names_the_alternatives() {
        let all = [tpl("bug", "", ""), tpl("ui", "other", "")];
        assert_eq!(find(&all, "bug", "r", "/r").unwrap().id, "bug");
        let err = find(&all, "ui", "r", "/r").unwrap_err();
        assert!(err.contains("available: bug"), "{err}");
        let err = find(&[], "ui", "r", "/r").unwrap_err();
        assert!(err.contains("none apply"), "{err}");
    }

    #[test]
    fn goal_is_skeleton_then_typed() {
        let t = tpl("bug", "", "Reproduce first, then fix.");
        assert_eq!(
            compose_goal(&t, Some(" login 500s ")).unwrap(),
            "Reproduce first, then fix.\n\nlogin 500s"
        );
        assert_eq!(compose_goal(&t, None).unwrap(), "Reproduce first, then fix.");
        assert_eq!(compose_goal(&tpl("x", "", " "), Some("")), None);
    }

    #[test]
    fn setup_runs_in_the_task_dir_and_warns_on_failure() {
        let dir = tempfile::TempDir::new().unwrap();
        assert_eq!(run_setup(dir.path(), "touch made").unwrap(), None);
        assert!(dir.path().join("made").is_file());
        assert!(run_setup(dir.path(), "false").unwrap().unwrap().contains("exit 1"));
        assert_eq!(run_setup(dir.path(), "   ").unwrap(), None);
    }
}
