//! Decoding, turning upright, leveling and encoding. Previews and saved photos go through the
//! same functions so what the preview shows is what gets written.

use crate::exif::{self, Tiff};
use crate::Error;

/// 8-bit RGB pixels, rows top to bottom.
#[derive(Clone, Debug, PartialEq)]
pub struct Rgb {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<u8>,
}

impl Rgb {
    pub fn new(width: usize, height: usize) -> Self {
        Rgb { width, height, pixels: vec![0; width * height * 3] }
    }
}

/// A decoded JPEG and the metadata that travels with its pixels.
pub struct Decoded {
    /// As stored in the file (not yet turned upright).
    pub image: Rgb,
    pub orientation: u16,
    pub exif: Option<Vec<u8>>,
    pub icc: Option<Vec<u8>>,
    /// Stored size of the full image (before any scaled decode).
    pub full_width: u32,
    pub full_height: u32,
}

/// Decode a JPEG. With `max_edge`, the decoder skips detail it does not need (1/2, 1/4 or 1/8
/// scale) and the result is then reduced to fit `max_edge`.
pub fn decode(data: &[u8], max_edge: Option<u32>) -> Result<Decoded, Error> {
    let mut decoder = jpeg_decoder::Decoder::new(data);
    decoder.read_info().map_err(|_| Error::Unreadable)?;
    let info = decoder.info().ok_or(Error::Unreadable)?;
    let (full_width, full_height) = (info.width as u32, info.height as u32);
    if let Some(edge) = max_edge {
        let edge = edge.min(u16::MAX as u32) as u16;
        decoder.scale(edge, edge).map_err(|_| Error::Unreadable)?;
    }
    let raw = decoder.decode().map_err(|_| Error::Unreadable)?;
    let info = decoder.info().ok_or(Error::Unreadable)?;
    let (width, height) = (info.width as usize, info.height as usize);
    let pixels = match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => raw,
        jpeg_decoder::PixelFormat::L8 => raw.iter().flat_map(|&v| [v, v, v]).collect(),
        _ => return Err(Error::Unsupported),
    };
    if pixels.len() != width * height * 3 {
        return Err(Error::Unreadable);
    }
    let exif = decoder.exif_data().map(<[u8]>::to_vec);
    let orientation = exif.as_deref().and_then(Tiff::new).map_or(1, |t| t.orientation());
    let mut image = Rgb { width, height, pixels };
    if let Some(edge) = max_edge {
        image = fit(&image, edge as usize);
    }
    Ok(Decoded { image, orientation, exif, icc: decoder.icc_profile(), full_width, full_height })
}

