//! Preview screen backend: the capture half of the annotate-and-send flow. "Send to
//! agent" needs a pixel-accurate PNG of what the user sees, and the DOM can't produce
//! one — a cross-origin iframe taints any canvas it is drawn into.
//! `webkit_web_view_get_snapshot` rasterizes the app webview's composited viewport
//! instead, embedded iframe included, being a privileged native API with no CORS-taint
//! concept. `preview_write_feedback` stages the annotated PNG outside any repo (same
//! reasoning as `tt_tasks::pasted`) so the frontend can name its path in a prompt.
//!
//! `preview_read_file` serves the *other* direction, the agent→human one the
//! `preview_file` MCP tool opens. Reading the file here rather than shipping bytes in the
//! `preview://show` event is what makes reload work — and that reload is *hot*, not just
//! a button; see [`PreviewWatches`].

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tt_agentboard::fs_notify::MultiFileNotifier;
use tt_tasks::pasted::{self, PastedImage};

use crate::ide::MAIN_WINDOW_LABEL;

/// CSS pixels, plus the `devicePixelRatio` that scales them into the snapshot
/// surface's device-pixel space. Only the Linux path reads these fields; the
/// macOS/Windows stub ignores them, hence the `allow(dead_code)`.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub struct CaptureRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub device_pixel_ratio: f64,
}

/// Rasterize the main webview's visible viewport and crop to `rect`, as a base64
/// PNG. Here rather than in the webview, which cannot read its own pixels.
#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn preview_capture(
    window: tauri::WebviewWindow,
    rect: CaptureRect,
) -> Result<String, String> {
    use base64::Engine as _;
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| {
            // Runs on the GTK main thread, so keep it cheap — the un-premultiply
            // and the PNG encode wait for the spawn_blocking below.
            webview.inner().snapshot(
                SnapshotRegion::Visible,
                SnapshotOptions::NONE,
                None::<&webkit2gtk::gio::Cancellable>,
                move |result| {
                    let cropped = result
                        .map_err(|e| format!("webview snapshot failed: {e}"))
                        .and_then(|surface| crop_surface_argb(&surface, rect));
                    let _ = tx.send(cropped);
                },
            );
        })
        .map_err(|e| format!("with_webview: {e}"))?;

    let cropped = rx.await.map_err(|_| "snapshot callback dropped".to_string())??;
    let png = tauri::async_runtime::spawn_blocking(move || {
        let (width, height, rgba) = argb_to_straight_rgba(cropped);
        pasted::rgba_to_png(width, height, &rgba)
    })
    .await
    .map_err(|e| format!("encode task failed: {e}"))?
    .map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}

/// Cairo's premultiplied ARGB32 with a tight row stride — the raw form that
/// leaves the GTK thread. `data` is BGRA, `width * height * 4` bytes.
#[cfg(target_os = "linux")]
struct CroppedArgb {
    width: u32,
    height: u32,
    data: Vec<u8>,
}

/// No capture path on Windows/macOS yet (wry exposes no `capturePage` there).
#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub async fn preview_capture(
    _window: tauri::WebviewWindow,
    _rect: CaptureRect,
) -> Result<String, String> {
    Err("preview capture is only implemented for the Linux (WebKitGTK) shell".to_string())
}

/// Crop to `rect` (scaled by DPR). Runs on the GTK thread, so it stays
/// memcpy-cheap — per-pixel arithmetic is `argb_to_straight_rgba`'s job.
#[cfg(target_os = "linux")]
fn crop_surface_argb(surface: &cairo::Surface, rect: CaptureRect) -> Result<CroppedArgb, String> {
    let dpr = if rect.device_pixel_ratio.is_finite() && rect.device_pixel_ratio > 0.0 {
        rect.device_pixel_ratio
    } else {
        1.0
    };
    let width = (rect.width * dpr).round() as i32;
    let height = (rect.height * dpr).round() as i32;
    if width <= 0 || height <= 0 {
        return Err("capture rect is empty".to_string());
    }

    let mut cropped = cairo::ImageSurface::create(cairo::Format::ARgb32, width, height)
        .map_err(|e| format!("create crop surface: {e}"))?;
    {
        let cr = cairo::Context::new(&cropped).map_err(|e| format!("cairo context: {e}"))?;
        cr.set_source_surface(surface, -(rect.x * dpr).round(), -(rect.y * dpr).round())
            .map_err(|e| format!("set snapshot source: {e}"))?;
        cr.paint().map_err(|e| format!("paint crop: {e}"))?;
    }
    cropped.flush();

    let stride = cropped.stride() as usize;
    let (w, h) = (width as usize, height as usize);
    let src = cropped.data().map_err(|e| format!("read surface data: {e}"))?;
    let mut data = vec![0u8; w * h * 4];
    for row in 0..h {
        data[row * w * 4..(row + 1) * w * 4]
            .copy_from_slice(&src[row * stride..row * stride + w * 4]);
    }
    Ok(CroppedArgb { width: width as u32, height: height as u32, data })
}

