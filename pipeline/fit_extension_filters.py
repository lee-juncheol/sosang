"""Fit neutral print filters for Film Lab extension papers.

Same goal as upstream's database: 18% gray prints neutral (R = G = B on the
sRGB output) for each film, with C fixed at 0 and normalized print exposure.
Gray is the V-Log 18% sample the app uses (pipeline.print_blend.measure_cast).
Positive films get upstream's placeholder [0, 50, 50]; they are never printed.

Run: .venv/bin/python -m pipeline.fit_extension_filters
"""
from __future__ import annotations

from pipeline.common import CONFIG, profiles, save_json, vlog_encode
from pipeline import extensions
import json

import numpy as np
from scipy.optimize import least_squares
from spektrafilm.runtime.params_builder import digest_params, init_params
from spektrafilm.runtime.pipeline import SimulationPipeline
from spektrafilm.utils.io import read_neutral_print_filters
from spektrafilm_lut_creator.bundles import BundleSpec
from spektrafilm_lut_creator.color_spaces import decode_cctf, get

STARTING_PAPER = 'kodak_2383'


def gray_output(film, paper, cmy):
    spec = BundleSpec(film_profile=film, print_profiles=(paper,), input_color_space=CONFIG['input'],
                      output_color_space=CONFIG['output'], topology=CONFIG['topology'], resolution=CONFIG['resolution'],
                      target=CONFIG['target'], stops_above_midgray=CONFIG['stops_above_midgray'],
                      output_gamut_compress=CONFIG['output_gamut_compress'])
    in_entry, out_entry = get(spec.input_color_space), get(spec.output_color_space)
    params = init_params(film_profile=film, print_profile=paper)
    params.debug.lut_mode = True
    params.io.input_color_space, params.io.output_color_space = in_entry.primaries, out_entry.primaries
    params.io.input_cctf_decoding = params.io.output_cctf_encoding = False
    params.io.input_gamut_compress, params.io.output_gamut_compress = spec.input_gamut_compress, spec.output_gamut_compress
    params.settings.neutral_print_filters_from_database = False
    params.enlarger.c_filter_neutral, params.enlarger.m_filter_neutral, params.enlarger.y_filter_neutral = (float(v) for v in cmy)
    params.enlarger.normalize_print_exposure = True
    pipe = SimulationPipeline(digest_params(params))
    gray = vlog_encode(np.array([[0.184, 0.184, 0.184]]))
    linear = (decode_cctf(gray.astype(np.float32), spec.input_color_space) * spec.bake_frame().input_gain).astype(np.float32)
    return np.asarray(pipe.process(linear.reshape(1, 1, 3)), dtype=float).reshape(3)


def fit(film, paper, start):
    def residual(my):
        rgb = gray_output(film, paper, (0., *my))
        return (rgb / rgb.mean() - 1) * 100
    r = least_squares(residual, np.asarray(start, dtype=float), bounds=([0, 0], [200, 200]), diff_step=0.02)
    return [0.0, float(r.x[0]), float(r.x[1])], float(np.abs(r.fun).max())


def main():
    """Fit every negative-film/paper pair missing from upstream's database and the extension file.

    Existing extension entries are kept as they are, so published looks do not move."""
    from pipeline.extensions import _upstream_filters
    upstream = _upstream_filters()
    existing = extensions.extra_filters()
    stocks = profiles()
    films = [s for s in stocks if s['stage'] == 'filming']
    papers = [s['id'] for s in stocks if s['stage'] == 'printing']
    report = {}
    for paper in papers:
        illuminant = init_params(film_profile='kodak_portra_400', print_profile=paper).enlarger.illuminant
        have = {**upstream.get(paper, {}).get(illuminant, {}), **existing.get(paper, {}).get(illuminant, {})}
        for film in films:
            if film['id'] in have: continue
            table = existing.setdefault(paper, {}).setdefault(illuminant, {})
            if film['type'] == 'positive':
                table[film['id']] = [0.0, 50.0, 50.0]; continue
            ref = upstream.get(paper, upstream[STARTING_PAPER]).get(illuminant, upstream[STARTING_PAPER][illuminant])
            start = ref.get(film['id'], ref.get('kodak_vision3_250d'))[1:]
            table[film['id']], err = fit(film['id'], paper, start)
            report[f"{film['id']}__{paper}"] = round(err, 4)
            print(film['id'], paper, np.round(table[film['id']], 2).tolist(), f'{err:.4f}%', flush=True)
    save_json(extensions.FILTERS_PATH, existing)
    print(json.dumps({'fitted': len(report), 'worstGrayChromaPct': max(report.values(), default=0)}))


if __name__ == '__main__':
    main()
