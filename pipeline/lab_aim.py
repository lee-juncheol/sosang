"""Manufacturer lab-aim printing ("제조사 기준 인화"): print the way the paper's datasheet says a lab should.

Motion-picture print datasheets give status A aim densities for an 18% gray
card on a normally exposed negative:

    Kodak VISION 2383 (H-1-2383, LAD):          R 1.09  G 1.06  B 1.03
    Fujifilm ETERNA-CP 3523XD (KB-1004E):       R 1.10  G 1.05  B 1.05

Kodak states that its aims read as a visually neutral gray of density 1.00.
spektrafilm has no exact status A response, and matching the numbers with an
approximate one tints whole images red by 10-30%, so the fit asks for what the
aims describe: the 18% gray prints neutral on screen at visual density 1.00
(CIE 1931 y-bar under the paper's viewing illuminant, base included).

Recipe: the film's neutral filters plus an M/Y shift and a print exposure
factor on top of the usual mid-gray print-exposure normalization:

    appliedCC = filmCC + [0, m, y],  print_exposure = factor

Neutral printing (the base look) prints that gray lighter (visual density
about 0.75 on 2383), so lab-aim prints are darker and denser.
"""
from __future__ import annotations

from dataclasses import replace
import math

import colour
import numpy as np
from scipy.optimize import least_squares

from pipeline.common import sha256, vlog_encode
from spektrafilm.model.illuminants import standard_illuminant
from spektrafilm.runtime.params_builder import digest_params, init_params
from spektrafilm.runtime.pipeline import SimulationPipeline
from spektrafilm.utils.io import read_neutral_print_filters
from spektrafilm_lut_creator.builders import BundleBuilder
from spektrafilm_lut_creator.color_spaces import decode_cctf, encode_cctf, get

METHOD = 'film-lab-lab-aim-v1'
SUFFIX = '__labaim'
NUMBER_OFFSET = 2000
VISUAL_AIM = 1.00
GRAY = 0.184
AIMS = {
    'kodak_2383': {'statusA': [1.09, 1.06, 1.03], 'source': 'Kodak VISION Color Print Film 2383 datasheet H-1-2383 (laboratory aim density, LAD)'},
    'fujifilm_eterna_cp_3523xd': {'statusA': [1.10, 1.05, 1.05], 'source': 'Fujifilm ETERNA-CP 3523XD datasheet KB-1004E'},
}
LIMITATIONS = [
    'Experimental Film Lab variant, not an upstream spektrafilm preset.',
    'The datasheet aims are status A densities; spektrafilm has no exact status A response, so the fit targets the '
    'visually neutral density-1.00 gray those aims describe, not the three numbers themselves.',
    'Only the 18% gray is fitted; the rest of the tone and colour response is the engine\'s.',
    'Not compared with a real lab print.',
]


def _database():
    return read_neutral_print_filters()


def film_cc(film, paper):
    params = init_params(film_profile=film, print_profile=paper)
    return np.asarray(_database()[paper][params.enlarger.illuminant][film], dtype=float), params.enlarger.illuminant


def configure(params, film, paper, shift, exposure):
    cc, _ = film_cc(film, paper)
    params.settings.neutral_print_filters_from_database = False
    params.enlarger.c_filter_neutral = float(cc[0])
    params.enlarger.m_filter_neutral = float(cc[1] + shift[0])
    params.enlarger.y_filter_neutral = float(cc[2] + shift[1])
    params.enlarger.m_filter_shift = 0.
    params.enlarger.y_filter_shift = 0.
    params.enlarger.normalize_print_exposure = True
    return params


def make_pipeline(spec, film, paper, shift, exposure, in_entry=None, out_entry=None):
    in_entry, out_entry = in_entry or get(spec.input_color_space), out_entry or get(spec.output_color_space)
    params = init_params(film_profile=film, print_profile=paper)
    params.debug.lut_mode = True
    params.io.input_color_space = in_entry.primaries
    params.io.output_color_space = out_entry.primaries
    params.io.input_cctf_decoding = False
    params.io.output_cctf_encoding = False
    params.io.input_gamut_compress = spec.input_gamut_compress
    params.io.output_gamut_compress = spec.output_gamut_compress
    # digest_params resets print_exposure to 1 in lut_mode, so the factor goes on afterwards.
    digested = digest_params(configure(params, film, paper, shift, exposure))
    digested.enlarger.print_exposure = float(exposure)
    return SimulationPipeline(digested), digested


def _linear(spec, encoded):
    samples = np.asarray(encoded, dtype=np.float32).reshape(-1, 3)
    return (decode_cctf(samples, spec.input_color_space) * spec.bake_frame().input_gain).astype(np.float32)


