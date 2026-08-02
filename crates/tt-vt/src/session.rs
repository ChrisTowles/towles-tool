//! Per-terminal thread wrapper around [`Engine`]. libghostty-vt state is `!Send`, so
//! each terminal gets a dedicated thread owning its engine; callers talk to it through
//! channels and receive [`Event`]s on a sink callback run on that thread.
//!
//! Batching falls out of the loop shape: one blocking wait, drain everything queued,
//! then a single render pass, so a PTY flood coalesces into one frame throttled to
//! [`MIN_FRAME_INTERVAL`]. Two problems the throttle alone doesn't solve are handled by
//! splitting byte and control input onto separate channels. **Bounded memory**: bytes
//! ride a *bounded* channel ([`MAX_QUEUED_BYTE_CHUNKS`]); once full the reader blocks,
//! the kernel's PTY buffer fills and the shell gets real flow control. **Responsive
//! UI**: control rides an *unbounded* channel the engine drains first.

use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use libghostty_vt::selection::gesture::Autoscroll;

use crate::engine::{
    Engine, EngineOptions, KeyEvent, MouseInput, PasteOutcome, Pointer, Select, Theme, VtError,
};
use crate::frame::Frame;
use crate::search::SearchMatch;

/// Minimum time between render passes (~90 fps), so the UI can't fall behind.
const MIN_FRAME_INTERVAL: Duration = Duration::from_micros(1_000_000 / 90);

/// Render interval while the pane is hidden (~2 fps). Frontend panes never
/// unmount, so without this a streaming session renders at the interactive cap
/// for a canvas nothing paints. [`Input::RequestFull`] catches it up later.
const HIDDEN_FRAME_INTERVAL: Duration = Duration::from_millis(500);

/// How often a drag held past an edge advances the viewport by one row.
const AUTOSCROLL_TICK_INTERVAL: Duration = Duration::from_millis(50);

/// Longest a synchronized-output batch (DEC mode 2026) may hold rendering — a
/// program that crashes mid-batch must not freeze the pane. Matches kitty.
const SYNC_OUTPUT_MAX_HOLD: Duration = Duration::from_millis(150);

/// Cap on unconsumed PTY byte chunks queued for the engine — ~4 MB in flight
/// at the reader's 64 KiB read size, far above any interactive burst. A
/// firehose blocks the reader rather than ballooning memory; control is exempt.
const MAX_QUEUED_BYTE_CHUNKS: usize = 64;

pub enum Input {
    Bytes(Vec<u8>),
    /// A keystroke to encode against live terminal state and write to the PTY.
    Key(KeyEvent),
    Resize {
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
    },
    /// Scroll the viewport by rows (up is negative); `None` jumps to bottom.
    Scroll(Option<isize>),
    /// A mouse-wheel gesture at viewport cell (`x`, `y`), with `shift` held.
    /// [`Engine::wheel`] decides: scrollback paging, a wheel report, or
    /// alternate-scroll keys.
    Wheel {
        x: u16,
        y: u16,
        lines: i32,
        shift: bool,
    },
    /// A pointer event for the program, when it enabled mouse tracking.
    Mouse(MouseInput),
    /// Reported to the program when it asked for focus events (mode 1004).
    Focus(bool),
    Select(Select),
    /// A pointer event for libghostty's selection-gesture state machine.
    Pointer(Pointer),
    /// Replies with the active selection's plain text.
    Copy(mpsc::SyncSender<Option<String>>),
    /// Paste through libghostty's encoder (strips dangerous control bytes,
    /// honors bracketed paste). `NeedsConfirm` means nothing was written.
    Paste {
        text: String,
        force: bool,
        reply: mpsc::SyncSender<PasteOutcome>,
    },
    /// Case-insensitive scrollback search; matches come back top to bottom.
    Search {
        query: String,
        limit: usize,
        reply: mpsc::SyncSender<Vec<SearchMatch>>,
    },
    /// Scroll the viewport so the given absolute row is visible.
    ScrollTo(usize),
    /// Force a full frame — a re-shown pane needs a complete repaint.
    RequestFull,
    /// Drop scrollback history, keeping the visible screen.
    ClearScrollback,
    /// Widens the render interval to [`HIDDEN_FRAME_INTERVAL`] while hidden.
    Visibility(bool),
    /// Push the UI theme into the emulator so color queries answer the truth.
    Theme(Theme),
}

