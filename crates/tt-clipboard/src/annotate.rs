//! Screenshot markup: the shapes an editor draws, in image pixels, and the
//! rasterizer that bakes them into the PNG that gets copied.
//!
//! Geometry (arrowheads, text boxes) lives here so the editor's preview and the
//! export draw the same thing.

use std::io::Cursor;

use ab_glyph::{Font, FontRef, PxScale, ScaleFont, point};
use image::{ImageFormat, RgbaImage};
use tiny_skia::{
    FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, PremultipliedColorU8, Stroke,
    Transform,
};

pub type Pos = [f32; 2];
pub type Color = [u8; 4];

/// An axis-aligned box: min x, min y, max x, max y.
pub type Bounds = [f32; 4];

#[derive(Debug, Clone, PartialEq)]
pub enum Shape {
    Arrow {
        from: Pos,
        to: Pos,
        color: Color,
        width: f32,
    },
    Rect {
        bounds: Bounds,
        color: Color,
        width: f32,
    },
    Pen {
        points: Vec<Pos>,
        color: Color,
        width: f32,
    },
    /// A filled label: `at` is the box's top-left, `size` the font's em height.
    Text {
        at: Pos,
        text: String,
        color: Color,
        size: f32,
    },
}

/// The font both the editor and the export set labels in; egui's default face.
pub fn font() -> FontRef<'static> {
    FontRef::try_from_slice(epaint_default_fonts::UBUNTU_LIGHT).expect("bundled font parses")
}

/// `size` as an em height, the way egui sizes its fonts.
fn px_scale(font: &FontRef, size: f32) -> PxScale {
    PxScale::from(size * font.height_unscaled() / font.units_per_em().unwrap_or(1000.0))
}

/// Normalize two corners into [`Bounds`].
pub fn bounds(a: Pos, b: Pos) -> Bounds {
    [
        a[0].min(b[0]),
        a[1].min(b[1]),
        a[0].max(b[0]),
        a[1].max(b[1]),
    ]
}

/// Where the shaft stops and the head's three corners (tip first).
pub fn arrow_geometry(from: Pos, to: Pos, width: f32) -> (Pos, [Pos; 3]) {
    let (dx, dy) = (to[0] - from[0], to[1] - from[1]);
    let len = dx.hypot(dy).max(f32::EPSILON);
    let (ux, uy) = (dx / len, dy / len);
    // The head never outgrows the arrow, so a short drag still reads as one.
    let head = (width * 4.0).max(12.0).min(len);
    let half = head * 0.55;
    let base = [to[0] - ux * head, to[1] - uy * head];
    let left = [base[0] - uy * half, base[1] + ux * half];
    let right = [base[0] + uy * half, base[1] - ux * half];
    // Stop the round-capped shaft inside the head so its cap stays hidden.
    let shaft = [to[0] - ux * head * 0.6, to[1] - uy * head * 0.6];
    (shaft, [to, left, right])
}

/// The label's padding, line height and box size for `text` at `size`.
pub struct TextLayout {
    pub pad: f32,
    pub line_height: f32,
    pub width: f32,
    pub height: f32,
}

pub fn text_layout(text: &str, size: f32) -> TextLayout {
    let font = font();
    let scaled = font.as_scaled(px_scale(&font, size));
    let line_height = scaled.height() + scaled.line_gap();
    let widest = text.split('\n').map(|line| line_width(&scaled, line)).fold(0.0, f32::max);
    let lines = text.split('\n').count().max(1) as f32;
    let pad = size * 0.35;
    TextLayout {
        pad,
        line_height,
        width: widest + pad * 2.0,
        height: lines * line_height + pad * 2.0,
    }
}

fn line_width<F: Font>(scaled: &impl ScaleFont<F>, line: &str) -> f32 {
    let mut prev = None;
    line.chars().fold(0.0, |x, c| {
        let id = scaled.glyph_id(c);
        let kern = prev.map_or(0.0, |p| scaled.kern(p, id));
        prev = Some(id);
        x + kern + scaled.h_advance(id)
    })
}

/// Black or white, whichever reads on `bg`.
pub fn contrast(bg: Color) -> Color {
    let luma = 0.299 * bg[0] as f32 + 0.587 * bg[1] as f32 + 0.114 * bg[2] as f32;
    if luma > 150.0 { [0, 0, 0, 255] } else { [255, 255, 255, 255] }
}

