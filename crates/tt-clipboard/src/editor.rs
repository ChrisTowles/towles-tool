//! The screenshot editor: crop, then mark up with arrows, boxes, a pen and text
//! labels. Enter copies the result; Ctrl+S also saves it.

use std::cell::RefCell;
use std::rc::Rc;

use eframe::egui::{
    self, Align2, Color32, ColorImage, CursorIcon, FontId, Key, KeyboardShortcut, Modifiers, Pos2,
    Rect, Sense, Stroke, StrokeKind, TextureHandle, TextureOptions, Vec2, pos2,
};
use image::RgbaImage;

use crate::annotate::{self, Bounds, Color, Pos, Shape};
use crate::{Error, Result};

/// The editor window's Wayland app id.
pub const APP_ID: &str = "tt-clip-shot";

/// Long edge of the on-screen copy; the export always uses the full image.
const DISPLAY_EDGE: u32 = 8192;
const COLORS: [Color; 6] = [
    [235, 50, 50, 255],
    [255, 200, 0, 255],
    [40, 185, 95, 255],
    [45, 125, 245, 255],
    [255, 255, 255, 255],
    [20, 20, 20, 255],
];
/// Stroke widths and label sizes, in screen points (stored scaled to image pixels).
const WEIGHTS: [f32; 3] = [3.0, 5.0, 9.0];
const TEXT_SIZES: [f32; 3] = [16.0, 22.0, 32.0];
/// A drag shorter than this, in image pixels, is a click, not a shape.
const MIN_DRAG: f32 = 3.0;

