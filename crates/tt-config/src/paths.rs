use super::*;

pub(crate) fn home_dir() -> Result<PathBuf> {
    dirs::home_dir().ok_or(Error::NoHomeDir)
}

/// `~/.claude`, resolved against `.` when there is no home dir.
pub fn claude_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".claude")
}

/// `~/.claude.json`, the CLI's global config: a sibling of [`claude_dir`], not inside it.
pub fn claude_json_path() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".claude.json")
}

/// Expands a leading `~` or `~/` to the home dir; `~user` passes through.
pub fn expand_tilde(raw: &str) -> PathBuf {
    expand_tilde_with(raw, dirs::home_dir().as_deref())
}

pub(crate) fn expand_tilde_with(raw: &str, home: Option<&Path>) -> PathBuf {
    let raw = raw.trim();
    match (raw.strip_prefix('~'), home) {
        (Some(""), Some(home)) => home.to_path_buf(),
        (Some(rest), Some(home)) if rest.starts_with('/') => {
            home.join(rest.trim_start_matches('/'))
        }
        _ => PathBuf::from(raw),
    }
}

pub(crate) fn home_dir_string() -> String {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).to_string_lossy().to_string()
}

pub(crate) fn default_template_dir() -> String {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join(TOOL_NAME)
        .join("templates")
        .to_string_lossy()
        .to_string()
}

/// Non-empty forces that scope name, empty forces *unscoped*, unset detects.
pub const STATE_SCOPE_ENV: &str = "TT_STATE_SCOPE";

/// Shared stores ignore an *auto-detected* scope; a *forced* one isolates everything.
pub(crate) enum Scope {
    None,
    Auto(String),
    Forced(String),
}

/// The dir under a state root that holds one subdir per checkout scope.
pub const SCOPE_DIR: &str = "tasks";

/// The single place either unscoped base is derived.
pub(crate) fn state_base_dirs() -> (Result<PathBuf>, Result<PathBuf>) {
    (
        dirs::data_dir().ok_or(Error::NoDataDir).map(|d| d.join(TOOL_NAME)),
        home_dir().map(|h| h.join(".config").join(TOOL_NAME)),
    )
}

pub(crate) fn detect_scope() -> Scope {
    match std::env::var(STATE_SCOPE_ENV) {
        Ok(v) if !v.trim().is_empty() => Scope::Forced(sanitize_scope(&v)),
        Ok(_) => Scope::None,
        Err(_) => match std::env::current_dir().ok().as_deref().and_then(task_scope_from_dir) {
            Some(s) => Scope::Auto(s),
            None => Scope::None,
        },
    }
}

/// [`STATE_SCOPE_ENV`] wins; otherwise walk up to a checkout of *this* repo.
pub fn state_scope() -> Option<String> {
    match detect_scope() {
        Scope::None => None,
        Scope::Auto(s) | Scope::Forced(s) => Some(s),
    }
}

/// **The one definition of "a checkout of this repo"**: nearest ancestor with a
/// `crates/tt-config` dir. A packaged app gets `None` and falls back to settings.
pub fn checkout_root_from_dir(dir: &Path) -> Option<PathBuf> {
    dir.ancestors().find(|a| a.join("crates").join("tt-config").is_dir()).map(Path::to_path_buf)
}

/// The main checkout owning a `<repo>/.claude/worktrees/<name>` task.
pub(crate) fn main_checkout_of(root: &Path) -> Option<&Path> {
    root.parent()
        .filter(|p| p.file_name().is_some_and(|n| n == "worktrees"))
        .and_then(Path::parent)
        .filter(|p| p.file_name().is_some_and(|n| n == ".claude"))
        .and_then(Path::parent)
}

/// Scopes qualify as `<repo>-<name>`: a task's bare dir name isn't unique across repos.
pub fn task_scope_from_dir(dir: &Path) -> Option<String> {
    let root = checkout_root_from_dir(dir)?;
    let name = root.file_name().and_then(|n| n.to_str())?;
    // `<repo>/.claude/worktrees/<name>` → qualify with the repo dir name.
    let main = main_checkout_of(&root).and_then(Path::file_name).and_then(|n| n.to_str());
    Some(sanitize_scope(&match main {
        Some(repo) => format!("{repo}-{name}"),
        None => name.to_string(),
    }))
}

/// Like [`detect_scope`], but the ambient cwd never scopes.
pub(crate) fn detect_forced_scope() -> Scope {
    match std::env::var(STATE_SCOPE_ENV) {
        Ok(v) if !v.trim().is_empty() => Scope::Forced(sanitize_scope(&v)),
        _ => Scope::None,
    }
}

