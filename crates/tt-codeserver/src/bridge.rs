//! The app's own extension inside the workbench, and the socket that reaches it.
//!
//! code-server's CLI can open files and file-vs-file diffs and nothing else —
//! its request types are open/openExternal/status/extensionManagement/clipboard,
//! with no way to run a command. So VS Code's *git* diff, the one with `git:`
//! URIs, staging gutters and decorations, can only be asked for from inside the
//! workbench. This is that inside: a small user extension, and an HTTP/1.0
//! request to the unix socket it listens on.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{CodeServerError, RETRY_PAUSE, unix_http};

/// A click on the Agentboard's diff chip opens the pane in the same gesture, so
/// this covers the server starting, the workbench booting, and git's first scan.
const SHOW_DEADLINE: Duration = Duration::from_secs(45);

/// Bumping this rewrites the profile entry beside the old copy. The built-in
/// copy carries no version and is overwritten in place.
const VERSION: &str = "0.1.0";
const ID: &str = "towles-tool.tt-bridge";

const PACKAGE_JSON: &str = include_str!("bridge/package.json");
const EXTENSION_JS: &str = include_str!("bridge/extension.js");

/// Write the extension where the next workbench to boot will scan it, on every
/// launch. `builtin_dir` — the dist's own `extensions/`, only for the install
/// this app manages — is scanned by *listing*, which keeps us out of the shared
/// `extensions.json`. Without one, the user dir is the only door, race and all.
pub fn install(extensions_dir: &Path, builtin_dir: Option<&Path>) -> Result<(), CodeServerError> {
    if let Some(builtin) = builtin_dir {
        write_files(&builtin.join(ID))?;
        // A user extension overrides the built-in copy of the same id, so a
        // current-version one left in the user dir has to carry current bytes.
        let user_copy = extensions_dir.join(format!("{ID}-{VERSION}"));
        if user_copy.is_dir() {
            write_files(&user_copy)?;
        }
        return sweep_stale(extensions_dir);
    }
    let relative = format!("{ID}-{VERSION}");
    write_files(&extensions_dir.join(&relative))?;
    register(extensions_dir, &relative)
}

fn write_files(dir: &Path) -> Result<(), CodeServerError> {
    std::fs::create_dir_all(dir)?;
    write_if_changed(&dir.join("package.json"), PACKAGE_JSON)?;
    write_if_changed(&dir.join("extension.js"), EXTENSION_JS)?;
    Ok(())
}

/// A rewrite is a truncate another instance's booting workbench can read
/// mid-scan, and every launch calls this.
fn write_if_changed(path: &Path, contents: &str) -> Result<(), CodeServerError> {
    if std::fs::read_to_string(path).is_ok_and(|existing| existing == contents) {
        return Ok(());
    }
    std::fs::write(path, contents)?;
    Ok(())
}

