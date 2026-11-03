"""Official FUJIFILM LUT composition with explicit Film Lab input adaptation.

The downloaded 65-grid F-Log2 LUT values are never regraded. The sRGB input
adapter is a display-linear-as-scene approximation, not a camera inverse.
"""
from __future__ import annotations

import io
import json
import subprocess
import zipfile
from functools import lru_cache

import numpy as np
from pipeline.common import ROOT, srgb_decode, VGAMUT_TO_SRGB, sha256
from pipeline.research import srgb_encode
from spektrafilm_lut_creator.qa.evaluators import apply_tetrahedral

CONFIG_PATH = ROOT / 'pipeline/config/fujifilm-official.json'
METHOD_ID = 'film-lab-fujifilm-official-paper-v1'
# D65 sRGB -> BT.2020; F-Gamut has exactly the BT.2020 primaries.
SRGB_TO_FGAMUT = np.array([
    [.627403895934699, .329283038377883, .043313065687418],
    [.069097289358232, .919540395075459, .011362315566309],
    [.016391438875150, .088013307877226, .895595253247624],
])


def load_study():
    study = json.loads(CONFIG_PATH.read_text())
    if study['methodId'] != METHOD_ID or len(study['looks']) != 10:
        raise ValueError('Unexpected official LUT study')
    return study


def official_archive(*, download=False):
    study = load_study()
    path = ROOT / '.cache/fujifilm-gfx/gfx-eterna-55-3d-lut-v110.zip'
    if not path.exists() and download:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix('.download')
        subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error',
                        '--output', str(temporary), study['downloadUrl']], check=True)
        if sha256(temporary) != study['sourceSha256']:
            raise ValueError('Official package changed; review a new version before use')
        temporary.replace(path)
    if not path.exists() or sha256(path) != study['sourceSha256']:
        raise ValueError('Missing or changed official package; run generator with --download')
    return path


@lru_cache(maxsize=10)
def official_table(film_id):
    import hashlib
    look = next(x for x in load_study()['looks'] if x['film'] == film_id)
    with zipfile.ZipFile(official_archive()) as archive:
        raw = archive.read(look['sourceArchivePath'])
    if hashlib.sha256(raw).hexdigest() != look['sourceSha256']:
        raise ValueError('Official LUT hash mismatch')
    lines = raw.decode('utf-8-sig').splitlines()
    if 'LUT_3D_SIZE 65' not in lines:
        raise ValueError('Expected official 65-grid LUT')
    rows = '\n'.join(line for line in lines if line.strip() and not line.startswith(('#', 'LUT_3D_SIZE')))
    table = np.loadtxt(io.StringIO(rows)).reshape(65, 65, 65, 3)
    if not np.isfinite(table).all() or table.min() < 0 or table.max() > 1:
        raise ValueError('Invalid official LUT')
    table.setflags(write=False)
    return table


def flog2_encode(linear):
    """Fujifilm F-Log2 datasheet 1.1, scene reflection to full-range code."""
    x = np.asarray(linear, dtype=float)
    return np.where(x >= .000889,
                    .245281 * np.log10(np.maximum(5.555556*x + .064829, 1e-30)) + .384316,
                    8.799461*x + .092864)


def flog2_decode(encoded):
    x = np.asarray(encoded, dtype=float)
    return np.where(x >= .100686685370811,
                    (10**((x-.384316)/.245281)-.064829)/5.555556,
                    (x-.092864)/8.799461)


def input_to_flog2(rgb, input_kind='std'):
    x = np.asarray(rgb, dtype=float)
    if x.ndim < 1 or x.shape[-1] != 3 or not np.isfinite(x).all() or np.any((x < 0) | (x > 1)):
        raise ValueError('Expected finite full-range RGB triples')
    if input_kind == 'std':
        linear = srgb_decode(x) @ SRGB_TO_FGAMUT.T
    elif input_kind == 'vlog':
        vlinear = np.where(x < .181, (x-.125)/5.6, 10**((x-.598206)/.241514)-.00873)
        linear = vlinear @ (SRGB_TO_FGAMUT @ VGAMUT_TO_SRGB).T
    else:
        raise ValueError('Input must be std or vlog')
    # Negative/over-domain code values cannot be queried in a bounded cube.
    return np.clip(flog2_encode(linear), 0, 1)


def apply_official(rgb, film_id, input_kind='std', paper=None):
    x = np.asarray(rgb, dtype=float)
    flog = input_to_flog2(x, input_kind)
    encoded709 = apply_tetrahedral(official_table(film_id), flog.reshape(-1, 3))
    # Whitepaper p13 recommends Rec.709/D65/gamma 2.2 for these LUTs.
    # Explicitly re-encode for the application's sRGB display contract.
    linear = np.clip(encoded709, 0, 1)**2.2
    if paper is not None:
        linear = paper.apply(linear)
    return np.clip(srgb_encode(linear), 0, 1).reshape(x.shape)
