"""Append experimental manufacturer lab-aim print LUTs (see pipeline.lab_aim).

One variant per negative film on each paper with a datasheet aim (Kodak 2383,
Fujifilm ETERNA-CP 3523XD). Base looks are not touched; variants live in their
own directories with number = base + 2000.

Run: PYTHONPATH=vendor/spektrafilm/src .venv/bin/python -m pipeline.generate_lab_aim --jobs 4
"""
from __future__ import annotations

from pipeline.common import CONFIG, PUBLIC, ROOT, UPSTREAM, read_cube, save_json, sha256, metrics, vlog_encode
from pipeline.camera_std import rebuild_standard
from pipeline.generate import describe
from pipeline.generate_film_cast import make_spec
from pipeline import lab_aim
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict
from datetime import datetime, timezone
import argparse
import json
import platform
import shutil
import subprocess
import time
import traceback

import numpy as np
from spektrafilm_lut_creator.formats import Lut
from spektrafilm_lut_creator.formats.lumix import LumixCubeFormat
from spektrafilm_lut_creator.grid import cube_grid
from spektrafilm_lut_creator.qa.evaluators import apply_tetrahedral, apply_trilinear

AUDIT = ROOT / 'artifacts/lab-aim'


def candidates(catalog):
    return [c for c in catalog['combinations'] if c.get('processMode') == 'negative_print' and c.get('status') == 'ready'
            and not c.get('castBaseId') and not c.get('labAimBaseId') and c['paper'] in lab_aim.AIMS]


def generate_one(base):
    started = time.perf_counter()
    variant_id = base['id'] + lab_aim.SUFFIX
    number = base['number'] + lab_aim.NUMBER_OFFSET
    directory = PUBLIC / 'luts' / variant_id
    record = {'id': variant_id, 'film': base['film'], 'paper': base['paper'], 'number': number,
              'processMode': 'negative_print', 'labAimBaseId': base['id']}
    try:
        spec = make_spec(base)
        shift, exposure, density, chroma = lab_aim.solve(spec)
        recipe = lab_aim.settings(base['film'], base['paper'], shift, exposure, density, chroma)
        if directory.exists(): shutil.rmtree(directory)
        directory.mkdir(parents=True)
        bundle = lab_aim.LabAimBundleBuilder(spec, shift, exposure).build()
        vlog = bundle.luts[0][1].table
        if not np.isfinite(vlog).all(): raise ValueError('Engine produced non-finite values')
        vlog_path = directory / f'{number:04d}VLOG.cube'
        LumixCubeFormat().write(Lut(vlog, title=f'{number:04d}_VLOG'), vlog_path, photo_style_tag='VLOG')
        vlog_disk = read_cube(vlog_path, 'VLOG')
        roundtrip = float(np.max(np.abs(vlog_disk - vlog)))
        if roundtrip > 0.000000501: raise ValueError('Cube serialization changed the table')
        gray = np.repeat(np.linspace(0, 1, 129)[:, None], 3, axis=1)
        points = np.concatenate([np.random.default_rng(CONFIG['seed']).random((CONFIG['qa_random_samples'], 3)),
                                 gray, cube_grid(5)])
        direct = lab_aim.run_reference(spec, points, shift, exposure)
        if not np.isfinite(direct).all(): raise ValueError('Non-finite independent reference output')
        fidelity = {name: metrics(fn(vlog_disk, points), direct)
                    for name, fn in [('tetrahedral', apply_tetrahedral), ('trilinear', apply_trilinear)]}
        mid = vlog_encode(np.array([[lab_aim.GRAY] * 3]))
        recipe['calibrationGray'] = {'input': 'linear V-Gamut RGB = [0.184, 0.184, 0.184], V-Log encoded',
                                     'outputSpace': 'sRGB, 8-bit scale (unrounded)',
                                     'base': (lab_aim.run_reference(spec, mid, (0., 0.), 1.)[0] * 255).tolist(),
                                     'labAim': (lab_aim.run_reference(spec, mid, shift, exposure)[0] * 255).tolist(),
                                     'baseVisualDensity': round(lab_aim.measure_gray(spec, (0., 0.), 1.)[0], 4)}
        qa = {'fileChecks': 'passed', 'rowsPerCube': 35937, 'serializationMaxError': roundtrip,
              'processMode': 'negative_print', 'scanFilm': False, 'referenceModel': lab_aim.METHOD,
              'vlogVsDirectEngine': fidelity, 'cameraVerified': False, 'labAim': recipe}
        save_json(directory / 'qa.json', qa)
        provenance = {'engine': {'repository': 'https://github.com/andreavolpato/spektrafilm',
                                 'commit': CONFIG['engine_commit'], 'version': CONFIG['engine_version']},
                      'profiles': {'film': base['film'], 'paper': base['paper']}, 'config': CONFIG,
                      'bundle': asdict(bundle.meta), 'processMode': 'negative_print', 'scanFilm': False,
                      'processingPath': 'film exposure -> film development -> print exposure through the film\'s neutral '
                                        'filters plus a solved M/Y shift and print exposure (datasheet lab aim) -> '
                                        'print development -> print scan',
                      'sourceRenderingMethod': lab_aim.METHOD, 'labAim': recipe,
                      'labAimBase': {'id': base['id'], 'vlogSha256': base['files']['vlog']['sha256'], 'preserved': True},
                      'effects': {'grain': False, 'halation': False, 'blur': False, 'autoExposure': False},
                      'environment': {'python': platform.python_version(), 'platform': platform.platform()},
                      'limitations': lab_aim.LIMITATIONS,
                      'license': 'CC BY-SA 4.0; derived from spektrafilm by Andrea Volpato'}
        save_json(directory / 'provenance.json', provenance)
        shutil.copyfile(UPSTREAM / 'SPEKTRAFILM_LICENSE.txt', directory / 'SPEKTRAFILM_LICENSE.txt')
        (directory / 'CHANGELOG.txt').write_text(
            'Film Lab experimental lab-aim variant: printed to the paper datasheet aim (18% gray card neutral at '
            'visual density 1.00) with a solved print exposure and M/Y shift. The base look is unchanged.\n')
        record.update(status='ready', labAim=recipe, qa=qa,
                      files={'vlog': describe(vlog_path), 'qa': describe(directory / 'qa.json'),
                             'provenance': describe(directory / 'provenance.json')})
        record = rebuild_standard(record, backup=False)
        record['seconds'] = round(time.perf_counter() - started, 3)
    except Exception as exc:
        record.update(status='failed', reason=f'{type(exc).__name__}: {exc}')
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'error.log').write_text(traceback.format_exc())
    if record['status'] == 'ready':
        save_json(directory / 'metadata.json', record)
    return record


