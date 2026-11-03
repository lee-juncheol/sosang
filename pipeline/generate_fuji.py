"""Append official Fuji simulations + optional virtual digital printing.

Run .venv/bin/python -m pipeline.generate_fuji --download --jobs 2
Existing 152 looks are verified and preserved. Source package stays in .cache.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import shutil
import time
import zipfile
from functools import lru_cache

import numpy as np
from PIL import Image
from pipeline.common import ROOT, PUBLIC, UPSTREAM, CONFIG, save_json, sha256, read_cube, metrics, std_to_vlog
from pipeline.generate import describe, valid_assets
from pipeline.samples import save_image
from pipeline.fuji import METHOD_ID, load_study, official_archive, official_table, apply_official, input_adapter_metadata
from pipeline.fuji_paper import PaperBridge
from spektrafilm_lut_creator.formats import Lut
from spektrafilm_lut_creator.formats.lumix import LumixCubeFormat
from spektrafilm_lut_creator.grid import cube_grid
from spektrafilm_lut_creator.qa.evaluators import apply_tetrahedral

TRUTH = {'officialSource': True, 'officialUnmodifiedProduct': False,
         'physicalFilmCalibrated': False, 'cameraVerified': False,
         'outputIsRealFilm': False, 'outputOrigin': 'official_lut_with_film_lab_adapter'}

@lru_cache(maxsize=8)
def paper_bridge(paper_id):
    return PaperBridge(paper_id)

@lru_cache(maxsize=6)
def source_pixels(path):
    return np.asarray(Image.open(PUBLIC / path.lstrip('/')).convert('RGB')) / 255.


def generate_look(study, look, paper, number, samples, force=False):
    started = time.perf_counter()
    film_id = look['film']
    paper_id = paper['id'] if paper else None
    mode = 'official_print' if paper else 'official_direct'
    combo_id = f'{film_id}__{paper_id or "official_direct"}'
    directory = PUBLIC / 'luts' / combo_id
    metadata_path = directory / 'metadata.json'
    key = hashlib.sha256(json.dumps({'study': study, 'look': look, 'paper': paper,
          'config': CONFIG,
          'code': {n: sha256(ROOT / 'pipeline' / n) for n in ['fuji.py','fuji_paper.py','generate_fuji.py','common.py','research.py','samples.py']},
          'samples': {s['id']: sha256(PUBLIC / s['path'].lstrip('/')) for s in samples}}, sort_keys=True).encode()).hexdigest()
    if metadata_path.exists() and not force:
        previous = json.loads(metadata_path.read_text())
        if previous.get('cacheKey') == key and valid_assets(previous): return previous
    directory.mkdir(parents=True, exist_ok=True)
    bridge = paper_bridge(paper_id) if paper_id else None
    def transform(values, tag): return apply_official(values, film_id, tag.lower(), bridge)
    grid = cube_grid(33)
    writer = LumixCubeFormat()
    tables, paths = {}, {}
    serialization_error = 0.
    for tag in ['STD','VLOG']:
        raw = transform(grid, tag).reshape(33,33,33,3)
        if not np.isfinite(raw).all() or raw.min() < 0 or raw.max() > 1: raise ValueError('Invalid output')
        path = directory / f'{number:04d}{tag}.cube'
        writer.write(Lut(raw, title=f'{number:04d}_{tag}'), path, photo_style_tag=tag)
        tables[tag] = read_cube(path, tag); paths[tag] = path
        serialization_error = max(serialization_error, float(np.max(np.abs(raw - tables[tag]))))
    if serialization_error > .000000501: raise ValueError('Serialization precision failed')
    gray = np.repeat(np.linspace(0,1,129)[:,None],3,axis=1)
    points = np.concatenate([np.random.default_rng(CONFIG['seed']).random((4096,3)),gray,cube_grid(5)])
    fidelity = {tag: {'tetrahedral':metrics(apply_tetrahedral(tables[tag],points),transform(points,tag))} for tag in tables}
    envelope = std_to_vlog(points)
    envelope_fidelity = metrics(apply_tetrahedral(tables['VLOG'],envelope),transform(envelope,'VLOG'))
    photo_fidelity = {}
    for sample in samples:
        if sample['inputKind'] != 'camera-std': continue
        pixels = source_pixels(sample['path']).reshape(-1,3)
        indices = np.random.default_rng(20261103).choice(len(pixels),min(1024,len(pixels)),replace=False)
        picked = pixels[indices]
        photo_fidelity[sample['id']] = metrics(apply_tetrahedral(tables['STD'],picked),transform(picked,'STD'))
    warnings = []
    if fidelity['STD']['tetrahedral']['p99'] > .02: warnings.append('STD 전체 도메인 상위 1% 보간 오차가 0.02를 넘습니다.')
    if fidelity['VLOG']['tetrahedral']['p99'] > .05: warnings.append('V-Log 전체 도메인 상위 1% 보간 오차가 0.05를 넘습니다.')
    gray_codes = np.array([0, 8, 16, 32, 64, 128, 192, 240, 255])
    gray_inputs = np.repeat((gray_codes/255.)[:,None],3,axis=1)
    gray_diagnostic = {'inputCodes':gray_codes.tolist(), 'scale':'encoded sRGB 0–255; RGB triples, not physical luminance',
        'officialBeforePaper':(apply_official(gray_inputs,film_id,'std')*255).tolist(),
        'finalOutput':(transform(gray_inputs,'STD')*255).tolist(),
        'purpose':'Regression diagnostic for double-applied shadow tone, not camera or real-print calibration'}
    qa = {'fileChecks':'passed','cameraVerified':False,'warnings':warnings,'processMode':mode,
          'referenceModel':METHOD_ID,'rowsPerCube':35937,'serializationMaxError':serialization_error,
          'stdVsDirectEngine':fidelity['STD'],'vlogVsDirectEngine':fidelity['VLOG'],
          'vlogWithinSrgbEnvelope':envelope_fidelity,'photoPixelFidelity':photo_fidelity,
          'sampling':'4096 uniform random + 129 gray + 125 grid, fixed seed; 1024 pixels per user photo',
          'metricReference':'Sequential source 65-grid official LUT + analytic adapters + exact paper develop/spectral scan; not camera accuracy',
          'officialLutSha256':look['sourceSha256'],'grayResponse':gray_diagnostic,**TRUTH}
    save_json(directory/'qa.json',qa)
    provenance = {'methodId':METHOD_ID,'processMode':mode,'film':film_id,'paper':paper_id,
        'source':{key:study[key] for key in ['model','packageVersion','sourceLutVersion','sourceUrl','downloadUrl','sourceSha256','sourceInput','sourceOutput','rights']},
        'sourceLut':look,'inputAdapter':{
            'std':'sRGB decode -> shared PROVIA neutral-response inverse using a common RGB gain -> virtual scene RGB -> BT.2020/F-Gamut -> official F-Log2 encoding, code clamp 0..1. Same mapping for all ten simulations and photos; NOT a measured camera inverse.',
            'stdCalibration':input_adapter_metadata(),
            'vlog':'V-Log decode -> V-Gamut to F-Gamut linear matrix -> official F-Log2 encoding, code clamp 0..1. This bounds negative/out-of-F-Gamut coordinates in code space: code0 corresponds to negative linear reflection, not linear0. No extra display shoulder. Not a measured sensor match.',
            'output':'Official BT709/gamma2.2 interpretation -> linear -> optional virtual paper -> sRGB encoding'},
        'paperBridge':bridge.metadata() if bridge else None,
        'upstream':{'repository':'https://github.com/andreavolpato/spektrafilm','commit':CONFIG['engine_commit'],'author':'Andrea Volpato','filmStagesApplied':False,'paperDevelopScanApplied':bool(bridge)},
        'officialSourceResolution':65,'exportResolution':33,'effects':{'grain':False,'halation':False,'autoExposure':False},
        'preview':'User Standard digital photo -> exported STD LUT once; not captured on GFX or physical film',**TRUTH}
    save_json(directory/'provenance.json',provenance)
    previews = {}
    for sample in samples:
        pixels = source_pixels(sample['path'])
        rendered = apply_tetrahedral(tables['STD'],pixels.reshape(-1,3)).reshape(pixels.shape)
        path = directory/f"{sample['id']}.webp"; save_image(rendered,path)
        previews[sample['id']] = describe(path)
    readme = f'''Film Lab / FUJIFILM GFX ETERNA 55 / {look['name']}
Paper: {paper['name'] if paper else 'None - official LUT with input/display adaptation only'}

Official source: {study['sourceUrl']}
Package v1.10; selected 65-grid F-Log2 LUT v1.00.
Source LUT: {look['sourceFile']}
SHA256: {look['sourceSha256']}

{number:04d}STD.cube: rendered Standard/sRGB -> shared PROVIA neutral-response
inverse (JPG shadow protection) -> virtual scene RGB -> F-Log2/F-Gamut.
{number:04d}VLOG.cube: Panasonic V-Log/V-Gamut input -> F-Log2/F-Gamut (experimental).
Both: official LUT -> BT709/gamma2.2 interpretation -> optional virtual printer
and spektrafilm paper development/scanning -> sRGB. 33 cubed full range 0..1.
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
'''
    (directory/'README.txt').write_text(readme)
    (directory/'CHANGELOG.txt').write_text('v2: Fix repeated shadow compression on rendered JPGs with one shared PROVIA neutral inverse; calibrate paper exposure across the neutral ramp instead of applying a second S-curve. Official source LUTs and direct V-Log transform unchanged. Existing152 preserved.\n')
    (directory/'FUJIFILM_NOTICE.txt').write_text(study['rights']+'\n'+study['sourceUrl']+'\n')
    shutil.copyfile(UPSTREAM/'SPEKTRAFILM_LICENSE.txt',directory/'SPEKTRAFILM_LICENSE.txt')
    zip_path=directory/f'{number:04d}LUTS.zip'
    with zipfile.ZipFile(zip_path,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for p in [*paths.values(), *[directory/n for n in ['qa.json','provenance.json','README.txt','CHANGELOG.txt','SPEKTRAFILM_LICENSE.txt','FUJIFILM_NOTICE.txt']]]: z.write(p,p.name)
    record={'id':combo_id,'film':film_id,'paper':paper_id,'number':number,'processMode':mode,'status':'ready','cacheKey':key,
            'files':{'std':describe(paths['STD']),'vlog':describe(paths['VLOG']),'zip':describe(zip_path),'qa':describe(directory/'qa.json'),'provenance':describe(directory/'provenance.json')},
            'previews':previews,'qa':qa,**TRUTH,'seconds':round(time.perf_counter()-started,3),'generatedAt':datetime.now(timezone.utc).isoformat()}
    save_json(metadata_path,record)
    return record


def generate_film(args):
    study,look,papers,samples,force=args
    result=[]
    for index,paper in enumerate([None,*papers]):
        record=generate_look(study,look,paper,look['numberStart']+index,samples,force)
        result.append(record)
        print(f"ready {record['id']} ({record['seconds']}s)",flush=True)
    return result


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--download',action='store_true');parser.add_argument('--force',action='store_true');parser.add_argument('--jobs',type=int,default=2);parser.add_argument('--only')
    args=parser.parse_args();study=load_study();official_archive(download=args.download)
    path=PUBLIC/'catalog.json';catalog=json.loads(path.read_text())
    preserved=[c for c in catalog['combinations'] if not c['processMode'].startswith('official_')]
    if len(preserved)!=152 or not all(valid_assets(c) for c in preserved): raise SystemExit('Expected152 intact existing looks')
    old_films=[f for f in catalog['films'] if f['type']!='official']
    existing={c['id']:c for c in catalog['combinations'] if c['processMode'].startswith('official_')}
    jobs=[(study,l,catalog['papers'],catalog['samples'],args.force) for l in study['looks'] if not args.only or l['film']==args.only]
    if args.jobs==1: results=map(generate_film,jobs)
    else:
        executor=ProcessPoolExecutor(max_workers=args.jobs);results=executor.map(generate_film,jobs)
    for batch in results:
        for record in batch: existing[record['id']]=record
    if args.jobs!=1: executor.shutdown()
    catalog['films']=old_films+[{'id':l['film'],'name':'Fujifilm '+l['name'],'type':'official','stage':'official_lut','brand':'Fujifilm','use':'digital_simulation','recommendedPrint':None,'sha256':l['sourceSha256']} for l in study['looks']]
    catalog['combinations']=preserved+sorted(existing.values(),key=lambda c:c['number'])
    catalog['counts']={s:sum(c['status']==s for c in catalog['combinations']) for s in ['ready','failed','unsupported','not-generated']}
    catalog['fujiStudy']=study;catalog['generatedAt']=datetime.now(timezone.utc).isoformat()
    save_json(PUBLIC/'research/fujifilm-official.json',study);save_json(path,catalog)
    print(json.dumps(catalog['counts']),flush=True)

if __name__=='__main__':main()
