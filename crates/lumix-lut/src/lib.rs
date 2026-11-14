//! LUT Library access inside a LUMIX camera settings blob.
//!
//! The blob is what PTP vendor operation `0x9421` returns for property `0x080000A2`, and what
//! `0x9422` accepts back. Layout facts were recovered from a DC-S1M2 on firmware 1.5 and are
//! documented in `docs/camera-lut-library.md`. Only DC-S1M2 is accepted until other bodies are
//! checked by reading their blobs.
//!
//! Every write goes through [`SettingsBlob::with_lut`], which returns a new blob and refuses
//! to produce one whose changes reach outside the chosen title entry, its LUT record and the
//! trailing checksum byte.

mod cube;

pub use cube::{parse_cube, CubeFile, Lut33};

/// PTP property code that addresses the whole camera settings file.
pub const SETTINGS_PROP: u32 = 0x0800_00A2;
/// Grid size of every LUT Library record.
pub const GRID: usize = 33;
pub const LUT_ENTRIES: usize = GRID * GRID * GRID;

const ITEM_TITLES: u16 = 0x02F4;
const ITEM_LUTS: u16 = 0x051F;
const TITLE_STRIDE: usize = 776;
const TITLE_HEADER: usize = 8;
const TITLE_NAME_BYTES: usize = 512;
const LUT_RECORD_LEN: u32 = 0x34A4C; // grid u16 + flag u16 + 33^3*3 u16 + 2 pad bytes
const LUT_DATA_BYTES: usize = LUT_ENTRIES * 6;
const MODEL_OFFSET: usize = 0x1E;
const SUPPORTED_MODELS: &[&str] = &["DC-S1M2"];
/// Longest title accepted, matching LUMIX Lab's file-name limit.
pub const MAX_NAME_CHARS: usize = 95;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The bytes are not a settings blob this crate understands.
    Format(String),
    UnsupportedModel(String),
    Checksum { stored: u8, expected: u8 },
    Cube(String),
    UnsupportedPhotoStyle(String),
    InvalidName(String),
    /// The requested Library entry cannot be used.
    Slot(String),
    /// Internal guard: the patch would have changed bytes outside the allowed ranges.
    Guard(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Format(m) => write!(f, "unrecognised settings data: {m}"),
            Error::UnsupportedModel(m) => write!(f, "camera model {m} is not supported yet"),
            Error::Checksum { stored, expected } => write!(f, "settings checksum mismatch (stored {stored:#04x}, expected {expected:#04x})"),
            Error::Cube(m) => write!(f, "cannot use this .cube file: {m}"),
            Error::UnsupportedPhotoStyle(t) => write!(f, "#LUMIXPHOTOSTYLE {t} is not supported yet (only STD or no tag)"),
            Error::InvalidName(m) => write!(f, "invalid LUT name: {m}"),
            Error::Slot(m) => write!(f, "{m}"),
            Error::Guard(m) => write!(f, "refusing to write: {m}"),
        }
    }
}

impl std::error::Error for Error {}

/// Base Photo Style stored with a LUT. Values observed in the camera's own registrations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BaseStyle {
    /// `#LUMIXPHOTOSTYLE STD`
    Standard,
    /// No tag in the file; the camera treats it as V-Log.
    VLog,
}

impl BaseStyle {
    fn code(self) -> u16 {
        match self {
            BaseStyle::Standard => 0,
            BaseStyle::VLog => 49,
        }
    }
}

/// One entry of the LUT Library title table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryEntry {
    /// Entry index in the table (0 = built-in Vlog_709).
    pub index: usize,
    pub name: String,
    /// Raw base-style code (0 = STD, 49 = V-Log, 37 = ARRI 709, 10 = Vlog_709).
    pub style_code: u16,
    pub in_use: bool,
}

#[derive(Debug, Clone, Copy)]
struct Layout {
    titles: usize, // first title entry
    title_count: usize,
    records: usize, // first LUT record
    record_count: usize,
}

/// A validated settings blob (`[prop][len][datalen][data...][checksum]`).
#[derive(Clone)]
pub struct SettingsBlob {
    bytes: Vec<u8>,
    layout: Layout,
    model: String,
}

impl std::fmt::Debug for SettingsBlob {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SettingsBlob({} bytes, {})", self.bytes.len(), self.model)
    }
}

fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

