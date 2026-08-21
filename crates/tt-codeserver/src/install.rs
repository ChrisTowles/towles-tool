//! Provisioning the code-server the Files pane needs, when the machine has
//! none: fetch the pinned release tarball, check it against a digest pinned
//! here, and unpack it into a shared directory the launcher then finds.
//!
//! 740 MB unpacked can't ride the Tauri bundle (docs/CODE-SERVER.md), so the
//! app downloads it the way VS Code downloads its own remote server — on first
//! use, with progress. Version and digests are pinned rather than read from
//! the releases API: an install that can't be checked against a constant in
//! this file isn't one worth doing unattended.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use sha2::{Digest, Sha256};

/// The release every install pins to. Moving it means new [`ASSETS`] digests.
pub const VERSION: &str = "4.133.0";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Between two reads of the body, not for the whole transfer: a 235 MB
/// download on a slow link is normal, a stalled socket is not.
const READ_TIMEOUT: Duration = Duration::from_secs(120);
const CHUNK: usize = 1 << 20;

#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    #[error("no published code-server build for {0}/{1}")]
    UnsupportedPlatform(&'static str, &'static str),
    #[error("downloading code-server {VERSION} failed: {0}")]
    Download(String),
    #[error("the code-server download didn't match its pinned digest (got {0})")]
    Digest(String),
    #[error("unpacking code-server failed: {0}")]
    Unpack(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// A release asset: the tarball's name, its size (the denominator progress is
/// reported against) and the SHA-256 the download must hash to.
struct Asset {
    name: &'static str,
    bytes: u64,
    sha256: &'static str,
}

/// The four builds coder publishes, keyed by `(os, arch)` as Rust spells them.
/// Digests are the ones GitHub reports for the v4.133.0 assets.
const ASSETS: &[((&str, &str), Asset)] = &[
    (
        ("linux", "x86_64"),
        Asset {
            name: "code-server-4.133.0-linux-amd64.tar.gz",
            bytes: 235_581_640,
            sha256: "a4e0f8f8c76e7de8e7424289f74e507af4c97bfe104c3e8ee272b8cc7b46c6f1",
        },
    ),
    (
        ("linux", "aarch64"),
        Asset {
            name: "code-server-4.133.0-linux-arm64.tar.gz",
            bytes: 229_166_602,
            sha256: "d999d8b0256e5537f3b62e6c09f624220026e19107a04a876c0cef62d1c71147",
        },
    ),
    (
        ("macos", "x86_64"),
        Asset {
            name: "code-server-4.133.0-macos-amd64.tar.gz",
            bytes: 227_305_837,
            sha256: "a87706c2146436af6f63e8dbc0aa983b31312caea2b3ddff32e99da79f58ce7a",
        },
    ),
    (
        ("macos", "aarch64"),
        Asset {
            name: "code-server-4.133.0-macos-arm64.tar.gz",
            bytes: 207_882_232,
            sha256: "dcfa7932dbb6f47ca803ed4b7872847b9aa5394867ba9c78303fa461bda37deb",
        },
    ),
];

fn asset_for(os: &str, arch: &str) -> Option<&'static Asset> {
    ASSETS.iter().find(|((o, a), _)| *o == os && *a == arch).map(|(_, asset)| asset)
}

/// Rust names macOS `macos` in `target_os`, which is what [`ASSETS`] keys on.
fn host() -> (&'static str, &'static str) {
    (std::env::consts::OS, std::env::consts::ARCH)
}

/// Where a completed install of [`VERSION`] lives under `root`. Version-scoped,
/// so bumping the pin installs beside the old tree instead of over a running
/// server's own files.
pub fn install_dir(root: &Path) -> PathBuf {
    root.join(VERSION)
}

/// The binary of a completed install, or `None` when there is none to run.
pub fn installed_binary(root: &Path) -> Option<PathBuf> {
    let bin = install_dir(root).join("bin").join("code-server");
    bin.is_file().then_some(bin)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Downloading,
    Verifying,
    Unpacking,
}

#[derive(Debug, Clone, Copy)]
pub struct Progress {
    pub phase: Phase,
    pub done_bytes: u64,
    pub total_bytes: u64,
}