#[derive(Debug)]
pub enum Event {
    Frame(Frame),
    /// Bytes the terminal wants written back to the PTY (query replies).
    PtyReply(Vec<u8>),
    /// The program rang the bell (BEL) — an attention signal for the UI.
    Bell,
    /// A desktop notification (OSC 9 / OSC 777) — e.g. Claude Code asking for
    /// input.
    Notify(String),
    /// Text a program copied via OSC 52. The host writes it to the system
    /// clipboard, gated on this terminal being focused.
    Clipboard(String),
}

#[derive(Debug, thiserror::Error)]
pub enum SpawnError {
    #[error("failed to spawn tt-vt session thread: {0}")]
    Thread(#[from] std::io::Error),
    #[error(transparent)]
    Vt(#[from] VtError),
    #[error("tt-vt session thread died before reporting readiness")]
    ThreadDied,
}

/// Cloneable handle for feeding a session. [`Input::Bytes`] rides a bounded
/// channel, and blocking there is the backpressure that reaches the PTY reader.
#[derive(Clone)]
pub struct Sender {
    bytes: mpsc::SyncSender<Vec<u8>>,
    control: mpsc::Sender<Input>,
    wake: mpsc::Sender<()>,
}

impl Sender {
    /// Bytes may block under backpressure; control never does. False once the
    /// session thread is gone.
    pub fn send(&self, input: Input) -> bool {
        match input {
            Input::Bytes(bytes) => {
                if self.bytes.send(bytes).is_err() {
                    return false;
                }
            }
            control => {
                if self.control.send(control).is_err() {
                    return false;
                }
            }
        }
        // A failed wake means the engine is gone, which the payload send above
        // would already have caught.
        let _ = self.wake.send(());
        true
    }

    /// Dead stand-ins, so dropping this handle ends the engine's wake loop.
    fn disconnect(&mut self) {
        let (bytes, _) = mpsc::sync_channel(0);
        self.bytes = bytes;
        let (control, _) = mpsc::channel();
        self.control = control;
        let (wake, _) = mpsc::channel();
        self.wake = wake;
    }
}

pub struct Session {
    sender: Sender,
    join: Option<JoinHandle<()>>,
}

impl Session {
    /// Engine creation happens on the new thread, so its error is relayed back.
    pub fn spawn(
        opts: EngineOptions,
        mut sink: impl FnMut(Event) + Send + 'static,
    ) -> Result<Self, SpawnError> {
        let (bytes_tx, bytes_rx) = mpsc::sync_channel::<Vec<u8>>(MAX_QUEUED_BYTE_CHUNKS);
        let (control_tx, control_rx) = mpsc::channel::<Input>();
        let (wake_tx, wake_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), VtError>>(1);

        let join = std::thread::Builder::new().name("tt-vt-session".into()).spawn(move || {
            let mut engine = match Engine::new(opts) {
                Ok(e) => {
                    let _ = ready_tx.send(Ok(()));
                    e
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };

            // `hidden` picks the render interval outside this closure, so it is
            // passed rather than captured.
            let apply_control = |engine: &mut Engine, hidden: &mut bool, input: Input| match input {
                // Bytes never route here; feed defensively rather than panic.
                Input::Bytes(b) => engine.feed(&b),
                Input::Resize { cols, rows, cell_width_px, cell_height_px } => {
                    // A failed resize (zero cols in a layout race) keeps the
                    // old grid; the next one fixes it.
                    let _ = engine.resize(cols, rows, cell_width_px, cell_height_px);
                }
                Input::Scroll(delta) => engine.scroll(delta),
                // Encoding fails only on allocation; a lost keystroke or wheel
                // report reads as dropped input, never a crash. Same for the
                // mouse, focus, selection and scroll arms below.
                Input::Key(event) => {
                    let _ = engine.key(&event);
                }
                Input::Wheel { x, y, lines, shift } => {
                    let _ = engine.wheel(x, y, lines, shift);
                }
                Input::Mouse(input) => {
                    let _ = engine.mouse(&input);
                }
                Input::Focus(focused) => {
                    let _ = engine.focus(focused);
                }
                Input::Select(op) => {
                    let _ = engine.select(op);
                }
                Input::Pointer(ev) => {
                    let _ = engine.pointer(ev);
                }
                Input::Copy(reply) => {
                    let _ = reply.try_send(engine.copy_selection().ok().flatten());
                }
                // An FFI failure reads as pasted-and-lost; NeedsConfirm here
                // would raise a spurious dialog.
                Input::Paste { text, force, reply } => {
                    let _ =
                        reply.try_send(engine.paste(&text, force).unwrap_or(PasteOutcome::Pasted));
                }
                Input::Search { query, limit, reply } => {
                    let _ = reply.try_send(engine.search(&query, limit).unwrap_or_default());
                }
                Input::ScrollTo(row) => {
                    let _ = engine.scroll_to(row);
                }
                Input::RequestFull => engine.request_full(),
                Input::ClearScrollback => engine.clear_scrollback(),
                Input::Visibility(visible) => *hidden = !visible,
                // A failed push keeps the old colors; the next change retries.
                Input::Theme(theme) => {
                    let _ = engine.set_theme(&theme);
                }
            };

            // Start in the past so the first input renders immediately.
            let mut last_render = Instant::now() - MIN_FRAME_INTERVAL;
            let mut hidden = false;
            // Bounds the render hold to `SYNC_OUTPUT_MAX_HOLD` from the instant
            // the application opened its synchronized-output batch.
            let mut sync_since: Option<Instant> = None;
            // Buffered wakes arrive before disconnect, so a dropped session
            // still drains its queued input before the loop ends.
            loop {
                // A drag held past an edge produces no further events, so an
                // active autoscroll drives the loop on its own clock instead
                // of waiting for a wake that will not come.
                if engine.autoscroll() == Autoscroll::None {
                    if wake_rx.recv().is_err() {
                        break;
                    }
                } else if wake_rx.recv_timeout(AUTOSCROLL_TICK_INTERVAL)
                    == Err(mpsc::RecvTimeoutError::Disconnected)
                {
                    break;
                }
                let mut applied = false;
                // Absorb input until the frame interval passes; control drains
                // before bytes so UI ops never wait behind output.
                loop {
                    while let Ok(input) = control_rx.try_recv() {
                        apply_control(&mut engine, &mut hidden, input);
                        applied = true;
                    }
                    while let Ok(bytes) = bytes_rx.try_recv() {
                        engine.feed(&bytes);
                        applied = true;
                    }
                    // A synchronized-output batch (DEC 2026) holds the frame
                    // until the app closes it (ESU) or the cap expires, so
                    // half-drawn TUI updates never reach the screen.
                    if engine.sync_output() {
                        let since = *sync_since.get_or_insert_with(Instant::now);
                        if let Some(hold) = SYNC_OUTPUT_MAX_HOLD.checked_sub(since.elapsed()) {
                            match wake_rx.recv_timeout(hold) {
                                // More input — maybe the ESU. Re-drain.
                                Ok(()) => continue,
                                // Hold cap reached (or disconnected): render.
                                Err(_) => break,
                            }
                        }
                    } else {
                        sync_since = None;
                    }
                    let interval = if hidden { HIDDEN_FRAME_INTERVAL } else { MIN_FRAME_INTERVAL };
                    let elapsed = last_render.elapsed();
                    if elapsed >= interval {
                        break;
                    }
                    match wake_rx.recv_timeout(interval - elapsed) {
                        Ok(()) => continue,
                        // Interval reached, or disconnected: render what we
                        // have and let the outer recv end the loop.
                        Err(_) => break,
                    }
                }
                if engine.autoscroll() != Autoscroll::None {
                    let _ = engine.autoscroll_tick();
                    applied = true;
                }
                // A lone wake token an earlier pass already drained.
                if !applied {
                    continue;
                }

                let reply = engine.take_pty_output();
                if !reply.is_empty() {
                    sink(Event::PtyReply(reply));
                }
                for text in engine.take_clipboard() {
                    sink(Event::Clipboard(text));
                }
                if engine.take_bell() {
                    sink(Event::Bell);
                }
                for body in engine.take_notifications() {
                    sink(Event::Notify(body));
                }
                match engine.render() {
                    Ok(Some(frame)) => {
                        sink(Event::Frame(frame));
                        last_render = Instant::now();
                    }
                    Ok(None) => {}
                    // Render errors are state bugs, not recoverable I/O.
                    Err(_) => break,
                }
            }
        })?;

        ready_rx.recv().map_err(|_| SpawnError::ThreadDied)??;
        Ok(Self {
            sender: Sender { bytes: bytes_tx, control: control_tx, wake: wake_tx },
            join: Some(join),
        })
    }

    /// See [`Sender::send`].
    pub fn send(&self, input: Input) -> bool {
        self.sender.send(input)
    }

    /// For feeding this session from other threads. The engine thread exits
    /// once the [`Session`] is dropped AND every clone is gone.
    pub fn sender(&self) -> Sender {
        self.sender.clone()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // Drop our senders so the wake loop can end once every clone is gone.
        self.sender.disconnect();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A failure against this means a real hang, not a slow machine.
    const TIMEOUT: Duration = Duration::from_secs(5);
    /// Accepted chunks arrive microseconds apart, so a gap this long means the
    /// bounded queue is genuinely full.
    const STALL_TIMEOUT: Duration = Duration::from_millis(500);

    /// A sink that parks the engine thread inside the first frame it emits, so
    /// a test can observe the engine stalled.
    fn spawn_parked() -> (Session, mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (entered_tx, entered_rx) = mpsc::sync_channel::<()>(1);
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let mut parked = false;
        let session = Session::spawn(
            EngineOptions { cols: 40, rows: 8, max_scrollback: 100 },
            move |event| {
                if let Event::Frame(_) = event {
                    if !parked {
                        parked = true;
                        let _ = entered_tx.send(());
                        let _ = release_rx.recv();
                    }
                }
            },
        )
        .expect("spawn session");
        (session, entered_rx, release_tx)
    }

    #[test]
    fn stalled_sink_bounds_the_byte_feed() {
        let (session, entered_rx, release_tx) = spawn_parked();

        // First chunk triggers a frame, parking the engine mid-sink.
        assert!(session.send(Input::Bytes(b"hi".to_vec())));
        entered_rx.recv_timeout(TIMEOUT).expect("engine parked in the sink");

        let feeder = session.sender();
        let (count_tx, count_rx) = mpsc::channel::<usize>();
        let handle = std::thread::spawn(move || {
            let mut n = 0;
            // Capped above the bound so a broken (unbounded) feed terminates
            // instead of hanging the test.
            while n < MAX_QUEUED_BYTE_CHUNKS + 100 {
                if !feeder.send(Input::Bytes(vec![b'x'])) {
                    break;
                }
                n += 1;
                let _ = count_tx.send(n);
            }
        });

        // Drain progress until it stalls: the feeder blocks once full.
        let mut accepted = 0;
        while let Ok(n) = count_rx.recv_timeout(STALL_TIMEOUT) {
            accepted = n;
        }
        assert_eq!(
            accepted, MAX_QUEUED_BYTE_CHUNKS,
            "the stalled engine bounds the byte feed to the channel capacity"
        );
        assert!(!handle.is_finished(), "the feeder is blocked on backpressure, not finished");

        // Released, the engine drains and the feeder runs to its safety cap.
        let _ = release_tx.send(());
        handle.join().expect("feeder joins once backpressure lifts");
        drop(session);
    }

    #[test]
    fn control_is_not_blocked_by_a_saturated_byte_queue() {
        let (session, entered_rx, release_tx) = spawn_parked();

        assert!(session.send(Input::Bytes(b"hi".to_vec())));
        entered_rx.recv_timeout(TIMEOUT).expect("engine parked in the sink");

        let feeder = session.sender();
        let (satc_tx, satc_rx) = mpsc::channel::<usize>();
        let sat = std::thread::spawn(move || {
            let mut n = 0;
            while n < MAX_QUEUED_BYTE_CHUNKS + 3 {
                if !feeder.send(Input::Bytes(vec![b'x'])) {
                    break;
                }
                n += 1;
                let _ = satc_tx.send(n);
            }
        });
        // Wait until the queue is full and the feeder blocks on its next send.
        let mut accepted = 0;
        while accepted < MAX_QUEUED_BYTE_CHUNKS {
            accepted = satc_rx.recv_timeout(TIMEOUT).expect("byte queue fills");
        }

        // With bytes saturated, a control send must still complete promptly.
        let control = session.sender();
        let (done_tx, done_rx) = mpsc::channel::<bool>();
        std::thread::spawn(move || {
            let ok = control.send(Input::Scroll(Some(-1)));
            let _ = done_tx.send(ok);
        });
        assert!(
            done_rx.recv_timeout(TIMEOUT).expect("control send blocked behind saturated bytes"),
            "control send accepted while the byte queue is full"
        );

        // Confirm control is actually *processed* with a backlog pending.
        let _ = release_tx.send(());
        let (reply_tx, reply_rx) = mpsc::sync_channel::<Option<String>>(1);
        assert!(session.send(Input::Copy(reply_tx)));
        reply_rx.recv_timeout(TIMEOUT).expect("engine processed the control input");

        sat.join().expect("saturating feeder drains once backpressure lifts");
        drop(session);
    }
}
