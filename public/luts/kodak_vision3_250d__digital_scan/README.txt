Film Lab / kodak_vision3_250d / negative_digital
Camera: LUMIX S1II (S1II, DC-S1M2)

0174STD.cube: S1II Standard -> V-Log Alchemy adapter -> original creative VLOG.
0174VLOG.cube: unchanged Panasonic V-Log / V-Gamut -> sRGB renderer.
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
Adapter SHA256: 7f1f997cb4bcf5c427e8e6ccc81acfedd3f14dae0b1e8e3f8672a8231daefa7e
Creative VLOG SHA256: 019ab2aa9e40496d6961122c7b4ceae34f21cfe94eb59a894c5237a4e3308d4b
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