def publish(catalog, records):
    base = [c for c in catalog['combinations'] if not c.get('labAimBaseId')]
    variants = sorted((r for r in records if r['status'] == 'ready'), key=lambda r: r['number'])
    for stale in PUBLIC.glob(f'luts/*{lab_aim.SUFFIX}'):
        if stale.name not in {r['id'] for r in variants}: shutil.rmtree(stale)
    catalog['combinations'] = base + variants
    catalog['counts'] = {s: sum(c['status'] == s for c in catalog['combinations'])
                         for s in ['ready', 'failed', 'unsupported', 'not-generated']}
    catalog['labAim'] = {'method': lab_aim.METHOD, 'suffix': lab_aim.SUFFIX, 'numberOffset': lab_aim.NUMBER_OFFSET,
                         'experimental': True, 'visualAim': lab_aim.VISUAL_AIM,
                         'papers': {k: v for k, v in lab_aim.AIMS.items()}, 'variants': len(variants),
                         'limitations': lab_aim.LIMITATIONS}
    catalog['generatedAt'] = datetime.now(timezone.utc).isoformat()
    save_json(PUBLIC / 'catalog.json', catalog)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--jobs', type=int, default=3)
    parser.add_argument('--missing', action='store_true', help='Append variants only for base looks without one')
    args = parser.parse_args()
    commit = subprocess.check_output(['git', '-C', str(UPSTREAM), 'rev-parse', 'HEAD'], text=True).strip()
    if commit != CONFIG['engine_commit']: raise SystemExit('Pinned engine commit differs')
    if subprocess.check_output(['git', '-C', str(UPSTREAM), 'diff', '--stat'], text=True).strip():
        raise SystemExit('Vendor checkout must be unchanged')
    catalog = json.loads((PUBLIC / 'catalog.json').read_text())
    bases = candidates(catalog)
    for b in bases:
        if sha256(PUBLIC / b['files']['vlog']['path'].lstrip('/')) != b['files']['vlog']['sha256']:
            raise SystemExit(f'Changed base VLOG: {b["id"]}')
    kept = []
    if args.missing:
        kept = [c for c in catalog['combinations'] if c.get('labAimBaseId')]
        bases = [b for b in bases if b['id'] not in {c['labAimBaseId'] for c in kept}]
    started = time.perf_counter(); records = []
    with ProcessPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        for done, future in enumerate(as_completed([pool.submit(generate_one, b) for b in bases]), 1):
            r = future.result(); records.append(r)
            print(f"[{done}/{len(bases)}] {r['status']} {r['id']} {r.get('reason', '')}", flush=True)
    failed = [r['id'] for r in records if r['status'] == 'failed']
    save_json(AUDIT / 'build-report.json', {
        'variants': len(records) - len(failed), 'failed': failed, 'wallSeconds': round(time.perf_counter() - started, 2),
        'looks': {r['id']: ({k: r['labAim'][k] for k in ['shiftCC', 'printExposure', 'printExposureStops', 'grayVisualDensity', 'grayChromaMaxPct']}
                            | {'baseVisualDensity': r['labAim']['calibrationGray']['baseVisualDensity'],
                               'vlogVsDirectEngine': r['qa']['vlogVsDirectEngine']['tetrahedral']['max']})
                  if r['status'] == 'ready' else {'reason': r['reason']} for r in sorted(records, key=lambda r: r['number'])}})
    if failed: raise SystemExit(f'Failed: {failed}')
    publish(catalog, kept + records)
    print(json.dumps({'variants': len(records), 'wallSeconds': round(time.perf_counter() - started, 2)}), flush=True)


if __name__ == '__main__':
    main()
