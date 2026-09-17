//! macOS-only: a native `NSEvent` local monitor for the Ctrl chords Cocoa takes
//! before WKWebView dispatches a DOM keydown. Bare Control+C spells U+0003,
//! which the text-input layer reads as `insertNewline:`, so no page ever sees
//! it (WebKitGTK has no such table). A focused terminal gets it straight into
//! its PTY. With PC keybindings on, everywhere else gets Ctrl+C re-spelled as a
//! plain `c` for the page to copy with, and Ctrl+V turned into ⌘V — the one
//! trusted paste, which no page can start itself. Every other bare Ctrl chord
//! stays the frontend's (Ctrl+`=`/`-`/`0` are font zoom).

use std::sync::atomic::{AtomicBool, Ordering};

static PC_KEYBINDINGS: AtomicBool = AtomicBool::new(false);

/// The frontend owns the setting and its refresh policy; this only obeys.
#[tauri::command]
pub fn keymap_set_pc(on: bool) {
    PC_KEYBINDINGS.store(on, Ordering::Relaxed);
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Pass,
    Respell,
    Command,
}

/// With PC keybindings on, for a Ctrl+C or Ctrl+V a terminal didn't take.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn decide(key: char, shift: bool, terminal_focused: bool) -> Action {
    match key {
        'c' => Action::Respell,
        'v' if !shift && !terminal_focused => Action::Command,
        _ => Action::Pass,
    }
}

/// The letter a Control chord is on, from either spelling the event offers:
/// `charactersIgnoringModifiers` does *not* strip Control despite the name.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn chord_key(characters: Option<&str>, unmodified: Option<&str>) -> Option<char> {
    let single = |s: Option<&str>| {
        let mut chars = s?.chars();
        chars.next().filter(|_| chars.next().is_none())
    };
    if let Some(c) = single(unmodified).filter(char::is_ascii_alphabetic) {
        return Some(c.to_ascii_lowercase());
    }
    let control = single(characters).filter(|c| ('\u{1}'..='\u{1a}').contains(c))?;
    Some(char::from(b'a' + control as u8 - 1))
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};
    use objc2_foundation::NSString;
    use std::ptr::NonNull;
    use tauri::{AppHandle, Manager};
    use tt_vt::{KeyAction, KeyEvent};

    use std::sync::atomic::Ordering;

    use super::{Action, PC_KEYBINDINGS, chord_key, decide};
    use crate::terminal::TermState;

    /// Installs the monitor for the app's lifetime (no teardown point — the
    /// handle is deliberately leaked).
    pub fn install(app: &AppHandle) {
        let app = app.clone();
        let block = block2::RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit calls a local monitor with a valid event, for the
            // duration of this call only.
            let event_ref = unsafe { event.as_ref() };
            let mods = event_ref.modifierFlags();
            let extra = NSEventModifierFlags::Command | NSEventModifierFlags::Option;
            if !mods.contains(NSEventModifierFlags::Control) || mods.intersects(extra) {
                return event.as_ptr();
            }
            let characters = event_ref.characters().map(|s| s.to_string());
            let unmodified = event_ref
                .charactersByApplyingModifiers(NSEventModifierFlags::empty())
                .map(|s| s.to_string());
            let key = match chord_key(characters.as_deref(), unmodified.as_deref()) {
                Some(key @ ('c' | 'v')) => key,
                _ => return event.as_ptr(),
            };
            let shift = mods.contains(NSEventModifierFlags::Shift);
            let terms = app.state::<TermState>();
            if key == 'c' && !shift && terms.send_key_to_focused(ctrl_c()) {
                return std::ptr::null_mut();
            }
            if !PC_KEYBINDINGS.load(Ordering::Relaxed) {
                return event.as_ptr();
            }
            match decide(key, shift, terms.has_focused()) {
                Action::Pass => event.as_ptr(),
                Action::Respell => rewrite(event, mods, if shift { "C" } else { "c" }),
                Action::Command => {
                    let flags =
                        (mods - NSEventModifierFlags::Control) | NSEventModifierFlags::Command;
                    rewrite(event, flags, "v")
                }
            }
        });
        // SAFETY: `block` matches the required signature and returns either a
        // valid pointer or null.
        let monitor: Option<Retained<AnyObject>> = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block)
        };
        tracing::debug!(installed = monitor.is_some(), "macos_keys.monitor_installed");
        std::mem::forget(monitor);
        std::mem::forget(block);
    }

    fn ctrl_c() -> KeyEvent {
        KeyEvent {
            code: "KeyC".into(),
            key: "c".into(),
            action: KeyAction::Press,
            shift: false,
            alt: false,
            ctrl: true,
            meta: false,
            caps_lock: false,
            num_lock: false,
        }
    }

    /// The same keystroke with other modifiers and spelling; the original
    /// passes through if AppKit declines to build one.
    fn rewrite(event: NonNull<NSEvent>, flags: NSEventModifierFlags, key: &str) -> *mut NSEvent {
        // SAFETY: as in `install` — valid for this call.
        let original = unsafe { event.as_ref() };
        let key = NSString::from_str(key);
        let rewritten = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            original.r#type(),
            original.locationInWindow(),
            flags,
            original.timestamp(),
            original.windowNumber(),
            None,
            &key,
            &key,
            original.isARepeat(),
            original.keyCode(),
        );
        match rewritten {
            Some(new) => Retained::autorelease_return(new),
            None => event.as_ptr(),
        }
    }
}

#[cfg(target_os = "macos")]
pub use imp::install;

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::{Action, chord_key, decide};

    #[test]
    fn reads_the_letter_from_either_spelling() {
        assert_eq!(chord_key(Some("\u{3}"), Some("c")), Some('c'));
        assert_eq!(chord_key(Some("\u{3}"), None), Some('c'));
        assert_eq!(chord_key(None, Some("C")), Some('c'));
        assert_eq!(chord_key(Some("\u{16}"), Some("\u{16}")), Some('v'));
        assert_eq!(chord_key(Some("="), Some("=")), None);
        assert_eq!(chord_key(None, None), None);
    }

    #[test]
    fn ctrl_c_is_always_spelled_for_the_page() {
        assert_eq!(decide('c', false, false), Action::Respell);
        // Ctrl+Shift+C is a terminal's copy chord, so it has to be spelled too.
        assert_eq!(decide('c', true, true), Action::Respell);
    }

    #[test]
    fn ctrl_v_pastes_everywhere_but_a_terminal() {
        assert_eq!(decide('v', false, false), Action::Command);
        assert_eq!(decide('v', false, true), Action::Pass);
        assert_eq!(decide('v', true, false), Action::Pass);
    }
}
