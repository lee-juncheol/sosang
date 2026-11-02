"""Generate actual spektrafilm LUTs, independent checks, previews and catalog.

Run from the project root: .venv/bin/python -m pipeline.generate --jobs 3
"""
from __future__ import annotations

from pipeline.common import CONFIG, ROOT, PUBLIC, UPSTREAM, PROFILES, profiles, sha256, save_json, std_to_vlog, read_cube, metrics
import argparse
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
import platform
import resource
import shutil
import subprocess
import time
import traceback
import zipfile

import numpy as np
from PIL import Image
from spektrafilm_lut_creator.bundles import BundleSpec
from spektrafilm_lut_creator.builders import BundleBuilder
from spektrafilm_lut_creator.formats import Lut
from spektrafilm_lut_creator.formats.lumix import LumixCubeFormat
from spektrafilm_lut_creator.grid import cube_grid
from spektrafilm_lut_creator.qa.evaluators import apply_tetrahedral, apply_trilinear
from spektrafilm_lut_creator.qa.reference import run_pipeline_at
from pipeline.samples import prepare, save_image
from pipeline.slide import INIT_PRINT_PROFILE, SlideBundleBuilder, run_slide_reference
from pipeline.std import bake_std, run_std_reference, STD_GENERATION, STD_INPUT_GAIN, STD_CONTRACT


def combination_choices(stocks):
    films = [s for s in stocks if s['stage'] == 'filming']
    papers = [s for s in stocks if s['stage'] == 'printing']
    for i, film in enumerate(films):
        # Preserve existing negative filenames; use the first unused number
        # in each formerly unsupported slide block for its single direct scan.
        for j, paper in enumerate([None] if film['type'] == 'positive' else papers):
            yield film, paper, i * len(papers) + j + 1


def combination_id(film, paper):
    return f"{film['id']}__{paper['id'] if paper else 'direct_scan'}"


def cache_key(film, paper):
    dependencies = {p.name: sha256(p) for p in sorted((ROOT / 'pipeline').glob('*.py'))}
    lock = ROOT / 'pipeline/requirements.lock'
    if lock.exists():
        dependencies['requirements.lock'] = sha256(lock)
    dependencies['sampleManifest'] = sha256(PUBLIC / 'samples/manifest.json')
    for sample in json.loads((PUBLIC / 'samples/manifest.json').read_text()):
        dependencies[f"sample:{sample['id']}"] = sha256(PUBLIC / sample['path'].lstrip('/'))
    payload = {"config": CONFIG, "film": film['sha256'], "paper": paper['sha256'] if paper else None,
               "processMode": 'negative_print' if paper else 'positive_direct', "code": dependencies}
    if paper is None:
        payload['runtimeInitPrintProfileSha256'] = sha256(PROFILES / f'{INIT_PRINT_PROFILE}.json')
    return hashlib.sha256(json.dumps(payload,sort_keys=True).encode()).hexdigest()


def describe(path):
    return {"path": '/' + path.relative_to(PUBLIC).as_posix(), "name": path.name,
            "bytes": path.stat().st_size, "sha256": sha256(path)}


def valid_cache(record, key):
    if record.get('status') != 'ready' or record.get('cacheKey') != key:
        return False
    for asset in [*record['files'].values(), *record['previews'].values()]:
        p = PUBLIC / asset['path'].lstrip('/')
        if not p.is_file() or sha256(p) != asset['sha256']:
            return False
    return True


