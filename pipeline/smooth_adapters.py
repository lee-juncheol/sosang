"""Smooth the V-Log Alchemy Standard->V-Log adapters where no camera data exists.

The upstream v1.6 adapters are solved on a 9-point lattice and resampled to 33
points. In colours with no controlled camera sample (for example blue sky) the
solve bends, and a smooth blue gradient turns into a cyan band after the film
look. This keeps the adapter unchanged next to real S1RII sample pairs, blends
toward a smoothed copy far from them, and restores the exact neutral axis.

Usage:
  .venv/bin/python -m pipeline.smooth_adapters --source artifacts/before-adapter-smoothing
  .venv/bin/python -m pipeline.smooth_adapters --sky-v2     # second pass on the v1 files in public/

Sky v2 (2026-11-14): after v1 a small hue wobble was left in clear-sky gradients (hue turns cyan, back,
then blue; Reddit photo test). v2 blurs only nodes whose input colour is sky blue (OKLab hue 255 +-45,
chroma > 0.02), sigma 2.5 nodes, and again restores the exact neutral axis.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter
from scipy.spatial import cKDTree

from pipeline.common import PUBLIC

ADAPTERS = PUBLIC / 'camera-adapters'
ANCHORS_SHA256 = '950e498b9ddb0a206866b345dc1fbce329432a4337171ac83c8ee12d1f7deed6'
PARAMS = {'smoothSigmaNodes': 3.0, 'dataDistanceFull': 0.03, 'dataDistanceNone': 0.08, 'maskSigmaNodes': 1.0}
METHOD = 'film-lab-adapter-smoothing-v1'
NOTE = ('Film Lab modification: smoothed only where no controlled camera sample is nearby '
        '(blue/cyan/purple sky band fix). Neutral axis kept exact.')


def read(path: Path):
    lines = path.read_text().splitlines()
    header = [l for l in lines if l and not l[0].isdigit() and not l.startswith('-')]
    rows = np.array([[float(v) for v in l.split()] for l in lines if l and (l[0].isdigit() or l[0] == '-')])
    n = round(len(rows) ** (1 / 3))
    return header, rows.reshape(n, n, n, 3)  # file order: red fastest -> [b][g][r]


def write(path: Path, header, table):
    out = [l for l in header if not l.startswith('LUT_3D_SIZE')]
    out.append('# ' + NOTE)
    out.append(f'LUT_3D_SIZE {table.shape[0]}')
    body = '\n'.join(' '.join(f'{v:.10f}' for v in row) for row in table.reshape(-1, 3))
    path.write_text('\n'.join(out) + '\n\n' + body + '\n')


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def data_weight(anchors: Path, n: int):
    if hashlib.sha256(anchors.read_bytes()).hexdigest() != ANCHORS_SHA256:
        raise ValueError('Unexpected anchor file')
    standard = np.load(anchors, allow_pickle=False)['standard']
    g = np.linspace(0, 1, n)
    b, gg, r = np.meshgrid(g, g, g, indexing='ij')           # [b][g][r] node coordinates
    nodes = np.stack([r, gg, b], -1).reshape(-1, 3)            # as RGB
    dist = cKDTree(standard).query(nodes)[0].reshape(n, n, n)
    w = sstep(PARAMS['dataDistanceFull'], PARAMS['dataDistanceNone'], dist)
    return gaussian_filter(w, PARAMS['maskSigmaNodes'], mode='nearest')[..., None]


def keep_neutral(new, orig):
    n = new.shape[0]
    i = np.arange(n)
    offset = orig[i, i, i] - new[i, i, i]
    level = np.add.outer(np.add.outer(i, i), i) / 3.0
    out = new.copy()
    for k in range(3):
        out[..., k] += np.interp(level, i, offset[:, k])
    return out


def smooth(table, weight):
    s = PARAMS['smoothSigmaNodes']
    blurred = np.stack([gaussian_filter(table[..., k], s, mode='nearest') for k in range(3)], -1)
    return np.clip(keep_neutral(table * (1 - weight) + blurred * weight, table), 0, 1)


SKY_PARAMS = {'hue': 255.0, 'halfWidth': 45.0, 'fadeDegrees': 20.0, 'chromaMin': 0.02, 'chromaRamp': 0.03,
              'maskSigmaNodes': 1.0, 'smoothSigmaNodes': 2.5}
SKY_METHOD = 'film-lab-adapter-smoothing-v2-sky'
SKY_NOTE = 'Film Lab modification v2: extra smoothing of sky-blue input colours only (hue wobble fix). Neutral axis kept exact.'


def _oklab_hue_chroma(rgb):
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    m1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566],
                   [0.0883024619, 0.2817188376, 0.6299787005]])
    m2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468], [1.9779984951, -2.4285922050, 0.4505937099],
                   [0.0259040371, 0.7827717662, -0.8086757660]])
    lab = np.cbrt(lin @ m1.T) @ m2.T
    return np.degrees(np.arctan2(lab[..., 2], lab[..., 1])) % 360, np.hypot(lab[..., 1], lab[..., 2])


def sky_weight(n: int):
    p = SKY_PARAMS
    g = np.linspace(0, 1, n)
    b, gg, r = np.meshgrid(g, g, g, indexing='ij')            # [b][g][r] node coordinates
    hue, chroma = _oklab_hue_chroma(np.stack([r, gg, b], -1))
    d = np.abs((hue - p['hue'] + 180) % 360 - 180)
    w = np.clip(1 - (d - p['halfWidth']) / p['fadeDegrees'], 0, 1) * np.clip((chroma - p['chromaMin']) / p['chromaRamp'], 0, 1)
    return gaussian_filter(w, p['maskSigmaNodes'])[..., None]


def smooth_sky(table):
    w = sky_weight(table.shape[0])
    s = SKY_PARAMS['smoothSigmaNodes']
    blurred = np.stack([gaussian_filter(table[..., k], s, mode='nearest') for k in range(3)], -1)
    return np.clip(keep_neutral(table * (1 - w) + blurred * w, table), 0, 1)


def main_sky_v2():
    manifest = json.loads((ADAPTERS / 'manifest.json').read_text())
    if manifest.get('filmLabModification', {}).get('method') != METHOD:
        raise SystemExit(f'Expected the v1 adapters in public/ (found {manifest.get("filmLabModification", {}).get("method")})')
    sums = []
    for item in manifest['luts']:
        path = ADAPTERS / Path(item['path']).name
        if hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError(f'Adapter is not the recorded v1 file: {path.name}')
        header, table = read(path)
        header = [l for l in header if not l.startswith('# Film Lab modification')]
        fixed = smooth_sky(table)
        i = np.arange(table.shape[0])
        assert np.abs(fixed[i, i, i] - table[i, i, i]).max() < 1e-12, 'neutral axis moved'
        out = [l for l in header if not l.startswith('LUT_3D_SIZE')] + ['# ' + NOTE, '# ' + SKY_NOTE, f'LUT_3D_SIZE {table.shape[0]}']
        path.write_text('\n'.join(out) + '\n\n' + '\n'.join(' '.join(f'{v:.10f}' for v in row) for row in fixed.reshape(-1, 3)) + '\n')
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        item['v1Sha256'] = item['sha256']
        item['sha256'] = digest
        item['filmLabModificationV2'] = {'method': SKY_METHOD, 'params': SKY_PARAMS,
                                         'maxChange': float(np.abs(fixed - table).max()), 'meanChange': float(np.abs(fixed - table).mean())}
        sums.append(f'{digest}  {item["path"]}')
        print(f'{path.name}: sky v2 max change {np.abs(fixed - table).max():.4f}, mean {np.abs(fixed - table).mean():.5f}')
    manifest['filmLabModification'] = {**manifest['filmLabModification'], 'method': SKY_METHOD, 'previousMethod': METHOD,
                                       'note': NOTE + ' ' + SKY_NOTE, 'skyParams': SKY_PARAMS,
                                       'skyReason': 'v1 left a small cyan-then-blue hue wobble in clear-sky gradients (2026-11-14 Reddit photo test).'}
    (ADAPTERS / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
    old = (ADAPTERS / 'SHA256SUMS.txt').read_text().splitlines()
    other = [l for l in old if not l.split()[-1].startswith('Conversion/')]
    (ADAPTERS / 'SHA256SUMS.txt').write_text('\n'.join(sums + other) + '\n')
    src = json.loads((ADAPTERS / 'source.json').read_text())
    src.update(filmLabModification=SKY_METHOD)
    (ADAPTERS / 'source.json').write_text(json.dumps(src, indent=2, ensure_ascii=False) + '\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, help='Folder with the untouched camera-adapters/ and the anchor npz')
    parser.add_argument('--sky-v2', action='store_true', help='Apply the sky v2 pass to the v1 adapters in public/')
    args = parser.parse_args()
    if args.sky_v2:
        return main_sky_v2()
    if not args.source: parser.error('--source is required (or use --sky-v2)')
    source = args.source / 'camera-adapters'
    manifest = json.loads((source / 'manifest.json').read_text())
    weight = None
    sums = []
    for item in manifest['luts']:
        name = Path(item['path']).name
        original = source / name
        if hashlib.sha256(original.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError(f'Source adapter is not the pinned upstream file: {name}')
        header, table = read(original)
        if weight is None: weight = data_weight(args.source / 'PanasonicForwardPairAnchors.npz', table.shape[0])
        fixed = smooth(table, weight)
        i = np.arange(table.shape[0])
        assert np.abs(fixed[i, i, i] - table[i, i, i]).max() < 1e-12, 'neutral axis moved'
        write(ADAPTERS / name, header, fixed)
        digest = hashlib.sha256((ADAPTERS / name).read_bytes()).hexdigest()
        item['upstreamSha256'] = item['sha256']
        item['sha256'] = digest
        item['filmLabModification'] = {'method': METHOD, 'params': PARAMS, 'anchorsSha256': ANCHORS_SHA256,
                                       'maxChange': float(np.abs(fixed - table).max()),
                                       'meanChange': float(np.abs(fixed - table).mean())}
        sums.append(f'{digest}  {item["path"]}')
        print(f'{name}: max change {np.abs(fixed - table).max():.4f}, mean {np.abs(fixed - table).mean():.5f}')
    manifest['filmLabModification'] = {'method': METHOD, 'note': NOTE, 'params': PARAMS,
                                       'reason': 'Upstream v1.6 bends blue/cyan gradients where no camera sample exists.'}
    (ADAPTERS / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
    upstream_sums = (source / 'SHA256SUMS.txt').read_text().splitlines()
    other = [l for l in upstream_sums if not l.split()[-1].startswith('Conversion/')]
    (ADAPTERS / 'SHA256SUMS.txt').write_text('\n'.join(sums + other) + '\n')
    src = json.loads((source / 'source.json').read_text())
    src.update(filesUnmodified=False, filmLabModification=METHOD,
               note='Conversion cubes are smoothed by Film Lab where no controlled camera sample exists; '
                    'upstream hashes are kept as upstreamSha256 in manifest.json. Merged creative LUTs are separately identified derivatives.')
    (ADAPTERS / 'source.json').write_text(json.dumps(src, indent=2, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    main()
