Film Lab / FUJIFILM GFX ETERNA 55 / CLASSIC CHROME
Paper: Kodak Professional Portra Endura

Official source: https://www.fujifilm-x.com/global/support/download/lut/
Package v1.10; selected 65-grid F-Log2 LUT v1.00.
Source LUT: FLog2_to_CLASSIC-CHROME_65grid_V.1.00.cube
SHA256: 43f7fc5f262eaa2525c0de805ad7fa50f5b77d85873840ae48ab2a07a6b36ff9

0207STD.cube: rendered Standard/sRGB -> shared PROVIA neutral-response
inverse -> virtual scene RGB -> F-Log2/F-Gamut -> composition below -> JPG tone protection.
0207VLOG.cube: Panasonic V-Log/V-Gamut input -> F-Log2/F-Gamut (experimental).
Both: official LUT -> BT709/gamma2.2 interpretation -> optional virtual printer
and spektrafilm paper development/scanning -> sRGB. 33 cubed full range 0..1.
STD additionally uses fixed Film Lab neutral-tone compensation, source-lightness
bounds, neutral-cast removal and chroma gamut mapping. This preserves rendered
JPG gradation, including coloured shadows, and changes original model contrast.
No measured GFX JPEG or physical print match is claimed. VLOG is unchanged.
These downloads are Film Lab compositions, NOT unmodified official Fuji LUTs.
The GFX camera's proprietary rendering cannot be recovered from a LUMIX JPEG.
The optional printer uses fixed per-stock neutral-ramp exposure calibration
and a smooth target retaining paper black, white and middle gray. This avoids
a second steep shadow curve without altering spectral dyes or paper profiles.
The digital printer bridge is a Film Lab creative assumption, not
an official Fuji recipe or calibrated optical print. See provenance.json.
No spatial grain, halation, or image-dependent auto exposure is applied.

Official LUT data copyright FUJIFILM Corporation; original rights retained.
No CC BY-SA license is granted for FUJIFILM data by Film Lab.
Paper profiles and shared tools: spektrafilm by Andrea Volpato.
https://github.com/andreavolpato/spektrafilm
SPEKTRAFILM_LICENSE.txt applies to upstream components, not to Fuji data.
User photo copyrights remain with their owner. Not an affiliated product.
