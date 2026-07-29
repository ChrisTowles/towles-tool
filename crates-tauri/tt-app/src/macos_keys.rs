//! macOS-only: a native `NSEvent` local monitor that catches bare Control+C
//! before WKWebView's Cocoa text-editing layer turns it into `insertNewline:`
//! (which is why Ctrl+C never reached `term_key` on Mac — WebKitGTK has no such
//! table). Scoped to Ctrl+C only: the frontend owns other bare Ctrl chords
//! (Ctrl+`=`/`-`/`0` are font zoom), so widening the list means moving that
//! ownership below this fork first.

/// Whether an event already known to carry Control and nothing else is on the C
/// key — either spelling, because `charactersIgnoringModifiers` does *not*
/// strip Control despite the name (it reports the control character).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn is_c_key(characters: Option<&str>, unmodified: Option<&str>) -> bool {
    characters == Some("\u{3}") || unmodified == Some("c")
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};
    use std::ptr::NonNull;
    use tauri::{AppHandle, Manager};
    use tt_vt::{KeyAction, KeyEvent};

    use crate::terminal::TermState;

    /// Installs the monitor for the app's lifetime (no teardown point — the
    /// handle is deliberately leaked).
    pub fn install(app: &AppHandle) {
        let app = app.clone();
        let block = block2::RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit calls a local monitor with a valid event, for the
            // duration of this call only.
            let event_ref = unsafe { event.as_ref() };
            if !is_bare_ctrl_c(event_ref) {
                return event.as_ptr();
            }
            let delivered = app.state::<TermState>().send_key_to_focused(KeyEvent {
                code: "KeyC".into(),
                key: "c".into(),
                action: KeyAction::Press,
                shift: false,
                alt: false,
                ctrl: true,
                meta: false,
                caps_lock: false,
                num_lock: false,
            });
            // Once per outcome per run, never per keystroke.
            static FIRST_HIT: std::sync::Once = std::sync::Once::new();
            static FIRST_MISS: std::sync::Once = std::sync::Once::new();
            let first = if delivered { &FIRST_HIT } else { &FIRST_MISS };
            first.call_once(|| tracing::debug!(delivered, "macos_keys.chord_intercepted"));
            // Consume (null) only when a terminal took it — otherwise it's an
            // ordinary Ctrl+C elsewhere in the app.
            if delivered { std::ptr::null_mut() } else { event.as_ptr() }
        });
        // SAFETY: `block` matches the required signature and returns either a
        // valid pointer (unmodified) or null.
        let monitor: Option<Retained<AnyObject>> = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block)
        };
        tracing::debug!(installed = monitor.is_some(), "macos_keys.monitor_installed");
        std::mem::forget(monitor);
        std::mem::forget(block);
    }

    /// Bare Control+C (no Command/Option/Shift), on any keyboard layout. The
    /// mask test comes first — only a bare Ctrl chord reads strings.
    fn is_bare_ctrl_c(event: &NSEvent) -> bool {
        let mods = event.modifierFlags();
        let extra = NSEventModifierFlags::Command
            | NSEventModifierFlags::Option
            | NSEventModifierFlags::Shift;
        if !mods.contains(NSEventModifierFlags::Control) || mods.intersects(extra) {
            return false;
        }
        let characters = event.characters().map(|s| s.to_string());
        let unmodified = event
            .charactersByApplyingModifiers(NSEventModifierFlags::empty())
            .map(|s| s.to_string());
        super::is_c_key(characters.as_deref(), unmodified.as_deref())
    }
}

#[cfg(target_os = "macos")]
pub use imp::install;

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::is_c_key;

    #[test]
    fn accepts_either_spelling_the_event_offers() {
        assert!(is_c_key(Some("\u{3}"), Some("c")));
        assert!(is_c_key(Some("\u{3}"), None));
        assert!(is_c_key(None, Some("c")));
    }

    #[test]
    fn rejects_other_keys_and_a_silent_event() {
        assert!(!is_c_key(Some("\u{4}"), Some("d")));
        assert!(!is_c_key(Some("\u{1}"), Some("a")));
        assert!(!is_c_key(None, None));
    }
}
