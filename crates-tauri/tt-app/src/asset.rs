//! Repo files served to the webview as bytes, for the Files pane. Nothing else in the
//! app can: [`crate::ide::ide_read_file`] is text-only by design, and the webview's own
//! origin is the bundled frontend, so a relative `src` 404s against `tauri://localhost`.
//!
//! **What stops a Markdown file reading `~/.ssh/id_rsa`.** The URL carries the checkout
//! dir, and the URL is exactly the part a hostile README controls. Two independent
//! guards: `dir` must have been registered by [`asset_allow_dir`]; and the path is
//! resolved *within* that dir by [`resolve_within`]. The first is a policy about *which
//! trees*, the second a fact about *one path*, so a bug in either is invisible from the
//! other's tests.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use tauri::http::{Request, Response, StatusCode};
use tauri::{Manager, State};

/// The scheme this protocol registers under. The frontend builds matching URLs
/// with `convertFileSrc(…, ASSET_SCHEME)`, which keeps the platform difference
/// (`ttasset://localhost/…` vs. Windows' `http://ttasset.localhost/…`) out of our code.
pub const SCHEME: &str = "ttasset";

/// Big enough for a README screen recording, small enough that a stray `.iso`
/// can't be paged into the webview. Far above `ide_read_file`'s 2 MB text cap —
/// that one bounds an editor buffer, this one bounds a decode.
const MAX_BYTES: u64 = 25 * 1024 * 1024;

/// Checkout dirs the preview has been opened on, and therefore the only trees
/// this protocol will read from (module doc, guard 1). Insert-only: dropping
/// entries on unmount would race the image requests of a preview still on screen.
#[derive(Default)]
pub struct AssetScopes(Mutex<HashSet<PathBuf>>);

impl AssetScopes {
    fn allow(&self, dir: PathBuf) {
        if let Ok(mut set) = self.0.lock() {
            set.insert(dir);
        }
    }

    fn allows(&self, dir: &Path) -> bool {
        self.0.lock().map(|set| set.contains(dir)).unwrap_or(false)
    }
}

/// Register a checkout as readable by the asset protocol. Canonicalized on the
/// way in so the set is keyed the same way a request's `dir` will be — otherwise
/// `/home/me/repo` and a symlinked `/home/me/code/repo` are two scopes and one
/// silently fails to load images. Not instrumented: it fires on every remount.
#[tauri::command]
pub fn asset_allow_dir(scopes: State<AssetScopes>, dir: String) -> Result<(), String> {
    let canonical =
        std::fs::canonicalize(&dir).map_err(|e| format!("cannot open the folder {dir}: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("{dir} is not a folder"));
    }
    scopes.allow(canonical);
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub struct AssetRequest {
    pub dir: String,
    pub path: String,
}

/// Both halves travel as query parameters rather than in the URI's path: a path
/// would have to encode an absolute dir *inside* another path, and every layer
/// between here and WebKit would get a vote on how to normalize the result.
pub fn parse_request(uri: &str) -> Option<AssetRequest> {
    let url = tauri::Url::parse(uri).ok()?;
    let mut dir = None;
    let mut path = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "dir" => dir = Some(value.into_owned()),
            "path" => path = Some(value.into_owned()),
            _ => {}
        }
    }
    let (dir, path) = (dir?, path?);
    if dir.is_empty() || path.is_empty() {
        return None;
    }
    Some(AssetRequest { dir, path })
}

/// Collapse `.`/`..` first, then refuse anything that escaped (module doc,
/// guard 2). An absolute `rel` is rejected rather than rooted at `dir`, since
/// `Path::join` would silently discard the base — the [`crate::ide::confined`] trap.
pub fn resolve_within(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = Path::new(rel);
    if rel.is_absolute() {
        return Err(format!("absolute asset path: {}", rel.display()));
    }
    let mut out = PathBuf::new();
    for component in rel.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // Refuse rather than clamp, so a wrong link reads as broken.
                if !out.pop() {
                    return Err(format!("asset path escapes the folder: {}", rel.display()));
                }
            }
            Component::Normal(part) => out.push(part),
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!("asset path escapes the folder: {}", rel.display()));
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err("empty asset path".to_string());
    }
    Ok(dir.join(out))
}

