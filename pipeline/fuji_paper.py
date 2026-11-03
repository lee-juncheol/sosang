"""A declared digital-printer bridge into upstream paper development/scanning.

The input is display-linear sRGB/BT.709 RGB, *after* a film-simulation LUT.
It is not film density or scene-linear camera exposure.  The bridge creates
virtual paper-channel log exposures with one shared slope, then runs only
the existing paper-development and print-scanning nodes.  It never applies
a second film simulation or the upstream optical enlarger exposure model.
"""
from __future__ import annotations

from copy import deepcopy

import numpy as np
from scipy.optimize import least_squares

from pipeline.common import CONFIG
from spektrafilm.runtime.params_builder import digest_params, init_params
from spektrafilm.runtime.pipeline import SimulationPipeline
from spektrafilm.runtime.topology import Tap
from spektrafilm.utils.gamut_compression import OutputGamutCompressSpec


METHOD_ID = 'film-lab-fuji-digital-paper-bridge-v1'
GRAY_ANCHOR = 0.184
COMMON_SLOPE = 0.60
LINEAR_FLOOR = 1e-6
STAGE_NAMES = ('printing.develop', 'scanning.scan_print')


class PaperBridge:
    """Map a rendered RGB image through a fixed, gray-calibrated print model.

    ``COMMON_SLOPE`` is a Film Lab rendering choice, not a Fujifilm or measured
    printer coefficient.  Calibration solves one RGB offset per print stock;
    it does not fit individual simulations, images, slopes, or color matrices.
    Upstream paper curves, spectral dyes, and the print scanner stay intact.
    """

    def __init__(self, paper_id: str, init_film: str = 'kodak_portra_400'):
        params = init_params(film_profile=init_film, print_profile=paper_id)
        if params.print.info.stage != 'printing' or not params.print.is_negative:
            raise ValueError('Paper bridge requires a negative printing profile')
        params.debug.lut_mode = True
        params.settings.neutral_print_filters_from_database = False
        params.settings.use_scanner_lut = False
        params.io.scan_film = False
        params.io.input_color_space = 'sRGB'
        params.io.input_cctf_decoding = False
        params.io.output_color_space = 'sRGB'
        params.io.output_cctf_encoding = False
        params.io.output_gamut_compress = OutputGamutCompressSpec(
            algorithm=CONFIG['output_gamut_compress'],
        )
        self._pipeline = SimulationPipeline(digest_params(params))
        self.paper_id = paper_id
        self.init_film = init_film
        self._support = params.print.info.support

        # LOG_E_PRINT bypasses preprocess, all film nodes, and the enlarger.
        # lut_mode disables black/white correction, image statistics, and all
        # spatial/stochastic effects, so no earlier-stage state is required.
        log_exposure = np.asarray(params.print.data.log_exposure, dtype=float)
        result = least_squares(
            lambda offset: self._from_log_exposure(offset) - GRAY_ANCHOR,
            np.zeros(3),
            bounds=(float(log_exposure.min()), float(log_exposure.max())),
            xtol=1e-12, ftol=1e-12, gtol=1e-12,
        )
        self.offset = np.asarray(result.x, dtype=float)
        self._calibrated_gray = self._from_log_exposure(self.offset)
        self._calibration_error = float(np.max(np.abs(self._calibrated_gray - GRAY_ANCHOR)))
        if not result.success or self._calibration_error > 1e-7:
            raise RuntimeError(f'Paper gray calibration failed for {paper_id}')
        endpoints = self.apply(np.array([[0., 0., 0.], [1., 1., 1.]]))
        self._endpoints = {'black': endpoints[0].tolist(), 'white': endpoints[1].tolist()}

    def _from_log_exposure(self, log_exposure: np.ndarray) -> np.ndarray:
        values = np.asarray(log_exposure, dtype=float)
        result = self._pipeline.process(values.reshape(1, -1, 3), inject=Tap.LOG_E_PRINT)
        return np.asarray(result, dtype=float).reshape(values.shape)

    def apply(self, linear_srgb_array) -> np.ndarray:
        """Accept finite 0..1 RGB of shape ``(..., 3)``; return the same shape."""
        try:
            rgb = np.asarray(linear_srgb_array, dtype=np.float64)
        except (TypeError, ValueError) as exc:
            raise ValueError('Paper bridge input must be a numeric RGB array') from exc
        if rgb.ndim < 1 or rgb.shape[-1] != 3 or not rgb.size:
            raise ValueError('Paper bridge input must have nonempty shape (..., 3)')
        if not np.isfinite(rgb).all():
            raise ValueError('Paper bridge input must be finite')
        if rgb.min() < 0 or rgb.max() > 1:
            raise ValueError('Paper bridge input must be display-linear RGB in 0..1')
        log_exposure = self.offset - COMMON_SLOPE * np.log10(
            np.maximum(rgb, LINEAR_FLOOR) / GRAY_ANCHOR,
        )
        output = self._from_log_exposure(log_exposure)
        if not np.isfinite(output).all():
            raise RuntimeError('Non-finite paper bridge output')
        # The upstream gamut compressor bounds the result.  Clip only final
        # floating-point boundary overshoot; no image-dependent normalization.
        return np.clip(output, 0., 1.)

    def metadata(self) -> dict:
        """Return reproducible settings and explicit limits of the bridge."""
        return deepcopy({
            'method': METHOD_ID,
            'paperProfile': self.paper_id,
            'profileSupport': self._support,
            'input': 'display-linear sRGB / BT.709 primaries, D65, RGB 0..1',
            'output': 'display-linear sRGB, D65, RGB 0..1; encode sRGB after this stage',
            'formula': 'logE = offset - 0.60 * log10(max(linearRGB, 1e-6) / 0.184)',
            'offset': self.offset.tolist(),
            'commonSlope': COMMON_SLOPE,
            'linearFloor': LINEAR_FLOOR,
            'grayLinearAnchor': GRAY_ANCHOR,
            'calibratedGrayLinearRGB': self._calibrated_gray.tolist(),
            'calibrationMaxAbsLinearRGBError': self._calibration_error,
            'calibration': 'one fixed three-channel exposure offset per print stock; neutral gray only',
            'linearEndpointOutputs': self._endpoints,
            'upstreamStagesApplied': list(STAGE_NAMES),
            'upstreamPaperCurvesModified': False,
            'upstreamOpticalEnlargerApplied': False,
            'upstreamFilmStagesApplied': False,
            'runtimeInitFilm': self.init_film,
            'runtimeInitFilmApplied': False,
            'spectralScannerLUT': False,
            'outputGamutCompression': CONFIG['output_gamut_compress'],
            'perSimulationCalibration': False,
            'perImageCalibration': False,
            'physicalPrinterCalibrated': False,
            'fujifilmOfficialPaperTransform': False,
            'limitations': [
                'Virtual digital-printer exposure mapping; not an optical negative-to-paper exposure model.',
                'The shared 0.60 slope is a Film Lab rendering choice, not measured printer or Fujifilm data.',
                'Only middle gray is balanced; paper contrast, endpoint compression, and other gray-axis casts remain.',
                'Paper development, spectral dyes, viewing illuminant, and gamut compression use the pinned upstream model.',
                'Kodak 2383 and 2393 are motion-picture print films, not photographic paper.',
                'Fujifilm simulation output plus this bridge is a derived creative result, not an official Fujifilm paper rendering.',
            ],
        })