/// Crop `base` to `crop` (whole image when `None`), draw `shapes` over it, and
/// encode the result as PNG.
pub fn render(base: &RgbaImage, crop: Option<Bounds>, shapes: &[Shape]) -> Option<Vec<u8>> {
    let (w, h) = (base.width() as f32, base.height() as f32);
    let [x0, y0, x1, y1] = crop.map_or([0.0, 0.0, w, h], |c| bounds([c[0], c[1]], [c[2], c[3]]));
    let (x0, y0) = (x0.clamp(0.0, w).round() as u32, y0.clamp(0.0, h).round() as u32);
    let (x1, y1) = (x1.clamp(0.0, w).round() as u32, y1.clamp(0.0, h).round() as u32);
    let (cw, ch) = (x1.checked_sub(x0)?.max(1), y1.checked_sub(y0)?.max(1));
    let cropped = image::imageops::crop_imm(base, x0, y0, cw, ch).to_image();

    let mut pixmap = Pixmap::new(cw, ch)?;
    for (dst, src) in pixmap.pixels_mut().iter_mut().zip(cropped.pixels()) {
        let [r, g, b, a] = src.0;
        *dst = tiny_skia::ColorU8::from_rgba(r, g, b, a).premultiply();
    }
    let offset = [x0 as f32, y0 as f32];
    let at = |p: Pos| [p[0] - offset[0], p[1] - offset[1]];
    for shape in shapes {
        match shape {
            Shape::Arrow { from, to, color, width } => {
                let (shaft, head) = arrow_geometry(at(*from), at(*to), *width);
                stroke(&mut pixmap, &[at(*from), shaft], *color, *width);
                fill(&mut pixmap, &head, *color);
            }
            Shape::Rect { bounds, color, width } => {
                let [a, b] = [at([bounds[0], bounds[1]]), at([bounds[2], bounds[3]])];
                stroke(&mut pixmap, &[a, [b[0], a[1]], b, [a[0], b[1]], a], *color, *width);
            }
            Shape::Pen { points, color, width } => {
                let points: Vec<Pos> = points.iter().copied().map(at).collect();
                stroke(&mut pixmap, &points, *color, *width);
            }
            Shape::Text { at: origin, text, color, size } => {
                draw_text(&mut pixmap, at(*origin), text, *color, *size);
            }
        }
    }

    let rgba: Vec<u8> = pixmap
        .pixels()
        .iter()
        .flat_map(|p| {
            let c = p.demultiply();
            [c.red(), c.green(), c.blue(), c.alpha()]
        })
        .collect();
    let img = RgbaImage::from_raw(cw, ch, rgba)?;
    let mut png = Vec::new();
    img.write_to(&mut Cursor::new(&mut png), ImageFormat::Png).ok()?;
    Some(png)
}

fn paint(color: Color) -> Paint<'static> {
    let mut paint = Paint::default();
    paint.set_color_rgba8(color[0], color[1], color[2], color[3]);
    paint.anti_alias = true;
    paint
}

fn path(points: &[Pos]) -> Option<tiny_skia::Path> {
    let (first, rest) = points.split_first()?;
    let mut pb = PathBuilder::new();
    pb.move_to(first[0], first[1]);
    if rest.is_empty() {
        // A single click still leaves a dot.
        pb.line_to(first[0] + 0.01, first[1]);
    }
    for p in rest {
        pb.line_to(p[0], p[1]);
    }
    pb.finish()
}

fn stroke(pixmap: &mut Pixmap, points: &[Pos], color: Color, width: f32) {
    let Some(path) = path(points) else {
        return;
    };
    let stroke =
        Stroke { width, line_cap: LineCap::Round, line_join: LineJoin::Round, ..Stroke::default() };
    pixmap.stroke_path(&path, &paint(color), &stroke, Transform::identity(), None);
}

fn fill(pixmap: &mut Pixmap, points: &[Pos], color: Color) {
    let Some((first, rest)) = points.split_first() else {
        return;
    };
    let mut pb = PathBuilder::new();
    pb.move_to(first[0], first[1]);
    for p in rest {
        pb.line_to(p[0], p[1]);
    }
    pb.close();
    if let Some(path) = pb.finish() {
        pixmap.fill_path(&path, &paint(color), FillRule::Winding, Transform::identity(), None);
    }
}

