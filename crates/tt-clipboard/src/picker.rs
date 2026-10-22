//! The history window: type to search, arrows to move, Enter to paste.

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

use eframe::egui::{
    self, Color32, ColorImage, Key, Modifiers, RichText, TextureHandle, TextureOptions,
};

use crate::query::Query;
use crate::{Error, Kind, Result, Store, Summary, thumb};

/// The picker window's Wayland app id.
pub const APP_ID: &str = "tt-clip";

/// How long typing must pause before the query runs.
const SEARCH_DEBOUNCE: Duration = Duration::from_millis(60);
/// Rows a list shows; the search narrows from the whole store, not from these.
const LIMIT: usize = 500;
const ROW_HEIGHT: f32 = 56.0;
const THUMB_HEIGHT: f32 = 48.0;
/// Text past this is cut from the preview pane (the copy is always whole).
const PREVIEW_TEXT_CHARS: usize = 20_000;
/// Long edge an image is decoded to for the preview pane.
const PREVIEW_IMAGE_EDGE: u32 = 1600;

/// What the person chose, and what to do with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Picked {
    pub id: i64,
    pub kind: Kind,
    pub action: Action,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Copy, then send the paste keystroke.
    Paste,
    Copy,
    /// Open an image in the screenshot editor.
    Edit,
}

/// A full-size preview decoded off the UI thread: id, width, height, RGBA.
type Decoded = (i64, u32, u32, Vec<u8>);

enum Preview {
    Text(String),
    Image(TextureHandle),
    Missing,
}

struct Picker {
    store: Store,
    query: String,
    results: Vec<Summary>,
    selected: usize,
    /// Set when the selection moved by keyboard, so the list scrolls to it.
    scroll_to_selected: bool,
    thumbs: HashMap<i64, Option<TextureHandle>>,
    preview: Option<(i64, Preview)>,
    /// The image the decode worker should finish; older requests give up.
    wanted: Arc<AtomicI64>,
    decoded: (Sender<Decoded>, Receiver<Decoded>),
    had_focus: bool,
    now_ms: i64,
    picked: Rc<Cell<Option<Picked>>>,
    error: Option<String>,
    /// When the query last changed plus [`SEARCH_DEBOUNCE`]: a burst of typing searches once.
    search_due: Option<Instant>,
}

/// Show the picker until something is chosen or it is dismissed.
pub fn run(store: Store) -> Result<Option<Picked>> {
    let picked = Rc::new(Cell::new(None));
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("tt clipboard manager")
            .with_app_id(APP_ID)
            .with_inner_size([980.0, 620.0]),
        ..Default::default()
    };
    let out = picked.clone();
    eframe::run_native(
        "tt-clip",
        options,
        Box::new(move |_cc| {
            let mut p = Picker {
                store,
                query: String::new(),
                results: Vec::new(),
                selected: 0,
                scroll_to_selected: false,
                thumbs: HashMap::new(),
                preview: None,
                wanted: Arc::new(AtomicI64::new(0)),
                decoded: channel(),
                had_focus: false,
                now_ms: tt_config::now_ms(),
                picked: out,
                error: None,
                search_due: None,
            };
            p.refresh();
            Ok(Box::new(p))
        }),
    )
    .map_err(|e| Error::Picker(e.to_string()))?;
    Ok(picked.get())
}

impl Picker {
    fn refresh(&mut self) {
        match self.store.search(&Query::parse(&self.query), LIMIT) {
            Ok(rows) => {
                self.results = rows;
                self.error = None;
            }
            Err(e) => self.error = Some(e.to_string()),
        }
        self.selected = 0;
        self.scroll_to_selected = true;
    }

    fn current(&self) -> Option<&Summary> {
        self.results.get(self.selected)
    }