/// Byte that makes `sum(bytes[0x0C..]) % 256 == 0`, computed over everything but the last byte.
fn checksum_for(bytes: &[u8]) -> u8 {
    let sum = bytes[0x0C..bytes.len() - 1].iter().fold(0u8, |a, b| a.wrapping_add(*b));
    sum.wrapping_neg()
}

/// Find exactly one item header `[id u16][index 0 u16][len u32]` whose payload passes `check`.
fn find_item(b: &[u8], id: u16, check: impl Fn(usize, usize) -> bool) -> Result<usize, Error> {
    let pat = id.to_le_bytes();
    let mut found = Vec::new();
    for o in 0x40..b.len().saturating_sub(8) {
        if b[o] == pat[0] && b[o + 1] == pat[1] && u16_at(b, o + 2) == 0 {
            let len = u32_at(b, o + 4) as usize;
            if o + 8 + len < b.len() && check(o + 8, len) {
                found.push(o + 8);
            }
        }
    }
    match found.as_slice() {
        [one] => Ok(*one),
        [] => Err(Error::Format(format!("item {id:#06x} not found"))),
        _ => Err(Error::Format(format!("item {id:#06x} is ambiguous ({} matches)", found.len()))),
    }
}

impl SettingsBlob {
    /// Validate a blob read with `0x9421` / `0x080000A2`.
    pub fn parse(bytes: Vec<u8>) -> Result<Self, Error> {
        if bytes.len() < 0x100 {
            return Err(Error::Format("too short".into()));
        }
        if u32_at(&bytes, 0) != SETTINGS_PROP {
            return Err(Error::Format("not a 0x080000A2 settings property".into()));
        }
        if u32_at(&bytes, 4) as usize + 8 != bytes.len() || u32_at(&bytes, 8) as usize + 12 != bytes.len() {
            return Err(Error::Format("length fields do not match the data size".into()));
        }
        let expected = checksum_for(&bytes);
        let stored = *bytes.last().unwrap();
        if stored != expected {
            return Err(Error::Checksum { stored, expected });
        }
        let model_raw = &bytes[MODEL_OFFSET..MODEL_OFFSET + 16];
        let model: String = model_raw.iter().take_while(|c| **c != 0).map(|c| *c as char).collect();
        if !SUPPORTED_MODELS.contains(&model.as_str()) {
            return Err(Error::UnsupportedModel(model));
        }

        // Title table payload: [u32 0x0A][u32 array bytes][entries...]
        let t = find_item(&bytes, ITEM_TITLES, |p, len| {
            len >= 8 && u32_at(&bytes, p) == 0x0A && {
                let arr = u32_at(&bytes, p + 4) as usize;
                arr + 8 <= len && arr % TITLE_STRIDE == 0 && arr > 0
            }
        })?;
        let title_count = u32_at(&bytes, t + 4) as usize / TITLE_STRIDE;
        // LUT section payload: [u32 0x0C][records of (u32 len + len bytes)...][8 trailing bytes on fw 1.5]
        let l = find_item(&bytes, ITEM_LUTS, |p, len| {
            len > 4 + 4 + LUT_RECORD_LEN as usize && u32_at(&bytes, p) == 0x0C && u32_at(&bytes, p + 4) == LUT_RECORD_LEN
        })?;
        let llen = u32_at(&bytes, l - 4) as usize;
        let record_count = (llen - 4) / (4 + LUT_RECORD_LEN as usize);
        let layout = Layout { titles: t + 8, title_count, records: l + 4, record_count };
        for r in 0..record_count {
            if u32_at(&bytes, layout.records + r * (4 + LUT_RECORD_LEN as usize)) != LUT_RECORD_LEN {
                return Err(Error::Format(format!("LUT record {r} has an unexpected length")));
            }
        }
        if title_count != record_count {
            return Err(Error::Format(format!("{title_count} titles but {record_count} LUT records")));
        }
        Ok(Self { bytes, layout, model })
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }

    fn title_offset(&self, index: usize) -> usize {
        self.layout.titles + index * TITLE_STRIDE
    }

    /// Offset of the record linked to title `index` (title n -> record n - 1).
    fn record_offset(&self, index: usize) -> usize {
        assert!(index >= 1 && index - 1 < self.layout.record_count, "entry {index} has no LUT record");
        self.layout.records + (index - 1) * (4 + LUT_RECORD_LEN as usize)
    }