/// Drop the *other* versions the user dir carries, and leave the current one:
/// it is the same bytes, a user extension overrides the built-in copy of the
/// same id anyway, and deleting it every launch would fight the instance on
/// Homebrew's binary that has no built-in dir to install into.
fn sweep_stale(extensions_dir: &Path) -> Result<(), CodeServerError> {
    let current = format!("{ID}-{VERSION}");
    let prefix = format!("{ID}-");
    for entry in std::fs::read_dir(extensions_dir).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(&prefix) && name != current {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    let manifest = extensions_dir.join("extensions.json");
    let Ok(raw) = std::fs::read_to_string(&manifest) else {
        return Ok(());
    };
    let Ok(mut entries) = serde_json::from_str::<Vec<Value>>(&raw) else {
        return Ok(());
    };
    let before = entries.len();
    entries.retain(|e| {
        e.pointer("/identifier/id").and_then(Value::as_str) != Some(ID)
            || e.get("relativeLocation").and_then(Value::as_str) == Some(current.as_str())
    });
    if entries.len() != before {
        std::fs::write(manifest, Value::Array(entries).to_string())?;
    }
    Ok(())
}

/// VS Code scans the *profile manifest*, never the directory listing, so an
/// unregistered folder is invisible. Every checkout shares the file, so it is
/// rewritten only when our entry differs from what we would write.
fn register(extensions_dir: &Path, relative_location: &str) -> Result<(), CodeServerError> {
    // `location` is required even beside `relativeLocation`, and validated field
    // by field — an entry missing it fails the whole file, which VS Code answers
    // by discarding every extension in the profile, not just ours.
    let entry = json!({
        "identifier": { "id": ID },
        "version": VERSION,
        "location": {
            "$mid": 1,
            "path": extensions_dir.join(relative_location).to_string_lossy(),
            "scheme": "file",
        },
        "relativeLocation": relative_location,
    });
    let manifest = extensions_dir.join("extensions.json");
    let raw = std::fs::read_to_string(&manifest).unwrap_or_else(|_| "[]".to_string());
    let mut entries: Vec<Value> = serde_json::from_str(&raw).unwrap_or_default();
    if entries.contains(&entry) {
        return Ok(());
    }
    entries.retain(|e| e.pointer("/identifier/id").and_then(Value::as_str) != Some(ID));
    entries.push(entry);
    std::fs::write(manifest, Value::Array(entries).to_string())?;
    Ok(())
}

/// Where the extension in `folder`'s workbench listens. Hashed because the
/// checkout path itself would blow past `sun_path`'s 108 bytes.
pub fn socket(bridge_dir: &Path, folder: &Path) -> PathBuf {
    let digest = Sha256::digest(folder.to_string_lossy().as_bytes());
    let key: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    bridge_dir.join(format!("w-{key}.sock"))
}

/// Ask `folder`'s workbench to put everything uncommitted on screen, as VS
/// Code's Source Control would open it. Polls, like [`crate::reveal`]: a pane
/// opened a moment ago is still booting.
pub fn show(bridge_dir: &Path, folder: &Path) -> Result<(), CodeServerError> {
    let body = json!({ "type": "changes" }).to_string();
    let request = format!(
        "POST / HTTP/1.0\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let socket = socket(bridge_dir, folder);
    let deadline = Instant::now() + SHOW_DEADLINE;
    loop {
        // A connect error is a window that has not opened its socket yet; 503 is
        // that window answering that git has not scanned the folder yet. Both
        // mean ask again, so the deadline covers the whole exchange rather than
        // only the socket appearing.
        let pending = match unix_http(&socket, &request) {
            Ok(reply) if reply.status == 200 => return Ok(()),
            Ok(reply) if reply.status == 503 => {
                CodeServerError::Reveal(reply.body.trim().to_string())
            }
            Ok(reply) => {
                return Err(CodeServerError::Reveal(format!(
                    "{} {}",
                    reply.status,
                    reply.body.trim()
                )));
            }
            Err(_) => CodeServerError::NoWorkbench,
        };
        if Instant::now() >= deadline {
            return Err(pending);
        }
        std::thread::sleep(RETRY_PAUSE);
    }
}

#[cfg(test)]
mod tests {
    use std::time::SystemTime;

    use super::*;

    #[test]
    fn a_socket_name_is_short_and_folder_specific() {
        let dir = Path::new("/tmp/tt");
        let a = socket(dir, Path::new("/home/me/code/very/deeply/nested/checkout-a"));
        let b = socket(dir, Path::new("/home/me/code/very/deeply/nested/checkout-b"));
        assert_ne!(a, b);
        assert!(a.to_string_lossy().len() < 108);
    }

    #[test]
    fn registering_replaces_our_stale_entry_and_keeps_everyone_elses() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = dir.path().join("extensions.json");
        std::fs::write(
            &manifest,
            r#"[{"identifier":{"id":"ms.other"},"version":"1.0.0","relativeLocation":"ms.other-1.0.0"},
                {"identifier":{"id":"towles-tool.tt-bridge"},"version":"0.0.1","relativeLocation":"old"}]"#,
        )
        .unwrap();

        register(dir.path(), "towles-tool.tt-bridge-0.1.0").unwrap();

        let entries: Vec<Value> =
            serde_json::from_str(&std::fs::read_to_string(&manifest).unwrap()).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["identifier"]["id"], "ms.other");
        assert_eq!(entries[1]["relativeLocation"], "towles-tool.tt-bridge-0.1.0");
        assert_eq!(entries[1]["version"], VERSION);
    }

    /// The `location` field is what VS Code validates hardest, and a manifest it
    /// rejects loses every extension in the profile, not only this one.
    #[test]
    fn our_entry_carries_an_absolute_location_beside_the_relative_one() {
        let dir = tempfile::tempdir().unwrap();
        register(dir.path(), "towles-tool.tt-bridge-0.1.0").unwrap();
        let entries: Vec<Value> = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("extensions.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(entries[0]["location"]["scheme"], "file");
        assert_eq!(
            entries[0]["location"]["path"],
            dir.path().join("towles-tool.tt-bridge-0.1.0").to_string_lossy().as_ref()
        );
    }

    #[test]
    fn registering_an_installed_version_rewrites_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = dir.path().join("extensions.json");
        register(dir.path(), "towles-tool.tt-bridge-0.1.0").unwrap();
        let first = std::fs::read_to_string(&manifest).unwrap();
        std::fs::write(&manifest, format!("{first}\n")).unwrap();

        register(dir.path(), "towles-tool.tt-bridge-0.1.0").unwrap();
        assert_eq!(std::fs::read_to_string(&manifest).unwrap(), format!("{first}\n"));
    }

    /// A workbench booting in another instance is scanning this directory.
    #[test]
    fn a_second_install_does_not_rewrite_files_it_already_wrote() {
        let dir = tempfile::tempdir().unwrap();
        install(dir.path(), None).unwrap();
        let ext = dir.path().join(format!("{ID}-{VERSION}")).join("extension.js");
        let stamp = SystemTime::now() - Duration::from_secs(600);
        std::fs::File::options().write(true).open(&ext).unwrap().set_modified(stamp).unwrap();

        install(dir.path(), None).unwrap();

        assert_eq!(std::fs::metadata(&ext).unwrap().modified().unwrap(), stamp);
    }

    #[test]
    fn install_without_a_builtin_dir_lands_both_files_and_a_manifest_entry() {
        let dir = tempfile::tempdir().unwrap();
        install(dir.path(), None).unwrap();
        let ext = dir.path().join(format!("{ID}-{VERSION}"));
        assert!(ext.join("extension.js").is_file());
        assert!(ext.join("package.json").is_file());
        let raw = std::fs::read_to_string(dir.path().join("extensions.json")).unwrap();
        assert!(raw.contains(ID));
    }

    #[test]
    fn a_builtin_install_writes_the_dist_and_never_the_shared_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let builtin = dir.path().join("dist-extensions");
        std::fs::create_dir_all(&builtin).unwrap();

        install(dir.path(), Some(&builtin)).unwrap();

        assert!(builtin.join(ID).join("extension.js").is_file());
        assert!(builtin.join(ID).join("package.json").is_file());
        assert!(!dir.path().join("extensions.json").exists());
    }

    /// The upgrade path: a machine that ran an older build has that version in
    /// the shared manifest, and it would override our built-in copy.
    #[test]
    fn a_builtin_install_evicts_a_stale_user_dir_copy_and_keeps_everyone_elses() {
        let dir = tempfile::tempdir().unwrap();
        let builtin = dir.path().join("dist-extensions");
        std::fs::create_dir_all(&builtin).unwrap();
        let stale = format!("{ID}-0.0.1");
        std::fs::create_dir_all(dir.path().join(&stale)).unwrap();
        std::fs::write(
            dir.path().join("extensions.json"),
            json!([
                { "identifier": { "id": "ms.other" }, "version": "1.0.0" },
                { "identifier": { "id": ID }, "version": "0.0.1", "relativeLocation": stale },
            ])
            .to_string(),
        )
        .unwrap();

        install(dir.path(), Some(&builtin)).unwrap();

        let entries: Vec<Value> = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("extensions.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["identifier"]["id"], "ms.other");
        assert!(!dir.path().join(&stale).exists());
    }

    /// The other instance on this machine resolved Homebrew's binary, so the
    /// user dir is the only place it can install — deleting its copy on every
    /// launch is a fight neither side wins. It wins the id, so it is refreshed
    /// rather than left to shadow the built-in copy with older bytes.
    #[test]
    fn a_builtin_install_refreshes_a_current_user_dir_copy_and_keeps_its_entry() {
        let dir = tempfile::tempdir().unwrap();
        let builtin = dir.path().join("dist-extensions");
        std::fs::create_dir_all(&builtin).unwrap();
        install(dir.path(), None).unwrap();
        let user_copy = dir.path().join(format!("{ID}-{VERSION}"));
        std::fs::write(user_copy.join("extension.js"), "// from an older build").unwrap();
        let manifest = std::fs::read_to_string(dir.path().join("extensions.json")).unwrap();

        install(dir.path(), Some(&builtin)).unwrap();

        assert_eq!(std::fs::read_to_string(user_copy.join("extension.js")).unwrap(), EXTENSION_JS);
        assert_eq!(std::fs::read_to_string(dir.path().join("extensions.json")).unwrap(), manifest);
    }
}
