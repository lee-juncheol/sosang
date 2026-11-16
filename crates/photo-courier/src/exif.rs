//! Just enough of JPEG and TIFF/Exif to read camera details, find the embedded thumbnail and
//! rewrite the few tags that must follow new pixels. Anything malformed reads as "absent".

use std::ops::Range;

/// Markers before the first scan of a JPEG file.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct JpegHeader {
    pub width: u32,
    pub height: u32,
    /// TIFF bytes of the Exif APP1 segment (after "Exif\0\0").
    pub exif: Option<Range<usize>>,
}

/// Walk the markers up to the first scan. `None` when the data does not start like a JPEG.
pub fn jpeg_header(data: &[u8]) -> Option<JpegHeader> {
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return None;
    }
    let mut header = JpegHeader::default();
    let mut i = 2;
    while i + 4 <= data.len() {
        if data[i] != 0xFF {
            return None;
        }
        let marker = data[i + 1];
        if marker == 0xFF {
            i += 1; // Fill byte.
            continue;
        }
        if marker == 0xD8 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            i += 2;
            continue;
        }
        if marker == 0xD9 || marker == 0xDA {
            break;
        }
        let len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
        let start = i + 4;
        let end = (i + 2 + len).min(data.len());
        if len < 2 || start > end {
            return None;
        }
        let body = &data[start..end];
        let is_sof = matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if is_sof && body.len() >= 5 {
            header.height = u16::from_be_bytes([body[1], body[2]]) as u32;
            header.width = u16::from_be_bytes([body[3], body[4]]) as u32;
        } else if marker == 0xE1 && header.exif.is_none() && body.starts_with(b"Exif\0\0") {
            header.exif = Some(start + 6..end);
        }
        i = i + 2 + len;
    }
    Some(header)
}

/// A TIFF structure (the body of an Exif block). Offsets are relative to its start.
#[derive(Clone, Copy)]
pub struct Tiff<'a> {
    data: &'a [u8],
    little: bool,
}

#[derive(Clone, Copy, Debug)]
struct Entry {
    /// Position of the 12-byte entry.
    at: usize,
    tag: u16,
    kind: u16,
    count: u32,
}

const IFD_EXIF: u16 = 0x8769;
const TAG_ORIENTATION: u16 = 0x0112;

impl<'a> Tiff<'a> {
    pub fn new(data: &'a [u8]) -> Option<Self> {
        let little = match data.get(..4)? {
            [b'I', b'I', 42, 0] => true,
            [b'M', b'M', 0, 42] => false,
            _ => return None,
        };
        Some(Tiff { data, little })
    }