    /// All title entries, including unused ones.
    pub fn entries(&self) -> Vec<LibraryEntry> {
        (0..self.layout.title_count)
            .map(|k| {
                let o = self.title_offset(k);
                let pos = u16_at(&self.bytes, o + 4);
                let units: Vec<u16> = (0..TITLE_NAME_BYTES / 2)
                    .map(|i| u16_at(&self.bytes, o + TITLE_HEADER + 2 * i))
                    .take_while(|u| *u != 0)
                    .collect();
                LibraryEntry {
                    index: k,
                    name: String::from_utf16_lossy(&units),
                    style_code: u16_at(&self.bytes, o + 6),
                    in_use: pos != 0xFFFF,
                }
            })
            .collect()
    }

    /// Entries that can receive a new LUT (unused, and linked to a record).
    pub fn free_slots(&self) -> Vec<usize> {
        self.entries().into_iter().filter(|e| e.index >= 1 && !e.in_use).map(|e| e.index).collect()
    }

    /// The stored LUT for a used entry.
    pub fn lut(&self, index: usize) -> Option<Lut33> {
        if index == 0 || index >= self.layout.title_count || !self.entries()[index].in_use {
            return None;
        }
        let p = self.record_offset(index) + 8;
        let v = (0..LUT_ENTRIES)
            .map(|i| {
                let q = p + i * 6;
                [u16_at(&self.bytes, q), u16_at(&self.bytes, q + 2), u16_at(&self.bytes, q + 4)]
            })
            .collect();
        Lut33::from_u16(v).ok()
    }

    /// Return a new blob with `lut` stored in Library entry `index` under `name`.
    ///
    /// The entry's link field is set to its own index — the camera does the same, and any
    /// other value makes it render a different record.
    pub fn with_lut(&self, index: usize, name: &str, style: BaseStyle, lut: &Lut33, allow_overwrite: bool) -> Result<SettingsBlob, Error> {
        if index == 0 || index >= self.layout.title_count {
            return Err(Error::Slot(format!("entry {index} is not a user slot (1..={})", self.layout.title_count - 1)));
        }
        if self.entries()[index].in_use && !allow_overwrite {
            return Err(Error::Slot(format!("entry {index} already holds a LUT")));
        }
        validate_name(name)?;
        let mut b = self.bytes.clone();
        let t = self.title_offset(index);
        b[t..t + 4].copy_from_slice(&(index as u32).to_le_bytes());
        b[t + 4..t + 6].copy_from_slice(&(index as u16).to_le_bytes());
        b[t + 6..t + 8].copy_from_slice(&style.code().to_le_bytes());
        let name_area = t + TITLE_HEADER..t + TITLE_HEADER + TITLE_NAME_BYTES;
        b[name_area.clone()].fill(0);
        for (i, u) in name.encode_utf16().enumerate() {
            b[name_area.start + 2 * i..name_area.start + 2 * i + 2].copy_from_slice(&u.to_le_bytes());
        }
        let r = self.record_offset(index);
        b[r + 4..r + 6].copy_from_slice(&(GRID as u16).to_le_bytes());
        b[r + 6..r + 8].copy_from_slice(&style.code().to_le_bytes());
        for (i, px) in lut.values().iter().enumerate() {
            let q = r + 8 + i * 6;
            for c in 0..3 {
                b[q + 2 * c..q + 2 * c + 2].copy_from_slice(&px[c].to_le_bytes());
            }
        }
        let last = b.len() - 1;
        b[last] = checksum_for(&b);

        // Guard: nothing outside the title entry, its record and the checksum may change.
        let allowed = [t..t + TITLE_STRIDE, r..r + 4 + LUT_RECORD_LEN as usize, last..last + 1];
        if let Some((i, _)) = b
            .iter()
            .zip(&self.bytes)
            .enumerate()
            .find(|(i, (x, y))| x != y && !allowed.iter().any(|a| a.contains(i)))
        {
            return Err(Error::Guard(format!("byte {i:#x} would change outside the target slot")));
        }
        debug_assert_eq!(&b[r + 8 + LUT_DATA_BYTES..r + 8 + LUT_DATA_BYTES + 2], &[0, 0]);
        SettingsBlob::parse(b)
    }
}

/// Titles are stored as UTF-16; keep to printable ASCII so they also survive card file names.
pub fn validate_name(name: &str) -> Result<(), Error> {
    if name.is_empty() {
        return Err(Error::InvalidName("empty".into()));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(Error::InvalidName(format!("longer than {MAX_NAME_CHARS} characters")));
    }
    if let Some(c) = name.chars().find(|c| !(' '..='~').contains(c)) {
        return Err(Error::InvalidName(format!("character {c:?} is not printable ASCII")));
    }
    Ok(())
}