/// The pinned code-server under `root`, downloading and unpacking it if this
/// machine has none. `on_progress` is called as the transfer advances so a
/// caller can show the minutes it takes.
pub fn ensure(root: &Path, on_progress: &mut dyn FnMut(Progress)) -> Result<PathBuf, InstallError> {
    if let Some(bin) = installed_binary(root) {
        return Ok(bin);
    }
    let (os, arch) = host();
    let asset = asset_for(os, arch).ok_or(InstallError::UnsupportedPlatform(os, arch))?;
    std::fs::create_dir_all(root)?;

    let tarball = root.join(format!(".download-{}-{}", std::process::id(), asset.name));
    let scratch = Scratch(vec![tarball.clone()]);
    tracing::info!(version = VERSION, asset = asset.name, "code-server.install.start");
    let digest = download(asset, &tarball, on_progress)?;
    if digest != asset.sha256 {
        return Err(InstallError::Digest(digest));
    }

    on_progress(Progress { phase: Phase::Unpacking, done_bytes: 0, total_bytes: asset.bytes });
    let stage = root.join(format!(".stage-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(&stage)?;
    let scratch = scratch.and(stage.clone());
    untar(&tarball, &stage)?;

    // Losing the rename means another instance installed the same version
    // while this one downloaded: its tree is as good as ours, so take it.
    if std::fs::rename(&stage, install_dir(root)).is_err() && installed_binary(root).is_none() {
        return Err(InstallError::Unpack(format!(
            "nothing usable landed in {}",
            install_dir(root).display()
        )));
    }
    drop(scratch);
    installed_binary(root).ok_or_else(|| {
        InstallError::Unpack(format!("no bin/code-server in {}", install_dir(root).display()))
    })
}

/// Streams `asset` into `dest`, hashing as it goes — the tarball is too big to
/// hash from memory afterwards. Returns the hex digest.
fn download(
    asset: &Asset,
    dest: &Path,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<String, InstallError> {
    let url =
        format!("https://github.com/coder/code-server/releases/download/v{VERSION}/{}", asset.name);
    let response =
        agent()?.get(&url).call().map_err(|e| InstallError::Download(format!("{url}: {e}")))?;
    let mut body = response.into_reader();
    let mut file = std::io::BufWriter::new(std::fs::File::create(dest)?);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    loop {
        let read = body.read(&mut buf).map_err(|e| InstallError::Download(e.to_string()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
        file.write_all(&buf[..read])?;
        done += read as u64;
        on_progress(Progress {
            phase: Phase::Downloading,
            done_bytes: done,
            total_bytes: asset.bytes.max(done),
        });
    }
    file.flush()?;
    on_progress(Progress {
        phase: Phase::Verifying,
        done_bytes: done,
        total_bytes: asset.bytes.max(done),
    });
    Ok(hex(&hasher.finalize()))
}

/// `tar` rather than a Rust decoder: every target platform ships one that
/// handles gzip, and 740 MB of extraction is the one part of this that wants a
/// C implementation. `--strip-components=1` drops the release's own top folder
/// so the tree is `<version>/bin/code-server`.
fn untar(tarball: &Path, into: &Path) -> Result<(), InstallError> {
    let output = Command::new("tar")
        .arg("-xzf")
        .arg(tarball)
        .arg("--strip-components=1")
        .arg("-C")
        .arg(into)
        .output()
        .map_err(|e| InstallError::Unpack(format!("tar: {e}")))?;
    if !output.status.success() {
        return Err(InstallError::Unpack(format!(
            "tar {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(())
}

/// native-tls, not ureq's bundled roots: a TLS-inspecting proxy's CA is in the
/// OS trust store and nowhere else. Same reasoning as `tt_update::agent`.
fn agent() -> Result<&'static ureq::Agent, InstallError> {
    static AGENT: OnceLock<Result<ureq::Agent, String>> = OnceLock::new();
    AGENT
        .get_or_init(|| {
            let connector = native_tls::TlsConnector::new().map_err(|e| e.to_string())?;
            Ok(ureq::AgentBuilder::new()
                .tls_connector(Arc::new(connector))
                .timeout_connect(CONNECT_TIMEOUT)
                .timeout_read(READ_TIMEOUT)
                .build())
        })
        .as_ref()
        .map_err(|e| InstallError::Download(e.clone()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
        s.push_str(&format!("{b:02x}"));
        s
    })
}

/// Partial downloads and half-unpacked trees, removed however the install
/// ends — an aborted one must not leave 235 MB behind.
struct Scratch(Vec<PathBuf>);

impl Scratch {
    fn and(mut self, path: PathBuf) -> Self {
        self.0.push(path);
        self
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_published_target_has_a_pinned_digest() {
        for ((os, arch), asset) in ASSETS {
            assert!(asset.name.contains(VERSION), "{os}/{arch} pins a stale asset name");
            assert_eq!(asset.sha256.len(), 64, "{os}/{arch} digest is not a sha256");
            assert!(asset.bytes > 0);
        }
    }

    #[test]
    fn the_host_this_test_runs_on_is_installable() {
        let (os, arch) = host();
        assert!(asset_for(os, arch).is_some(), "no pinned build for {os}/{arch}");
    }

    #[test]
    fn installed_binary_is_none_until_the_tree_exists() {
        let root = tempfile::tempdir().unwrap();
        assert!(installed_binary(root.path()).is_none());
        let bin = install_dir(root.path()).join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("code-server"), "#!/bin/sh\n").unwrap();
        assert_eq!(installed_binary(root.path()), Some(bin.join("code-server")));
    }

    #[test]
    fn scratch_removes_both_a_file_and_a_directory() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("download.tar.gz");
        let dir = root.path().join("stage");
        std::fs::write(&file, "x").unwrap();
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        drop(Scratch(vec![file.clone()]).and(dir.clone()));
        assert!(!file.exists());
        assert!(!dir.exists());
    }

    #[test]
    fn untar_strips_the_releases_own_top_folder() {
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join("code-server-1.2.3-linux-amd64");
        std::fs::create_dir_all(src.join("bin")).unwrap();
        std::fs::write(src.join("bin").join("code-server"), "#!/bin/sh\n").unwrap();
        let tarball = root.path().join("release.tar.gz");
        let status = Command::new("tar")
            .arg("-czf")
            .arg(&tarball)
            .arg("-C")
            .arg(root.path())
            .arg("code-server-1.2.3-linux-amd64")
            .status()
            .unwrap();
        assert!(status.success());
        let into = root.path().join("stage");
        std::fs::create_dir_all(&into).unwrap();
        untar(&tarball, &into).unwrap();
        assert!(into.join("bin").join("code-server").is_file());
    }
}
