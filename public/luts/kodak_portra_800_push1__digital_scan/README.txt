Film Lab / Kodak Portra 800 (Push 1) + Film Lab digital positive (experimental, no paper)

Processing mode: negative_digital; scan_film=True
Digital method: film-lab-common-digital-negative-v1. Upstream film exposure/development -> D50 fixed Gaussian RGB transmission; D=-log10(S/S_base), S=sum(D50*Gaussian*10^(-spectral_density)); q=0.184*10^((D-D_gray)/0.60), where D_gray is the same film at linear RGB 0.184; shared channel shoulder q/(0.816+q) -> upstream output gamut compression. No paper, per-film slope/matrix fit, image statistics or automatic exposure. Generic digital positive model; not a measured physical scanner. Experimental Film Lab extension; not a measured scanner or the upstream authors print rendering.

0169VLOG.cube: Panasonic V-Log / V-Gamut input -> sRGB output
0169STD.cube: Standard/sRGB -> colour model -> Film Lab JPG tone protection -> sRGB
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
