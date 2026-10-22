//! Capturing the screen through the desktop portal: the one route COSMIC, GNOME
//! and KDE all allow, since none of them speak wlr-screencopy.

use std::collections::HashMap;

use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

use crate::{Error, Result};

const DESKTOP: &str = "org.freedesktop.portal.Desktop";

/// Let the desktop's own picker choose a region, window or screen, and return
/// the PNG it wrote; `None` when the person backed out.
pub fn screenshot() -> Result<Option<Vec<u8>>> {
    let conn = Connection::session().map_err(portal)?;
    // Subscribe before asking: the portal answers on a request path named
    // after our bus name and token, and may answer before `Screenshot` returns.
    let sender = conn.unique_name().ok_or_else(|| Error::Portal("no bus name".into()))?;
    let sender = sender.trim_start_matches(':').replace('.', "_");
    let token = format!("tt_clip_{}", std::process::id());
    let request = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
    let request =
        Proxy::new(&conn, DESKTOP, request, "org.freedesktop.portal.Request").map_err(portal)?;
    let mut responses = request.receive_signal("Response").map_err(portal)?;

    let shooter = Proxy::new(
        &conn,
        DESKTOP,
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Screenshot",
    )
    .map_err(portal)?;
    let options: HashMap<&str, Value> = HashMap::from([
        ("handle_token", Value::from(token.as_str())),
        // The desktop's picker knows the monitor layout; one stitched capture of
        // every output would not fit any single screen.
        ("interactive", Value::from(true)),
    ]);
    let _: OwnedObjectPath = shooter.call("Screenshot", &("", options)).map_err(portal)?;

    let reply = responses.next().ok_or_else(|| Error::Portal("no response".into()))?;
    let (code, results): (u32, HashMap<String, OwnedValue>) =
        reply.body().deserialize().map_err(portal)?;
    // 1 is the documented "cancelled by the user".
    if code == 1 {
        return Ok(None);
    }
    if code != 0 {
        return Err(Error::Portal(format!("screenshot refused (response {code})")));
    }
    let uri = results
        .get("uri")
        .and_then(|v| <&str>::try_from(v).ok())
        .ok_or_else(|| Error::Portal("no uri in the response".into()))?;
    let path = file_path(uri).ok_or_else(|| Error::Portal(format!("not a file uri: {uri}")))?;
    let bytes = std::fs::read(&path)?;
    // The portal leaves its copy in a temp dir; the history keeps ours.
    let _ = std::fs::remove_file(&path);
    Ok(Some(bytes))
}

fn portal(e: impl std::fmt::Display) -> Error {
    Error::Portal(e.to_string())
}

/// `file:///tmp/a%20b.png` → `/tmp/a b.png`.
fn file_path(uri: &str) -> Option<std::path::PathBuf> {
    let raw = uri.strip_prefix("file://")?.as_bytes();
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        let hex = raw.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok());
        match (raw[i], hex.and_then(|h| u8::from_str_radix(h, 16).ok())) {
            (b'%', Some(byte)) => {
                out.push(byte);
                i += 3;
            }
            (b, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    use std::os::unix::ffi::OsStringExt;
    Some(std::ffi::OsString::from_vec(out).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_uris_decode_to_paths() {
        assert_eq!(
            file_path("file:///tmp/a%20b.png").unwrap(),
            std::path::Path::new("/tmp/a b.png")
        );
        assert_eq!(file_path("file:////tmp/s.png").unwrap(), std::path::Path::new("//tmp/s.png"));
        assert!(file_path("https://x").is_none());
    }
}
