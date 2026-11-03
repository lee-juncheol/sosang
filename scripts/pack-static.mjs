// Store each LUT once in its existing ZIP. Individual downloads and the upload
// renderer extract verified entries; raw source files and ZIP bytes stay intact.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root=path.resolve('dist');
const catalog=JSON.parse(await fs.readFile(path.join(root,'catalog.json'),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let removedTotal=0,count=0;
for(const combo of catalog.combinations){
 if(combo.status!=='ready')continue;
 const zip=combo.files.zip;
 const zipBytes=await fs.readFile(path.join(root,zip.path));
 if(zipBytes.length!==zip.bytes||hash(zipBytes)!==zip.sha256)throw new Error('ZIP asset hash mismatch');
 for(const key of ['vlog','std']){
  const asset=combo.files[key];
  const file=path.join(root,asset.path);
  if(!file.startsWith(root+path.sep))throw new Error('Invalid asset path');
  const raw=await fs.readFile(file);
  if(raw.length!==asset.bytes||hash(raw)!==asset.sha256)throw new Error('Source asset hash mismatch');
  await fs.unlink(file);
  removedTotal+=raw.length;count++;
  Object.assign(asset,{path:zip.path,encoding:'zip-entry',transferBytes:zip.bytes,transferSha256:zip.sha256});
 }
 // The official family uses the same verified STD worker for built-in photos
 // and uploads. Keep its source previews in public for reproducible QA, but
 // avoid shipping 540 redundant images in the hosting archive.
 if(combo.processMode==='official_direct'||combo.processMode==='official_print'){
  for(const asset of Object.values(combo.previews)){
   const file=path.resolve(root,'.'+asset.path);
   if(!file.startsWith(path.join(root,'luts',combo.id)+path.sep))throw new Error('Invalid preview path');
   const bytes=await fs.readFile(file);
   if(bytes.length!==asset.bytes||hash(bytes)!==asset.sha256)throw new Error('Preview source hash mismatch');
   await fs.unlink(file);
  }
  combo.previews={};
  combo.previewMode='runtime-std';
 }
 const metadata=path.join(root,'luts',combo.id,'metadata.json');
 await fs.writeFile(metadata,JSON.stringify(combo,null,2)+'\n');
}
await fs.writeFile(path.join(root,'catalog.json'),JSON.stringify(catalog,null,2)+'\n');
console.log(`Lossless ZIP transport: ${count} LUTs reuse verified bundles; removed ${(removedTotal/1048576).toFixed(1)} MiB of duplicate raw cubes`);
