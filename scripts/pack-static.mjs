// Lossless transport compression keeps all generated looks within static hosting
// limits. Raw local artifacts and ZIP contents remain byte-for-byte intact.
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const root=path.resolve('dist');
const catalog=JSON.parse(await fs.readFile(path.join(root,'catalog.json'),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let rawTotal=0,packedTotal=0,count=0;
for(const combo of catalog.combinations){
 if(combo.status!=='ready')continue;
 for(const key of ['vlog','std']){
  const asset=combo.files[key];
  const file=path.join(root,asset.path);
  if(!file.startsWith(root+path.sep))throw new Error('Invalid asset path');
  const raw=await fs.readFile(file);
  if(raw.length!==asset.bytes||hash(raw)!==asset.sha256)throw new Error('Source asset hash mismatch');
  const packed=gzipSync(raw,{level:9});
  await fs.writeFile(file+'.gz',packed);
  await fs.unlink(file);
  rawTotal+=raw.length;packedTotal+=packed.length;count++;
  Object.assign(asset,{path:asset.path+'.gz',encoding:'gzip',transferBytes:packed.length,transferSha256:hash(packed)});
 }
 const metadata=path.join(root,'luts',combo.id,'metadata.json');
 await fs.writeFile(metadata,JSON.stringify(combo,null,2)+'\n');
}
await fs.writeFile(path.join(root,'catalog.json'),JSON.stringify(catalog,null,2)+'\n');
console.log(`Lossless LUT transport: ${count} files, ${(rawTotal/1048576).toFixed(1)} -> ${(packedTotal/1048576).toFixed(1)} MiB`);
