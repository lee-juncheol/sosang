Film Lab / Kodak Portra 400 + Fujifilm Crystal Archive Type II

Processing mode: negative_print; scan_film=False


0081VLOG.cube: Panasonic V-Log / V-Gamut input -> sRGB output
0081STD.cube: Standard/sRGB -> colour model -> Film Lab JPG tone protection -> sRGB
33 x 33 x 33, full range 0..1. Both files produce sRGB, NOT Rec.709.
S1M2 / S1II physical camera validation: NOT performed.
Do not apply the VLOG file to an already normalized Rec.709/sRGB picture.
Standard mapping is approximate; clipped highlights cannot be recovered.
STD grid nodes are evaluated directly through the colour model and the fixed
Film Lab JPG tone-protection policy. Neutral tonality is reduced, coloured
shadow lightness is bounded, neutral casts are removed and chroma is mapped
into sRGB. No image statistics or automatic exposure are used. This is NOT
unmodified upstream tonality, a camera inverse, or measured film/print accuracy.
Native model input gain remains 1.0. VLOG keeps its original rendering.
stdVsDirectEngine in qa.json compares to the complete protected STD reference.
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
