//! Tests against real DC-S1M2 (firmware 1.5) settings captures.
//! The captures hold personal camera settings, so they live in the git-ignored
//! `tests/fixtures/local/` folder; each test is skipped when its file is absent.

use lumix_lut::{parse_cube, BaseStyle, Error, Lut33, SettingsBlob};
use std::path::PathBuf;

fn fixture(name: &str) -> Option<Vec<u8>> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/local").join(name);
    match std::fs::read(&p) {
        Ok(b) => Some(b),
        Err(_) => {
            eprintln!("skipping: {} not present", p.display());
            None
        }
    }
}

/// The monochrome TEST01 written to the camera on 2026-11-14 (Python, round-half-even).
fn test01() -> Lut33 {
    let mut v = Vec::new();
    for b in 0..33 {
        for g in 0..33 {
            for r in 0..33 {
                let y = ((0.2126 * r as f64 + 0.7152 * g as f64 + 0.0722 * b as f64) / 32.0 * 65535.0).round_ties_even();
                let y = y.min(65535.0) as u16;
                v.push([y, y, y]);
            }
        }
    }
    Lut33::from_u16(v).unwrap()
}

#[test]
fn lists_library_like_the_camera() {
    let Some(b) = fixture("s1m2_fw15_first_read.bin") else { return };
    let s = SettingsBlob::parse(b).unwrap();
    assert_eq!(s.model(), "DC-S1M2");
    let e = s.entries();
    assert_eq!(e.len(), 41);
    assert_eq!(e[0].name, "Vlog_709");
    assert_eq!(e[1].name, "ARRI 709");
    assert_eq!(e[2].name, "C200CAFC.cube");
    assert_eq!(e[37].name, "WEDBLU33.cube");
    assert_eq!(e.iter().filter(|x| x.in_use).count(), 38);
    assert_eq!(s.free_slots(), vec![38, 39, 40]);
}

#[test]
fn reproduces_the_verified_test01_write_byte_for_byte() {
    let (Some(before), Some(after)) = (fixture("s1m2_fw15_before_test01.bin"), fixture("s1m2_fw15_test01_slot40.bin")) else { return };
    let s = SettingsBlob::parse(before).unwrap();
    // Entry 40 held our earlier WEDDIRS attempt at that point, so overwrite must be allowed.
    let out = s.with_lut(40, "TEST01", BaseStyle::Standard, &test01(), true).unwrap();
    assert!(out.as_bytes() == after.as_slice(), "patched blob differs from the blob the camera accepted");
    assert_eq!(out.lut(40).unwrap(), test01());
}

#[test]
fn refuses_used_slot_without_overwrite() {
    let Some(b) = fixture("s1m2_fw15_first_read.bin") else { return };
    let s = SettingsBlob::parse(b).unwrap();
    assert!(matches!(s.with_lut(5, "X", BaseStyle::Standard, &test01(), false), Err(Error::Slot(_))));
    assert!(matches!(s.with_lut(0, "X", BaseStyle::Standard, &test01(), true), Err(Error::Slot(_))));
}

#[test]
fn camera_registration_matches_our_cube_quantisation() {
    // The camera's own SD-card import of WEDDIRS.cube differed from round(v*65535) by at most 1 LSB.
    let Some(text) = fixture("WEDDIRS.cube") else { return };
    let cube = parse_cube(std::str::from_utf8(&text).unwrap()).unwrap();
    assert_eq!(cube.base_style().unwrap(), BaseStyle::Standard);
    assert_eq!(cube.lut.values().len(), 33 * 33 * 33);
}

#[test]
fn rejects_corrupted_checksum() {
    let Some(mut b) = fixture("s1m2_fw15_first_read.bin") else { return };
    let n = b.len();
    b[n - 1] ^= 0x55;
    assert!(matches!(SettingsBlob::parse(b), Err(Error::Checksum { .. })));
}
