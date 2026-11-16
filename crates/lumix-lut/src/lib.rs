//! LUT Library access inside a LUMIX camera settings blob.
//!
//! The blob is what PTP vendor operation `0x9421` returns for property `0x080000A2`, and what
//! `0x9422` accepts back. Layout facts were recovered from a DC-S1M2 on firmware 1.5 and are
//! documented in `docs/camera-lut-library.md`. Other LUMIX bodies are accepted when their blob
//! passes the same structure checks (items found by number, record sizes, checksum); which
//! bodies may be written to is decided by the caller (`lumix-ptp`).
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
/// Link value of an empty title entry.
const EMPTY_LINK: u16 = 0xFFFF;
/// Items holding the Library entry chosen in the camera menu: one for photo modes (0x052F)
/// and one for video modes (0x0530). Each is stored three times (item indices 0, 1, 2;
/// payload 28 bytes). Payload byte 4 is entry + 1, or `title_count + 1` (42 on DC-S1M2) when
/// that mode uses no LUT; the next 13 bytes held the same "no LUT" value in every capture.
/// Observed on DC-S1M2 firmware 1.5 (2026-11-16: photo mode set to Standard made 0x052F read
/// 42 while 0x0530 kept the video LUT).
const ITEMS_SELECTED: [u16; 2] = [0x052F, 0x0530];
const SELECTED_PAYLOAD: usize = 28;
const SELECTED_AT: usize = 4;
/// Bytes from `SELECTED_AT` that may name an entry (byte 4 and the 13 that follow it).
const SELECTED_BYTES: usize = 14;
/// Entries 0 (Vlog_709) and 1 (ARRI 709) came with the camera and are never changed.
const BUILT_IN_ENTRIES: usize = 2;
const LUT_RECORD_LEN: u32 = 0x34A4C; // grid u16 + flag u16 + 33^3*3 u16 + 2 pad bytes
const LUT_DATA_BYTES: usize = LUT_ENTRIES * 6;
const MODEL_OFFSET: usize = 0x1E;
/// Panasonic interchangeable-lens bodies report models like "DC-S1M2" or "DC-GH7".
const MODEL_PREFIX: &str = "DC-";
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
    /// A Library entry no longer holds what the caller saw (changed on the camera meanwhile).
    Changed(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Format(m) => write!(f, "unrecognised settings data: {m}"),
            Error::UnsupportedModel(m) => write!(f, "camera model {m} is not supported yet"),
            Error::Checksum { stored, expected } => write!(f, "settings checksum mismatch (stored {stored:#04x}, expected {expected:#04x})"),
            Error::Cube(m) => write!(f, "cannot use this .cube file: {m}"),
            Error::UnsupportedPhotoStyle(t) => write!(f, "#LUMIXPHOTOSTYLE {t} is not supported yet (only STD, VLOG or no tag)"),
            Error::InvalidName(m) => write!(f, "invalid LUT name: {m}"),
            Error::Slot(m) => write!(f, "{m}"),
            Error::Guard(m) => write!(f, "refusing to write: {m}"),
            Error::Changed(m) => write!(f, "the camera's LUT Library changed: {m}"),
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

/// A LUT to store with [`SettingsBlob::with_luts`].
#[derive(Debug, Clone, Copy)]
pub struct NewLut<'a> {
    pub index: usize,
    pub name: &'a str,
    pub style: BaseStyle,
    pub lut: &'a Lut33,
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
    /// Payload offsets of the three copies of each selection item ([`ITEMS_SELECTED`]).
    selected_at: Option<[[usize; 3]; 2]>,
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
    find_item_at(b, id, 0, check)
}

