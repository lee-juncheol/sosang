"""Bake Standard JPEGs through the colour model and explicit JPG tone protection."""
import numpy as np

from pipeline.common import std_to_vlog
from pipeline.slide import run_slide_reference
from pipeline.digital import run_digital_reference
from pipeline.jpg import JpgToneProtection
from spektrafilm_lut_creator.grid import cube_grid
from spektrafilm_lut_creator.qa.reference import run_pipeline_at

STD_GENERATION = 'direct-engine-grid-jpg-tone-v3'
STD_INPUT_GAIN = 1.0
STD_CONTRACT = (
    'L_STD grid(x) = JpgToneProtection(x, F_VLOG(VLogEncode(sRGBDecode(x) @ sRGB_to_VGamut.T))); '
    'F_VLOG is the continuous upstream engine, not the exported VLOG cube. '
    'Native linear input gain = 1.0; no intermediate VLOG LUT interpolation. '
    'The display-referred Film Lab protection reduces repeated model tonality, '
    'removes neutral casts, bounds coloured-shadow lightness changes and maps chroma into sRGB. '
    'This is not an inverse camera profile or unmodified upstream tonality.'
)


def run_std_native(spec, bundle, samples, *, is_slide=False, is_digital=False):
    """Unprotected continuous model; retained as the colour source and audit reference."""
    if spec.input_color_space != 'Panasonic V-Log' or spec.output_color_space != 'sRGB':
        raise ValueError('STD adapter requires Panasonic V-Log input and sRGB output')
    if not np.isclose(spec.bake_frame().input_gain, STD_INPUT_GAIN, atol=1e-12, rtol=0):
        raise ValueError('STD adapter requires unchanged native input exposure (gain 1)')
    coordinates = std_to_vlog(np.asarray(samples, dtype=np.float64).reshape(-1, 3))
    if not np.isfinite(coordinates).all() or coordinates.min() < 0 or coordinates.max() > 1:
        raise ValueError('Analytic adapter outside source domain')
    if is_slide and is_digital:
        raise ValueError('Select either positive direct scan or negative digital conversion')
    if is_digital:
        return run_digital_reference(spec, coordinates)
    if is_slide:
        return run_slide_reference(spec, coordinates)
    return run_pipeline_at(spec, bundle, 0, coordinates)


def std_protection(spec, bundle, *, is_slide=False, is_digital=False):
    return JpgToneProtection(
        lambda samples: run_std_native(spec, bundle, samples, is_slide=is_slide, is_digital=is_digital),
        digital=is_digital,
    )


def run_std_reference(spec, bundle, samples, *, is_slide=False, is_digital=False, protection=None):
    protection = protection or std_protection(spec, bundle, is_slide=is_slide, is_digital=is_digital)
    return protection.apply(samples)


def bake_std(spec, bundle, *, is_slide=False, is_digital=False, protection=None):
    """One engine evaluation per STD grid node; final cube uses R-fastest order."""
    n = spec.resolution
    return run_std_reference(spec, bundle, cube_grid(n), is_slide=is_slide, is_digital=is_digital,
                             protection=protection).reshape(n, n, n, 3)
