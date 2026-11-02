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

EXCLUSION = "슬라이드/포지티브 필름입니다. 현재 네거티브 → 인화지 경로에서는 톤이 반전되므로 직접 스캔 경로를 구현하기 전까지 제공하지 않습니다."


def cache_key(film, paper):
    dependencies = {p.name: sha256(p) for p in sorted((ROOT / 'pipeline').glob('*.py'))}
    lock = ROOT / 'pipeline/requirements.lock'
    if lock.exists():
        dependencies['requirements.lock'] = sha256(lock)
    dependencies['sampleManifest'] = sha256(PUBLIC / 'samples/manifest.json')
    for sample in json.loads((PUBLIC / 'samples/manifest.json').read_text()):
        dependencies[f"sample:{sample['id']}"] = sha256(PUBLIC / sample['path'].lstrip('/'))
    payload = {"config": CONFIG, "film": film['sha256'], "paper": paper['sha256'], "code": dependencies}
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
    combo_id=f"{film['id']}__{paper['id']}"
    directory=PUBLIC / 'luts' / combo_id
    record_path=directory / 'metadata.json'
    key=cache_key(film,paper)
    if record_path.exists() and not force:
        cached=json.loads(record_path.read_text())
        if valid_cache(cached,key):
            return cached
    started=time.perf_counter()
    directory.mkdir(parents=True,exist_ok=True)
    record={"id":combo_id,"film":film['id'],"paper":paper['id'],"number":number,"cacheKey":key}
    try:
        spec=BundleSpec(film_profile=film['id'],print_profiles=(paper['id'],),
                        input_color_space=CONFIG['input'],output_color_space=CONFIG['output'],
                        topology=CONFIG['topology'],resolution=CONFIG['resolution'],target=CONFIG['target'],
                        stops_above_midgray=CONFIG['stops_above_midgray'],output_gamut_compress=CONFIG['output_gamut_compress'])
        builder=BundleBuilder(spec)
        bundle=builder.build()
        vlog=bundle.luts[0][1].table
        if not np.isfinite(vlog).all():
            raise ValueError('Engine produced non-finite values')
        # Record bounded-output policy from upstream; no additional hidden clipping.
        coordinates=std_to_vlog(cube_grid(33))
        if coordinates.min()<0 or coordinates.max()>1:
            raise ValueError('Analytic adapter outside source LUT domain')
        std=apply_tetrahedral(vlog,coordinates).reshape(33,33,33,3)
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
        direct=run_pipeline_at(spec,bundle,0,samples)
        fidelity={name:metrics(fn(vlog_disk,samples),direct) for name,fn in [('tetrahedral',apply_tetrahedral),('trilinear',apply_trilinear)]}
        # An independent continuous composition is evaluated off-grid, against
        # the final written 33-point STD file. No identity/circular comparison.
        composed=apply_tetrahedral(vlog_disk,std_to_vlog(samples))
        std_errors={name:metrics(fn(std_disk,samples),composed) for name,fn in [('tetrahedral',apply_tetrahedral),('trilinear',apply_trilinear)]}
        if not np.isfinite(direct).all():
            raise ValueError('Non-finite direct engine reference')
        gray_out=apply_tetrahedral(vlog_disk,std_to_vlog(gray))
        tone_delta=float((gray_out[-1]-gray_out[0]).mean())
        if tone_delta<=0:
            raise ValueError('Inverted or flat black-to-white tone response')
        warnings=[]
        # Explicit engineering review flags, not claims of perceptual accuracy.
        if fidelity['tetrahedral']['p99']>0.05:
            warnings.append('V-Log 전체 도메인의 상위 1% 보간 오차가 0.05를 넘습니다. 고채도·극단 노출를 검토하세요.')
        if std_errors['tetrahedral']['p99']>0.02:
            warnings.append('STD 합성의 상위 1% 보간 오차가 0.02를 넘습니다. 색 경계를 검토하세요.')
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
            "vlogVsDirectEngine":fidelity,"stdVsContinuousComposition":std_errors,
            "grayBlackToWhiteDelta":tone_delta,"warnings":warnings,"cameraVerified":False,
            "sampling":"4096 uniform random RGB + 129 gray ramp + 125 RGB grid; fixed seed",
            "cameraInterpolation":"unknown; both tetrahedral and trilinear measured"}
        save_json(directory/'qa.json',qa)
        provenance={"engine":{"repository":"https://github.com/andreavolpato/spektrafilm","commit":CONFIG['engine_commit'],"version":CONFIG['engine_version']},
                    "profiles":{"film":film,"paper":paper},"config":CONFIG,"bundle":asdict(bundle.meta),
                    "adapter":{"id":CONFIG['adapter'],"target":"S1M2 / S1II (camera validation pending)",
                    "source":"https://pro-av.panasonic.net/en/cinema_camera_varicam_eva/support/pdf/VARICAM_V-Log_V-Gamut.pdf",
                    "contract":"L_STD(x) = tetrahedral(L_VLOG, VLogEncode(sRGBDecode(x) @ sRGB_to_VGamut.T))",
                    "limitation":"Analytic working model; does not invert the camera's proprietary Standard rendering."},
                    "effects":{"grain":False,"halation":False,"blur":False,"autoExposure":False},
                    "gamutPolicy":"Upstream input RGC + CAM16-UCS output compression; upstream final [0,1] boundary clamp; no extra creative clipping.",
                    "preview":"Verified LUT-OFF S1M2 Standard JPEGs (resized, color unchanged) and a synthetic sRGB chart -> exported STD LUT directly (tetrahedral) -> sRGB. Not a camera-applied LUT accuracy validation.",
                    "sampleManifestSha256":sha256(PUBLIC/'samples/manifest.json'),
                    "environment":{"python":platform.python_version(),"platform":platform.platform()},
                    "license":"CC BY-SA 4.0; derived from spektrafilm by Andrea Volpato"}
        save_json(directory/'provenance.json',provenance)
        readme=f'''Film Lab / {film['name']} + {paper['name']}

{vlog_path.name}: Panasonic V-Log / V-Gamut input -> sRGB output
{std_path.name}: Standard/sRGB analytic working model input -> sRGB output
33 x 33 x 33, full range 0..1. Both files produce sRGB, NOT Rec.709.
S1M2 / S1II physical camera validation: NOT performed.
Do not apply the VLOG file to an already normalized Rec.709/sRGB picture.
Standard mapping is approximate; clipped highlights cannot be recovered.
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
        (directory/'CHANGELOG.txt').write_text('Generated by Film Lab from unmodified spektrafilm profiles. Composed an analytic sRGB -> V-Gamut -> V-Log adapter to produce a new STD input LUT. Shortened camera filenames. Changes and derived LUTs remain CC BY-SA 4.0.\n')
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
    for i,film in enumerate(films):
        for j,paper in enumerate(papers):
            cid=f"{film['id']}__{paper['id']}"
            base={"id":cid,"film":film['id'],"paper":paper['id'],"number":i*len(papers)+j+1}
            if film['type']!='negative':
                base.update(status='unsupported',reason=EXCLUSION)
            else:
                base=records.get(cid,{**base,"status":"not-generated","reason":"이 조합의 LUT는 아직 생성되지 않았습니다."})
            combos.append(base)
    result={"schemaVersion":1,"generatedAt":datetime.now(timezone.utc).isoformat(),"engineCommit":CONFIG['engine_commit'],
            "engineVersion":CONFIG['engine_version'],"adapter":CONFIG['adapter'],"output":"sRGB","resolution":33,
            "films":films,"papers":papers,"samples":json.loads((PUBLIC/'samples/manifest.json').read_text()),
            "combinations":combos,"counts":{s:sum(c['status']==s for c in combos) for s in ['ready','failed','unsupported','not-generated']}}
    save_json(PUBLIC/'catalog.json',result)
    return result


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--only',help='film_id__paper_id')
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
    films=[s for s in stocks if s['stage']=='filming']
    papers=[s for s in stocks if s['stage']=='printing']
    jobs=[]
    for i,f in enumerate(films):
        for j,p in enumerate(papers):
            if f['type']!='negative':
                continue
            cid=f"{f['id']}__{p['id']}"
            path=PUBLIC/'luts'/cid/'metadata.json'
            if path.exists():
                old=json.loads(path.read_text())
                if valid_cache(old,cache_key(f,p)):
                    records[cid]=old
            if not args.only or cid==args.only:
                jobs.append((f,p,i*len(papers)+j+1,args.force))
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
