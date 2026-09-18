//! Makes VS Code's webviews (image and markdown previews, extension panels)
//! work in the Files pane. Their files come from a service worker that asks the
//! webview's host frame for each one. Under WebKit, with a custom-scheme top
//! page like `tauri://localhost`, that worker can't reach its frames:
//! `clients.matchAll()` is empty, `claim()` controls nothing, and messages from
//! uncontrolled frames are dropped, so every request times out.
//!
//! A `BroadcastChannel` still works both ways, so this adds one as a fallback,
//! used only where VS Code's own lookup comes up empty. It edits the dist in
//! place, so it runs only on the install this app manages. It recomputes the
//! host script's CSP hash, and every anchor must match an exact number of times,
//! so a moved anchor fails the patch loudly.

use std::path::Path;

use base64::Engine;
use sha2::{Digest, Sha256};

/// The channel name. It is also how a patched file is recognised.
const CHANNEL: &str = "tt-webview-relay";

const WORKER: &str = "service-worker.js";
const HOST: &str = "index.html";

const WORKER_SOURCE_GUARD: &str = "\tif (!event.source) {\n\t\treturn;\n\t}";
const WORKER_SOURCE_GUARD_PATCHED: &str =
    "\tif (!event.source && !event.ttRelayed) {\n\t\treturn;\n\t}";

const WORKER_LOOKUP: &str = "async function getOuterIframeClient(webviewId) {";
const WORKER_LOOKUP_PATCHED: &str = r"const ttRelay = new BroadcastChannel('tt-webview-relay');
ttRelay.onmessage = (e) => {
	if (e.data?.to !== 'worker') {
		return;
	}
	const event = new MessageEvent('message', { data: e.data.message });
	event.ttRelayed = true;
	sw.dispatchEvent(event);
};

async function getOuterIframeClient(webviewId) {
	const clients = await ttMatchOuterIframeClients(webviewId);
	return clients.length ? clients : [{ postMessage: (message) => ttRelay.postMessage({ to: webviewId, message }) }];
}