    fn u16(&self, at: usize) -> Option<u16> {
        let b = self.data.get(at..at + 2)?;
        Some(if self.little { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) })
    }

    fn u32(&self, at: usize) -> Option<u32> {
        let b = self.data.get(at..at + 4)?;
        let b = [b[0], b[1], b[2], b[3]];
        Some(if self.little { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) })
    }

    fn ifd0(&self) -> Option<usize> {
        self.u32(4).map(|v| v as usize)
    }

    fn entries(&self, ifd: usize) -> Vec<Entry> {
        let Some(count) = self.u16(ifd) else { return Vec::new() };
        (0..count as usize)
            .map_while(|i| {
                let at = ifd + 2 + i * 12;
                Some(Entry { at, tag: self.u16(at)?, kind: self.u16(at + 2)?, count: self.u32(at + 4)? })
            })
            .collect()
    }

    /// Offset of the IFD that follows `ifd`, if any.
    fn next_ifd_field(&self, ifd: usize) -> Option<usize> {
        Some(ifd + 2 + self.u16(ifd)? as usize * 12)
    }

    fn find(&self, ifd: usize, tag: u16) -> Option<Entry> {
        self.entries(ifd).into_iter().find(|e| e.tag == tag)
    }

    fn sub_ifd(&self, ifd: usize, tag: u16) -> Option<usize> {
        let entry = self.find(ifd, tag)?;
        self.u32(entry.at + 8).map(|v| v as usize).filter(|&v| v > 0 && v < self.data.len())
    }

    /// SHORT or LONG value of a single-count entry.
    fn int(&self, ifd: usize, tag: u16) -> Option<u32> {
        let e = self.find(ifd, tag)?;
        match e.kind {
            3 => self.u16(e.at + 8).map(u32::from),
            4 => self.u32(e.at + 8),
            _ => None,
        }
    }

    fn rational(&self, ifd: usize, tag: u16) -> Option<(u32, u32)> {
        let e = self.find(ifd, tag)?;
        if !matches!(e.kind, 5 | 10) {
            return None;
        }
        let at = self.u32(e.at + 8)? as usize;
        Some((self.u32(at)?, self.u32(at + 4)?))
    }

    fn text(&self, ifd: usize, tag: u16) -> Option<String> {
        let e = self.find(ifd, tag)?;
        if e.kind != 2 {
            return None;
        }
        let len = e.count as usize;
        let at = if len <= 4 { e.at + 8 } else { self.u32(e.at + 8)? as usize };
        let raw = self.data.get(at..at.checked_add(len)?)?;
        let raw = raw.split(|&b| b == 0).next().unwrap_or(&[]);
        let s = String::from_utf8_lossy(raw).trim().to_string();
        (!s.is_empty()).then_some(s)
    }

    /// EXIF orientation 1–8; 1 when absent or out of range.
    pub fn orientation(&self) -> u16 {
        self.ifd0()
            .and_then(|ifd| self.int(ifd, TAG_ORIENTATION))
            .filter(|v| (1..=8).contains(v))
            .map(|v| v as u16)
            .unwrap_or(1)
    }

    /// The JPEG thumbnail of IFD1.
    pub fn thumbnail(&self) -> Option<&'a [u8]> {
        let ifd0 = self.ifd0()?;
        let ifd1 = self.u32(self.next_ifd_field(ifd0)?)? as usize;
        if ifd1 == 0 {
            return None;
        }
        let start = self.int(ifd1, 0x0201)? as usize;
        let len = self.int(ifd1, 0x0202)? as usize;
        let thumb = self.data.get(start..start.checked_add(len)?)?;
        thumb.starts_with(&[0xFF, 0xD8]).then_some(thumb)
    }

    pub fn info(&self) -> CameraInfo {
        let Some(ifd0) = self.ifd0() else { return CameraInfo::default() };
        let exif = self.sub_ifd(ifd0, IFD_EXIF);
        let ratio = |tag| exif.and_then(|ifd| self.rational(ifd, tag)).filter(|r| r.1 != 0);
        CameraInfo {
            make: self.text(ifd0, 0x010F),
            model: self.text(ifd0, 0x0110),
            lens: exif.and_then(|ifd| self.text(ifd, 0xA434)),
            exposure: ratio(0x829A).map(|(n, d)| [n, d]),
            f_number: ratio(0x829D).map(|(n, d)| n as f64 / d as f64),
            focal_length: ratio(0x920A).map(|(n, d)| n as f64 / d as f64),
            iso: exif.and_then(|ifd| self.int(ifd, 0x8827)),
            taken: exif.and_then(|ifd| self.text(ifd, 0x9003)),
        }
    }
}

/// Capture details shown over the preview.
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraInfo {
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    /// Exposure time as a fraction [numerator, denominator] of a second.
    pub exposure: Option<[u32; 2]>,
    pub f_number: Option<f64>,
    pub focal_length: Option<f64>,
    pub iso: Option<u32>,
    /// "YYYY:MM:DD HH:MM:SS" as the camera wrote it.
    pub taken: Option<String>,
}