/// What the person asked for when the window closed.
pub enum Outcome {
    Copy(Vec<u8>),
    /// Copy and also write to the screenshots folder.
    Save(Vec<u8>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tool {
    Crop,
    Arrow,
    Rect,
    Pen,
    Text,
}

impl Tool {
    const ALL: [Tool; 5] = [Tool::Crop, Tool::Arrow, Tool::Rect, Tool::Pen, Tool::Text];

    fn key(self) -> Key {
        match self {
            Tool::Crop => Key::C,
            Tool::Arrow => Key::A,
            Tool::Rect => Key::R,
            Tool::Pen => Key::P,
            Tool::Text => Key::T,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Tool::Crop => "Crop  C",
            Tool::Arrow => "Arrow  A",
            Tool::Rect => "Box  R",
            Tool::Pen => "Pen  P",
            Tool::Text => "Text  T",
        }
    }
}

enum Drag {
    Crop(Pos),
    Shape(Shape),
}

struct Draft {
    at: Pos,
    text: String,
    color: Color,
    size: f32,
}

struct Editor {
    base: RgbaImage,
    tex: TextureHandle,
    shapes: Vec<Shape>,
    undone: Vec<Shape>,
    crop: Option<Bounds>,
    tool: Tool,
    color: usize,
    weight: usize,
    drag: Option<Drag>,
    draft: Option<Draft>,
    /// Image pixels per screen point, as of the last frame.
    px_per_pt: f32,
    outcome: Rc<RefCell<Option<Outcome>>>,
    error: Option<String>,
}

/// Show the editor over `image` until the result is copied or it is dismissed.
pub fn run(image: &[u8]) -> Result<Option<Outcome>> {
    let base = image::load_from_memory(image)
        .map_err(|e| Error::Picker(format!("decoding the image: {e}")))?
        .into_rgba8();
    let outcome = Rc::new(RefCell::new(None));
    let viewport = egui::ViewportBuilder::default()
        .with_title("tt screenshot")
        .with_app_id(APP_ID)
        .with_inner_size([1200.0, 800.0]);
    let options = eframe::NativeOptions { viewport, ..Default::default() };
    let out = outcome.clone();
    eframe::run_native(
        "tt-clip-shot",
        options,
        Box::new(move |cc| {
            let shown = if base.width().max(base.height()) > DISPLAY_EDGE {
                image::DynamicImage::ImageRgba8(base.clone())
                    .resize(DISPLAY_EDGE, DISPLAY_EDGE, image::imageops::FilterType::Triangle)
                    .into_rgba8()
            } else {
                base.clone()
            };
            let size = [shown.width() as usize, shown.height() as usize];
            let img = ColorImage::from_rgba_unmultiplied(size, shown.as_raw());
            let tex = cc.egui_ctx.load_texture("shot", img, TextureOptions::LINEAR);
            Ok(Box::new(Editor {
                base,
                tex,
                shapes: Vec::new(),
                undone: Vec::new(),
                crop: None,
                tool: Tool::Arrow,
                color: 0,
                weight: 1,
                drag: None,
                draft: None,
                px_per_pt: 1.0,
                outcome: out,
                error: None,
            }))
        }),
    )
    .map_err(|e| Error::Picker(e.to_string()))?;
    Ok(outcome.take())
}

/// Where the image sits on screen and how to move between its pixels and points.
#[derive(Clone, Copy)]
struct View {
    rect: Rect,
    /// Points per image pixel.
    scale: f32,
    size: Vec2,
}

impl View {
    /// Fit the image in `area`, never past `max_scale` so a small capture stays sharp.
    fn fit(area: Rect, w: u32, h: u32, max_scale: f32) -> View {
        let size = Vec2::new(w as f32, h as f32);
        let scale = (area.width() / size.x).min(area.height() / size.y).min(max_scale);
        let rect = Rect::from_center_size(area.center(), size * scale);
        View { rect, scale, size }
    }

    fn screen(&self, p: Pos) -> Pos2 {
        self.rect.min + Vec2::new(p[0], p[1]) * self.scale
    }

    fn image(&self, p: Pos2) -> Pos {
        let v = (p - self.rect.min) / self.scale;
        [v.x.clamp(0.0, self.size.x), v.y.clamp(0.0, self.size.y)]
    }

    fn screen_rect(&self, b: Bounds) -> Rect {
        Rect::from_min_max(self.screen([b[0], b[1]]), self.screen([b[2], b[3]]))
    }
}

fn color32(c: Color) -> Color32 {
    Color32::from_rgba_unmultiplied(c[0], c[1], c[2], c[3])
}

impl Editor {
    fn stroke_width(&self) -> f32 {
        WEIGHTS[self.weight] * self.px_per_pt
    }

    fn push(&mut self, shape: Shape) {
        self.shapes.push(shape);
        self.undone.clear();
    }

    fn commit_draft(&mut self) {
        if let Some(d) = self.draft.take()
            && !d.text.trim().is_empty()
        {
            let text = d.text.trim_end().to_string();
            self.push(Shape::Text { at: d.at, text, color: d.color, size: d.size });
        }
    }

    fn finish(&mut self, ctx: &egui::Context, save: bool) {
        self.commit_draft();
        match annotate::render(&self.base, self.crop, &self.shapes) {
            Some(png) => {
                *self.outcome.borrow_mut() =
                    Some(if save { Outcome::Save(png) } else { Outcome::Copy(png) });
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            }
            None => self.error = Some("the crop is empty".into()),
        }
    }

    fn handle_keys(&mut self, ctx: &egui::Context) {
        let pressed = |m, k| ctx.input_mut(|i| i.consume_key(m, k));
        if self.draft.is_some() {
            // The label owns the keyboard: Enter sets it, Esc drops it.
            if pressed(Modifiers::NONE, Key::Enter) {
                self.commit_draft();
            } else if pressed(Modifiers::NONE, Key::Escape) {
                self.draft = None;
            }
            return;
        }
        for tool in Tool::ALL {
            if pressed(Modifiers::NONE, tool.key()) {
                self.tool = tool;
            }
        }
        let digits = [
            Key::Num1,
            Key::Num2,
            Key::Num3,
            Key::Num4,
            Key::Num5,
            Key::Num6,
        ];
        for (i, key) in digits.into_iter().enumerate() {
            if pressed(Modifiers::NONE, key) {
                self.color = i;
            }
        }
        if pressed(Modifiers::NONE, Key::OpenBracket) {
            self.weight = self.weight.saturating_sub(1);
        }
        if pressed(Modifiers::NONE, Key::CloseBracket) {
            self.weight = (self.weight + 1).min(WEIGHTS.len() - 1);
        }
        if pressed(Modifiers::CTRL | Modifiers::SHIFT, Key::Z) {
            self.redo();
        } else if pressed(Modifiers::CTRL, Key::Z) {
            self.undo();
        }
        if pressed(Modifiers::CTRL, Key::S) {
            self.finish(ctx, true);
        } else if pressed(Modifiers::NONE, Key::Enter) || pressed(Modifiers::CTRL, Key::C) {
            self.finish(ctx, false);
        }
        if pressed(Modifiers::NONE, Key::Escape) && self.drag.take().is_none() {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
    }

    fn undo(&mut self) {
        if let Some(s) = self.shapes.pop() {
            self.undone.push(s);
        }
    }

    fn redo(&mut self) {
        if let Some(s) = self.undone.pop() {
            self.shapes.push(s);
        }
    }

    fn canvas(&mut self, ui: &mut egui::Ui) {
        let area = ui.max_rect();
        let resp = ui.allocate_rect(area, Sense::click_and_drag());
        let native = 1.0 / ui.ctx().pixels_per_point();
        let view = View::fit(area, self.base.width(), self.base.height(), native);
        self.px_per_pt = 1.0 / view.scale;
        if resp.hovered() {
            let icon =
                if self.tool == Tool::Text { CursorIcon::Text } else { CursorIcon::Crosshair };
            ui.ctx().set_cursor_icon(icon);
        }
        self.pointer(ui.ctx(), &resp, view);

        let painter = ui.painter_at(area);
        let uv = Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0));
        painter.image(self.tex.id(), view.rect, uv, Color32::WHITE);
        for shape in &self.shapes {
            paint_shape(&painter, view, shape);
        }
        if let Some(Drag::Shape(shape)) = &self.drag {
            paint_shape(&painter, view, shape);
        }
        let crop = match &self.drag {
            Some(Drag::Crop(start)) => resp.interact_pointer_pos().map(|p| {
                let b = annotate::bounds(*start, view.image(p));
                view.screen_rect(b)
            }),
            _ => self.crop.map(|b| view.screen_rect(b)),
        };
        let shade = Color32::from_black_alpha(130);
        match crop {
            Some(c) => {
                let r = view.rect;
                for outside in [
                    Rect::from_min_max(r.min, pos2(r.max.x, c.min.y)),
                    Rect::from_min_max(pos2(r.min.x, c.max.y), r.max),
                    Rect::from_min_max(pos2(r.min.x, c.min.y), pos2(c.min.x, c.max.y)),
                    Rect::from_min_max(pos2(c.max.x, c.min.y), pos2(r.max.x, c.max.y)),
                ] {
                    painter.rect_filled(outside, 0.0, shade);
                }
                painter.rect_stroke(c, 0.0, Stroke::new(1.0, Color32::WHITE), StrokeKind::Outside);
            }
            // Before a region is picked, the dimming says the crop tool is live.
            None if self.tool == Tool::Crop => {
                painter.rect_filled(view.rect, 0.0, Color32::from_black_alpha(60));
            }
            None => {}
        }
        self.draft_ui(ui.ctx(), &painter, view);
    }

    fn pointer(&mut self, ctx: &egui::Context, resp: &egui::Response, view: View) {
        let color = COLORS[self.color];
        let width = self.stroke_width();
        if resp.drag_started() && self.tool != Tool::Text {
            self.commit_draft();
            let origin = ctx.input(|i| i.pointer.press_origin()).or(resp.interact_pointer_pos());
            let start = view.image(origin.unwrap_or_default());
            self.drag = Some(match self.tool {
                Tool::Crop => Drag::Crop(start),
                Tool::Arrow => Drag::Shape(Shape::Arrow { from: start, to: start, color, width }),
                Tool::Rect => Drag::Shape(Shape::Rect {
                    bounds: [start[0], start[1], start[0], start[1]],
                    color,
                    width,
                }),
                Tool::Pen | Tool::Text => {
                    Drag::Shape(Shape::Pen { points: vec![start], color, width })
                }
            });
        }
        if let (Some(p), Some(Drag::Shape(shape))) = (resp.interact_pointer_pos(), &mut self.drag) {
            let p = view.image(p);
            match shape {
                Shape::Arrow { to, .. } => *to = p,
                Shape::Rect { bounds, .. } => {
                    bounds[2] = p[0];
                    bounds[3] = p[1];
                }
                Shape::Pen { points, .. } => {
                    if points.last().is_none_or(|l| (l[0] - p[0]).hypot(l[1] - p[1]) > 1.0) {
                        points.push(p);
                    }
                }
                Shape::Text { .. } => {}
            }
        }
        if resp.drag_stopped() {
            let end = resp.interact_pointer_pos().map(|p| view.image(p));
            match (self.drag.take(), end) {
                (Some(Drag::Crop(start)), Some(end)) => {
                    let b = annotate::bounds(start, end);
                    if b[2] - b[0] > MIN_DRAG && b[3] - b[1] > MIN_DRAG {
                        self.crop = Some(b);
                        // A region picked means it's time to point at things.
                        self.tool = Tool::Arrow;
                    }
                }
                (Some(Drag::Shape(shape)), _) if !too_small(&shape) => self.push(shape),
                _ => {}
            }
        }
        if resp.clicked() {
            self.commit_draft();
            if self.tool == Tool::Text
                && let Some(p) = resp.interact_pointer_pos()
            {
                let size = TEXT_SIZES[self.weight] * self.px_per_pt;
                self.draft = Some(Draft { at: view.image(p), text: String::new(), color, size });
            }
        }
    }

    fn draft_ui(&mut self, ctx: &egui::Context, painter: &egui::Painter, view: View) {
        let Some(draft) = &mut self.draft else {
            return;
        };
        let layout = annotate::text_layout(&draft.text, draft.size);
        let min = view.screen(draft.at);
        // Room for the caret while the label is still empty.
        let width = layout.width.max(draft.size) * view.scale;
        let rect = Rect::from_min_size(min, Vec2::new(width, layout.height * view.scale));
        painter.rect_filled(rect, 0.0, color32(draft.color));
        let inset = Vec2::splat(layout.pad * view.scale);
        egui::Area::new(egui::Id::unique("draft"))
            .fixed_pos(min + inset)
            .order(egui::Order::Foreground)
            .show(ctx, |ui| {
                let edit = egui::TextEdit::multiline(&mut draft.text)
                    .font(FontId::proportional(draft.size * view.scale))
                    .text_color(color32(annotate::contrast(draft.color)))
                    .frame(egui::Frame::NONE)
                    .margin(Vec2::ZERO)
                    .desired_rows(1)
                    .desired_width(width - inset.x * 2.0 + 2.0)
                    .return_key(KeyboardShortcut::new(Modifiers::SHIFT, Key::Enter));
                ui.add(edit).request_focus();
            });
    }

    fn toolbar(&mut self, ctx: &egui::Context) {
        egui::Area::new(egui::Id::unique("toolbar"))
            .anchor(Align2::CENTER_BOTTOM, Vec2::new(0.0, -16.0))
            .order(egui::Order::Foreground)
            .show(ctx, |ui| {
                egui::Frame::popup(ui.style()).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        for tool in Tool::ALL {
                            if ui
                                .add(egui::Button::selectable(self.tool == tool, tool.label()))
                                .clicked()
                            {
                                self.commit_draft();
                                self.tool = tool;
                            }
                        }
                        ui.separator();
                        for (i, c) in COLORS.into_iter().enumerate() {
                            self.swatch(ui, i, c);
                        }
                        ui.separator();
                        for (i, name) in ["S", "M", "L"].into_iter().enumerate() {
                            if ui.add(egui::Button::selectable(self.weight == i, name)).clicked() {
                                self.weight = i;
                            }
                        }
                        ui.separator();
                        if ui.button("Undo").clicked() {
                            self.undo();
                        }
                        if ui.button("Copy  ⏎").clicked() {
                            self.finish(ctx, false);
                        }
                        if ui.button("Save  Ctrl+S").clicked() {
                            self.finish(ctx, true);
                        }
                    });
                    let hint = match (&self.error, self.tool, self.crop) {
                        (Some(e), ..) => e.clone(),
                        (None, Tool::Crop, None) => {
                            "Drag to pick a region — Enter takes it all".into()
                        }
                        (None, Tool::Text, _) => {
                            "Click to place a label — Enter sets it, Shift+Enter breaks a line"
                                .into()
                        }
                        _ => "1–6 color   [ ] size   Ctrl+Z undo   Esc close".into(),
                    };
                    ui.weak(hint);
                });
            });
    }

    fn swatch(&mut self, ui: &mut egui::Ui, i: usize, c: Color) {
        let (rect, resp) = ui.allocate_exact_size(Vec2::splat(20.0), Sense::click());
        let ring = if i == self.color { ui.visuals().strong_text_color() } else { Color32::GRAY };
        ui.painter().circle_filled(rect.center(), 8.0, color32(c));
        ui.painter().circle_stroke(rect.center(), 9.5, Stroke::new(1.5, ring));
        if resp.clicked() {
            self.color = i;
        }
    }
}

