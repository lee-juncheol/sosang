//! Minimal `.cube` reader for the camera LUT Library: 33-point 3D LUTs only.

use crate::{BaseStyle, Error, GRID, LUT_ENTRIES};

/// A 33x33x33 RGB LUT, red varying fastest (the `.cube` order and the camera order).
#[derive(Clone, PartialEq)]
pub struct Lut33 {
    values: Vec<[u16; 3]>,
}

impl std::fmt::Debug for Lut33 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Lut33({} entries)", self.values.len())
    }
}

/// Parsed `.cube` contents plus the metadata the camera cares about.
#[derive(Debug, Clone)]
pub struct CubeFile {
    pub title: Option<String>,
    /// From `#LUMIXPHOTOSTYLE <tag>`; `None` when the file carries no tag.
    pub photo_style_tag: Option<String>,
    pub lut: Lut33,
}

impl CubeFile {
    /// Base Photo Style the camera will assign. Untagged files fall back to V-Log, as the manual states.
    pub fn base_style(&self) -> Result<BaseStyle, Error> {
        match self.photo_style_tag.as_deref() {
            None => Ok(BaseStyle::VLog),
            Some("STD") => Ok(BaseStyle::Standard),
            Some(other) => Err(Error::UnsupportedPhotoStyle(other.to_string())),
        }
    }
}

/// Quantise a 0..1 value the way the camera stores it: round(v * 65535), ties to even.
pub(crate) fn quantise(v: f64) -> u16 {
    (v.clamp(0.0, 1.0) * 65535.0).round_ties_even() as u16
}

impl Lut33 {
    /// Build from already quantised 16-bit values (red fastest).
    pub fn from_u16(values: Vec<[u16; 3]>) -> Result<Self, Error> {
        if values.len() != LUT_ENTRIES {
            return Err(Error::Cube(format!("expected {LUT_ENTRIES} entries, got {}", values.len())));
        }
        Ok(Self { values })
    }

    /// Build from a function of normalised grid coordinates (r, g, b in 0..=1).
    pub fn from_fn(mut f: impl FnMut(f64, f64, f64) -> [f64; 3]) -> Self {
        let step = (GRID - 1) as f64;
        let mut values = Vec::with_capacity(LUT_ENTRIES);
        for b in 0..GRID {
            for g in 0..GRID {
                for r in 0..GRID {
                    let [x, y, z] = f(r as f64 / step, g as f64 / step, b as f64 / step);
                    values.push([quantise(x), quantise(y), quantise(z)]);
                }
            }
        }
        Self { values }
    }

    pub fn values(&self) -> &[[u16; 3]] {
        &self.values
    }
}

/// Parse a `.cube` text. Rejects anything the camera Library cannot hold unchanged
/// (non-33 grids, 1D LUTs, custom domains, out-of-range or non-finite values).
pub fn parse_cube(text: &str) -> Result<CubeFile, Error> {
    let mut title = None;
    let mut tag = None;
    let mut size = None;
    let mut values = Vec::with_capacity(LUT_ENTRIES);
    for (n, raw) in text.lines().enumerate() {
        let line = raw.trim();
        let err = |m: &str| Error::Cube(format!("line {}: {m}", n + 1));
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix('#') {
            let rest = rest.trim_start();
            if let Some(t) = rest.strip_prefix("LUMIXPHOTOSTYLE") {
                if tag.is_some() {
                    return Err(err("more than one #LUMIXPHOTOSTYLE tag"));
                }
                let t = t.trim();
                if t.is_empty() {
                    return Err(err("empty #LUMIXPHOTOSTYLE tag"));
                }
                tag = Some(t.to_string());
            }
            continue;
        }
        let mut parts = line.split_whitespace();
        let key = parts.next().unwrap_or_default();
        match key {
            "TITLE" => title = Some(line[5..].trim().trim_matches('"').to_string()),
            "LUT_3D_SIZE" => {
                let s: usize = parts.next().and_then(|v| v.parse().ok()).ok_or_else(|| err("bad LUT_3D_SIZE"))?;
                if s != GRID {
                    return Err(Error::Cube(format!("LUT_3D_SIZE {s} is not supported; the camera Library stores 33-point LUTs")));
                }
                size = Some(s);
            }
            "LUT_1D_SIZE" => return Err(err("1D LUTs are not supported")),
            "DOMAIN_MIN" | "DOMAIN_MAX" => {
                let want = if key == "DOMAIN_MIN" { 0.0 } else { 1.0 };
                let vals: Vec<f64> = parts.map(|v| v.parse().map_err(|_| err("bad DOMAIN value"))).collect::<Result<_, _>>()?;
                if vals.len() != 3 || vals.iter().any(|v| *v != want) {
                    return Err(err("only the default 0..1 domain is supported"));
                }
            }
            _ => {
                let nums: Vec<f64> = line
                    .split_whitespace()
                    .map(|v| v.parse::<f64>().map_err(|_| err("unexpected text")))
                    .collect::<Result<_, _>>()?;
                if nums.len() != 3 {
                    return Err(err("data line must have three values"));
                }
                if size.is_none() {
                    return Err(err("data before LUT_3D_SIZE"));
                }
                if nums.iter().any(|v| !v.is_finite() || *v < 0.0 || *v > 1.0) {
                    return Err(err("value outside 0..1"));
                }
                values.push([quantise(nums[0]), quantise(nums[1]), quantise(nums[2])]);
            }
        }
    }
    if size.is_none() {
        return Err(Error::Cube("missing LUT_3D_SIZE".into()));
    }
    Ok(CubeFile { title, photo_style_tag: tag, lut: Lut33::from_u16(values)? })
}
