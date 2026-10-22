//! Decoding clipboard images: sniffing, dimensions, and the stored thumbnail.

use std::io::Cursor;

use image::{ImageFormat, ImageReader};

/// Longest edge of the thumbnail stored beside each image.
pub const THUMB_EDGE: u32 = 320;

pub struct Probed {
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
    /// PNG-encoded, at most [`THUMB_EDGE`] on the long side.
    pub thumb: Vec<u8>,
}

/// `None` when the bytes are not an image this crate can decode.
pub fn probe(bytes: &[u8]) -> Option<Probed> {
    let format = image::guess_format(bytes).ok()?;
    let img = ImageReader::with_format(Cursor::new(bytes), format).decode().ok()?;
    let thumb = img.thumbnail(THUMB_EDGE, THUMB_EDGE);
    let mut png = Vec::new();
    thumb.write_to(&mut Cursor::new(&mut png), ImageFormat::Png).ok()?;
    Some(Probed {
        mime: format.to_mime_type(),
        width: img.width(),
        height: img.height(),
        thumb: png,
    })
}

/// RGBA pixels for display, downscaled so the long edge is at most `max_edge`.
pub fn decode_rgba(bytes: &[u8], max_edge: u32) -> Option<(u32, u32, Vec<u8>)> {
    let mut img = image::load_from_memory(bytes).ok()?;
    if img.width().max(img.height()) > max_edge {
        img = img.resize(max_edge, max_edge, image::imageops::FilterType::Triangle);
    }
    let rgba = img.into_rgba8();
    Some((rgba.width(), rgba.height(), rgba.into_raw()))
}

#[cfg(test)]
pub(crate) fn test_png(width: u32, height: u32) -> Vec<u8> {
    let img = image::RgbaImage::from_pixel(width, height, image::Rgba([200, 30, 30, 255]));
    let mut png = Vec::new();
    img.write_to(&mut Cursor::new(&mut png), ImageFormat::Png).unwrap();
    png
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_reads_dimensions_and_thumbnails_the_long_edge() {
        let p = probe(&test_png(1280, 640)).unwrap();
        assert_eq!((p.mime, p.width, p.height), ("image/png", 1280, 640));
        let (w, h, _) = decode_rgba(&p.thumb, u32::MAX).unwrap();
        assert_eq!((w, h), (THUMB_EDGE, THUMB_EDGE / 2));
    }

    #[test]
    fn probe_rejects_text() {
        assert!(probe(b"just some words").is_none());
    }
}