async function ttMatchOuterIframeClients(webviewId) {";

const HOST_READY: &str = "\t\tconst workerReady = new Promise((resolve, reject) => {";
const HOST_READY_PATCHED: &str = r"		const ttRelay = new BroadcastChannel('tt-webview-relay');
		const ttToWorker = (message, transfer) => {
			const controller = navigator.serviceWorker?.controller;
			if (controller) {
				controller.postMessage(message, transfer);
			} else {
				ttRelay.postMessage({ to: 'worker', message });
			}
		};
		const ttActivated = (registration) => new Promise(resolve => {
			const worker = registration.installing || registration.waiting || registration.active;
			if (!worker || worker.state === 'activated') {
				return resolve();
			}
			worker.addEventListener('statechange', () => {
				if (worker.state === 'activated') {
					resolve();
				}
			});
		});

		const workerReady = new Promise((resolve, reject) => {";

const HOST_REGISTERED: &str = "\t\t\t\t.then(async registration => {\n";
const HOST_REGISTERED_PATCHED: &str = "\t\t\t\t.then(async registration => {
\t\t\t\t\tif (!navigator.serviceWorker.controller) {
\t\t\t\t\t\treturn ttActivated(registration).then(resolve);
\t\t\t\t\t}
";

const HOST_SEND: &str = "assertIsDefined(navigator.serviceWorker.controller).postMessage(";
const HOST_SEND_PATCHED: &str = "ttToWorker(";

const HOST_LISTEN: &str = "\t\t\tnavigator.serviceWorker.addEventListener('message', event => {";
const HOST_LISTEN_PATCHED: &str = r"			ttRelay.addEventListener('message', event => {
				if (event.data?.to !== ID) {
					return;
				}
				const message = event.data.message;
				if (message.channel === 'load-resource' || message.channel === 'load-localhost') {
					hostMessaging.postMessage(message.channel, message);
				}
			});

			navigator.serviceWorker.addEventListener('message', event => {";

const SCRIPT_OPEN: &str = "<script async type=\"module\">";
const SCRIPT_CLOSE: &str = "</script>";

/// Patch the dist's `pre/` directory in place. A file that already carries the
/// relay is left alone, so this runs on every launch.
pub fn install(pre_dir: &Path) -> std::io::Result<()> {
    patch_file(&pre_dir.join(WORKER), patch_worker)?;
    patch_file(&pre_dir.join(HOST), patch_host)
}

fn patch_file(path: &Path, patch: fn(&str) -> Result<String, String>) -> std::io::Result<()> {
    let source = std::fs::read_to_string(path)?;
    if source.contains(CHANNEL) {
        return Ok(());
    }
    let patched =
        patch(&source).map_err(|e| std::io::Error::other(format!("{}: {e}", path.display())))?;
    // A running server may be serving this file, so it is swapped in whole.
    let scratch = path.with_extension("tt-patch");
    std::fs::write(&scratch, patched)?;
    std::fs::rename(&scratch, path)
}

fn patch_worker(source: &str) -> Result<String, String> {
    let source = replace(source, WORKER_SOURCE_GUARD, WORKER_SOURCE_GUARD_PATCHED, 1)?;
    replace(&source, WORKER_LOOKUP, WORKER_LOOKUP_PATCHED, 1)
}

fn patch_host(source: &str) -> Result<String, String> {
    let (_, old_hash) = inline_script(source)?;
    let patched = replace(source, HOST_READY, HOST_READY_PATCHED, 1)?;
    let patched = replace(&patched, HOST_REGISTERED, HOST_REGISTERED_PATCHED, 1)?;
    let patched = replace(&patched, HOST_SEND, HOST_SEND_PATCHED, 3)?;
    let patched = replace(&patched, HOST_LISTEN, HOST_LISTEN_PATCHED, 1)?;
    let (_, new_hash) = inline_script(&patched)?;
    replace(&patched, &format!("'sha256-{old_hash}'"), &format!("'sha256-{new_hash}'"), 1)
}

/// The host page's one inline script and the CSP hash that admits it.
fn inline_script(html: &str) -> Result<(&str, String), String> {
    let start = html.find(SCRIPT_OPEN).ok_or("no inline module script")? + SCRIPT_OPEN.len();
    let len = html[start..].find(SCRIPT_CLOSE).ok_or("unterminated inline script")?;
    let script = &html[start..start + len];
    let hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(script));
    Ok((script, hash))
}

fn replace(source: &str, anchor: &str, with: &str, expected: usize) -> Result<String, String> {
    let found = source.matches(anchor).count();
    if found != expected {
        let head = anchor.trim().lines().next().unwrap_or_default();
        return Err(format!("expected {expected} of `{head}`, found {found}"));
    }
    Ok(source.replace(anchor, with))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKER_FIXTURE: &str = "sw.addEventListener('message', async (event) => {
\tif (!event.source) {
\t\treturn;
\t}
});

async function getOuterIframeClient(webviewId) {
\treturn [];
}
";

    fn host_fixture() -> String {
        let script = "
\t\tconst workerReady = new Promise((resolve, reject) => {
\t\t\tnavigator.serviceWorker.register(swPath)
\t\t\t\t.then(async registration => {
\t\t\t\t\treturn resolve();
\t\t\t\t});
\t\t});
\t\tassertIsDefined(navigator.serviceWorker.controller).postMessage({ channel: 'a' });
\t\tassertIsDefined(navigator.serviceWorker.controller).postMessage({ channel: 'b' });
\t\tassertIsDefined(navigator.serviceWorker.controller).postMessage({ channel: 'c' });
\t\t\tnavigator.serviceWorker.addEventListener('message', event => {
\t\t\t});
\t";
        let hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(script));
        format!(
            "<meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'sha256-{hash}' 'self';\">\n\
             <script async type=\"module\">{script}</script>\n"
        )
    }

    #[test]
    fn the_worker_falls_back_to_the_channel() {
        let patched = patch_worker(WORKER_FIXTURE).unwrap();
        assert!(patched.contains("!event.source && !event.ttRelayed"));
        assert!(patched.contains("async function ttMatchOuterIframeClients(webviewId) {"));
        assert!(patched.contains(CHANNEL));
    }

    #[test]
    fn the_host_script_still_matches_its_csp_hash() {
        let patched = patch_host(&host_fixture()).unwrap();
        let (script, hash) = inline_script(&patched).unwrap();
        assert!(patched.contains(&format!("'sha256-{hash}'")));
        assert_eq!(script.matches("ttToWorker(").count(), 3);
        assert!(script.contains("return ttActivated(registration).then(resolve);"));
        assert!(script.contains("if (event.data?.to !== ID)"));
    }

    #[test]
    fn a_moved_anchor_fails_instead_of_half_patching() {
        let host = host_fixture().replacen("postMessage({ channel: 'c' })", "send('c')", 1);
        let err = patch_host(&host).unwrap_err();
        assert!(err.contains("expected 3"), "{err}");
    }

    #[test]
    fn install_patches_once() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(WORKER), WORKER_FIXTURE).unwrap();
        std::fs::write(dir.path().join(HOST), host_fixture()).unwrap();
        install(dir.path()).unwrap();
        let first = std::fs::read_to_string(dir.path().join(HOST)).unwrap();
        install(dir.path()).unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join(HOST)).unwrap(), first);
        assert!(!dir.path().join("index.tt-patch").exists());
    }
}
