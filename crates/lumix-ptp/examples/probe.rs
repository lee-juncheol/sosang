//! Hardware check for lumix-ptp.
//!
//!   cargo run -p lumix-ptp --example probe                 # read only: device info + Library
//!   cargo run -p lumix-ptp --example probe -- --rewrite    # write the settings back unchanged
//!   cargo run -p lumix-ptp --example probe -- --register FILE.cube SLOT NAME [--overwrite]
//!   cargo run -p lumix-ptp --example probe -- --test01 SLOT [--overwrite]
//!   cargo run -p lumix-ptp --example probe -- --dump FILE  # save the settings read (personal data)
//!   cargo run -p lumix-ptp --example probe -- --describe-backup FILE.bin MILLIS ACTION
//!       # write the .json record for an older backup of THIS camera (serial is not printed)
//!
//! Backups go to ./camera-backups/. ImageCaptureCore needs the main run loop, so the work runs
//! on a second thread while the main thread spins NSRunLoop (on Windows it just waits).

use lumix_lut::{parse_cube, BaseStyle, Lut33};
use lumix_ptp::{register_lut, Camera};
use std::path::Path;
use std::time::{Duration, Instant};

fn test01() -> Lut33 {
    let mut v = Vec::new();
    for b in 0..33 {
        for g in 0..33 {
            for r in 0..33 {
                let y = ((0.2126 * r as f64 + 0.7152 * g as f64 + 0.0722 * b as f64) / 32.0 * 65535.0).round_ties_even().min(65535.0) as u16;
                v.push([y, y, y]);
            }
        }
    }
    Lut33::from_u16(v).unwrap()
}

fn run(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let cam = Camera::open("S1M2", Duration::from_secs(15))?;
    let i = cam.info();
    println!("camera: {} {} firmware {} (write verified: {})", i.manufacturer, i.model, i.version, i.write_verified());
    let t = Instant::now();
    let blob = cam.read_settings()?;
    println!("read settings: {} bytes in {:.1}s", blob.as_bytes().len(), t.elapsed().as_secs_f32());
    for e in blob.entries().iter().filter(|e| e.in_use) {
        println!("  {:2} [{:2}] {}", e.index, e.style_code, e.name);
    }
    println!("free slots: {:?}", blob.free_slots());
    let overwrite = args.iter().any(|a| a == "--overwrite");
    let backups = Path::new("camera-backups");
    let progress = |s: &str| println!("  .. {s}");
    match args.first().map(String::as_str) {
        Some("--describe-backup") => {
            let (file, millis, action) = (Path::new(&args[1]), args[2].parse()?, &args[3]);
            lumix_lut::SettingsBlob::parse(std::fs::read(file)?)?;
            lumix_ptp::write_backup_info(cam.info(), file, millis, action)?;
            println!("wrote {}", file.with_extension("json").display());
        }
        Some("--dump") => {
            std::fs::write(&args[1], blob.as_bytes())?;
            println!("saved {}", args[1]);
        }
        Some("--rewrite") => {
            let t = Instant::now();
            cam.write_settings(&blob)?;
            println!("rewrote unchanged settings in {:.1}s", t.elapsed().as_secs_f32());
            let again = cam.read_settings()?;
            let diff = again.as_bytes().iter().zip(blob.as_bytes()).filter(|(a, b)| a != b).count();
            println!("read back: {diff} bytes differ (camera-side state bytes are expected)");
        }
        Some("--register") => {
            let (file, slot, name) = (&args[1], args[2].parse()?, &args[3]);
            let cube = parse_cube(&std::fs::read_to_string(file)?)?;
            let r = register_lut(&cam, slot, name, cube.base_style()?, &cube.lut, overwrite, backups, progress)?;
            println!("registered {:?} in entry {} (backup {}, other changed bytes {})", r.name, r.index, r.backup.display(), r.other_changes);
        }
        Some("--test01") => {
            let slot = args[1].parse()?;
            let r = register_lut(&cam, slot, "TEST01", BaseStyle::Standard, &test01(), overwrite, backups, progress)?;
            println!("registered TEST01 in entry {} (backup {}, other changed bytes {})", r.index, r.backup.display(), r.other_changes);
        }
        _ => {}
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::thread::spawn(move || {
        let code = match run(args) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("error: {e}");
                1
            }
        };
        // Let the session close on the main thread before exiting.
        std::thread::sleep(Duration::from_millis(500));
        std::process::exit(code);
    });
    #[cfg(target_os = "macos")]
    objc2_foundation::NSRunLoop::mainRunLoop().run();
    // Elsewhere the main thread only waits; the worker thread exits the process.
    #[cfg(not(target_os = "macos"))]
    loop {
        std::thread::park();
    }
}
