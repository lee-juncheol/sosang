Film Lab / Kodak Portra 800 + Kodak Vision Premier 2393

Processing mode: negative_print; scan_film=False

0091VLOG.cube: Panasonic V-Log / V-Gamut input -> sRGB output
0091STD.cube: Standard/sRGB analytic working model input -> sRGB output
33 x 33 x 33, full range 0..1. Both files produce sRGB, NOT Rec.709.
S1M2 / S1II physical camera validation: NOT performed.
Do not apply the VLOG file to an already normalized Rec.709/sRGB picture.
Standard mapping is approximate; clipped highlights cannot be recovered.
STD grid nodes are evaluated directly through the upstream engine using the
analytic sRGB -> V-Gamut -> V-Log input mapping. No intermediate VLOG cube
is interpolated. Native input gain remains 1.0; no exposure boost is added.
stdVsDirectEngine in qa.json is the end-to-end STD accuracy measurement.
stdVsContinuousComposition is only a diagnostic difference from the legacy
VLOG-cube composition, not the accuracy reference.
Previews apply this exported STD file directly to LUT-OFF S1M2 Standard
captures or a synthetic sRGB chart. No extra V-Log/gamma transform is used.
They are not a validation against camera-applied LUT captures.

Derived from spektrafilm by Andrea Volpato
https://github.com/andreavolpato/spektrafilm
Licensed CC BY-SA 4.0. See SPEKTRAFILM_LICENSE.txt and CHANGELOG.txt.
Engine commit: 3bb2c2d2801ff68b92019cf1dbcbb133d60832bc
File checks and measured interpolation errors: qa.json
Settings and provenance: provenance.json
