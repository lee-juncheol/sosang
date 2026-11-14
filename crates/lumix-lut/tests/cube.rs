use lumix_lut::{parse_cube, validate_name, BaseStyle, Error};

fn identity_cube(header: &str) -> String {
    let mut s = String::from(header);
    s.push_str("LUT_3D_SIZE 33\n");
    for b in 0..33 {
        for g in 0..33 {
            for r in 0..33 {
                s.push_str(&format!("{:.6} {:.6} {:.6}\n", r as f64 / 32.0, g as f64 / 32.0, b as f64 / 32.0));
            }
        }
    }
    s
}

#[test]
fn reads_tag_title_and_order() {
    let c = parse_cube(&identity_cube("TITLE \"Id\"\n#LUMIXPHOTOSTYLE STD\n")).unwrap();
    assert_eq!(c.title.as_deref(), Some("Id"));
    assert_eq!(c.base_style().unwrap(), BaseStyle::Standard);
    let v = c.lut.values();
    assert_eq!(v[0], [0, 0, 0]);
    assert_eq!(v[1], [2048, 0, 0]); // red varies fastest: 1/32 * 65535 = 2047.97
    assert_eq!(v[33], [0, 2048, 0]);
    assert_eq!(v[33 * 33], [0, 0, 2048]);
    assert_eq!(*v.last().unwrap(), [65535, 65535, 65535]);
}

#[test]
fn untagged_is_vlog_and_other_tags_are_refused() {
    assert_eq!(parse_cube(&identity_cube("")).unwrap().base_style().unwrap(), BaseStyle::VLog);
    let c = parse_cube(&identity_cube("#LUMIXPHOTOSTYLE VIVD\n")).unwrap();
    assert!(matches!(c.base_style(), Err(Error::UnsupportedPhotoStyle(_))));
}

#[test]
fn rejects_unsupported_cubes() {
    assert!(parse_cube("LUT_3D_SIZE 17\n").is_err());
    assert!(parse_cube("LUT_1D_SIZE 1024\n").is_err());
    let mut bad = identity_cube("");
    bad.push_str("0 0 0\n");
    assert!(parse_cube(&bad).is_err(), "too many entries");
    assert!(parse_cube(&identity_cube("DOMAIN_MAX 2 2 2\n")).is_err());
    assert!(parse_cube(&identity_cube("").replacen("0.000000 0.000000 0.000000", "1.5 0 0", 1)).is_err());
}

#[test]
fn names() {
    assert!(validate_name("WEDDIRS.cube").is_ok());
    assert!(validate_name("PRO Neg - STD v2.cube").is_ok());
    assert!(validate_name("").is_err());
    assert!(validate_name("한글").is_err());
    assert!(validate_name(&"a".repeat(96)).is_err());
}