def run_reference(spec, points, shift, exposure):
    """Encoded sRGB output for V-Log samples, independent of the builder and baked cube."""
    film, paper = spec.film_profile, spec.print_profiles[0]
    pipe, _ = make_pipeline(spec, film, paper, shift, exposure)
    out = np.asarray(pipe.process(_linear(spec, points).reshape(1, -1, 3)), dtype=float).reshape(-1, 3)
    return np.clip(encode_cctf(out * spec.bake_frame().output_gain, spec.output_color_space), 0., 1.)


def measure_gray(spec, shift, exposure):
    """(visual density, linear sRGB output) of the app's 18% gray."""
    film, paper = spec.film_profile, spec.print_profiles[0]
    pipe, params = make_pipeline(spec, film, paper, shift, exposure)
    linear = _linear(spec, vlog_encode(np.array([[GRAY] * 3]))).reshape(1, 1, 3)
    cmy = np.asarray(pipe.process(linear, collect='cmy_print'), dtype=float).reshape(3)
    rgb = np.asarray(pipe.process(linear), dtype=float).reshape(3)
    data = params.print.data
    wl = np.asarray(data.wavelengths)
    cmfs = colour.MSDS_CMFS['CIE 1931 2 Degree Standard Observer']
    ybar = np.interp(wl, cmfs.wavelengths, cmfs.values[:, 1])
    light = np.asarray(standard_illuminant(params.print.info.viewing_illuminant), dtype=float).ravel() * ybar
    spectral = np.nan_to_num(np.asarray(data.channel_density)) @ cmy + np.nan_to_num(np.asarray(data.base_density))
    return float(-np.log10(np.sum(light * 10 ** -spectral) / np.sum(light))), rgb


def solve(spec):
    """(shift (m, y) in 0.1 CC, exposure factor, visual density, gray chroma %) for the lab aim."""
    def residual(v):
        density, rgb = measure_gray(spec, v[1:], 10 ** v[0])
        return np.r_[(density - VISUAL_AIM) * 100, (rgb / rgb.mean() - 1) * 100]
    r = least_squares(residual, np.zeros(3), bounds=([-1., -100., -100.], [1., 100., 100.]), diff_step=1e-3)
    shift = tuple(float(v) + 0. for v in np.round(r.x[1:], 1))
    exposure = round(float(10 ** r.x[0]), 4)
    density, rgb = measure_gray(spec, shift, exposure)
    return shift, exposure, density, float(np.abs(rgb / rgb.mean() - 1).max() * 100)


def settings(film, paper, shift, exposure, density=None, chroma=None):
    cc, illuminant = film_cc(film, paper)
    applied = cc + np.array([0., *shift])
    result = {'method': METHOD, 'experimental': True, 'film': film, 'paper': paper, 'illuminant': illuminant,
              'channelOrder': ['C', 'M', 'Y'], 'units': 'Kodak CC; 100 CC = 1.0 filter optical density',
              'filmCC': cc.tolist(), 'shiftCC': [0., *shift], 'appliedCC': applied.tolist(),
              'printExposure': exposure, 'printExposureStops': round(math.log2(exposure), 4),
              'formula': 'appliedCC = filmCC + shiftCC; print_exposure = factor x normalized mid-gray exposure',
              'aim': {'visualDensity': VISUAL_AIM, 'neutral': True, 'datasheet': AIMS[paper]},
              'normalizePrintExposure': True, 'notes': LIMITATIONS}
    if density is not None: result['grayVisualDensity'] = round(density, 4)
    if chroma is not None: result['grayChromaMaxPct'] = round(chroma, 4)
    return result


class LabAimBundleBuilder(BundleBuilder):
    def __init__(self, spec, shift, exposure):
        super().__init__(spec)
        self.shift, self.exposure = tuple(shift), float(exposure)

    def _make_pipeline(self, spec, in_entry, out_entry, print_stock):
        return make_pipeline(spec, spec.film_profile, print_stock, self.shift, self.exposure, in_entry, out_entry)[0]

    def build(self):
        if self.spec.topology != '1lut': raise ValueError('Lab-aim variants support combined 1lut only')
        bundle = super().build()
        snapshot = dict(bundle.meta.params_snapshot)
        for paper, value in snapshot.items():
            snapshot[paper] = {**value, 'labAim': settings(self.spec.film_profile, paper, self.shift, self.exposure)}
        bundle.meta = replace(bundle.meta, params_snapshot=snapshot)
        return bundle