/// Premultiplied ARGB32 (byte order B,G,R,A) to the straight RGBA
/// `rgba_to_png` wants. A per-pixel divide, so it runs off the GTK thread.
#[cfg(target_os = "linux")]
fn argb_to_straight_rgba(cropped: CroppedArgb) -> (u32, u32, Vec<u8>) {
    let mut buf = cropped.data;
    for px in buf.chunks_exact_mut(4) {
        let (b, g, r, a) = (px[0], px[1], px[2], px[3]);
        // Un-premultiply so translucent page regions don't come out dark.
        let un = |c: u8| -> u8 {
            if a == 0 || a == 255 { c } else { ((c as u32 * 255) / a as u32).min(255) as u8 }
        };
        px[0] = un(r);
        px[1] = un(g);
        px[2] = un(b);
        px[3] = a;
    }
    (cropped.width, cropped.height, buf)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDoc {
    pub path: String,
    /// `html` | `markdown` | `text` — see [`preview_kind`].
    pub kind: &'static str,
    pub content: String,
}

/// Mirrors `PREVIEW_MAX_BYTES` in `tt-mcp`, which catches an agent's oversized
/// path first; this copy guards a reload after the file grew.
const PREVIEW_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// Extension only, never sniffed content: a file an agent is still writing would
/// otherwise flip surfaces mid-edit, remounting the frame and losing scroll.
fn preview_kind(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "html",
        "md" | "markdown" | "mdx" => "markdown",
        _ => "text",
    }
}

/// Deliberately *not* Tauri's asset protocol, whose scope would have to widen to
/// every path on disk. A previewed HTML artifact is self-contained, so `srcdoc`
/// costs nothing.
#[tauri::command]
pub async fn preview_read_file(path: String) -> Result<PreviewDoc, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&path).map_err(|e| format!("can't read {path}: {e}"))?;
        if !meta.is_file() {
            return Err(format!("{path} is not a file"));
        }
        if meta.len() > PREVIEW_MAX_BYTES {
            return Err(format!("{path} is too large to preview ({} bytes)", meta.len()));
        }
        let content =
            std::fs::read_to_string(&path).map_err(|e| format!("can't read {path}: {e}"))?;
        let kind = preview_kind(&path);
        Ok(PreviewDoc { path, kind, content })
    })
    .await
    .map_err(|e| format!("preview read task failed: {e}"))?
}

/// Carries every path in the debounce batch; each pane re-reads its own if named.
pub const PREVIEW_FILE_CHANGED_EVENT: &str = "preview://file-changed";

/// **One** [`MultiFileNotifier`] for every open pane (inotify instances are a
/// scarce per-user resource), with per-path refcounts inside it. Not
/// `ide_watch_files`, whose paths are confined to a checkout dir: a previewed
/// file is routinely a scratch page under no tracked folder at all.
#[derive(Default)]
pub struct PreviewWatches(Mutex<Option<MultiFileNotifier>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewChangedPayload {
    paths: Vec<String>,
}

/// Pair with [`preview_unwatch_file`] when the pane stops showing `path`. A
/// failed watch is reported so the pane can fall back to its reload button.
#[tauri::command]
pub fn preview_watch_file(
    app: AppHandle,
    watches: State<PreviewWatches>,
    path: String,
) -> Result<(), String> {
    let mut slot = watches.0.lock().unwrap();
    let notifier = match slot.as_mut() {
        Some(n) => n,
        None => {
            let app = app.clone();
            let created = MultiFileNotifier::new(move |paths| {
                let paths: Vec<String> =
                    paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                tracing::debug!(files = ?paths, "preview files changed on disk");
                let _ = app.emit_to(
                    MAIN_WINDOW_LABEL,
                    PREVIEW_FILE_CHANGED_EVENT,
                    PreviewChangedPayload { paths },
                );
            })
            .map_err(|e| format!("cannot start watching {path}: {e}"))?;
            slot.insert(created)
        }
    };
    notifier.add(std::path::Path::new(&path)).map_err(|e| format!("cannot watch {path}: {e}"))
}

/// Unmatched calls — a watch that never started, browser dev — are a no-op.
#[tauri::command]
pub fn preview_unwatch_file(watches: State<PreviewWatches>, path: String) {
    let mut slot = watches.0.lock().unwrap();
    let Some(notifier) = slot.as_mut() else {
        return;
    };
    notifier.remove(std::path::Path::new(&path));
    if notifier.is_empty() {
        *slot = None;
    }
}

/// Stage an annotated capture as a PNG and return its absolute path for the
/// caller to name in an agent prompt. One scope per send, so a second send can't
/// clear the previous one out from under an agent still reading it.
#[tauri::command]
pub async fn preview_write_feedback(
    repo: String,
    images: Vec<PastedImage>,
) -> Result<Vec<String>, String> {
    let base = tt_config::pasted_images_dir();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    tauri::async_runtime::spawn_blocking(move || {
        let scope = pasted::scope_name(&repo, &format!("preview-{now_ms}"));
        let paths = pasted::write_images(&base, &scope, &images, now_ms)?;
        tracing::info!(repo = %repo, count = paths.len(), "preview.feedback_staged");
        Ok(paths)
    })
    .await
    .map_err(|e| format!("feedback task failed: {e}"))?
    .map(|paths: Vec<std::path::PathBuf>| {
        paths.iter().map(|p| p.to_string_lossy().to_string()).collect()
    })
    .map_err(|e: pasted::PastedError| e.to_string())
}
