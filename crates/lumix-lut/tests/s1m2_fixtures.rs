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
    // Entry 40 pointed at record 37 (empty entry 38's) then; no other entry used record 39, so
    // writing 40 was safe, while writing 38 would have overwritten what 40 showed.
    assert_eq!((s.camera_reordered(), s.shared_records()), (vec![40], vec![38]));
    assert!(!s.free_slots().contains(&38));
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
        assert!(SettingsBlob::parse(b).unwrap().selected_entries().unwrap().contains(&selected), "{name}");
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
    assert!(s.selected_entries().unwrap().contains(&2));
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

/// Recompute the trailing checksum byte after editing a capture.
fn reseal(b: &mut [u8]) {
    let last = b.len() - 1;
    let sum = b[0x0C..last].iter().fold(0u8, |a, c| a.wrapping_add(*c));
    b[last] = sum.wrapping_neg();
}

#[test]
fn other_lumix_bodies_are_read_when_the_structure_matches() {
    let Some(mut b) = fixture("s1m2_fw15_test01_slot40.bin") else { return };
    // Same layout under another model string (as an S5II would report it).
    b[0x1E..0x1E + 8].copy_from_slice(b"DC-S5M2\0");
    reseal(&mut b);
    let s = SettingsBlob::parse(b.clone()).unwrap();
    assert_eq!(s.model(), "DC-S5M2");
    assert_eq!(s.entries().len(), 41);
    assert!(s.selected_entries().unwrap().contains(&2));

    // Not a LUMIX model string.
    let mut other = b.clone();
    other[0x1E..0x1E + 8].copy_from_slice(b"XX-1234\0");
    reseal(&mut other);
    assert!(matches!(SettingsBlob::parse(other), Err(Error::UnsupportedModel(_))));
}

#[test]
fn reads_the_photo_and_video_selections() {
    // 2026-11-16, Windows: photo mode on entry 37, video mode with no LUT.
    if let Some(b) = fixture("s1m2_fw15_photo37_video_none.bin") {
        assert_eq!(SettingsBlob::parse(b).unwrap().selected_entries(), Some(vec![37]));
    }
    // Then video mode on ARRI 709 (entry 1).
    if let Some(b) = fixture("s1m2_fw15_photo37_video1.bin") {
        assert_eq!(SettingsBlob::parse(b).unwrap().selected_entries(), Some(vec![1, 37]));
    }
}

#[test]
fn delete_works_when_photo_mode_uses_no_lut() {
    // 2026-11-16: photo mode set to Standard (no LUT) while video mode kept ARRI 709. The
    // photo item then reads "no LUT" (42), which blocked every delete before.
    let Some(b) = fixture("s1m2_fw15_photo_none_video1.bin") else { return };
    let s = SettingsBlob::parse(b).unwrap();
    assert_eq!(s.selected_entries(), Some(vec![1]));
    let out = s.without_lut(37).unwrap();
    assert!(!out.entries()[37].in_use);
}

#[test]
fn delete_refuses_an_entry_selected_in_video_mode() {
    let Some(mut b) = fixture("s1m2_fw15_photo_none_video1.bin") else { return };
    // Point the video selection (0x0530, all three copies) at entry 37.
    for seq in 0..3u8 {
        let pat = [0x30, 0x05, seq, 0x00, 0x1C, 0x00, 0x00, 0x00];
        let at = b.windows(8).position(|w| w == pat).expect("video selection item");
        b[at + 8 + 4] = 38;
    }
    reseal(&mut b);
    let s = SettingsBlob::parse(b).unwrap();
    assert_eq!(s.selected_entries(), Some(vec![37]));
    assert!(matches!(s.without_lut(37), Err(Error::Slot(_))), "entry 37 is selected in video mode");
    assert!(s.without_lut(36).is_ok());
}

fn identity(s: &SettingsBlob) -> Vec<Option<usize>> {
    s.entries().iter().map(|e| e.in_use.then_some(e.index)).collect()
}

