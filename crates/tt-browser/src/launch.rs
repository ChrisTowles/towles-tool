//! Find a Chrome binary and run one as a supervised child.
//!
//! One process per profile dir — Chrome's own singleton lock makes a second
//! launch against the same dir delegate to the first and drop the debugging
//! flags, so the caller must serialize access (tt-app holds a lockfile).
//! `--remote-debugging-port=0` plus polling `DevToolsActivePort` avoids ever
//! claiming a port ourselves; the file's second line is the browser WS path.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::BrowserError;

const STARTUP_DEADLINE: Duration = Duration::from_secs(15);
const STDERR_TAIL_LINES: usize = 30;

/// Binary override for tests and settings; checked before PATH and bundles.
pub const BIN_ENV: &str = "TT_BROWSER_BIN";

pub fn find_chrome(override_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = override_path.filter(|p| p.is_file()) {
        return Some(p.to_path_buf());
    }
    if let Some(p) = std::env::var_os(BIN_ENV).map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    #[cfg(target_os = "macos")]
    {
        let bundles = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ];
        if let Some(p) = bundles.iter().map(PathBuf::from).find(|p| p.is_file()) {
            return Some(p);
        }
    }
    let names = [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
    ];
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct ChromeConfig {
    pub binary: PathBuf,
    pub user_data_dir: PathBuf,
    pub headless: bool,
    pub start_url: Option<String>,
}

/// CDP stays on in headful mode too — the pop-out window keeps a debugging
/// endpoint (our profile isn't Chrome's default dir, so the 136+ block never
/// applies), which is what makes reattach able to read the URL back.
pub fn build_args(cfg: &ChromeConfig) -> Vec<String> {
    let mut args = vec![
        format!("--user-data-dir={}", cfg.user_data_dir.display()),
        "--remote-debugging-port=0".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--hide-crash-restore-bubble".into(),
        "--disable-session-crashed-bubble".into(),
    ];
    if cfg.headless {
        args.push("--headless".into());
        args.push("--disable-renderer-backgrounding".into());
        args.push("--disable-background-timer-throttling".into());
    }
    args.push(cfg.start_url.clone().unwrap_or_else(|| "about:blank".into()));
    args
}

pub struct ChromeChild {
    child: Child,
    pub port: u16,
    pub ws_url: String,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

impl ChromeChild {
    /// Launch headless Chrome and wait for its DevTools endpoint. The stale
    /// `DevToolsActivePort` from a previous run is removed first — polling
    /// would otherwise read last session's dead port.
    pub fn launch(cfg: &ChromeConfig) -> Result<Self, BrowserError> {
        let port_file = cfg.user_data_dir.join("DevToolsActivePort");
        let _ = std::fs::remove_file(&port_file);
        std::fs::create_dir_all(&cfg.user_data_dir)?;

        let args = build_args(cfg);
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let bin = cfg.binary.to_string_lossy();
        tt_exec::record_detached_spawn(&bin, &arg_refs, "browser");

        let mut cmd = Command::new(&cfg.binary);
        cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
        for (key, _) in std::env::vars_os() {
            let name = key.to_string_lossy().into_owned();
            if tt_exec::is_app_instance_env(&name)
                || tt_exec::CLAUDE_SESSION_ENV_VARS.contains(&name.as_str())
            {
                cmd.env_remove(&key);
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let mut child = cmd.spawn()?;
        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(stderr) = child.stderr.take() {
            let tail = Arc::clone(&stderr_tail);
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let mut tail = tail.lock().unwrap();
                    if tail.len() >= STDERR_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            });
        }

        let deadline = Instant::now() + STARTUP_DEADLINE;
        let (port, ws_path) = loop {
            if let Ok(contents) = std::fs::read_to_string(&port_file)
                && let Some(parsed) = parse_devtools_active_port(&contents)
            {
                break parsed;
            }
            if let Ok(Some(status)) = child.try_wait() {
                let tail = tail_string(&stderr_tail);
                return Err(BrowserError::StartupExit(format!("{status}; stderr: {tail}")));
            }
            if Instant::now() > deadline {
                kill_group(&mut child);
                return Err(BrowserError::Startup(format!(
                    "no DevToolsActivePort within {STARTUP_DEADLINE:?}; stderr: {}",
                    tail_string(&stderr_tail)
                )));
            }
            std::thread::sleep(Duration::from_millis(50));
        };

        let ws_url = format!("ws://127.0.0.1:{port}{ws_path}");
        Ok(Self { child, port, ws_url, stderr_tail })
    }