def generate_one(job):
    film,paper,number,force=job
    combo_id=combination_id(film,paper)
    is_slide=film['type']=='positive'
    directory=PUBLIC / 'luts' / combo_id
    record_path=directory / 'metadata.json'
    key=cache_key(film,paper)
    if record_path.exists() and not force:
        cached=json.loads(record_path.read_text())
        if valid_cache(cached,key):
            return cached
    started=time.perf_counter()
    directory.mkdir(parents=True,exist_ok=True)
    record={"id":combo_id,"film":film['id'],"paper":paper['id'] if paper else None,"number":number,"cacheKey":key,
            "processMode":'positive_direct' if is_slide else 'negative_print'}
    try:
        if is_slide != (paper is None):
            raise ValueError('Positive films require no paper; negatives require a paper')
        spec=BundleSpec(film_profile=film['id'],print_profiles=(INIT_PRINT_PROFILE if is_slide else paper['id'],),
                        input_color_space=CONFIG['input'],output_color_space=CONFIG['output'],
                        topology=CONFIG['topology'],resolution=CONFIG['resolution'],target=CONFIG['target'],
                        stops_above_midgray=CONFIG['stops_above_midgray'],output_gamut_compress=CONFIG['output_gamut_compress'])
        builder=(SlideBundleBuilder if is_slide else BundleBuilder)(spec)
        bundle=builder.build()
        vlog=bundle.luts[0][1].table
        if not np.isfinite(vlog).all():
            raise ValueError('Engine produced non-finite values')
        # Preserve the native input interpretation, but evaluate the continuous
        # engine at STD grid nodes instead of interpolating the V-Log cube.
        std=bake_std(spec,bundle,is_slide=is_slide)
        if not np.isfinite(std).all():
            raise ValueError('Engine produced non-finite STD values')
        writer=LumixCubeFormat()
        vlog_path=directory / f'{number:04d}VLOG.cube'
        std_path=directory / f'{number:04d}STD.cube'
        writer.write(Lut(vlog,title=f'{number:04d}_VLOG'),vlog_path,photo_style_tag='VLOG')
        writer.write(Lut(std,title=f'{number:04d}_STD'),std_path,photo_style_tag='STD')
        vlog_disk=read_cube(vlog_path,'VLOG')
        std_disk=read_cube(std_path,'STD')
        roundtrip=max(float(np.max(np.abs(vlog_disk-vlog))),float(np.max(np.abs(std_disk-std))))
        if roundtrip>0.000000501:
            raise ValueError('Cube serialization changed the table')

        rng=np.random.default_rng(CONFIG['seed'])
        gray=np.repeat(np.linspace(0,1,129)[:,None],3,axis=1)
        patches=cube_grid(5)
        samples=np.concatenate([rng.random((CONFIG['qa_random_samples'],3)),gray,patches])
        direct=run_slide_reference(spec,samples) if is_slide else run_pipeline_at(spec,bundle,0,samples)
        fidelity={name:metrics(fn(vlog_disk,samples),direct) for name,fn in [('tetrahedral',apply_tetrahedral),('trilinear',apply_trilinear)]}
        # Direct engine evaluation at off-grid STD inputs measures end-to-end
        # error, including the analytic adapter. Never use a baked LUT as truth.
        std_direct=run_std_reference(spec,bundle,samples,is_slide=is_slide)
        std_fidelity={name:metrics(fn(std_disk,samples),std_direct) for name,fn in [('tetrahedral',apply_tetrahedral),('trilinear',apply_trilinear)]}
        # Retained only to compare against the legacy VLOG-cube composition.
        # This is a diagnostic difference, not the STD accuracy reference.
        composed=apply_tetrahedral(vlog_disk,std_to_vlog(samples))
        legacy_std_difference={name:metrics(fn(std_disk,samples),composed) for name,fn in [('tetrahedral',apply_tetrahedral),('trilinear',apply_trilinear)]}
        if not np.isfinite(direct).all() or not np.isfinite(std_direct).all():
            raise ValueError('Non-finite direct engine reference')
        gray_out=apply_tetrahedral(std_disk,gray)
        tone_delta=float((gray_out[-1]-gray_out[0]).mean())
        if tone_delta<=0:
            raise ValueError('Inverted or flat black-to-white tone response')
        warnings=[]
        # Explicit engineering review flags, not claims of perceptual accuracy.
        if fidelity['tetrahedral']['p99']>0.05:
            warnings.append('V-Log 전체 도메인의 상위 1% 보간 오차가 0.05를 넘습니다. 고채도·극단 노출를 검토하세요.')
        if std_fidelity['tetrahedral']['p99']>0.02:
            warnings.append('STD와 직접 엔진 사이의 상위 1% 보간 오차가 0.02를 넘습니다. 색 경계를 검토하세요.')
        previews={}
        for sample in json.loads((PUBLIC/'samples/manifest.json').read_text()):
            source=np.asarray(Image.open(PUBLIC/sample['path'].lstrip('/')).convert('RGB'))/255.
            # These are already Standard/sRGB pixels. Apply the downloaded
            # STD cube once, without an extra gamma or V-Log conversion.
            rendered=apply_tetrahedral(std_disk,source.reshape(-1,3)).reshape(source.shape)
            path=directory/f"{sample['id']}.webp"
            save_image(rendered,path)
            previews[sample['id']]=describe(path)
        qa={"fileChecks":"passed","rowsPerCube":35937,"serializationMaxError":roundtrip,
            "processMode":record['processMode'],"scanFilm":is_slide,
            "vlogVsDirectEngine":fidelity,"stdVsDirectEngine":std_fidelity,
            "stdGeneration":STD_GENERATION,"stdInputGain":STD_INPUT_GAIN,
            "stdVsContinuousComposition":legacy_std_difference,
            "stdVsContinuousCompositionPurpose":"Diagnostic difference from legacy VLOG-cube composition; not an engine accuracy metric or quality gate.",
            "grayBlackToWhiteDelta":tone_delta,"warnings":warnings,"cameraVerified":False,
            "sampling":"4096 uniform random RGB + 129 gray ramp + 125 RGB grid; fixed seed",
            "cameraInterpolation":"unknown; both tetrahedral and trilinear measured"}
        save_json(directory/'qa.json',qa)
        provenance={"engine":{"repository":"https://github.com/andreavolpato/spektrafilm","commit":CONFIG['engine_commit'],"version":CONFIG['engine_version']},
                    "profiles":{"film":film,"paper":paper},"config":CONFIG,"bundle":asdict(bundle.meta),
                    "processMode":record['processMode'],"scanFilm":is_slide,
                    "processingPath":'film exposure -> film development -> direct film scan' if is_slide else 'film exposure -> film development -> print exposure -> print development -> print scan',
                    "runtimeInitPrintProfile":({"id":INIT_PRINT_PROFILE,"sha256":sha256(PROFILES / f'{INIT_PRINT_PROFILE}.json'),
                        "note":"Required only to initialize upstream runtime; printing stages are bypassed and paper is not applied."} if is_slide else None),
                    "adapter":{"id":CONFIG['adapter'],"target":"S1M2 / S1II (camera validation pending)",
                    "source":"https://pro-av.panasonic.net/en/cinema_camera_varicam_eva/support/pdf/VARICAM_V-Log_V-Gamut.pdf",
                    "generation":STD_GENERATION,"inputGain":STD_INPUT_GAIN,
                    "contract":STD_CONTRACT,
                    "limitation":"Analytic working model; does not invert the camera's proprietary Standard rendering."},
                    "effects":{"grain":False,"halation":False,"blur":False,"autoExposure":False},
                    "gamutPolicy":"Upstream input RGC + CAM16-UCS output compression; upstream final [0,1] boundary clamp; no extra creative clipping.",
                    "preview":"Verified LUT-OFF S1M2 Standard JPEGs (resized, color unchanged) and a synthetic sRGB chart -> exported STD LUT directly (tetrahedral) -> sRGB. Not a camera-applied LUT accuracy validation.",
                    "sampleManifestSha256":sha256(PUBLIC/'samples/manifest.json'),
                    "environment":{"python":platform.python_version(),"platform":platform.platform()},
                    "license":"CC BY-SA 4.0; derived from spektrafilm by Andrea Volpato"}
        save_json(directory/'provenance.json',provenance)
        readme=f'''Film Lab / {film['name']} + {paper['name'] if paper else 'Direct film scan (no paper)'}

Processing mode: {record['processMode']}; scan_film={is_slide}

{vlog_path.name}: Panasonic V-Log / V-Gamut input -> sRGB output
{std_path.name}: Standard/sRGB analytic working model input -> sRGB output
33 x 33 x 33, full range 0..1. Both files produce sRGB, NOT Rec.709.
S1M2 / S1II physical camera validation: NOT performed.
Do not apply the VLOG file to an already normalized Rec.709/sRGB picture.
Standard mapping is approximate; clipped highlights cannot be recovered.
STD grid nodes are evaluated directly through the upstream engine using the
analytic sRGB -> V-Gamut -> V-Log input mapping. No intermediate VLOG cube
is interpolated. Native input gain remains 1.0; no exposure boost is added.
stdVsDirectEngine in qa.json is the end-to-end STD accuracy measurement.
stdVsContinuousComposition is only a diagnostic difference from the legacy
VLOG-cube composition, not the accuracy reference.
Previews apply this exported STD file directly to LUT-OFF S1M2 Standard
captures or a synthetic sRGB chart. No extra V-Log/gamma transform is used.
They are not a validation against camera-applied LUT captures.

Derived from spektrafilm by Andrea Volpato
https://github.com/andreavolpato/spektrafilm
Licensed CC BY-SA 4.0. See SPEKTRAFILM_LICENSE.txt and CHANGELOG.txt.
Engine commit: {CONFIG['engine_commit']}
File checks and measured interpolation errors: qa.json
Settings and provenance: provenance.json
'''
        (directory/'README.txt').write_text(readme)
        (directory/'CHANGELOG.txt').write_text('Generated by Film Lab from unmodified spektrafilm profiles. STD v2 evaluates analytic sRGB -> V-Gamut -> V-Log coordinates directly through the continuous engine, removing intermediate VLOG cube interpolation. Native input gain remains 1.0; VLOG generation and film/paper profiles are unchanged. Added direct-engine off-grid STD QA. Shortened camera filenames. Changes and derived LUTs remain CC BY-SA 4.0.\n')
        shutil.copyfile(UPSTREAM/'SPEKTRAFILM_LICENSE.txt',directory/'SPEKTRAFILM_LICENSE.txt')
        zip_path=directory/f'{number:04d}LUTS.zip'
        with zipfile.ZipFile(zip_path,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
            for p in [vlog_path,std_path,*[directory/n for n in ['README.txt','CHANGELOG.txt','SPEKTRAFILM_LICENSE.txt','qa.json','provenance.json']]]:
                archive.write(p,p.name)
        record.update(status='ready',files={"vlog":describe(vlog_path),"std":describe(std_path),"zip":describe(zip_path),
                                          "qa":describe(directory/'qa.json'),"provenance":describe(directory/'provenance.json')},
                      previews=previews,qa=qa,seconds=round(time.perf_counter()-started,3),
                      peakRssBytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if platform.system()=='Darwin' else 1024),
                      generatedAt=datetime.now(timezone.utc).isoformat())
    except Exception as exc:
        record.update(status='failed',reason=f'{type(exc).__name__}: {exc}')
        (directory/'error.log').write_text(traceback.format_exc())
    save_json(record_path,record)
    return record


