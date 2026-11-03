//! Claude Desktop `.claude/launch.json` dev-server configs.
//!
//! Its "Set up dev server" flow saves what it detects to `<dir>/.claude/
//! launch.json`. We read that same file so a config that works there works here:
//! the app lists a folder's configs and launches one by typing `runtimeExecutable
//! runtimeArgs…` into a PTY; the app's port probe keeps a second launch from
//! being offered while something holds the port.
//!
//! The file is owned by Claude Desktop — we read it, never write it — so parsing
//! is tolerant: every field defaults, unknown fields are ignored, and an
//! unlaunchable config is filtered by callers via [`LaunchConfig::launchable`].
//! It may carry comments and trailing commas, so parsing goes via `jsonc-parser`.

use std::path::{Path, PathBuf};

pub fn launch_file_path(dir: &Path) -> PathBuf {
    dir.join(".claude").join("launch.json")
}

pub fn has_launch_file(dir: &Path) -> bool {
    launch_file_path(dir).is_file()
}

/// One dev server / app in `launch.json`'s `configurations[]`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfig {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub runtime_executable: String,
    #[serde(default)]
    pub runtime_args: Vec<String>,
    #[serde(default)]
    pub port: Option<u16>,
}

impl LaunchConfig {
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
    jsonc_parser::parse_to_serde_value::<Option<LaunchFile>>(text, &JSONC_OPTIONS)
        .map(Option::unwrap_or_default)
        .map_err(|e| crate::Error::Json(serde::de::Error::custom(e)))
}

/// Exactly the dialect an editor writes: JSON plus comments and trailing
/// commas. `jsonc-parser`'s own defaults are far looser, and accepting those
/// would quietly launch from a file Claude Desktop itself calls malformed —
/// the opposite of the compatibility this module exists for.
const JSONC_OPTIONS: jsonc_parser::ParseOptions = jsonc_parser::ParseOptions {
    allow_comments: true,
    allow_trailing_commas: true,
    allow_loose_object_property_names: false,
    allow_missing_commas: false,
    allow_single_quoted_strings: false,
    allow_hexadecimal_numbers: false,
    allow_unary_plus_numbers: false,
};

#[cfg(test)]
mod tests {
    use super::*;

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
}
