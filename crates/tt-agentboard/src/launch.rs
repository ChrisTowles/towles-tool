//! Claude Desktop `.claude/launch.json` dev-server configs.
//!
//! Its "Set up dev server" flow saves what it detects to `<dir>/.claude/
//! launch.json`. We read that same file so a config that works there works here:
//! the app lists a folder's configs, launches one by typing `runtimeExecutable
//! runtimeArgs…` into a PTY, and [`port_listening`] tells "already running" from
//! "stopped" so a second launch is never offered while something holds the port.
//!
//! The file is owned by Claude Desktop — we read it, never write it — so parsing
//! is tolerant: every field defaults, unknown fields are ignored, and an
//! unlaunchable config is filtered by callers via [`LaunchConfig::launchable`].
//! It may carry comments and trailing commas, so parsing goes via `jsonc-parser`.

use std::path::{Path, PathBuf};

/// `<dir>/.claude/launch.json` — where Claude Desktop saves a checkout's
/// dev-server configs.
pub fn launch_file_path(dir: &Path) -> PathBuf {
    dir.join(".claude").join("launch.json")
}

/// Whether `dir` has a `launch.json` at all — the cheap probe stamped onto
/// [`crate::types::FolderData`], so the client gates its dev-servers affordance
/// without reading the file every poll.
pub fn has_launch_file(dir: &Path) -> bool {
    launch_file_path(dir).is_file()
}

/// One dev server / app in `launch.json`'s `configurations[]`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfig {
    /// Display name, e.g. `"blog"`.
    #[serde(default)]
    pub name: String,
    /// The command itself, e.g. `"pnpm"`. Empty = not launchable.
    #[serde(default)]
    pub runtime_executable: String,
    /// Arguments for the command, e.g. `["--filter", "@x/blog", "dev"]`.
    #[serde(default)]
    pub runtime_args: Vec<String>,
    /// Port the server listens on once up. Two configs may share one, and one
    /// without a port simply can't be probed.
    #[serde(default)]
    pub port: Option<u16>,
}

impl LaunchConfig {
    /// A config the app can actually start — parsing keeps every entry.
    pub fn launchable(&self) -> bool {
        !self.runtime_executable.trim().is_empty()
    }
}

/// The whole `launch.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchFile {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub configurations: Vec<LaunchConfig>,
}