/// Copy of the TIFF block for pixels that are already upright and `width`×`height`:
/// orientation becomes 1, the Exif pixel size follows the new image, and the IFD1 thumbnail
/// (which still shows the old framing) is unlinked. `None` when the block cannot be patched.
pub fn normalized(tiff: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    let t = Tiff::new(tiff)?;
    let ifd0 = t.ifd0()?;
    let mut out = tiff.to_vec();
    let little = t.little;
    let put16 = |out: &mut Vec<u8>, at: usize, v: u16| {
        let b = if little { v.to_le_bytes() } else { v.to_be_bytes() };
        out.get_mut(at..at + 2).map(|s| s.copy_from_slice(&b))
    };
    let put32 = |out: &mut Vec<u8>, at: usize, v: u32| {
        let b = if little { v.to_le_bytes() } else { v.to_be_bytes() };
        out.get_mut(at..at + 4).map(|s| s.copy_from_slice(&b))
    };
    let put_int = |out: &mut Vec<u8>, e: Entry, v: u32| match e.kind {
        3 => put16(out, e.at + 8, v.min(u16::MAX as u32) as u16),
        4 => put32(out, e.at + 8, v),
        _ => Some(()),
    };
    if let Some(e) = t.find(ifd0, TAG_ORIENTATION) {
        put_int(&mut out, e, 1)?;
    }
    if let Some(exif) = t.sub_ifd(ifd0, IFD_EXIF) {
        if let Some(e) = t.find(exif, 0xA002) {
            put_int(&mut out, e, width)?;
        }
        if let Some(e) = t.find(exif, 0xA003) {
            put_int(&mut out, e, height)?;
        }
    }
    put32(&mut out, t.next_ifd_field(ifd0)?, 0)?;
    Some(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Big- or little-endian TIFF: IFD0 {Make, Orientation, ExifIFD}, Exif {ExposureTime,
    /// FNumber, ISO, PixelX, PixelY}, IFD1 {thumbnail offset, length} + the thumbnail bytes.
    pub fn sample_tiff(little: bool, orientation: u16, thumb: &[u8]) -> Vec<u8> {
        let mut t = Vec::new();
        let p16 = |t: &mut Vec<u8>, v: u16| t.extend(if little { v.to_le_bytes() } else { v.to_be_bytes() });
        let p32 = |t: &mut Vec<u8>, v: u32| t.extend(if little { v.to_le_bytes() } else { v.to_be_bytes() });
        t.extend(if little { *b"II*\0" } else { *b"MM\0*" });
        p32(&mut t, 8);
        // IFD0 at 8: 3 entries -> 2 + 36 + 4 = 42 bytes, ends at 50.
        let exif_at = 50u32;
        // Exif IFD: 5 entries -> 2 + 60 + 4 = 66 bytes, ends at 116; rationals after.
        let rationals = exif_at + 66;
        let ifd1 = rationals + 16;
        let make_at = ifd1 + 2 + 24 + 4;
        let thumb_at = make_at + 10;
        p16(&mut t, 3);
        p16(&mut t, 0x010F); p16(&mut t, 2); p32(&mut t, 10); p32(&mut t, make_at);
        p16(&mut t, TAG_ORIENTATION); p16(&mut t, 3); p32(&mut t, 1); p16(&mut t, orientation); p16(&mut t, 0);
        p16(&mut t, IFD_EXIF); p16(&mut t, 4); p32(&mut t, 1); p32(&mut t, exif_at);
        p32(&mut t, ifd1);
        assert_eq!(t.len() as u32, exif_at);
        p16(&mut t, 5);
        p16(&mut t, 0x829A); p16(&mut t, 5); p32(&mut t, 1); p32(&mut t, rationals);
        p16(&mut t, 0x829D); p16(&mut t, 5); p32(&mut t, 1); p32(&mut t, rationals + 8);
        p16(&mut t, 0x8827); p16(&mut t, 3); p32(&mut t, 1); p16(&mut t, 800); p16(&mut t, 0);
        p16(&mut t, 0xA002); p16(&mut t, 4); p32(&mut t, 1); p32(&mut t, 6000);
        p16(&mut t, 0xA003); p16(&mut t, 3); p32(&mut t, 1); p16(&mut t, 4000); p16(&mut t, 0);
        p32(&mut t, 0);
        assert_eq!(t.len() as u32, rationals);
        p32(&mut t, 1); p32(&mut t, 250);
        p32(&mut t, 28); p32(&mut t, 10);
        assert_eq!(t.len() as u32, ifd1);
        p16(&mut t, 2);
        p16(&mut t, 0x0201); p16(&mut t, 4); p32(&mut t, 1); p32(&mut t, thumb_at);
        p16(&mut t, 0x0202); p16(&mut t, 4); p32(&mut t, 1); p32(&mut t, thumb.len() as u32);
        p32(&mut t, 0);
        assert_eq!(t.len() as u32, make_at);
        t.extend(b"Panasonic\0");
        t.extend(thumb);
        t
    }

    #[test]
    fn reads_both_byte_orders() {
        for little in [true, false] {
            let data = sample_tiff(little, 6, &[0xFF, 0xD8, 1, 2]);
            let t = Tiff::new(&data).unwrap();
            assert_eq!(t.orientation(), 6);
            assert_eq!(t.thumbnail(), Some(&[0xFF, 0xD8, 1, 2][..]));
            let info = t.info();
            assert_eq!(info.make.as_deref(), Some("Panasonic"));
            assert_eq!(info.exposure, Some([1, 250]));
            assert_eq!(info.f_number, Some(2.8));
            assert_eq!(info.iso, Some(800));
        }
    }

    #[test]
    fn normalizing_resets_orientation_size_and_thumbnail() {
        for little in [true, false] {
            let data = sample_tiff(little, 8, &[0xFF, 0xD8, 1, 2]);
            let out = normalized(&data, 3990, 5990).unwrap();
            let t = Tiff::new(&out).unwrap();
            assert_eq!(t.orientation(), 1);
            assert_eq!(t.thumbnail(), None);
            let exif = t.sub_ifd(t.ifd0().unwrap(), IFD_EXIF).unwrap();
            assert_eq!(t.int(exif, 0xA002), Some(3990));
            assert_eq!(t.int(exif, 0xA003), Some(5990));
            assert_eq!(t.info().make.as_deref(), Some("Panasonic"));
        }
    }

    #[test]
    fn garbage_is_absent_not_a_panic() {
        assert!(Tiff::new(b"nope").is_none());
        let mut data = sample_tiff(true, 3, &[0xFF, 0xD8]);
        data.truncate(40);
        let t = Tiff::new(&data).unwrap();
        assert_eq!(t.orientation(), 3);
        assert_eq!(t.thumbnail(), None);
        let _ = t.info();
        assert!(jpeg_header(b"\xFF\xD8\xFF\xE1\xFF\xFF").is_some());
        assert!(jpeg_header(b"GIF89a").is_none());
    }
}
