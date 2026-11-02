import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
const root = path.resolve(process.argv[2] || 'public');
const catalog = JSON.parse(await fs.readFile(path.join(root,'catalog.json'),'utf8'));
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
  assert(catalog.films.some(f=>f.id===combo.film)); assert(catalog.papers.some(p=>p.id===combo.paper));
  if (combo.status !== 'ready') { assert(!combo.files); assert(combo.reason); continue; }
  assert.deepEqual(Object.keys(combo.previews).sort(),sampleIds);
  for (const asset of [...Object.values(combo.files),...Object.values(combo.previews)]) {
    const local = path.join(root,asset.path);
    assert(local.startsWith(root+path.sep));
    const bytes = await fs.readFile(local);
    if(asset.encoding==='gzip'){
      assert.equal(bytes.length,asset.transferBytes);assert.equal(hash(bytes),asset.transferSha256);
      const raw=gunzipSync(bytes);assert.equal(raw.length,asset.bytes);assert.equal(hash(raw),asset.sha256);
    }else{assert.equal(bytes.length,asset.bytes);assert.equal(hash(bytes),asset.sha256);} assets++;
  }
  assert.notEqual(combo.files.vlog.sha256,combo.files.std.sha256);
  for (const [key,tag] of [['vlog','VLOG'],['std','STD']]) {
    const file=combo.files[key]; assert(!seenNames.has(file.name)); seenNames.add(file.name);
    assert(file.name.split('.')[0].length<=8);
    const bytes=await fs.readFile(path.join(root,file.path));
    const lines=(file.encoding==='gzip'?gunzipSync(bytes):bytes).toString('utf8').trim().split('\n');
    assert(lines[0].startsWith('TITLE "')); assert.equal(lines[1],`#LUMIXPHOTOSTYLE ${tag}`);
    assert.equal(lines[2],'LUT_3D_SIZE 33');
    assert.equal(lines[3],'DOMAIN_MIN 0.000000 0.000000 0.000000');
    assert.equal(lines[4],'DOMAIN_MAX 1.000000 1.000000 1.000000');
    const rows=lines.slice(6); assert.equal(rows.length,35937);
    for(const row of rows){const v=row.split(' ').map(Number);assert(v.length===3&&v.every(n=>Number.isFinite(n)&&n>=0&&n<=1));}
    cubes++;
  }
}
assert.equal(catalog.combinations.length,catalog.films.length*catalog.papers.length);
for(const [status,count] of Object.entries(catalog.counts)) assert.equal(count,catalog.combinations.filter(c=>c.status===status).length);
console.log(JSON.stringify({passed:true,combinations:seenIds.size,cubes,assets,counts:catalog.counts},null,2));