/// Read `<dir>/.claude/launch.json`. `Ok(None)` when absent (most checkouts);
/// `Err` only for a file that exists but can't be read or parsed, so the UI can
/// say "malformed" instead of silently showing nothing.
pub fn read_launch_file(dir: &Path) -> crate::Result<Option<LaunchFile>> {
    let path = launch_file_path(dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    Ok(Some(parse_launch_json(&text)?))
}

/// Parse `launch.json`'s text (JSON, or JSONC as an editor would leave it). A
/// file that parses to nothing has no configs rather than being an error;
/// failures come back as [`crate::Error::Json`], already carrying line/column.
fn parse_launch_json(text: &str) -> crate::Result<LaunchFile> {
    // `Option<_>` because whitespace/comments-only input deserializes as null.
    jsonc_parser::parse_to_serde_value::<Option<LaunchFile>>(text, &JSONC_OPTIONS)
        .map(Option::unwrap_or_default)
        .map_err(|e| crate::Error::Json(serde::de::Error::custom(e)))
}

/// Exactly the dialect an editor writes: JSON plus comments and trailing
/// commas. `jsonc-parser`'s own defaults are far looser, and accepting those
/// would quietly launch from a file Claude Desktop itself calls malformed —
/// the opposite of the compatibility this module exists for.
/// (`allow_missing_commas` governs only object keys; between *array* elements
/// the parser is lossless either way, so that one is left alone.)
const JSONC_OPTIONS: jsonc_parser::ParseOptions = jsonc_parser::ParseOptions {
    allow_comments: true,
    allow_trailing_commas: true,
    allow_loose_object_property_names: false,
    allow_missing_commas: false,
    allow_single_quoted_strings: false,
    allow_hexadecimal_numbers: false,
    allow_unary_plus_numbers: false,
};

/// Whether something is accepting TCP connections on localhost:`port` — the
/// "already running" probe. A connect, not a bind test, so only a listener
/// genuinely serving counts; both loopback stacks are tried since dev servers
/// bind either.
pub fn port_listening(port: u16) -> bool {
    use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
    let timeout = std::time::Duration::from_millis(250);
    [
        SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
    ]
    .iter()
    .any(|addr| match TcpStream::connect_timeout(addr, timeout) {
        // A connect into the ephemeral range can "succeed" with no listener:
        // TCP simultaneous open lets the socket connect to itself when the
        // kernel picks source port == dest port. Such a stream has local ==
        // peer, which a real accepted connection never does.
        Ok(stream) => match (stream.local_addr(), stream.peer_addr()) {
            (Ok(local), Ok(peer)) => local != peer,
            _ => true, // connected but unreadable addrs: trust the connect
        },
        Err(_) => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real file Claude Desktop wrote for the blog repo.
    const BLOG_FIXTURE: &str = r#"{
      "version": "0.0.1",
      "configurations": [
        {
          "name": "blog",
          "runtimeExecutable": "pnpm",
          "runtimeArgs": ["--filter", "@chris-towles/blog", "dev"],
          "port": 3000
        },
        {
          "name": "mcp",
          "runtimeExecutable": "pnpm",
          "runtimeArgs": ["mcp:dev"],
          "port": 8081
        },
        {
          "name": "all",
          "runtimeExecutable": "pnpm",
          "runtimeArgs": ["dev"],
          "port": 3000
        }
      ]
    }"#;

    fn write_launch(dir: &Path, text: &str) {
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::write(launch_file_path(dir), text).unwrap();
    }

    #[test]
    fn parses_the_claude_desktop_fixture() {
        let file = parse_launch_json(BLOG_FIXTURE).unwrap();
        assert_eq!(file.version, "0.0.1");
        assert_eq!(file.configurations.len(), 3);
        let blog = &file.configurations[0];
        assert_eq!(blog.name, "blog");
        assert_eq!(blog.runtime_executable, "pnpm");
        assert_eq!(blog.runtime_args, vec!["--filter", "@chris-towles/blog", "dev"]);
        assert_eq!(blog.port, Some(3000));
        assert!(blog.launchable());
        // Two configs sharing one port is legal (the fixture does it).
        assert_eq!(file.configurations[2].port, Some(3000));
    }

    #[test]
    fn tolerates_unknown_fields_and_missing_optionals() {
        let file = parse_launch_json(
            r#"{
              "version": "0.0.2",
              "futureTopLevel": true,
              "configurations": [
                {"name": "bare", "runtimeExecutable": "npm", "env": {"A": "1"}}
              ]
            }"#,
        )
        .unwrap();
        let cfg = &file.configurations[0];
        assert!(cfg.runtime_args.is_empty());
        assert_eq!(cfg.port, None);
        assert!(cfg.launchable());
    }

    #[test]
    fn empty_executable_is_kept_but_not_launchable() {
        let file = parse_launch_json(r#"{"configurations": [{"name": "broken"}]}"#).unwrap();
        assert_eq!(file.configurations.len(), 1);
        assert!(!file.configurations[0].launchable());
    }

    #[test]
    fn read_missing_file_is_none() {
        let root = tempfile::TempDir::new().unwrap();
        assert_eq!(read_launch_file(root.path()).unwrap(), None);
    }

    #[test]
    fn read_parses_from_disk() {
        let root = tempfile::TempDir::new().unwrap();
        write_launch(root.path(), BLOG_FIXTURE);
        let file = read_launch_file(root.path()).unwrap().unwrap();
        assert_eq!(file.configurations.len(), 3);
        assert!(has_launch_file(root.path()));
    }

    /// The dialect an editor actually leaves behind: `//` and `/* */`
    /// comments plus trailing commas, all of which `serde_json` rejects.
    #[test]
    fn parses_comments_and_trailing_commas() {
        let file = parse_launch_json(
            r#"{
              // Written by hand after Claude Desktop's version.
              "version": "0.0.1",
              "configurations": [
                {
                  "name": "blog", /* the site itself */
                  "runtimeExecutable": "pnpm",
                  "runtimeArgs": ["dev", "--host", ],
                  "port": 3000,
                },
                /* Disabled for now — the mcp server moved.
                {"name": "mcp", "runtimeExecutable": "pnpm"}
                */
              ],
            }"#,
        )
        .unwrap();
        assert_eq!(file.version, "0.0.1");
        assert_eq!(file.configurations.len(), 1);
        assert_eq!(file.configurations[0].runtime_args, vec!["dev", "--host"]);
        assert_eq!(file.configurations[0].port, Some(3000));
    }

    /// `//` and `/*` inside a string are content, not comments.
    #[test]
    fn comment_markers_inside_strings_survive() {
        let file = parse_launch_json(
            r#"{"configurations": [
                 {"name": "docs", "runtimeExecutable": "npx",
                  "runtimeArgs": ["serve", "https://example.com/x", "src/**/*.md"]}
               ]}"#,
        )
        .unwrap();
        assert_eq!(
            file.configurations[0].runtime_args,
            vec!["serve", "https://example.com/x", "src/**/*.md"]
        );
    }

    /// `jsonc-parser`'s remaining defaults would accept files Claude Desktop
    /// itself rejects, so a config that runs here would not run there.
    #[test]
    fn other_loose_json_dialects_are_still_errors() {
        for text in [
            r#"{"version": '0.0.1'}"#,              // single-quoted string
            r#"{configurations: []}"#,              // unquoted key
            r#"{"configurations": [], "x": 0x10}"#, // hex number
            r#"{"configurations": [], "x": +1}"#,   // unary plus
            r#"{"a": 1} {"b": 2}"#,                 // trailing garbage
        ] {
            assert!(parse_launch_json(text).is_err(), "should not parse: {text}");
        }
    }

    #[test]
    fn a_comments_only_file_has_no_configs() {
        let file = parse_launch_json("// nothing configured yet\n").unwrap();
        assert!(file.configurations.is_empty());
    }

    #[test]
    fn read_malformed_file_is_an_error() {
        let root = tempfile::TempDir::new().unwrap();
        write_launch(root.path(), "{not json");
        assert!(read_launch_file(root.path()).is_err());
    }

    #[test]
    fn has_launch_file_false_without_one() {
        let root = tempfile::TempDir::new().unwrap();
        assert!(!has_launch_file(root.path()));
    }

    /// Start of the kernel's auto-assigned port range; below it a port is only
    /// ever bound by explicit request, never handed out by `bind(0)`.
    fn ephemeral_range_start() -> u16 {
        std::fs::read_to_string("/proc/sys/net/ipv4/ip_local_port_range")
            .ok()
            .and_then(|s| s.split_whitespace().next()?.parse().ok())
            .unwrap_or(32768)
    }

    /// Bind a listener *below* the ephemeral range, so the kernel can't hand
    /// this port to an unrelated `bind(0)` while the test is mid-flight.
    fn bind_below_ephemeral_range() -> Option<(std::net::TcpListener, u16)> {
        let start = ephemeral_range_start();
        (1024..start)
            .rev()
            .take(500)
            .find_map(|port| std::net::TcpListener::bind(("127.0.0.1", port)).ok())
            .map(|listener| {
                let port = listener.local_addr().expect("bound listener has an addr").port();
                (listener, port)
            })
    }

    #[test]
    fn port_listening_tracks_a_real_listener() {
        let Some((listener, port)) = bind_below_ephemeral_range() else {
            // No free non-ephemeral port to borrow — skip rather than race.
            return;
        };
        assert!(port_listening(port), "a bound listener must read as listening");
        drop(listener);

        // `drop` closes *our* descriptor, not necessarily the socket: a
        // subprocess forked while the listener was open inherits a duplicate
        // and holds it in LISTEN. So the honest assertion is that the port
        // frees up promptly, not that it is free the instant we let go.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while port_listening(port) {
            assert!(
                std::time::Instant::now() < deadline,
                "port {port} still listening 10s after its listener was dropped"
            );
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
}
