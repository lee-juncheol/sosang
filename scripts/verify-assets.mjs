import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {extractZipEntry} from '../src/assets.ts';
const root = path.resolve(process.argv[2] || 'public');
const catalog = JSON.parse(await fs.readFile(path.join(root,'catalog.json'),'utf8'));
assert.equal(catalog.schemaVersion,2);
const seenIds = new Set(), seenNames = new Set();
let cubes = 0, assets = 0;
const hash = data => createHash('sha256').update(data).digest('hex');
const sampleIds = catalog.samples.map(sample=>sample.id).sort();
for(const sample of catalog.samples){
  assert.equal(sample.previewLut,'std');
  const bytes=await fs.readFile(path.join(root,sample.path));
  if(sample.preparedSha256)assert.equal(hash(bytes),sample.preparedSha256);
}
for (const combo of catalog.combinations) {
  assert(!seenIds.has(combo.id)); seenIds.add(combo.id);
  const film=catalog.films.find(f=>f.id===combo.film); assert(film);
  if(film.type==='positive'){
    assert.equal(combo.paper,null); assert.equal(combo.processMode,'positive_direct');
  }else if(combo.processMode==='negative_digital'){
    assert.equal(combo.paper,null); assert(combo.id.endsWith('__digital_scan'));
    if(combo.status==='ready') assert(combo.qa.referenceModel?.startsWith('film-lab-'));
  }else if(combo.processMode==='reference_interpretation'){
    assert.equal(combo.paper,null); assert.equal(combo.id,`${film.id}__reference`);
    assert.equal(combo.outputOrigin,'generated_digital_interpretation');
    assert.equal(combo.referencesAreRealFilm,true); assert.equal(combo.outputIsRealFilm,false);
    assert(catalog.referenceStudy?.looks.some(look=>look.film===film.id&&look.number===combo.number));
    if(combo.status==='ready'){
      assert.equal(combo.qa.referenceModel,'film-lab-reference-interpretation-v1');
      assert.equal(combo.qa.upstreamFilmPaperPipelineApplied,false);
    }
  }else{
    assert(catalog.papers.some(p=>p.id===combo.paper)); assert.equal(combo.processMode,'negative_print');
  }
  if (combo.status !== 'ready') { assert(!combo.files); assert(combo.reason); continue; }
  assert.deepEqual(Object.keys(combo.previews).sort(),sampleIds);
  for (const asset of [...Object.values(combo.files),...Object.values(combo.previews)]) {
    const local = path.join(root,asset.path);
    assert(local.startsWith(root+path.sep));
    const bytes = await fs.readFile(local);
    if(asset.encoding==='zip-entry'){
      assert.equal(asset.path,combo.files.zip.path);
      assert.equal(bytes.length,asset.transferBytes);assert.equal(hash(bytes),asset.transferSha256);
      const raw=Buffer.from(await extractZipEntry(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),asset.name,asset.bytes));
      assert.equal(raw.length,asset.bytes);assert.equal(hash(raw),asset.sha256);
    }else if(asset.encoding==='gzip'){
      assert.equal(bytes.length,asset.transferBytes);assert.equal(hash(bytes),asset.transferSha256);
      const raw=gunzipSync(bytes);assert.equal(raw.length,asset.bytes);assert.equal(hash(raw),asset.sha256);
    }else{assert.equal(bytes.length,asset.bytes);assert.equal(hash(bytes),asset.sha256);} assets++;
  }
  assert.notEqual(combo.files.vlog.sha256,combo.files.std.sha256);
  for (const [key,tag] of [['vlog','VLOG'],['std','STD']]) {
    const file=combo.files[key]; assert(!seenNames.has(file.name)); seenNames.add(file.name);
    assert(file.name.split('.')[0].length<=8);
    const bytes=await fs.readFile(path.join(root,file.path));
    const unpacked=file.encoding==='zip-entry'?Buffer.from(await extractZipEntry(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),file.name,file.bytes)):file.encoding==='gzip'?gunzipSync(bytes):bytes;
    const lines=unpacked.toString('utf8').trim().split('\n');
    assert(lines[0].startsWith('TITLE "')); assert.equal(lines[1],`#LUMIXPHOTOSTYLE ${tag}`);
    assert.equal(lines[2],'LUT_3D_SIZE 33');
    assert.equal(lines[3],'DOMAIN_MIN 0.000000 0.000000 0.000000');
    assert.equal(lines[4],'DOMAIN_MAX 1.000000 1.000000 1.000000');
    const rows=lines.slice(6); assert.equal(rows.length,35937);
    for(const row of rows){const v=row.split(' ').map(Number);assert(v.length===3&&v.every(n=>Number.isFinite(n)&&n>=0&&n<=1));}
    cubes++;
  }
}
for(const film of catalog.films){
  const choices=catalog.combinations.filter(c=>c.film===film.id);
  const hasReference=catalog.referenceStudy?.looks.some(look=>look.film===film.id)?1:0;
  assert.equal(choices.length,film.type==='positive'?1:catalog.papers.length+1+hasReference);
  assert.equal(new Set(choices.map(c=>`${c.processMode}:${c.paper}`)).size,choices.length);
}
for(const [status,count] of Object.entries(catalog.counts)) assert.equal(count,catalog.combinations.filter(c=>c.status===status).length);
console.log(JSON.stringify({passed:true,combinations:seenIds.size,cubes,assets,counts:catalog.counts},null,2));
