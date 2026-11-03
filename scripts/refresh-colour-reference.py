"""Refresh JS fixtures with independent colour-science parsing/interpolation.

Run: .venv/bin/python scripts/refresh-colour-reference.py
Preserves the stored RGBA input pixels and alpha. It imports no application
parser, evaluator or pipeline code and verifies source cubes against catalog.
"""
import hashlib
import json
from pathlib import Path

import colour
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
fixture_path = ROOT / 'tests/fixtures/colour-reference.json'
fixture = json.loads(fixture_path.read_text())
original_pixels = list(fixture['pixels'])
pixels = np.asarray(original_pixels, dtype=np.uint8).reshape(-1, 4)
catalog = json.loads((ROOT / 'public/catalog.json').read_text())
assets = {asset['path'].lstrip('/'): asset for combo in catalog['combinations']
          for asset in combo['files'].values()}
for case in fixture['fixtures']:
    path = ROOT / 'public' / case['path']
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != assets[case['path']]['sha256']:
        raise ValueError(f'Catalog hash mismatch: {case["path"]}')
    lut = colour.read_LUT(str(path))
    rgb = lut.apply(pixels[:, :3] / 255.0,
                    interpolator=colour.algebra.table_interpolation_tetrahedral)
    if rgb.shape != pixels[:, :3].shape or not np.isfinite(rgb).all():
        raise ValueError('Invalid independent interpolation output')
    expected = pixels.copy()
    expected[:, :3] = np.floor(np.clip(rgb, 0, 1) * 255 + .5).astype(np.uint8)
    assert np.array_equal(expected[:, 3], pixels[:, 3])
    case['expected'] = expected.reshape(-1).tolist()
    case['sourceSha256'] = digest
assert fixture['pixels'] == original_pixels
fixture['reference'] = ('colour-science tetrahedral, independent parser; preserved 512 seeded random + '
                        '27 RGB boundary/midpoint colors; byte output rounded nearest, half up; alpha unchanged')
fixture['generator'] = 'scripts/refresh-colour-reference.py'
fixture['colourVersion'] = colour.__version__
fixture_path.write_text(json.dumps(fixture, separators=(',', ':')) + '\n')
print(json.dumps({'fixtures': len(fixture['fixtures']), 'rgbaPixelsPerFixture': len(pixels),
                  'inputAndAlphaPreserved': True, 'catalogHashesVerified': True,
                  'sourceSha256': [case['sourceSha256'] for case in fixture['fixtures']]}))