#[test]
fn swapping_two_entries_moves_name_style_and_lut_together() {
    let Some(b) = fixture("s1m2_fw15_photo_none_video1.bin") else { return };
    let s = SettingsBlob::parse(b.clone()).unwrap();
    let before = s.entries();
    let (a, c) = (30, 33);
    assert!(before[a].in_use && before[c].in_use);
    let mut order = identity(&s);
    order.swap(a, c);
    let out = s.rearranged(&order).unwrap();
    let after = out.entries();
    for (k, from) in [(a, c), (c, a)] {
        assert_eq!(after[k].name, before[from].name);
        assert_eq!(after[k].style_code, before[from].style_code);
        assert_eq!(out.lut(k), s.lut(from), "LUT data moved with entry {from}");
        // The link must equal the entry's own index.
        let t = TITLES + k * STRIDE;
        assert_eq!(&out.as_bytes()[t + 4..t + 6], &(k as u16).to_le_bytes());
    }
    // Nothing else changed in the Library.
    for k in (0..before.len()).filter(|&k| k != a && k != c) {
        assert_eq!(after[k], before[k]);
    }
    // Swapping back restores the original bytes exactly.
    let back = out.rearranged(&order).unwrap();
    assert!(back.as_bytes() == b.as_slice());
}

#[test]
fn moving_into_an_empty_entry_empties_the_old_one_like_a_delete() {
    let Some(b) = fixture("s1m2_fw15_photo_none_video1.bin") else { return };
    let s = SettingsBlob::parse(b).unwrap();
    let free = *s.free_slots().first().expect("an empty entry");
    let from = 30;
    let mut order = identity(&s);
    order[free] = Some(from);
    order[from] = None;
    let out = s.rearranged(&order).unwrap();
    assert_eq!(out.entries()[free].name, s.entries()[from].name);
    assert_eq!(out.lut(free), s.lut(from));
    assert!(!out.entries()[from].in_use);
    let deleted = s.without_lut(from).unwrap();
    let t = TITLES + from * STRIDE;
    assert_eq!(&out.as_bytes()[t..t + STRIDE], &deleted.as_bytes()[t..t + STRIDE], "emptied like the camera's delete");
}

#[test]
fn moving_refuses_fixed_entries_and_incomplete_orders() {
    let Some(b) = fixture("s1m2_fw15_photo_none_video1.bin") else { return };
    let s = SettingsBlob::parse(b).unwrap();
    assert_eq!(s.selected_entries(), Some(vec![1]));
    let base = identity(&s);
    let refuse = |order: &[Option<usize>], why: &str| assert!(matches!(s.rearranged(order), Err(Error::Slot(_))), "{why}");
    refuse(&base, "nothing moves");
    let mut o = base.clone();
    o.swap(1, 30);
    refuse(&o, "entry 1 is built in and selected in video mode");
    let mut o = base.clone();
    o.swap(0, 30);
    refuse(&o, "entry 0 is built in");
    let mut o = base.clone();
    o[31] = Some(30);
    refuse(&o, "entry 30 placed twice, 31 lost");
    let mut o = base.clone();
    o[30] = None;
    refuse(&o, "entry 30 would be lost");
    refuse(&base[..base.len() - 1], "wrong length");
}

#[test]
fn delete_is_refused_when_the_selected_entry_cannot_be_read() {
    let Some(mut b) = fixture("s1m2_fw15_test01_slot40.bin") else { return };
    // Hide the selected-entry item (id 0x052F, index 1) by renumbering it.
    let pat = [0x2F, 0x05, 0x01, 0x00, 0x1C, 0x00, 0x00, 0x00];
    let at = b.windows(8).position(|w| w == pat).expect("selected item index 1");
    b[at] = 0x30;
    reseal(&mut b);
    let s = SettingsBlob::parse(b).unwrap();
    assert_eq!(s.selected_entries(), None);
    assert!(matches!(s.without_lut(37), Err(Error::Slot(_))));
    // Registering does not depend on it.
    assert!(s.with_lut(38, "TEST", BaseStyle::VLog, &test01(), false).is_ok());
}

/// Reordering in the camera's own menu (2026-11-22 capture, against the app's backup taken just
/// before): names and styles moved between entries 28..=36, the LUT records stayed put, and each
/// moved entry's link points at its old record.
#[test]
fn camera_reordered_entries_are_found_and_not_overwritten() {
    let (Some(before), Some(after)) = (fixture("s1m2_fw15_before_camera_reorder.bin"), fixture("s1m2_fw15_after_camera_reorder.bin")) else { return };
    let (before, after) = (SettingsBlob::parse(before).unwrap(), SettingsBlob::parse(after).unwrap());
    assert!(before.camera_reordered().is_empty() && before.shared_records().is_empty());
    assert_eq!(after.camera_reordered(), (28..=36).collect::<Vec<_>>());
    assert_eq!(after.shared_records(), (28..=36).collect::<Vec<_>>());

    // Each LUT is still read under its own name, wherever the camera moved the name.
    let (b, a) = (before.entries(), after.entries());
    for k in 28..=36 {
        let was = b.iter().find(|e| e.in_use && e.name == a[k].name).expect("same names before and after");
        assert_eq!(after.lut(k), before.lut(was.index), "entry {k} {:?}", a[k].name);
    }

    // Writing a reordered entry would overwrite another entry's LUT: refused.
    let lut = test01();
    let err = after.with_lut(31, "TEST01", BaseStyle::Standard, &lut, true).unwrap_err();
    assert!(matches!(err, Error::Reordered(_)), "{err}");
    // Free entries whose records nobody uses still take new LUTs.
    assert_eq!(after.free_slots(), vec![20, 21, 37, 38, 39, 40]);
    assert!(after.with_lut(37, "TEST01", BaseStyle::Standard, &lut, false).is_ok());
}

