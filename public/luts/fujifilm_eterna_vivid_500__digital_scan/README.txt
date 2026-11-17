Film Lab / fujifilm_eterna_vivid_500 / negative_digital
Camera: LUMIX S1II (S1II, DC-S1M2)

0262STD.cube: S1II Standard -> V-Log Alchemy adapter -> original creative VLOG.
0262VLOG.cube: unchanged Panasonic V-Log / V-Gamut -> sRGB renderer.
Both are 33 x 33 x 33, full range 0..1. Apply only one creative cube.
STD: select this exact camera model, unadjusted Standard base, LUT opacity 100%.
VLOG: supply real Panasonic V-Log/V-Gamut. Do not add a second display conversion.
GH6 Standard output is post-processing only. DC-L10 does not mean DMC-L10.

The merged STD uses adapter trilinear -> serialized creative tetrahedral, then
nine-decimal 33-grid export. It contains no Film Lab B precurve, chroma gain,
automatic exposure or added colour correction. Browser previews use the same
merged cube. QA compares the serialized cube against the sequential transform;
it does not establish physical film accuracy or a camera-specific match.

Source adapter: https://github.com/shenmintao/V-Log-Alchemy/blob/e51ba9a23458ff5c316f630b860eb0201139d126/Luts/Panasonic-Standard/Conversion/S1IIS2V.cube
Adapter modified by Film Lab: smoothed only in colours with no nearby camera
sample (fixes a cyan band in blue skies); neutral axis unchanged.
Adapter SHA256 (Film Lab smoothed): a46b3369f1d9f4d8948e6fc9f20ed5594602b7361a0e1a0958b9d06a4d0611f1
Creative VLOG SHA256: b0e32838faa192055bcc2a1495380988c0d8d6c4d9753e2162cc10403cf2ed70
Upstream camera calibration status: pending.

Modified by Film Lab: merged camera Standard adapter and creative VLOG renderer.
V-Log Alchemy by shenmintao, Apache-2.0; license included.
spektrafilm by Andrea Volpato, https://github.com/andreavolpato/spektrafilm
SPEKTRAFILM_LICENSE.txt and spektrafilm-LICENSE.txt preserve upstream terms.
FUJIFILM source rights remain separate where FUJIFILM_NOTICE.txt is included.

- Standard clipping and gamut compression cannot be inverted exactly; clipped highlights and colours cannot be restored.
- Use the exact camera model and unadjusted Standard Photo Style. No automatic exposure or image statistics are applied.
- Camera cube interpolation is undocumented; tetrahedral and trilinear rebake error are both reported.
- Native V-Log acquisition gain, noise and highlight headroom cannot be recreated by an output LUT.
- Matched controlled capture validation is pending for this camera model.