    pub fn stderr_tail(&self) -> String {
        tail_string(&self.stderr_tail)
    }

    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Wait for the process to exit on its own — used after a CDP
    /// `Browser.close`, which is the only exit that flushes the profile
    /// (cookies are committed lazily; a signal loses recent logins).
    pub fn wait_exit(&mut self, timeout: Duration) -> bool {
        use wait_timeout::ChildExt;
        matches!(self.child.wait_timeout(timeout), Ok(Some(_)))
    }

    /// TERM the whole process group (Chrome forks and re-parents), give it a
    /// moment to flush the profile — cookies land on clean exit — then KILL.
    pub fn shutdown(&mut self) {
        if !self.is_running() {
            let _ = self.child.wait();
            return;
        }
        signal_group(&self.child, libc::SIGTERM);
        use wait_timeout::ChildExt;
        if self.child.wait_timeout(Duration::from_secs(3)).ok().flatten().is_none() {
            kill_group(&mut self.child);
        }
    }
}

impl Drop for ChromeChild {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn signal_group(child: &Child, signal: i32) {
    #[cfg(unix)]
    {
        // SAFETY: killpg on the pgid created by process_group(0) at spawn;
        // affects only our own child's group.
        unsafe {
            libc::killpg(child.id() as i32, signal);
        }
    }
    #[cfg(not(unix))]
    let _ = (child, signal);
}

fn kill_group(child: &mut Child) {
    signal_group(child, libc::SIGKILL);
    let _ = child.kill();
    let _ = child.wait();
}

fn tail_string(tail: &Arc<Mutex<VecDeque<String>>>) -> String {
    tail.lock().map(|t| t.iter().cloned().collect::<Vec<_>>().join("\n")).unwrap_or_default()
}

/// First line is the port, second the browser-target WS path.
pub fn parse_devtools_active_port(contents: &str) -> Option<(u16, String)> {
    let mut lines = contents.lines();
    let port = lines.next()?.trim().parse().ok()?;
    let path = lines.next()?.trim();
    if !path.starts_with('/') {
        return None;
    }
    Some((port, path.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_devtools_active_port() {
        let parsed = parse_devtools_active_port("39217\n/devtools/browser/abc-123\n");
        assert_eq!(parsed, Some((39217, "/devtools/browser/abc-123".to_string())));
        assert_eq!(parse_devtools_active_port(""), None);
        assert_eq!(parse_devtools_active_port("not-a-port\n/x"), None);
        assert_eq!(parse_devtools_active_port("1234\nnot-a-path"), None);
    }

    #[test]
    fn args_carry_profile_and_debug_port_in_both_modes() {
        let cfg = ChromeConfig {
            binary: "/usr/bin/google-chrome".into(),
            user_data_dir: "/tmp/prof".into(),
            headless: true,
            start_url: None,
        };
        let args = build_args(&cfg);
        assert!(args.contains(&"--user-data-dir=/tmp/prof".to_string()));
        assert!(args.contains(&"--headless".to_string()));
        assert!(args.contains(&"--remote-debugging-port=0".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("about:blank"));
        let headful = build_args(&ChromeConfig {
            headless: false,
            start_url: Some("https://example.com".into()),
            ..cfg
        });
        assert!(headful.contains(&"--remote-debugging-port=0".to_string()));
        assert!(!headful.contains(&"--headless".to_string()));
        assert_eq!(headful.last().map(String::as_str), Some("https://example.com"));
    }

    #[test]
    fn bin_env_override_wins() {
        let file = tempfile::NamedTempFile::new().unwrap();
        // SAFETY: test-only env mutation; cargo runs tests in one process but
        // no other test in this crate reads TT_BROWSER_BIN concurrently.
        unsafe { std::env::set_var(BIN_ENV, file.path()) };
        assert_eq!(find_chrome(None), Some(file.path().to_path_buf()));
        // SAFETY: as above.
        unsafe { std::env::remove_var(BIN_ENV) };
    }
}