def catalog(records, stocks):
    combos=[]
    films=[s for s in stocks if s['stage']=='filming']
    papers=[s for s in stocks if s['stage']=='printing']
    for film,paper,number in combination_choices(stocks):
        cid=combination_id(film,paper)
        base={"id":cid,"film":film['id'],"paper":paper['id'] if paper else None,"number":number,
              "processMode":'positive_direct' if paper is None else 'negative_print'}
        combos.append(records.get(cid,{**base,"status":"not-generated","reason":"이 룩의 LUT는 아직 생성되지 않았습니다."}))
    result={"schemaVersion":2,"generatedAt":datetime.now(timezone.utc).isoformat(),"engineCommit":CONFIG['engine_commit'],
            "engineVersion":CONFIG['engine_version'],"adapter":CONFIG['adapter'],"output":"sRGB","resolution":33,
            "films":films,"papers":papers,"samples":json.loads((PUBLIC/'samples/manifest.json').read_text()),
            "combinations":combos,"counts":{s:sum(c['status']==s for c in combos) for s in ['ready','failed','unsupported','not-generated']}}
    save_json(PUBLIC/'catalog.json',result)
    return result


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--only',help='film_id__paper_id or film_id__direct_scan')
    parser.add_argument('--jobs',type=int,default=3)
    parser.add_argument('--force',action='store_true')
    args=parser.parse_args()
    commit=subprocess.check_output(['git','-C',str(UPSTREAM),'rev-parse','HEAD'],text=True).strip()
    if commit!=CONFIG['engine_commit']:
        raise SystemExit('Upstream commit does not match config')
    if subprocess.check_output(['git','-C',str(UPSTREAM),'diff','--stat'],text=True).strip():
        raise SystemExit('Upstream has modifications; pin and document them before generation')
    prepare()
    stocks=profiles()
    records={}
    jobs=[]
    for f,p,number in combination_choices(stocks):
        cid=combination_id(f,p)
        path=PUBLIC/'luts'/cid/'metadata.json'
        if path.exists():
            old=json.loads(path.read_text())
            if valid_cache(old,cache_key(f,p)):
                records[cid]=old
        if not args.only or cid==args.only:
            jobs.append((f,p,number,args.force))
    if args.only and not jobs:
        raise SystemExit('Unknown or unsupported combination')
    catalog(records,stocks)
    started=time.perf_counter()
    with ProcessPoolExecutor(max_workers=max(1,args.jobs)) as pool:
        for completed,future in enumerate(as_completed([pool.submit(generate_one,j) for j in jobs]),1):
            record=future.result()
            records[record['id']]=record
            catalog(records,stocks)
            print(f"[{completed}/{len(jobs)}] {record['status']} {record['id']} ({record.get('seconds',0)}s)",flush=True)
    result=catalog(records,stocks)
    save_json(ROOT/'artifacts/build-report.json',{"counts":result['counts'],"wallSeconds":round(time.perf_counter()-started,2)})
    print(json.dumps(result['counts']),flush=True)
    if any(r['status']=='failed' for r in records.values()):
        raise SystemExit(1)


if __name__=='__main__':
    main()
