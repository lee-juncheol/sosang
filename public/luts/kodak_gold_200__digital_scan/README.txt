Film Lab / Kodak Gold 200 + Film Lab digital positive (experimental, no paper)

Processing mode: negative_digital; scan_film=True
Digital method: film-lab-common-digital-negative-v1. Upstream film exposure/development -> D50 fixed Gaussian RGB transmission; D=-log10(S/S_base), S=sum(D50*Gaussian*10^(-spectral_density)); q=0.184*10^((D-D_gray)/0.60), where D_gray is the same film at linear RGB 0.184; shared channel shoulder q/(0.816+q) -> upstream output gamut compression. No paper, per-film slope/matrix fit, image statistics or automatic exposure. Generic digital positive model; not a measured physical scanner. Experimental Film Lab extension; not a measured scanner or the upstream authors print rendering.

0165VLOG.cube: Panasonic V-Log / V-Gamut input -> sRGB output
0165STD.cube: Standard/sRGB analytic working model input -> sRGB output
33 x 33 x 33, full range 0..1. Both files produce sRGB, NOT Rec.709.
S1M2 / S1II physical camera validation: NOT performed.
Do not apply the VLOG file to an already normalized Rec.709/sRGB picture.
Standard mapping is approximate; clipped highlights cannot be recovered.
STD grid nodes are evaluated directly through upstream film stages plus Film Lab digital conversion using the
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