fn too_small(shape: &Shape) -> bool {
    match shape {
        Shape::Arrow { from, to, .. } => (to[0] - from[0]).hypot(to[1] - from[1]) < MIN_DRAG,
        Shape::Rect { bounds, .. } => {
            (bounds[2] - bounds[0]).abs() < MIN_DRAG || (bounds[3] - bounds[1]).abs() < MIN_DRAG
        }
        Shape::Pen { .. } | Shape::Text { .. } => false,
    }
}

fn paint_shape(painter: &egui::Painter, view: View, shape: &Shape) {
    match shape {
        Shape::Arrow { from, to, color, width } => {
            let (shaft, head) = annotate::arrow_geometry(*from, *to, *width);
            let (c, w) = (color32(*color), width * view.scale);
            painter.line_segment([view.screen(*from), view.screen(shaft)], Stroke::new(w, c));
            painter.circle_filled(view.screen(*from), w / 2.0, c);
            let head = head.iter().map(|p| view.screen(*p)).collect();
            painter.add(egui::Shape::convex_polygon(head, c, Stroke::NONE));
        }
        Shape::Rect { bounds, color, width } => {
            let rect =
                view.screen_rect(annotate::bounds([bounds[0], bounds[1]], [bounds[2], bounds[3]]));
            let stroke = Stroke::new(width * view.scale, color32(*color));
            painter.rect_stroke(rect, 0.0, stroke, StrokeKind::Middle);
        }
        Shape::Pen { points, color, width } => {
            let (c, w) = (color32(*color), width * view.scale);
            let points: Vec<Pos2> = points.iter().map(|p| view.screen(*p)).collect();
            for end in [points.first(), points.last()].into_iter().flatten() {
                painter.circle_filled(*end, w / 2.0, c);
            }
            painter.add(egui::Shape::line(points, Stroke::new(w, c)));
        }
        Shape::Text { at, text, color, size } => {
            let layout = annotate::text_layout(text, *size);
            let min = view.screen(*at);
            let box_size = Vec2::new(layout.width, layout.height) * view.scale;
            painter.rect_filled(Rect::from_min_size(min, box_size), 0.0, color32(*color));
            let ink = color32(annotate::contrast(*color));
            let font = FontId::proportional(size * view.scale);
            for (i, line) in text.split('\n').enumerate() {
                let y = layout.pad + i as f32 * layout.line_height;
                let pos = min + Vec2::new(layout.pad, y) * view.scale;
                painter.text(pos, Align2::LEFT_TOP, line, font.clone(), ink);
            }
        }
    }
}

impl eframe::App for Editor {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        self.handle_keys(&ctx);
        let frame = egui::Frame::NONE.fill(Color32::from_gray(18));
        egui::CentralPanel::no_frame().frame(frame).show(ui, |ui| self.canvas(ui));
        self.toolbar(&ctx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_round_trips_and_clamps() {
        let area = Rect::from_min_size(pos2(0.0, 0.0), Vec2::new(1000.0, 500.0));
        let view = View::fit(area, 2000, 500, 1.0);
        assert_eq!(view.scale, 0.5);
        assert_eq!(view.image(view.screen([400.0, 100.0])), [400.0, 100.0]);
        assert_eq!(view.image(pos2(-50.0, 9999.0)), [0.0, 500.0]);
        assert_eq!(View::fit(area, 100, 50, 1.0).scale, 1.0);
    }
}
