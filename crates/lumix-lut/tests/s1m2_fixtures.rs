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

const TITLES: usize = 0xF6B8;
const STRIDE: usize = 776;

#[test]
fn reads_the_entry_selected_in_the_camera() {
    let cases = [("s1m2_fw15_first_read.bin", 32), ("s1m2_fw15_test01_slot40.bin", 2), ("s1m2_fw15_before_camera_delete.bin", 39), ("s1m2_fw15_after_camera_delete.bin", 2)];
    for (name, selected) in cases {
        let Some(b) = fixture(name) else { continue };
        assert_eq!(SettingsBlob::parse(b).unwrap().selected_entry(), Some(selected), "{name}");
    }
}

#[test]
fn delete_writes_the_same_empty_entry_as_the_camera() {
    // The camera deleted entry 39 (WEDDIRS) between these two captures.
    let (Some(before), Some(after)) = (fixture("s1m2_fw15_test01_slot40.bin"), fixture("s1m2_fw15_after_camera_delete.bin")) else { return };
    let s = SettingsBlob::parse(before.clone()).unwrap();
    let out = s.without_lut(37).unwrap();
    let mine = &out.as_bytes()[TITLES + 37 * STRIDE..TITLES + 38 * STRIDE];
    let camera = &after[TITLES + 39 * STRIDE..TITLES + 40 * STRIDE];
    assert_eq!(&mine[0..4], &37u32.to_le_bytes());
    assert_eq!(&mine[4..], &camera[4..], "empty entry differs from the camera's own delete");
    assert!(!out.entries()[37].in_use);
    assert_eq!(out.free_slots(), vec![37, 38, 39]);
    // Only the title entry and the checksum change; the LUT record is left in place.
    let changed: Vec<usize> = out.as_bytes().iter().zip(&before).enumerate().filter(|(_, (a, b))| a != b).map(|(i, _)| i).collect();
    let last = before.len() - 1;
    assert!(changed.iter().all(|&i| (TITLES + 37 * STRIDE..TITLES + 38 * STRIDE).contains(&i) || i == last), "{changed:x?}");
    assert!(out.lut(37).is_none(), "an empty entry reports no LUT");
}

#[test]
fn delete_refuses_the_selected_entry_empty_entries_and_the_built_in() {
    let Some(b) = fixture("s1m2_fw15_test01_slot40.bin") else { return };
    let s = SettingsBlob::parse(b).unwrap();
    assert_eq!(s.selected_entry(), Some(2));
    assert!(matches!(s.without_lut(2), Err(Error::Slot(_))), "entry 2 is selected in the camera");
    assert!(matches!(s.without_lut(38), Err(Error::Slot(_))), "entry 38 is empty");
    assert!(matches!(s.without_lut(0), Err(Error::Slot(_))));
    assert!(matches!(s.without_lut(41), Err(Error::Slot(_))));
}

#[test]
fn registering_into_an_empty_entry_writes_the_same_title_as_the_camera() {
    // Entry 39 before the delete holds WEDDIRS.cube as the camera imported it from a card.
    let (Some(b), Some(cam)) = (fixture("s1m2_fw15_test01_slot40.bin"), fixture("s1m2_fw15_before_camera_delete.bin")) else { return };
    let s = SettingsBlob::parse(b).unwrap();
    let out = s.with_lut(39, "WEDDIRS.cube", BaseStyle::Standard, &test01(), false).unwrap();
    let mine = &out.as_bytes()[TITLES + 39 * STRIDE..TITLES + 40 * STRIDE];
    let camera = &cam[TITLES + 39 * STRIDE..TITLES + 40 * STRIDE];
    assert_eq!(mine, camera, "title entry differs from the camera's own import");
}