/// An unknown extension degrades to `application/octet-stream` rather than a
/// 500 — the requesting tag decides what it can use. SVG is here because an
/// `<img>` renders it inertly; it may never become a top-level navigation.
pub fn mime_for(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/vnd.microsoft.icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

fn error_response(status: StatusCode, message: String) -> Response<Vec<u8>> {
    // Text body so the reason shows in the webview's network panel; a failed
    // `<img>` renders its alt text, not this.
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(message.into_bytes())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Blocking — the caller runs it off the UI thread.
fn serve(scopes: &AssetScopes, uri: &str) -> Response<Vec<u8>> {
    let Some(request) = parse_request(uri) else {
        return error_response(StatusCode::BAD_REQUEST, "expected ?dir=&path=".to_string());
    };
    let Ok(dir) = std::fs::canonicalize(&request.dir) else {
        return error_response(StatusCode::FORBIDDEN, format!("unknown folder {}", request.dir));
    };
    if !scopes.allows(&dir) {
        return error_response(
            StatusCode::FORBIDDEN,
            format!("folder not open: {}", dir.display()),
        );
    }
    let abs = match resolve_within(&dir, &request.path) {
        Ok(abs) => abs,
        Err(message) => return error_response(StatusCode::FORBIDDEN, message),
    };
    let meta = match std::fs::metadata(&abs) {
        Ok(meta) => meta,
        Err(e) => {
            return error_response(StatusCode::NOT_FOUND, format!("{}: {e}", request.path));
        }
    };
    if !meta.is_file() {
        return error_response(StatusCode::NOT_FOUND, format!("{} is not a file", request.path));
    }
    if meta.len() > MAX_BYTES {
        return error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("{} is too large to preview ({} KB)", request.path, meta.len() / 1024),
        );
    }
    match std::fs::read(&abs) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", mime_for(&abs))
            // The preview re-requests every image on remount; revalidating would
            // put a disk stat on every toggle of the split view.
            .header("Cache-Control", "max-age=3600")
            .body(bytes)
            .unwrap_or_else(|_| Response::new(Vec::new())),
        Err(e) => error_response(StatusCode::NOT_FOUND, format!("{}: {e}", request.path)),
    }
}