    fn choose(&mut self, ctx: &egui::Context, action: Action) {
        if let Some(row) = self.current() {
            if action == Action::Edit && row.kind != Kind::Image {
                return;
            }
            self.picked.set(Some(Picked { id: row.id, kind: row.kind, action }));
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
    }

    fn delete_current(&mut self) {
        let Some(id) = self.current().map(|s| s.id) else {
            return;
        };
        if let Err(e) = self.store.delete(id) {
            self.error = Some(e.to_string());
            return;
        }
        self.results.remove(self.selected);
        self.selected = self.selected.min(self.results.len().saturating_sub(1));
        self.thumbs.remove(&id);
    }

    fn handle_keys(&mut self, ctx: &egui::Context) {
        let pressed = |m, k| ctx.input_mut(|i| i.consume_key(m, k));
        let last = self.results.len().saturating_sub(1);
        let before = self.selected;
        if pressed(Modifiers::NONE, Key::ArrowDown) || pressed(Modifiers::CTRL, Key::N) {
            self.selected = (self.selected + 1).min(last);
        }
        if pressed(Modifiers::NONE, Key::ArrowUp) || pressed(Modifiers::CTRL, Key::P) {
            self.selected = self.selected.saturating_sub(1);
        }
        if pressed(Modifiers::NONE, Key::PageDown) {
            self.selected = (self.selected + 8).min(last);
        }
        if pressed(Modifiers::NONE, Key::PageUp) {
            self.selected = self.selected.saturating_sub(8);
        }
        if before != self.selected {
            self.scroll_to_selected = true;
        }
        if pressed(Modifiers::SHIFT, Key::Enter) {
            self.choose(ctx, Action::Copy);
        } else if pressed(Modifiers::NONE, Key::Enter) {
            self.choose(ctx, Action::Paste);
        }
        if pressed(Modifiers::CTRL, Key::E) {
            self.choose(ctx, Action::Edit);
        }
        if pressed(Modifiers::SHIFT, Key::Delete) {
            self.delete_current();
        }
        if pressed(Modifiers::NONE, Key::Escape) {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
    }

    fn thumb(&mut self, ctx: &egui::Context, id: i64) -> Option<TextureHandle> {
        self.thumbs
            .entry(id)
            .or_insert_with(|| {
                let png = self.store.thumb(id).ok().flatten()?;
                texture(ctx, &format!("thumb-{id}"), &png, thumb::THUMB_EDGE)
            })
            .clone()
    }

    fn load_preview(&mut self, ctx: &egui::Context) {
        while let Ok((id, w, h, rgba)) = self.decoded.1.try_recv() {
            if let Some((current, preview)) = &mut self.preview
                && *current == id
            {
                let img = ColorImage::from_rgba_unmultiplied([w as usize, h as usize], &rgba);
                let tex = ctx.load_texture(format!("full-{id}"), img, TextureOptions::LINEAR);
                *preview = Preview::Image(tex);
            }
        }
        let Some((id, kind)) = self.current().map(|s| (s.id, s.kind)) else {
            self.preview = None;
            return;
        };
        if self.preview.as_ref().is_some_and(|(p, _)| *p == id) {
            return;
        }
        let preview = match kind {
            Kind::Text => self
                .store
                .text_prefix(id, PREVIEW_TEXT_CHARS)
                .map_or(Preview::Missing, Preview::Text),
            // Show the thumbnail now; the full decode swaps in when it lands.
            Kind::Image => {
                self.decode_in_background(ctx, id);
                self.thumb(ctx, id).map_or(Preview::Missing, Preview::Image)
            }
        };
        self.preview = Some((id, preview));
    }

    fn decode_in_background(&self, ctx: &egui::Context, id: i64) {
        let Ok(entry) = self.store.get(id) else {
            return;
        };
        self.wanted.store(id, Ordering::Relaxed);
        let (wanted, tx, ctx) = (self.wanted.clone(), self.decoded.0.clone(), ctx.clone());
        std::thread::spawn(move || {
            if wanted.load(Ordering::Relaxed) != id {
                return;
            }
            if let Some((w, h, rgba)) = thumb::decode_rgba(&entry.data, PREVIEW_IMAGE_EDGE) {
                let _ = tx.send((id, w, h, rgba));
                ctx.request_repaint();
            }
        });
    }

    fn list(&mut self, ui: &mut egui::Ui) {
        let ctx = ui.ctx().clone();
        let n = self.results.len();
        egui::ScrollArea::vertical().auto_shrink(false).show_rows(ui, ROW_HEIGHT, n, |ui, rows| {
            for i in rows {
                let (id, kind) = (self.results[i].id, self.results[i].kind);
                let thumb = if kind == Kind::Image { self.thumb(&ctx, id) } else { None };
                let selected = i == self.selected;
                let resp = row_ui(ui, &self.results[i], selected, thumb.as_ref(), self.now_ms);
                if selected && self.scroll_to_selected {
                    resp.scroll_to_me(None);
                    self.scroll_to_selected = false;
                }
                if resp.double_clicked() {
                    self.selected = i;
                    self.choose(&ctx, Action::Paste);
                } else if resp.clicked() {
                    self.selected = i;
                }
            }
        });
    }

    fn preview_ui(&self, ui: &mut egui::Ui) {
        match &self.preview {
            Some((_, Preview::Text(text))) => {
                egui::ScrollArea::both().auto_shrink(false).show(ui, |ui| {
                    ui.add(egui::Label::new(RichText::new(text).monospace()).extend());
                });
            }
            Some((_, Preview::Image(tex))) => {
                if let Some(row) = self.current() {
                    ui.label(
                        RichText::new(format!("{} × {}  ·  {}", row.width, row.height, row.mime))
                            .weak(),
                    );
                }
                ui.centered_and_justified(|ui| {
                    ui.add(
                        egui::Image::new(tex)
                            .max_size(ui.available_size())
                            .fit_to_original_size(1.0),
                    );
                });
            }
            Some((_, Preview::Missing)) => {
                ui.weak("Can't show this entry.");
            }
            None => {}
        }
    }
}

impl eframe::App for Picker {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        // Dismiss on focus loss, like a launcher: the window is a moment, not a place.
        match ctx.input(|i| i.viewport().focused) {
            Some(true) => self.had_focus = true,
            Some(false) if self.had_focus => ctx.send_viewport_cmd(egui::ViewportCommand::Close),
            _ => {}
        }
        self.handle_keys(&ctx);
        self.load_preview(&ctx);

        egui::Panel::top("search").show(ui, |ui| {
            ui.add_space(6.0);
            let edit = egui::TextEdit::singleline(&mut self.query)
                .hint_text("Search   (is:image · is:text)")
                .desired_width(f32::INFINITY);
            let resp = ui.add(edit);
            resp.request_focus();
            if resp.changed() {
                self.search_due = Some(Instant::now() + SEARCH_DEBOUNCE);
                ctx.request_repaint_after(SEARCH_DEBOUNCE);
            }
            if self.search_due.is_some_and(|due| Instant::now() >= due) {
                self.search_due = None;
                self.refresh();
            }
            ui.add_space(4.0);
        });
        egui::Panel::bottom("hints").show(ui, |ui| {
            ui.horizontal(|ui| {
                let hint = "Enter paste   Shift+Enter copy   Ctrl+E edit image   Shift+Del delete   Esc close";
                ui.weak(hint);
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    match &self.error {
                        Some(e) => ui.colored_label(Color32::LIGHT_RED, e),
                        None => ui.weak(format!("{} shown", self.results.len())),
                    };
                });
            });
        });
        let width = ui.available_width() * 0.55;
        egui::Panel::right("preview").default_size(width).show(ui, |ui| self.preview_ui(ui));
        egui::CentralPanel::default_margins().show(ui, |ui| {
            if self.results.is_empty() {
                ui.weak(if self.query.is_empty() { "Nothing copied yet." } else { "No matches." });
            }
            self.list(ui);
        });
    }
}