/// Shrink (never enlarge) so the longer edge is at most `edge`, averaging the covered pixels.
pub fn fit(src: &Rgb, edge: usize) -> Rgb {
    let longest = src.width.max(src.height);
    if longest <= edge || edge == 0 {
        return src.clone();
    }
    let scale = edge as f64 / longest as f64;
    let width = ((src.width as f64 * scale).round() as usize).max(1);
    let height = ((src.height as f64 * scale).round() as usize).max(1);
    let mut out = Rgb::new(width, height);
    let span = |i: usize, n: usize, m: usize| (i * m / n, ((i + 1) * m).div_ceil(n).max(i * m / n + 1).min(m));
    for y in 0..height {
        let (y0, y1) = span(y, height, src.height);
        for x in 0..width {
            let (x0, x1) = span(x, width, src.width);
            let mut sum = [0u32; 3];
            for sy in y0..y1 {
                let row = &src.pixels[(sy * src.width + x0) * 3..(sy * src.width + x1) * 3];
                for px in row.chunks_exact(3) {
                    sum[0] += px[0] as u32;
                    sum[1] += px[1] as u32;
                    sum[2] += px[2] as u32;
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as u32;
            let o = (y * width + x) * 3;
            for c in 0..3 {
                out.pixels[o + c] = ((sum[c] + n / 2) / n) as u8;
            }
        }
    }
    out
}

/// Turn stored pixels upright according to EXIF orientation 1–8.
pub fn upright(src: &Rgb, orientation: u16) -> Rgb {
    if !(2..=8).contains(&orientation) {
        return src.clone();
    }
    let (w, h) = (src.width, src.height);
    let swap = orientation >= 5;
    let (ow, oh) = if swap { (h, w) } else { (w, h) };
    let mut out = Rgb::new(ow, oh);
    for y in 0..oh {
        for x in 0..ow {
            let (sx, sy) = match orientation {
                2 => (w - 1 - x, y),
                3 => (w - 1 - x, h - 1 - y),
                4 => (x, h - 1 - y),
                5 => (y, x),
                6 => (y, h - 1 - x),
                7 => (w - 1 - y, h - 1 - x),
                _ => (w - 1 - y, x), // 8
            };
            let s = (sy * w + sx) * 3;
            let o = (y * ow + x) * 3;
            out.pixels[o..o + 3].copy_from_slice(&src.pixels[s..s + 3]);
        }
    }
    out
}

pub const LEVEL_LIMIT: f64 = 15.0;

/// How much a level rotation must enlarge the photo so no empty corner shows. The preview
/// (CSS `rotate(-θ) scale(zoom)`) uses the same value.
pub fn level_zoom(width: f64, height: f64, degrees: f64) -> f64 {
    let angle = degrees.clamp(-LEVEL_LIMIT, LEVEL_LIMIT).to_radians();
    let aspect = (width / height).max(height / width);
    angle.cos().abs() + angle.sin().abs() * aspect
}

/// Rotate around the center (positive = counterclockwise on screen) and enlarge just enough
/// to fill the original frame, which keeps the pixel size and aspect ratio.
pub fn level(src: &Rgb, degrees: f64) -> Rgb {
    let degrees = degrees.clamp(-LEVEL_LIMIT, LEVEL_LIMIT);
    if degrees == 0.0 || src.width == 0 || src.height == 0 {
        return src.clone();
    }
    let (w, h) = (src.width, src.height);
    let zoom = level_zoom(w as f64, h as f64, degrees);
    let (s, c) = degrees.to_radians().sin_cos();
    let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
    let mut out = Rgb::new(w, h);
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(1, 16);
    let rows_per = h.div_ceil(threads);
    std::thread::scope(|scope| {
        for (band, chunk) in out.pixels.chunks_mut(rows_per * w * 3).enumerate() {
            scope.spawn(move || {
                for (r, row) in chunk.chunks_exact_mut(w * 3).enumerate() {
                    let y = band * rows_per + r;
                    let v = y as f64 + 0.5 - cy;
                    for x in 0..w {
                        let u = x as f64 + 0.5 - cx;
                        // Inverse of the on-screen counterclockwise turn (y grows downward).
                        let sx = (c * u - s * v) / zoom + cx - 0.5;
                        let sy = (s * u + c * v) / zoom + cy - 0.5;
                        let px = sample(src, sx, sy);
                        row[x * 3..x * 3 + 3].copy_from_slice(&px);
                    }
                }
            });
        }
    });
    out
}

fn sample(src: &Rgb, x: f64, y: f64) -> [u8; 3] {
    let x = x.clamp(0.0, (src.width - 1) as f64);
    let y = y.clamp(0.0, (src.height - 1) as f64);
    let (x0, y0) = (x.floor() as usize, y.floor() as usize);
    let (x1, y1) = ((x0 + 1).min(src.width - 1), (y0 + 1).min(src.height - 1));
    let (fx, fy) = (x - x0 as f64, y - y0 as f64);
    let at = |xx: usize, yy: usize, c: usize| src.pixels[(yy * src.width + xx) * 3 + c] as f64;
    let mut px = [0u8; 3];
    for (c, out) in px.iter_mut().enumerate() {
        let top = at(x0, y0, c) * (1.0 - fx) + at(x1, y0, c) * fx;
        let bottom = at(x0, y1, c) * (1.0 - fx) + at(x1, y1, c) * fx;
        *out = (top * (1.0 - fy) + bottom * fy).round().clamp(0.0, 255.0) as u8;
    }
    px
}

/// Baseline JPEG, 4:2:2 like most camera files. Exif (TIFF bytes) and ICC are embedded as given;
/// an Exif block too large for one segment is left out rather than failing the photo.
pub fn encode_jpeg(image: &Rgb, quality: u8, exif: Option<&[u8]>, icc: Option<&[u8]>) -> Result<Vec<u8>, Error> {
    if image.width > u16::MAX as usize || image.height > u16::MAX as usize {
        return Err(Error::Unsupported);
    }
    let mut out = Vec::with_capacity(image.width * image.height / 2);
    let mut encoder = jpeg_encoder::Encoder::new(&mut out, quality);
    encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_2_2);
    if let Some(exif) = exif.filter(|e| e.len() <= 65_528) {
        encoder.add_exif_metadata(exif).map_err(|_| Error::Encode)?;
    }
    if let Some(icc) = icc {
        let _ = encoder.add_icc_profile(icc);
    }
    encoder
        .encode(&image.pixels, image.width as u16, image.height as u16, jpeg_encoder::ColorType::Rgb)
        .map_err(|_| Error::Encode)?;
    Ok(out)
}

/// Lossy WebP at `quality` (100 is the best lossy setting, not lossless). Exif and ICC go into
/// the extended container so capture details and the color space survive.
pub fn encode_webp(image: &Rgb, quality: u8, exif: Option<&[u8]>, icc: Option<&[u8]>) -> Result<Vec<u8>, Error> {
    if image.width > 16_383 || image.height > 16_383 {
        return Err(Error::Unsupported);
    }
    let mut config = webp::WebPConfig::new().map_err(|_| Error::Encode)?;
    config.quality = quality as f32;
    config.method = 4;
    config.thread_level = 1;
    let encoded = webp::Encoder::from_rgb(&image.pixels, image.width as u32, image.height as u32)
        .encode_advanced(&config)
        .map_err(|_| Error::Encode)?;
    Ok(with_metadata(&encoded, image.width as u32, image.height as u32, exif, icc))
}

fn chunk(out: &mut Vec<u8>, id: &[u8; 4], body: &[u8]) {
    out.extend_from_slice(id);
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(body);
    if body.len() % 2 == 1 {
        out.push(0);
    }
}

/// Rewrap a simple WebP (RIFF/WEBP + one image chunk) as VP8X with ICCP and EXIF chunks.
pub fn with_metadata(webp: &[u8], width: u32, height: u32, exif: Option<&[u8]>, icc: Option<&[u8]>) -> Vec<u8> {
    let simple = webp.len() > 20 && &webp[..4] == b"RIFF" && &webp[8..12] == b"WEBP" && matches!(&webp[12..16], b"VP8 " | b"VP8L");
    if !simple || (exif.is_none() && icc.is_none()) {
        return webp.to_vec();
    }
    let mut flags = 0u8;
    if icc.is_some() {
        flags |= 0x20;
    }
    if exif.is_some() {
        flags |= 0x08;
    }
    let mut vp8x = vec![flags, 0, 0, 0];
    vp8x.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
    vp8x.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
    let mut body = b"WEBP".to_vec();
    chunk(&mut body, b"VP8X", &vp8x);
    if let Some(icc) = icc {
        chunk(&mut body, b"ICCP", icc);
    }
    body.extend_from_slice(&webp[12..]);
    if let Some(exif) = exif {
        chunk(&mut body, b"EXIF", exif);
    }
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

/// Small upright JPEG for the photo list: the camera's embedded thumbnail when it has the same
/// shape as the photo (some are letterboxed), otherwise a fast 1/8-scale decode.
pub fn thumbnail(data: &[u8], edge: u32) -> Result<Vec<u8>, Error> {
    let header = exif::jpeg_header(data).ok_or(Error::Unreadable)?;
    let tiff = header.exif.clone().and_then(|r| data.get(r)).and_then(Tiff::new);
    let orientation = tiff.map_or(1, |t| t.orientation());
    let embedded = tiff.and_then(|t| t.thumbnail()).and_then(|thumb| {
        let th = exif::jpeg_header(thumb)?;
        let (a, b) = (th.width as f64 / th.height.max(1) as f64, header.width as f64 / header.height.max(1) as f64);
        ((a / b - 1.0).abs() < 0.02).then(|| decode(thumb, Some(edge)).ok()).flatten()
    });
    let small = match embedded {
        Some(d) => d.image,
        None => decode(data, Some(edge))?.image,
    };
    encode_jpeg(&upright(&small, orientation), 82, None, None)
}

/// What the preview needs: the photo upright and reduced to `edge`, plus its full upright size
/// and capture details.
pub struct Preview {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub info: exif::CameraInfo,
}

pub fn preview(data: &[u8], edge: u32) -> Result<Preview, Error> {
    let decoded = decode(data, Some(edge))?;
    let image = upright(&decoded.image, decoded.orientation);
    let jpeg = encode_jpeg(&image, 90, None, decoded.icc.as_deref())?;
    let (w, h) = (decoded.full_width, decoded.full_height);
    let (width, height) = if decoded.orientation >= 5 { (h, w) } else { (w, h) };
    let info = decoded.exif.as_deref().and_then(Tiff::new).map(|t| t.info()).unwrap_or_default();
    Ok(Preview { jpeg, width, height, info })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(w: usize, h: usize) -> Rgb {
        let mut img = Rgb::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let o = (y * w + x) * 3;
                img.pixels[o] = (x * 255 / (w - 1)) as u8;
                img.pixels[o + 1] = (y * 255 / (h - 1)) as u8;
                img.pixels[o + 2] = 40;
            }
        }
        img
    }

    #[test]
    fn upright_matches_exif_definitions() {
        // 3x2 image with distinct values: stored row-major [0 1 2 / 3 4 5].
        let mut img = Rgb::new(3, 2);
        for i in 0..6 {
            img.pixels[i * 3] = i as u8;
        }
        let read = |r: &Rgb| r.pixels.chunks(3).map(|p| p[0]).collect::<Vec<_>>();
        assert_eq!(read(&upright(&img, 1)), [0, 1, 2, 3, 4, 5]);
        assert_eq!(read(&upright(&img, 2)), [2, 1, 0, 5, 4, 3]);
        assert_eq!(read(&upright(&img, 3)), [5, 4, 3, 2, 1, 0]);
        assert_eq!(read(&upright(&img, 4)), [3, 4, 5, 0, 1, 2]);
        // 6: the camera was turned clockwise; the left column becomes the top row, read bottom-up.
        let six = upright(&img, 6);
        assert_eq!((six.width, six.height), (2, 3));
        assert_eq!(read(&six), [3, 0, 4, 1, 5, 2]);
        assert_eq!(read(&upright(&img, 8)), [2, 5, 1, 4, 0, 3]);
        assert_eq!(read(&upright(&img, 5)), [0, 3, 1, 4, 2, 5]);
        assert_eq!(read(&upright(&img, 7)), [5, 2, 4, 1, 3, 0]);
    }

    #[test]
    fn positive_level_turns_counterclockwise_and_fills_the_frame() {
        let (w, h) = (300, 200);
        let mut img = Rgb::new(w, h);
        // A bright dot right of center.
        for y in 98..102 {
            for x in 218..222 {
                img.pixels[(y * w + x) * 3] = 255;
            }
        }
        let out = level(&img, 10.0);
        assert_eq!((out.width, out.height), (w, h));
        let (mut sx, mut sy, mut n) = (0.0, 0.0, 0.0);
        for y in 0..h {
            for x in 0..w {
                let v = out.pixels[(y * w + x) * 3] as f64;
                sx += x as f64 * v;
                sy += y as f64 * v;
                n += v;
            }
        }
        let (dx, dy) = (sx / n - w as f64 / 2.0, sy / n - h as f64 / 2.0);
        // Counterclockwise on screen: the dot moves up (smaller y), and the zoom pushes it outward.
        let angle = (-dy).atan2(dx).to_degrees();
        assert!((angle - 10.0).abs() < 1.0, "angle {angle}");
        let radius = (dx * dx + dy * dy).sqrt();
        assert!((radius - 70.0 * level_zoom(300.0, 200.0, 10.0)).abs() < 2.0, "radius {radius}");
        // No empty corner: every pixel of a solid image stays solid.
        let mut solid = Rgb::new(w, h);
        solid.pixels.fill(200);
        assert!(level(&solid, -15.0).pixels.iter().all(|&v| v == 200));
    }

    #[test]
    fn jpeg_and_webp_round_trip_with_metadata() {
        let img = gradient(64, 48);
        let tiff = crate::exif::tests::sample_tiff(false, 6, &[0xFF, 0xD8, 0, 0]);
        let fixed = crate::exif::normalized(&tiff, 64, 48).unwrap();
        let jpeg = encode_jpeg(&img, 95, Some(&fixed), None).unwrap();
        let back = decode(&jpeg, None).unwrap();
        assert_eq!((back.image.width, back.image.height), (64, 48));
        assert_eq!(back.orientation, 1);
        assert_eq!(back.exif.as_deref(), Some(&fixed[..]));
        let diff = back.image.pixels.iter().zip(&img.pixels).map(|(a, b)| (*a as i32 - *b as i32).abs()).max().unwrap();
        assert!(diff < 12, "jpeg error {diff}");

        let webp = encode_webp(&img, 72, Some(&fixed), Some(b"icc!")).unwrap();
        assert_eq!(&webp[12..16], b"VP8X");
        assert_eq!(u32::from_le_bytes(webp[4..8].try_into().unwrap()) as usize, webp.len() - 8);
        assert!(webp.windows(4).any(|w| w == b"EXIF") && webp.windows(4).any(|w| w == b"ICCP"));
        let decoded = webp::Decoder::new(&webp).decode().unwrap();
        assert_eq!((decoded.width(), decoded.height()), (64, 48));
    }

    #[test]
    fn previews_and_thumbnails_are_upright_and_small() {
        let img = gradient(400, 200);
        let tiff = crate::exif::tests::sample_tiff(true, 6, &[0xFF, 0xD8, 0, 0]);
        let jpeg = encode_jpeg(&img, 90, Some(&tiff), None).unwrap();
        let p = preview(&jpeg, 100).unwrap();
        assert_eq!((p.width, p.height), (200, 400));
        let shown = decode(&p.jpeg, None).unwrap().image;
        assert_eq!((shown.width, shown.height), (50, 100));
        assert_eq!(p.info.iso, Some(800));
        // The fake embedded thumbnail is not a decodable JPEG, so the 1/8 decode is used.
        let t = decode(&thumbnail(&jpeg, 40).unwrap(), None).unwrap().image;
        assert_eq!((t.width, t.height), (20, 40));
    }
}