/// One safe path segment. Only guards a hand-set `TT_STATE_SCOPE`.
pub(crate) fn sanitize_scope(raw: &str) -> String {
    raw.trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' })
        .collect()
}

/// Instance state nests under any scope; shared stores only under a forced one.
pub(crate) fn nest(base: PathBuf, scope: &Scope, instance: bool) -> PathBuf {
    match scope {
        Scope::None => base,
        Scope::Auto(s) if instance => base.join(SCOPE_DIR).join(s),
        Scope::Auto(_) => base,
        Scope::Forced(s) => base.join(SCOPE_DIR).join(s),
    }
}

/// *Instance* state (sessions, windows, tt.db): any scope applies.
pub(crate) fn instance_under(base: PathBuf) -> PathBuf {
    nest(base, &detect_scope(), true)
}

/// *Shared* stores (one copy per machine): only a forced scope applies.
pub(crate) fn shared_under(base: PathBuf) -> PathBuf {
    nest(base, &detect_scope(), false)
}

pub(crate) fn config_dir() -> Result<PathBuf> {
    Ok(shared_under(home_dir()?.join(".config").join(TOOL_NAME)))
}

pub fn config_path() -> Result<PathBuf> {
    Ok(config_dir()?.join(format!("{TOOL_NAME}.settings.json")))
}

/// Instance-scoped, so a branch's schema experiments never touch the daily driver.
pub(crate) fn data_dir() -> Result<PathBuf> {
    Ok(instance_under(dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME)))
}

pub fn store_db_path() -> Result<PathBuf> {
    Ok(data_dir()?.join("tt.db"))
}

/// The tt.db owned by a *named* scope, for removing a task's row from inside a worktree.
pub fn store_db_path_for_scope(scope: Option<&str>) -> Result<PathBuf> {
    let base = dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME);
    let base = match detect_scope() {
        Scope::Forced(forced) => base.join(SCOPE_DIR).join(forced),
        _ => match scope {
            Some(scope) => base.join(SCOPE_DIR).join(scope),
            None => base,
        },
    };
    Ok(base.join("tt.db"))
}

/// Machine-global, so writer and every watcher resolve one dir.
pub fn nudge_dir_path() -> Result<PathBuf> {
    let base = dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME);
    Ok(nest(base, &detect_forced_scope(), true).join("nudge"))
}

/// Clipboard history: one per machine, since the clipboard is.
pub fn clipboard_dir() -> Result<PathBuf> {
    let base = dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME);
    Ok(shared_under(base).join("clipboard"))
}

/// Where a saved screenshot goes: the desktop's Pictures folder, like other tools.
pub fn screenshots_dir() -> Result<PathBuf> {
    let pictures =
        dirs::picture_dir().map_or_else(|| home_dir().map(|h| h.join("Pictures")), Ok)?;
    Ok(pictures.join("Screenshots"))
}

/// Instance-scoped, so the path alone says which task spawned the commands.
pub fn telemetry_dir() -> Result<PathBuf> {
    Ok(data_dir()?.join("telemetry"))
}

/// Pasted images, as temp files outside the repo for a prompt to reference.
pub fn pasted_images_dir() -> PathBuf {
    std::env::temp_dir().join(TOOL_NAME).join("pasted-images")
}

/// PID locks: temp and unscoped; per-checkout holders vary the lock *name*.
pub fn locks_dir() -> PathBuf {
    std::env::temp_dir().join(TOOL_NAME).join("locks")
}

pub fn agentboard_dir() -> Result<PathBuf> {
    Ok(instance_under(home_dir()?.join(".config").join(TOOL_NAME)).join("agentboard"))
}

/// repos.json — which repos exist is the same fact from every checkout.
pub fn agentboard_shared_dir() -> Result<PathBuf> {
    Ok(config_dir()?.join("agentboard"))
}

/// Collector results, shared like `repos.json`; one file per collector per repo.
pub fn gh_cache_dir() -> Result<PathBuf> {
    Ok(config_dir()?.join("gh-cache"))
}

/// The browser pane's Chrome profile: *shared*, and serialized by tt-app's `InstanceLock`.
pub fn browser_profile_dir() -> Result<PathBuf> {
    Ok(shared_under(dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME))
        .join("chrome-profile"))
}