fn row_ui(
    ui: &mut egui::Ui,
    row: &Summary,
    selected: bool,
    thumb: Option<&TextureHandle>,
    now_ms: i64,
) -> egui::Response {
    let size = egui::vec2(ui.available_width(), ROW_HEIGHT);
    let (rect, resp) = ui.allocate_exact_size(size, egui::Sense::click());
    if selected {
        ui.painter().rect_filled(rect, 4.0, ui.visuals().selection.bg_fill);
    } else if resp.hovered() {
        ui.painter().rect_filled(rect, 4.0, ui.visuals().widgets.hovered.weak_bg_fill);
    }
    let inner = rect.shrink2(egui::vec2(10.0, 4.0));
    let weak = ui.visuals().weak_text_color();
    let font = egui::TextStyle::Body.resolve(ui.style());
    // The right edge carries when it was copied and, for text, how much is hidden.
    let mut right = age(now_ms - row.used_at);
    let (first, more) = row.first_line();
    if row.kind == Kind::Text && more > 0 {
        right = format!("+{more} lines   {right}");
    }
    let meta =
        ui.painter().text(inner.right_center(), egui::Align2::RIGHT_CENTER, right, font, weak);
    let mut content = inner;
    content.set_right(meta.left() - 12.0);
    let mut child = ui.new_child(
        egui::UiBuilder::new()
            .max_rect(content)
            .layout(egui::Layout::left_to_right(egui::Align::Center)),
    );
    let ui = &mut child;
    match (row.kind, thumb) {
        (Kind::Image, Some(tex)) => {
            let max = egui::vec2(THUMB_HEIGHT * 3.0, THUMB_HEIGHT);
            ui.add(egui::Image::new(tex).max_size(max));
            ui.weak(format!("{} × {}", row.width, row.height));
        }
        (Kind::Image, None) => {
            ui.weak(format!("image {} × {}", row.width, row.height));
        }
        (Kind::Text, _) => {
            ui.add(egui::Label::new(first).truncate());
        }
    }
    resp
}

fn age(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    match s {
        0..60 => "now".into(),
        60..3600 => format!("{}m", s / 60),
        3600..86_400 => format!("{}h", s / 3600),
        _ => format!("{}d", s / 86_400),
    }
}

fn texture(ctx: &egui::Context, name: &str, bytes: &[u8], edge: u32) -> Option<TextureHandle> {
    let (w, h, rgba) = thumb::decode_rgba(bytes, edge)?;
    let img = ColorImage::from_rgba_unmultiplied([w as usize, h as usize], &rgba);
    Some(ctx.load_texture(name, img, TextureOptions::LINEAR))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn age_buckets() {
        assert_eq!(age(5_000), "now");
        assert_eq!(age(125_000), "2m");
        assert_eq!(age(3 * 3_600_000), "3h");
        assert_eq!(age(49 * 3_600_000), "2d");
    }
}