/// Like [`find_item`] for item index `seq` (some items are stored several times).
fn find_item_at(b: &[u8], id: u16, seq: u16, check: impl Fn(usize, usize) -> bool) -> Result<usize, Error> {
    let pat = id.to_le_bytes();
    let mut found = Vec::new();
    for o in 0x40..b.len().saturating_sub(8) {
        if b[o] == pat[0] && b[o + 1] == pat[1] && u16_at(b, o + 2) == seq {
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
        if !model.starts_with(MODEL_PREFIX) || model.len() <= MODEL_PREFIX.len() || !model.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
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
        let selected_at = Self::find_selected(&bytes);
        Ok(Self { bytes, layout, model, selected_at })
    }

    /// Offsets of the first selection byte in the three copies of each selection item, when
    /// both items are present.
    fn find_selected(bytes: &[u8]) -> Option<[[usize; 3]; 2]> {
        let mut at = [[0usize; 3]; 2];
        for (item, copies) in ITEMS_SELECTED.iter().zip(at.iter_mut()) {
            for (seq, slot) in copies.iter_mut().enumerate() {
                let p = find_item_at(bytes, *item, seq as u16, |_, len| len == SELECTED_PAYLOAD).ok()?;
                *slot = p + SELECTED_AT;
            }
        }
        Some(at)
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
        self.with_luts(&[NewLut { index, name, style, lut }], allow_overwrite)
    }

    /// Store several LUTs in one go (one write to the camera). Each is checked as in
    /// [`Self::with_lut`]; if any one is refused, nothing changes.
    pub fn with_luts(&self, luts: &[NewLut<'_>], allow_overwrite: bool) -> Result<SettingsBlob, Error> {
        if luts.is_empty() {
            return Err(Error::Slot("no LUTs to store".into()));
        }
        let entries = self.entries();
        let mut seen = Vec::with_capacity(luts.len());
        for l in luts {
            if l.index == 0 || l.index >= self.layout.title_count {
                return Err(Error::Slot(format!("entry {} is not a user slot (1..={})", l.index, self.layout.title_count - 1)));
            }
            if seen.contains(&l.index) {
                return Err(Error::Slot(format!("entry {} is listed twice", l.index)));
            }
            seen.push(l.index);
            if entries[l.index].in_use && !allow_overwrite {
                return Err(Error::Slot(format!("entry {} already holds a LUT", l.index)));
            }
            validate_name(l.name)?;
        }
        let mut b = self.bytes.clone();
        let mut allowed = Vec::with_capacity(luts.len() * 2 + 1);
        for l in luts {
            let t = self.title_offset(l.index);
            b[t..t + 4].copy_from_slice(&(l.index as u32).to_le_bytes());
            b[t + 4..t + 6].copy_from_slice(&(l.index as u16).to_le_bytes());
            b[t + 6..t + 8].copy_from_slice(&l.style.code().to_le_bytes());
            let name_area = t + TITLE_HEADER..t + TITLE_HEADER + TITLE_NAME_BYTES;
            b[name_area.clone()].fill(0);
            for (i, u) in l.name.encode_utf16().enumerate() {
                b[name_area.start + 2 * i..name_area.start + 2 * i + 2].copy_from_slice(&u.to_le_bytes());
            }
            let r = self.record_offset(l.index);
            b[r + 4..r + 6].copy_from_slice(&(GRID as u16).to_le_bytes());
            b[r + 6..r + 8].copy_from_slice(&l.style.code().to_le_bytes());
            for (i, px) in l.lut.values().iter().enumerate() {
                let q = r + 8 + i * 6;
                for c in 0..3 {
                    b[q + 2 * c..q + 2 * c + 2].copy_from_slice(&px[c].to_le_bytes());
                }
            }
            debug_assert_eq!(&b[r + 8 + LUT_DATA_BYTES..r + 8 + LUT_DATA_BYTES + 2], &[0, 0]);
            allowed.push(t..t + TITLE_STRIDE);
            allowed.push(r..r + 4 + LUT_RECORD_LEN as usize);
        }
        let last = b.len() - 1;
        b[last] = checksum_for(&b);
        allowed.push(last..last + 1);

        // Guard: nothing outside the chosen title entries, their records and the checksum may change.
        if let Some((i, _)) = b
            .iter()
            .zip(&self.bytes)
            .enumerate()
            .find(|(i, (x, y))| x != y && !allowed.iter().any(|a| a.contains(i)))
        {
            return Err(Error::Guard(format!("byte {i:#x} would change outside the target slots")));
        }
        SettingsBlob::parse(b)
    }

    /// Check that each listed entry still holds what the caller last saw: `None` = empty,
    /// `Some(name)` = in use under that name. Guards against writing over a slot that changed
    /// on the camera after the list was read.
    pub fn check_expected(&self, expected: &[(usize, Option<&str>)]) -> Result<(), Error> {
        let entries = self.entries();
        for &(index, want) in expected {
            let Some(entry) = entries.get(index) else {
                return Err(Error::Slot(format!("entry {index} does not exist")));
            };
            let have = entry.in_use.then_some(entry.name.as_str());
            if have != want {
                return Err(Error::Changed(format!("entry {index} is now {} (expected {})", show(have), show(want))));
            }
        }
        Ok(())
    }

    /// Library entries selected in the camera menu (photo and video modes), sorted. Empty when
    /// no mode uses a LUT; `None` when the selection can't be read for this layout (an item is
    /// missing, its three copies disagree, or a value is neither an entry nor "no LUT").
    pub fn selected_entries(&self) -> Option<Vec<usize>> {
        let at = self.selected_at?;
        let none = self.layout.title_count + 1;
        let mut selected = Vec::new();
        for copies in at {
            let first = &self.bytes[copies[0]..copies[0] + SELECTED_BYTES];
            if copies.iter().any(|&o| &self.bytes[o..o + SELECTED_BYTES] != first) {
                return None;
            }
            for (i, &v) in first.iter().enumerate() {
                match v as usize {
                    v if v == none => {}
                    v if (1..=self.layout.title_count).contains(&v) => selected.push(v - 1),
                    // Byte 4 is known; the bytes after it only ever held "no LUT", so an
                    // unknown value there is ignored rather than blocking deletes.
                    _ if i == 0 => return None,
                    _ => {}
                }
            }
        }
        selected.sort_unstable();
        selected.dedup();
        Some(selected)
    }

    /// Return a new blob with Library entry `index` emptied, the way the camera's own delete
    /// does it: only the title entry changes (link 0xFFFF, V-Log style, no name); the LUT
    /// record is left as it is and is ignored while the entry is empty.
    pub fn without_lut(&self, index: usize) -> Result<SettingsBlob, Error> {
        self.without_luts(&[index])
    }

    /// Empty several entries in one go (one write to the camera). Each entry is checked as in
    /// [`Self::without_lut`]; if any one is refused, nothing changes.
    pub fn without_luts(&self, indices: &[usize]) -> Result<SettingsBlob, Error> {
        if indices.is_empty() {
            return Err(Error::Slot("no entries to delete".into()));
        }
        let mut unique = indices.to_vec();
        unique.sort_unstable();
        unique.dedup();
        if unique.len() != indices.len() {
            return Err(Error::Slot("an entry is listed twice".into()));
        }
        let entries = self.entries();
        // The camera changes its selection when the selected LUT is deleted, by a rule not yet
        // known, so a LUT selected in any mode is never deleted, and nothing is when the
        // selection can't be read.
        let Some(selected) = self.selected_entries() else {
            return Err(Error::Slot("the LUT selected in the camera can't be read on this body, so deleting is not supported yet".into()));
        };
        for &index in &unique {
            if index == 0 || index >= self.layout.title_count {
                return Err(Error::Slot(format!("entry {index} is not a user slot (1..={})", self.layout.title_count - 1)));
            }
            if !entries[index].in_use {
                return Err(Error::Slot(format!("entry {index} is already empty")));
            }
            if selected.contains(&index) {
                return Err(Error::Slot(format!("entry {index} is selected in the camera; choose another LUT there first")));
            }
        }
        let mut b = self.bytes.clone();
        for &index in &unique {
            let t = self.title_offset(index);
            b[t..t + 4].copy_from_slice(&(index as u32).to_le_bytes());
            b[t + 4..t + 6].copy_from_slice(&EMPTY_LINK.to_le_bytes());
            b[t + 6..t + 8].copy_from_slice(&BaseStyle::VLog.code().to_le_bytes());
            b[t + TITLE_HEADER..t + TITLE_HEADER + TITLE_NAME_BYTES].fill(0);
        }
        let last = b.len() - 1;
        b[last] = checksum_for(&b);

        let titles: Vec<_> = unique.iter().map(|&i| self.title_offset(i)).map(|t| t..t + TITLE_STRIDE).collect();
        if let Some((i, _)) = b
            .iter()
            .zip(&self.bytes)
            .enumerate()
            .find(|(i, (x, y))| x != y && *i != last && !titles.iter().any(|a| a.contains(i)))
        {
            return Err(Error::Guard(format!("byte {i:#x} would change outside the target slots")));
        }
        SettingsBlob::parse(b)
    }

    /// Move LUTs between Library entries in one go (one write to the camera).
    ///
    /// `order` has one item per entry: `order[k]` is the entry whose LUT ends up in entry `k`
    /// (`None` = entry `k` ends up empty). Every LUT in use must appear exactly once. A moved
    /// LUT takes its name, base style and LUT record with it; the title's link is set to its
    /// new index, as the camera requires. Entries 0 and 1 and every entry selected in the
    /// camera stay where they are (the camera refers to selections by entry number), and
    /// nothing moves when the selection can't be read.
    pub fn rearranged(&self, order: &[Option<usize>]) -> Result<SettingsBlob, Error> {
        let count = self.layout.title_count;
        if order.len() != count {
            return Err(Error::Slot(format!("the new order lists {} entries, the camera has {count}", order.len())));
        }
        let entries = self.entries();
        let Some(selected) = self.selected_entries() else {
            return Err(Error::Slot("the LUT selected in the camera can't be read on this body, so moving is not supported yet".into()));
        };
        let mut used = vec![false; count];
        for (k, source) in order.iter().enumerate() {
            match *source {
                Some(s) if s >= count => return Err(Error::Slot(format!("entry {k}: entry {s} does not exist"))),
                Some(s) if !entries[s].in_use => return Err(Error::Slot(format!("entry {k}: entry {s} is empty"))),
                Some(s) if used[s] => return Err(Error::Slot(format!("entry {s} is placed twice"))),
                Some(s) => used[s] = true,
                None => {}
            }
            let fixed = k < BUILT_IN_ENTRIES || selected.contains(&k);
            if fixed && *source != entries[k].in_use.then_some(k) {
                return Err(Error::Slot(format!("entry {k} is built in or selected in the camera, so it stays as it is")));
            }
        }
        if let Some(lost) = entries.iter().find(|e| e.in_use && !used[e.index]) {
            return Err(Error::Slot(format!("entry {} ({:?}) is missing from the new order", lost.index, lost.name)));
        }
        let moved: Vec<usize> = (0..count).filter(|&k| order[k] != entries[k].in_use.then_some(k)).collect();
        if moved.is_empty() {
            return Err(Error::Slot("nothing to move".into()));
        }

        let record_len = 4 + LUT_RECORD_LEN as usize;
        let mut b = self.bytes.clone();
        let mut allowed = Vec::with_capacity(moved.len() * 2 + 1);
        for &k in &moved {
            let t = self.title_offset(k);
            b[t..t + 4].copy_from_slice(&(k as u32).to_le_bytes());
            match order[k] {
                Some(s) => {
                    let from = self.title_offset(s);
                    b[t + 4..t + 6].copy_from_slice(&(k as u16).to_le_bytes());
                    b[t + 6..t + TITLE_HEADER + TITLE_NAME_BYTES].copy_from_slice(&self.bytes[from + 6..from + TITLE_HEADER + TITLE_NAME_BYTES]);
                    let (r, src) = (self.record_offset(k), self.record_offset(s));
                    b[r..r + record_len].copy_from_slice(&self.bytes[src..src + record_len]);
                    allowed.push(r..r + record_len);
                }
                // Emptied the way the camera's own delete does it; the record is left as it is.
                None => {
                    b[t + 4..t + 6].copy_from_slice(&EMPTY_LINK.to_le_bytes());
                    b[t + 6..t + 8].copy_from_slice(&BaseStyle::VLog.code().to_le_bytes());
                    b[t + TITLE_HEADER..t + TITLE_HEADER + TITLE_NAME_BYTES].fill(0);
                }
            }
            allowed.push(t..t + TITLE_STRIDE);
        }
        let last = b.len() - 1;
        b[last] = checksum_for(&b);
        allowed.push(last..last + 1);

        // Guard: nothing outside the moved entries' titles, their records and the checksum.
        if let Some((i, _)) = b
            .iter()
            .zip(&self.bytes)
            .enumerate()
            .find(|(i, (x, y))| x != y && !allowed.iter().any(|a| a.contains(i)))
        {
            return Err(Error::Guard(format!("byte {i:#x} would change outside the moved slots")));
        }
        SettingsBlob::parse(b)
    }
}

fn show(entry: Option<&str>) -> String {
    entry.map_or_else(|| "empty".to_string(), |n| format!("{n:?}"))
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