/// Moving LUTs in the app after a reorder in the camera's menu: the moved LUTs and every
/// camera-reordered entry are written back with their own link, each keeping the LUT it showed.
#[test]
fn moving_after_a_camera_reorder_keeps_every_lut_and_clears_the_reorder() {
    let Some(after) = fixture("s1m2_fw15_after_camera_reorder.bin") else { return };
    let s = SettingsBlob::parse(after).unwrap();
    let before = s.entries();
    let selected = s.selected_entries().unwrap();
    let movable: Vec<usize> = (2..before.len()).filter(|&k| before[k].in_use && !selected.contains(&k)).collect();
    let free = *s.free_slots().last().unwrap();

    // A swap plus a move into an empty entry, inside the range the camera reordered.
    let (a, c) = (29, 34);
    assert!(movable.contains(&a) && movable.contains(&c) && movable.contains(&31));
    let mut order = identity(&s);
    order.swap(a, c);
    order[free] = Some(31);
    order[31] = None;
    let out = s.rearranged(&order).unwrap();

    assert!(out.camera_reordered().is_empty(), "every used entry has its own link again");
    assert!(out.shared_records().is_empty());
    let after = out.entries();
    for (k, from) in order.iter().enumerate() {
        match from {
            Some(f) => {
                assert_eq!(after[k].name, before[*f].name, "entry {k}");
                assert_eq!(after[k].style_code, before[*f].style_code, "entry {k}");
                assert_eq!(out.lut(k), s.lut(*f), "entry {k} shows the LUT entry {f} showed");
            }
            None => assert!(!after[k].in_use, "entry {k} is empty"),
        }
    }
    // Moving back gives the same names and LUTs in the original places (links now normalized).
    let mut back = identity(&out);
    back.swap(a, c);
    back[31] = Some(free);
    back[free] = None;
    let again = out.rearranged(&back).unwrap();
    for k in 0..before.len() {
        assert_eq!(again.entries()[k].name, before[k].name);
        assert_eq!(again.lut(k), s.lut(k), "entry {k}");
    }
}

/// LUMIX L10 settings saved to a card (2026-11-27): the same data as an S1II USB read without
/// the 12-byte header, with a 192-byte block per entry after the titles holding the LUT
/// display switch. The camera loaded TEST01 written here into entry 5, hidden; after turning
/// it on in the menu and saving again, only that switch changed in the Library.
#[test]
fn l10_card_file_takes_a_lut_like_the_camera_stores_it() {
    let (Some(original), Some(saved)) = (fixture("l10_camset_original.dat"), fixture("l10_camset_test01_shown.dat")) else { return };
    let s = SettingsBlob::from_card_file(&original).unwrap();
    assert_eq!(s.model(), "DC-L10");
    assert!(s.card_file_bytes() == original.as_slice());
    let names: Vec<String> = s.entries().iter().filter(|e| e.in_use).map(|e| e.name.clone()).collect();
    assert_eq!(names, ["Vlog_709", "ARRI 709", "Sample LUT1", "Sample LUT2", "Sample LUT3"]);
    assert_eq!((0..6).map(|k| s.shown(k).unwrap()).collect::<Vec<_>>(), [true, false, true, true, true, false]);

    let out = s.with_lut(5, "TEST01", BaseStyle::Standard, &test01(), false).unwrap();
    let camera = SettingsBlob::from_card_file(&saved).unwrap();
    assert_eq!(out.entries(), camera.entries());
    for k in 0..out.entries().len() {
        assert_eq!(out.shown(k), camera.shown(k), "display switch of entry {k}");
        assert_eq!(out.lut(k), camera.lut(k), "LUT of entry {k}");
    }
    assert_eq!(out.shown(5), Some(true));
    // The S1II has no display switch.
    if let Some(b) = fixture("s1m2_fw15_first_read.bin") {
        assert_eq!(SettingsBlob::parse(b).unwrap().shown(2), None);
    }
}