/// Asynchronous rather than the plain `register_uri_scheme_protocol`: the sync
/// form runs the handler on Linux's GTK main thread, where a 20 MB read stalls
/// the whole app — precisely the file this exists to serve.
pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(
        SCHEME,
        |ctx, request: Request<Vec<u8>>, responder| {
            let uri = request.uri().to_string();
            let scopes = ctx.app_handle().state::<AssetScopes>();
            // `State` can't cross to the blocking pool, but the set behind it can.
            let snapshot = scopes.0.lock().map(|set| set.clone()).unwrap_or_default();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(serve(&AssetScopes(Mutex::new(snapshot)), &uri));
            });
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_both_query_parameters() {
        let parsed =
            parse_request("ttasset://localhost/?dir=%2Fhome%2Fme%2Frepo&path=docs%2Fa.png");
        assert_eq!(
            parsed,
            Some(AssetRequest { dir: "/home/me/repo".into(), path: "docs/a.png".into() })
        );
    }

    #[test]
    fn parses_the_windows_host_form_too() {
        // convertFileSrc emits this shape on Windows; the handler is shared.
        let parsed = parse_request("http://ttasset.localhost/?dir=%2Frepo&path=a.gif");
        assert_eq!(parsed, Some(AssetRequest { dir: "/repo".into(), path: "a.gif".into() }));
    }

    #[test]
    fn a_request_missing_either_half_is_not_a_request() {
        assert_eq!(parse_request("ttasset://localhost/?dir=%2Frepo"), None);
        assert_eq!(parse_request("ttasset://localhost/?path=a.png"), None);
        assert_eq!(parse_request("ttasset://localhost/?dir=&path=a.png"), None);
    }

    #[test]
    fn resolves_a_plain_relative_path() {
        let resolved = resolve_within(Path::new("/repo"), "docs/images/a.png");
        assert_eq!(resolved, Ok(PathBuf::from("/repo/docs/images/a.png")));
    }

    #[test]
    fn collapses_dot_and_parent_segments_that_stay_inside() {
        // `docs/FOO.md` → `../images/a.png` is legal, which is why this doesn't
        // reject every `..` the way `ide::confined` does.
        assert_eq!(
            resolve_within(Path::new("/repo"), "docs/../images/a.png"),
            Ok(PathBuf::from("/repo/images/a.png"))
        );
        assert_eq!(
            resolve_within(Path::new("/repo"), "./docs/./a.png"),
            Ok(PathBuf::from("/repo/docs/a.png"))
        );
    }

    #[test]
    fn refuses_paths_that_climb_out() {
        assert!(resolve_within(Path::new("/repo"), "../secrets/a.png").is_err());
        assert!(resolve_within(Path::new("/repo"), "docs/../../a.png").is_err());
        assert!(resolve_within(Path::new("/repo"), "/etc/passwd").is_err());
        assert!(resolve_within(Path::new("/repo"), "").is_err());
    }

    #[test]
    fn mime_covers_the_formats_a_readme_uses() {
        assert_eq!(mime_for(Path::new("a.GIF")), "image/gif");
        assert_eq!(mime_for(Path::new("a.png")), "image/png");
        assert_eq!(mime_for(Path::new("a.jpeg")), "image/jpeg");
        assert_eq!(mime_for(Path::new("a.svg")), "image/svg+xml");
        assert_eq!(mime_for(Path::new("a.mp4")), "video/mp4");
        assert_eq!(mime_for(Path::new("a.unknown")), "application/octet-stream");
        assert_eq!(mime_for(Path::new("noext")), "application/octet-stream");
    }

    #[test]
    fn an_unregistered_folder_is_refused_before_any_read() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = tmp.path().join("a.png");
        std::fs::write(&file, b"bytes").expect("write");
        let dir = std::fs::canonicalize(tmp.path()).expect("canonicalize");
        let uri =
            format!("ttasset://localhost/?dir={}&path=a.png", urlencode(&dir.to_string_lossy()));

        let empty = AssetScopes::default();
        assert_eq!(serve(&empty, &uri).status(), StatusCode::FORBIDDEN);

        let allowed = AssetScopes::default();
        allowed.allow(dir);
        let response = serve(&allowed, &uri);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"bytes");
        assert_eq!(response.headers()["Content-Type"], "image/png");
    }

    #[test]
    fn a_registered_folder_still_cannot_be_escaped() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = std::fs::canonicalize(tmp.path()).expect("canonicalize");
        std::fs::create_dir(dir.join("repo")).expect("mkdir");
        std::fs::write(dir.join("secret.txt"), b"nope").expect("write");
        let scopes = AssetScopes::default();
        scopes.allow(dir.join("repo"));
        let uri = format!(
            "ttasset://localhost/?dir={}&path=..%2Fsecret.txt",
            urlencode(&dir.join("repo").to_string_lossy())
        );
        assert_eq!(serve(&scopes, &uri).status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn a_missing_file_is_a_404_not_a_panic() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = std::fs::canonicalize(tmp.path()).expect("canonicalize");
        let scopes = AssetScopes::default();
        scopes.allow(dir.clone());
        let uri =
            format!("ttasset://localhost/?dir={}&path=gone.png", urlencode(&dir.to_string_lossy()));
        assert_eq!(serve(&scopes, &uri).status(), StatusCode::NOT_FOUND);
    }

    /// Only the characters a tempdir path can contain need covering.
    fn urlencode(raw: &str) -> String {
        raw.chars()
            .map(|c| match c {
                '/' => "%2F".to_string(),
                ' ' => "%20".to_string(),
                c => c.to_string(),
            })
            .collect()
    }
}
