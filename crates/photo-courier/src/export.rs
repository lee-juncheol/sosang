//! Writing one photo into the destination folder. The original is only read. A finished file
//! appears under its final name in one step, and an existing file is never replaced.

use crate::exif;
use crate::image::{self, Rgb};
use crate::Error;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Format {
    /// Unchanged photos are copied byte for byte; leveled ones are re-encoded as JPG.
    Original,
    /// Lossy WebP at this quality (1–100).
    WebP(u8),
}

#[derive(Debug, Clone)]
pub struct Job {
    pub source: PathBuf,
    pub destination: PathBuf,
    /// Level rotation in degrees, positive = counterclockwise.
    pub level: f64,
    pub format: Format,
}

/// Quality of re-encoded JPGs.
pub const JPEG_QUALITY: u8 = 96;

/// Write the photo and return the path it was saved under.
pub fn export(job: &Job) -> Result<PathBuf, Error> {
    let data = fs::read(&job.source).map_err(|e| Error::Read(e.to_string()))?;
    let stem = job.source.file_stem().and_then(|s| s.to_str()).unwrap_or("photo");
    let source_ext = job.source.extension().and_then(|s| s.to_str()).unwrap_or("jpg");
    let level = job.level.clamp(-image::LEVEL_LIMIT, image::LEVEL_LIMIT);
    let (bytes, ext) = if level == 0.0 && job.format == Format::Original {
        (data, source_ext.to_string())
    } else {
        let decoded = image::decode(&data, None)?;
        drop(data);
        let upright: Rgb = image::level(&image::upright(&decoded.image, decoded.orientation), level);
        let tiff = decoded.exif.as_deref().and_then(|t| exif::normalized(t, upright.width as u32, upright.height as u32));
        match job.format {
            Format::Original => (image::encode_jpeg(&upright, JPEG_QUALITY, tiff.as_deref(), decoded.icc.as_deref())?, source_ext.to_string()),
            Format::WebP(q) => (image::encode_webp(&upright, q.clamp(1, 100), tiff.as_deref(), decoded.icc.as_deref())?, "webp".to_string()),
        }
    };
    write_new(&job.destination, stem, &ext, &bytes)
}

static STAGE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// `name.ext`, else `name_1.ext`, `name_2.ext`, … whichever does not exist yet.
pub fn write_new(folder: &Path, stem: &str, ext: &str, bytes: &[u8]) -> Result<PathBuf, Error> {
    let write_err = |e: std::io::Error| Error::Write(e.to_string());
    // Stage beside the destination so the final rename stays on one volume.
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let staged = folder.join(format!(
        ".sosang-send-{}-{stamp}-{}.tmp",
        std::process::id(),
        STAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&staged).map_err(write_err)?;
        file.write_all(bytes).map_err(write_err)?;
        file.sync_all().map_err(write_err)?;
        drop(file);
        for number in 0u32.. {
            let name = if number == 0 { format!("{stem}.{ext}") } else { format!("{stem}_{number}.{ext}") };
            let target = folder.join(name);
            // Claim the name first: create_new fails if any other file (or another send) has it.
            match OpenOptions::new().write(true).create_new(true).open(&target) {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(write_err(e)),
            }
            // Replaces only the empty placeholder this call just created.
            if let Err(e) = fs::rename(&staged, &target) {
                let _ = fs::remove_file(&target);
                return Err(write_err(e));
            }
            return Ok(target);
        }
        unreachable!()
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::Rgb;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("photo-courier-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_jpeg(orientation: u16) -> Vec<u8> {
        let mut img = Rgb::new(120, 80);
        for (i, v) in img.pixels.iter_mut().enumerate() {
            *v = (i % 251) as u8;
        }
        let tiff = crate::exif::tests::sample_tiff(true, orientation, &[0xFF, 0xD8, 0, 0]);
        image::encode_jpeg(&img, 90, Some(&tiff), None).unwrap()
    }

    #[test]
    fn names_never_overwrite() {
        let dir = temp_dir("names");
        assert_eq!(write_new(&dir, "P1", "JPG", b"a").unwrap(), dir.join("P1.JPG"));
        assert_eq!(write_new(&dir, "P1", "JPG", b"b").unwrap(), dir.join("P1_1.JPG"));
        assert_eq!(write_new(&dir, "P1", "JPG", b"c").unwrap(), dir.join("P1_2.JPG"));
        assert_eq!(fs::read(dir.join("P1.JPG")).unwrap(), b"a");
        let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
        assert!(leftovers.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unchanged_photos_are_copied_exactly_and_edits_are_upright() {
        let dir = temp_dir("export");
        let src = dir.join("in");
        let dst = dir.join("out");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        let original = sample_jpeg(6);
        fs::write(src.join("P100.JPG"), &original).unwrap();
        let job = |level, format| Job { source: src.join("P100.JPG"), destination: dst.clone(), level, format };

        let copied = export(&job(0.0, Format::Original)).unwrap();
        assert_eq!(fs::read(&copied).unwrap(), original);

        let leveled = export(&job(2.5, Format::Original)).unwrap();
        assert_eq!(leveled, dst.join("P100_1.JPG"));
        let back = image::decode(&fs::read(&leveled).unwrap(), None).unwrap();
        assert_eq!((back.image.width, back.image.height), (80, 120));
        assert_eq!(back.orientation, 1);
        assert_eq!(crate::exif::Tiff::new(back.exif.as_deref().unwrap()).unwrap().info().iso, Some(800));

        let webp = export(&job(0.0, Format::WebP(72))).unwrap();
        assert_eq!(webp, dst.join("P100.webp"));
        let decoded = webp::Decoder::new(&fs::read(&webp).unwrap()).decode().unwrap();
        assert_eq!((decoded.width(), decoded.height()), (80, 120));

        assert_eq!(fs::read(src.join("P100.JPG")).unwrap(), original);
        fs::remove_dir_all(dir).unwrap();
    }
}