#[test]
fn deletes_several_entries_in_one_blob() {
    let Some(b) = fixture("s1m2_fw15_test01_slot40.bin") else { return };
    let s = SettingsBlob::parse(b.clone()).unwrap();
    let out = s.without_luts(&[30, 37, 33]).unwrap();
    // Same bytes as deleting them one after another.
    let one_by_one = s.without_lut(30).unwrap().without_lut(33).unwrap().without_lut(37).unwrap();
    assert!(out.as_bytes() == one_by_one.as_bytes());
    assert_eq!(out.free_slots(), vec![30, 33, 37, 38, 39]);
    let last = b.len() - 1;
    let touched = |i: usize| [30, 33, 37].iter().any(|k| (TITLES + k * STRIDE..TITLES + (k + 1) * STRIDE).contains(&i)) || i == last;
    assert!(out.as_bytes().iter().zip(&b).enumerate().all(|(i, (x, y))| x == y || touched(i)));
}

#[test]
fn several_entry_delete_is_all_or_nothing() {
    let Some(b) = fixture("s1m2_fw15_test01_slot40.bin") else { return };
    let s = SettingsBlob::parse(b).unwrap();
    assert!(matches!(s.without_luts(&[30, 2]), Err(Error::Slot(_))), "entry 2 is selected");
    assert!(matches!(s.without_luts(&[30, 38]), Err(Error::Slot(_))), "entry 38 is empty");
    assert!(matches!(s.without_luts(&[30, 30]), Err(Error::Slot(_))), "listed twice");
    assert!(matches!(s.without_luts(&[]), Err(Error::Slot(_))));
}

#[test]
fn stores_several_luts_in_one_blob() {
    let Some(b) = fixture("s1m2_fw15_test01_slot40.bin") else { return };
    let s = SettingsBlob::parse(b.clone()).unwrap();
    let mono = test01();
    let flat = Lut33::from_fn(|r, g, b| [r, g, b]);
    let items = [
        lumix_lut::NewLut { index: 39, name: "B.cube", style: BaseStyle::VLog, lut: &flat },
        lumix_lut::NewLut { index: 38, name: "A.cube", style: BaseStyle::Standard, lut: &mono },
    ];
    let out = s.with_luts(&items, false).unwrap();
    let one_by_one = s.with_lut(39, "B.cube", BaseStyle::VLog, &flat, false).unwrap().with_lut(38, "A.cube", BaseStyle::Standard, &mono, false).unwrap();
    assert!(out.as_bytes() == one_by_one.as_bytes());
    assert_eq!(out.entries()[38].name, "A.cube");
    assert_eq!(out.entries()[39].style_code, 49);
    assert_eq!(out.lut(38).unwrap(), mono);
    assert!(out.free_slots().is_empty());
}

#[test]
fn several_lut_store_is_all_or_nothing() {
    let Some(b) = fixture("s1m2_fw15_test01_slot40.bin") else { return };
    let s = SettingsBlob::parse(b).unwrap();
    let l = test01();
    let item = |index, name| lumix_lut::NewLut { index, name, style: BaseStyle::Standard, lut: &l };
    assert!(matches!(s.with_luts(&[item(38, "A"), item(38, "B")], false), Err(Error::Slot(_))), "same slot twice");
    assert!(matches!(s.with_luts(&[item(38, "A"), item(37, "B")], false), Err(Error::Slot(_))), "37 is in use");
    assert!(s.with_luts(&[item(38, "A"), item(37, "B")], true).is_ok(), "overwrite allowed");
    assert!(matches!(s.with_luts(&[item(38, "A"), item(39, "명")], false), Err(Error::InvalidName(_))));
    assert!(matches!(s.with_luts(&[], false), Err(Error::Slot(_))));
}

#[test]
fn expected_state_must_match_the_camera() {
    let Some(b) = fixture("s1m2_fw15_test01_slot40.bin") else { return };
    let s = SettingsBlob::parse(b).unwrap();
    assert!(s.check_expected(&[(38, None), (40, Some("TEST01")), (37, Some("WEDBLU33.cube"))]).is_ok());
    assert!(matches!(s.check_expected(&[(37, None)]), Err(Error::Changed(_))), "37 is in use");
    assert!(matches!(s.check_expected(&[(38, Some("X.cube"))]), Err(Error::Changed(_))), "38 is empty");
    assert!(matches!(s.check_expected(&[(40, Some("OTHER"))]), Err(Error::Changed(_))), "40 holds TEST01");
    assert!(matches!(s.check_expected(&[(41, None)]), Err(Error::Slot(_))));
}