fn draw_text(pixmap: &mut Pixmap, at: Pos, text: &str, color: Color, size: f32) {
    let layout = text_layout(text, size);
    if let Some(rect) = tiny_skia::Rect::from_xywh(at[0], at[1], layout.width, layout.height) {
        pixmap.fill_rect(rect, &paint(color), Transform::identity(), None);
    }
    let ink = contrast(color);
    let font = font();
    let scale = px_scale(&font, size);
    let scaled = font.as_scaled(scale);
    for (i, line) in text.split('\n').enumerate() {
        let baseline = at[1] + layout.pad + i as f32 * layout.line_height + scaled.ascent();
        let mut x = at[0] + layout.pad;
        let mut prev = None;
        for c in line.chars() {
            let id = scaled.glyph_id(c);
            x += prev.map_or(0.0, |p| scaled.kern(p, id));
            prev = Some(id);
            let glyph = id.with_scale_and_position(scale, point(x, baseline));
            x += scaled.h_advance(id);
            let Some(outline) = font.outline_glyph(glyph) else {
                continue;
            };
            let min = outline.px_bounds().min;
            outline.draw(|gx, gy, coverage| {
                blend(pixmap, min.x as i32 + gx as i32, min.y as i32 + gy as i32, ink, coverage);
            });
        }
    }
}

/// Source-over one pixel of `color` at `coverage`.
fn blend(pixmap: &mut Pixmap, x: i32, y: i32, color: Color, coverage: f32) {
    let (w, h) = (pixmap.width() as i32, pixmap.height() as i32);
    if x < 0 || y < 0 || x >= w || y >= h {
        return;
    }
    let a = coverage.clamp(0.0, 1.0) * color[3] as f32 / 255.0;
    let px = &mut pixmap.pixels_mut()[(y * w + x) as usize];
    let mix = |src: u8, dst: u8| (src as f32 * a + dst as f32 * (1.0 - a)).round() as u8;
    let out_a = mix(255, px.alpha());
    let (r, g, b) = (mix(color[0], px.red()), mix(color[1], px.green()), mix(color[2], px.blue()));
    // Premultiplied channels never exceed alpha.
    if let Some(p) =
        PremultipliedColorU8::from_rgba(r.min(out_a), g.min(out_a), b.min(out_a), out_a)
    {
        *px = p;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RED: Color = [230, 40, 40, 255];

    fn base(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_pixel(w, h, image::Rgba([255, 255, 255, 255]))
    }

    fn decode(png: &[u8]) -> RgbaImage {
        image::load_from_memory(png).unwrap().into_rgba8()
    }

    #[test]
    fn render_crops_to_the_region() {
        let png = render(&base(200, 100), Some([150.0, 80.0, 20.0, 10.0]), &[]).unwrap();
        assert_eq!(decode(&png).dimensions(), (130, 70));
    }

    #[test]
    fn shapes_land_relative_to_the_crop() {
        let rect = Shape::Rect { bounds: [20.0, 20.0, 60.0, 60.0], color: RED, width: 4.0 };
        let img =
            decode(&render(&base(100, 100), Some([10.0, 10.0, 90.0, 90.0]), &[rect]).unwrap());
        // The rect's left edge, at x = 20 in the source, is x = 10 after the crop.
        assert_eq!(img.get_pixel(10, 30).0, RED);
        assert_eq!(img.get_pixel(30, 30).0, [255, 255, 255, 255]);
    }

    #[test]
    fn arrow_head_points_at_the_target() {
        let (shaft, [tip, left, right]) = arrow_geometry([0.0, 0.0], [100.0, 0.0], 4.0);
        assert_eq!(tip, [100.0, 0.0]);
        assert!(shaft[0] < 100.0 && shaft[0] > left[0]);
        assert_eq!(left[0], right[0]);
        assert!(left[1] > 0.0 && right[1] < 0.0);
    }

    #[test]
    fn text_draws_a_filled_label() {
        let label =
            Shape::Text { at: [5.0, 5.0], text: "Hi\nthere".into(), color: RED, size: 20.0 };
        let layout = text_layout("Hi\nthere", 20.0);
        assert!(layout.height > layout.line_height * 2.0);
        let img = decode(&render(&base(200, 120), None, &[label]).unwrap());
        assert_eq!(img.get_pixel(6, 6).0, RED);
        let inked = (5..5 + layout.width as u32)
            .flat_map(|x| (5..5 + layout.height as u32).map(move |y| (x, y)))
            .any(|(x, y)| img.get_pixel(x, y).0[1] > 200);
        assert!(inked, "white glyphs on the red label");
    }

    #[test]
    fn contrast_picks_a_readable_ink() {
        assert_eq!(contrast([255, 220, 0, 255]), [0, 0, 0, 255]);
        assert_eq!(contrast(RED), [255, 255, 255, 255]);
    }
}
