//! Photo sending for the sosang app (from PhotoCourier): list JPG photos in a folder, preview
//! them upright, level them by hand, and write copies to another folder without touching the
//! originals. HEIF is not handled yet.

pub mod exif;
pub mod export;
pub mod image;
pub mod scan;

pub use export::{export, Format, Job};
pub use scan::{list, Kind, PhotoEntry};

/// Why a photo could not be read or written. The app shows its own wording per kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Not a readable JPEG (damaged, truncated, or not a JPEG at all).
    Unreadable,
    /// A JPEG this app does not process (CMYK, too large for the output format).
    Unsupported,
    Encode,
    /// The folder or file could not be read.
    Read(String),
    /// The destination could not be written.
    Write(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Unreadable => f.write_str("not a readable JPEG"),
            Error::Unsupported => f.write_str("unsupported JPEG"),
            Error::Encode => f.write_str("encoding failed"),
            Error::Read(e) => write!(f, "read failed: {e}"),
            Error::Write(e) => write!(f, "write failed: {e}"),
        }
    }
}

impl std::error::Error for Error {}