/// Watched-DM handled ledger. *Shared*, so a dismissal survives a scope change.
pub fn dm_dismissals_path() -> Result<PathBuf> {
    Ok(shared_under(dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME))
        .join("dm-dismissals.json"))
}

/// What the last self-update replaced, for rolling back. *Shared*.
pub fn update_history_path() -> Result<PathBuf> {
    Ok(shared_under(dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME))
        .join("update-history.json"))
}

/// *Instance-scoped*, like the rest of a checkout's state.
pub fn code_server_user_data_dir() -> Result<PathBuf> {
    Ok(data_dir()?.join("code-server"))
}

/// code-server's window-registry socket: temp like [`locks_dir`], pid-named — the
/// instance dir overflows `sun_path`, and the registry dies with its server.
pub fn code_server_session_socket() -> PathBuf {
    std::env::temp_dir().join(TOOL_NAME).join(format!("code-server-{}.sock", std::process::id()))
}

/// Each workbench's bridge socket, temp and pid-named like [`code_server_session_socket`].
pub fn code_server_bridge_dir() -> PathBuf {
    std::env::temp_dir().join(TOOL_NAME).join(format!("bridge-{}", std::process::id()))
}

/// Where the app unpacks its own code-server. *Shared*: 740 MB is not a per-checkout cost.
pub fn code_server_install_dir() -> Result<PathBuf> {
    Ok(shared_under(dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME))
        .join("code-server-dist"))
}

/// *Shared*, like the Chrome profile: an installed extension is a machine fact.
pub fn code_server_extensions_dir() -> Result<PathBuf> {
    Ok(shared_under(dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME))
        .join("code-server-extensions"))
}

/// The hand-edited half of VS Code's `User/`. *Shared*, unlike the state DB beside it.
pub fn code_server_shared_user_dir() -> Result<PathBuf> {
    Ok(shared_under(dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME))
        .join("code-server-user"))
}

/// Claimed-port ledgers. *Shared*, and durable across reboots, unlike [`locks_dir`].
pub fn task_ports_dir() -> Result<PathBuf> {
    Ok(config_dir()?.join("task-ports"))
}

/// Each task's last setup output, *shared* by the CLI and every app instance.
pub fn task_setup_logs_dir() -> Result<PathBuf> {
    let base = dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME);
    Ok(shared_under(base).join("task-setup-logs"))
}

/// Reaches scopes *other than* the running process's, which
/// [`data_dir`]/[`agentboard_dir`] can't. Ignores an auto-detected scope; a
/// *forced* [`STATE_SCOPE_ENV`] still nests both so tests stay off the real tree.
pub struct InstanceStateBases {
    pub data: PathBuf,
    pub config: PathBuf,
}

impl InstanceStateBases {
    pub fn scope_parents(&self) -> [PathBuf; 2] {
        [self.data.join(SCOPE_DIR), self.config.join(SCOPE_DIR)]
    }

    pub fn agentboard_dir(&self, scope: Option<&str>) -> PathBuf {
        match scope {
            None => self.config.join("agentboard"),
            Some(s) => self.config.join(SCOPE_DIR).join(s).join("agentboard"),
        }
    }
}

pub fn instance_state_bases() -> Result<InstanceStateBases> {
    let (data, config) = state_base_dirs();
    let (data, config) = (data?, config?);
    match detect_scope() {
        Scope::Forced(s) => Ok(InstanceStateBases {
            data: data.join(SCOPE_DIR).join(&s),
            config: config.join(SCOPE_DIR).join(&s),
        }),
        Scope::None | Scope::Auto(_) => Ok(InstanceStateBases { data, config }),
    }
}

pub fn agentboard_dir_lossy() -> PathBuf {
    agentboard_dir().unwrap_or_else(|_| PathBuf::from(".").join("agentboard"))
}

pub fn agentboard_shared_dir_lossy() -> PathBuf {
    agentboard_shared_dir().unwrap_or_else(|_| PathBuf::from(".").join("agentboard"))
}

/// The dirs owned by `scope`, so `tt task rm` can delete a removed task's
/// state. Targets *another* checkout's scope, so the ambient one is ignored —
/// running inside a task must not nest the target under the runner's scope.
pub fn instance_state_dirs_for_scope(scope: &str) -> Vec<PathBuf> {
    let scope = sanitize_scope(scope);
    if scope.is_empty() {
        return Vec::new();
    }
    let (data, config) = state_base_dirs();
    [config, data]
        .into_iter()
        .flatten()
        .map(|base| shared_under(base).join(SCOPE_DIR).join(&scope))
        .collect()
}
