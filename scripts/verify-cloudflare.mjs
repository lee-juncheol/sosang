import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { publicCatalog, PUBLIC_LOOKS } from './prepare-cloudflare.mjs';

export const MAX_FILES = 20_000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const privateData = /(?:\/Users\/|\/home\/|file:\/\/|[A-Z]:[\\/]+Users[\\/]|(?:^|[\/\\])sample-study(?:[\/\\]|$))/i;

export function assetRelativePath(url) {
  assert(typeof url === 'string' && url.startsWith('/') && !url.startsWith('//'), `Invalid local asset path: ${url}`);
  const pathname = decodeURIComponent(url.split(/[?#]/, 1)[0]);
  assert(!pathname.split('/').includes('..') && !pathname.includes('\\'), `Unsafe asset path: ${url}`);
  return pathname.slice(1);
}

export async function verifyCloudflare(rootDir = 'dist-cloudflare', sourceDir = 'dist') {
  const root = path.resolve(rootDir), source = path.resolve(sourceDir);
  const sourceCatalog = JSON.parse(await fs.readFile(path.join(source, 'catalog.json'), 'utf8'));
  const { catalog: expected, removedIds } = publicCatalog(sourceCatalog);
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'catalog.json'), 'utf8'));
  const { sourceCode, ...publicSubset } = catalog;
  assert.deepEqual(publicSubset, expected, 'Public catalog differs from the permitted subset of the personal build');
  assert.equal(catalog.combinations.length, PUBLIC_LOOKS);
  assert(!('referenceStudy' in catalog));
  assert(catalog.fujiStudy, 'The requested FUJIFILM catalog must remain available');
  assert.equal(catalog.combinations.filter(combo => combo.processMode === 'official_direct' || combo.processMode === 'official_print').length, 90);
  assert(catalog.combinations.every(combo => combo.processMode !== 'reference_interpretation' && !combo.id.endsWith('__reference')));
  assert(catalog.samples.every(sample => ['camera-std', 'synthetic-srgb'].includes(sample.inputKind) && sample.source === null), 'Only user photos and the synthetic chart belong in the public build');

  const files = new Map();
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name), relative = path.relative(root, filename).split(path.sep).join('/');
      assert(!entry.isSymbolicLink(), `Symlink in public build: ${relative}`);
      assert(!relative.split('/').some(part => ['sample-study', '.cache', '.git'].includes(part)), `Private directory in public build: ${relative}`);
      if (entry.isDirectory()) await walk(filename);
      else {
        assert(entry.isFile(), `Non-file in public build: ${relative}`);
        const size = (await fs.stat(filename)).size;
        assert(size <= MAX_FILE_BYTES, `Cloudflare file limit exceeded: ${relative}`);
        files.set(relative, size);
      }
    }
  }
  await walk(root);
  assert(files.size <= MAX_FILES, 'Cloudflare file count limit exceeded');
  assert(!files.has('research/reference-looks.json'), 'Removed reference research data is still deployed');
  assert(files.has('research/fujifilm-official.json'), 'FUJIFILM source metadata is missing');
  const lutDirectories = await fs.readdir(path.join(root, 'luts'));
  assert.deepEqual(lutDirectories.sort(), catalog.combinations.map(combo => combo.id).sort(), 'Public LUT directory inventory differs from the catalog');
  for (const name of files.keys()) assert(!name.startsWith('luts/') || !removedIds.has(name.split('/')[1]), `Removed reference LUT remains: ${name}`);

  let references = 0;
  for (const [relative] of files) {
    if (!/\.(json|txt|html|js|css|svg)$/.test(relative)) continue;
    const content = await fs.readFile(path.join(root, relative), 'utf8');
    assert(!privateData.test(content), `Private local path in public data: ${relative}`);
    if (!relative.endsWith('.json')) continue;
    const document = JSON.parse(content);
    function checkPaths(value) {
      if (Array.isArray(value)) value.forEach(checkPaths);
      else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          // Relative paths in provenance describe engine inputs, not web assets.
          if (key === 'path' && typeof child === 'string' && child.startsWith('/')) {
            assert(files.has(assetRelativePath(child)), `Missing JSON asset ${child} referenced by ${relative}`);
            references++;
          }
          checkPaths(child);
        }
      }
    }
    checkPaths(document);
  }
  let luts = 0, assets = 0;
  const checked = new Map();
  async function verifyAsset(asset) {
    const relative = assetRelativePath(asset.path);
    let digest = checked.get(relative);
    if (!digest) {
      const bytes = await fs.readFile(path.join(root, relative));
      digest = { bytes: bytes.length, sha256: hash(bytes) };
      checked.set(relative, digest);
    }
    assert.equal(digest.bytes, asset.encoding ? asset.transferBytes : asset.bytes, `Asset size: ${relative}`);
    assert.equal(digest.sha256, asset.encoding ? asset.transferSha256 : asset.sha256, `Asset hash: ${relative}`);
    assets++;
  }
  for (const combo of catalog.combinations) {
    assert.equal(combo.status, 'ready');
    for (const key of ['std', 'vlog']) {
      assert.equal(combo.files[key].encoding, 'zip-entry');
      assert.equal(combo.files[key].path, combo.files.zip.path);
      luts++;
    }
    for (const asset of [...Object.values(combo.files), ...Object.values(combo.previews)]) await verifyAsset(asset);
  }
  if (sourceCode) await verifyAsset(sourceCode);
  assert.equal(luts, 476);
  for (const sample of catalog.samples) if (sample.preparedSha256) {
    const bytes = await fs.readFile(path.join(root, assetRelativePath(sample.path)));
    assert.equal(hash(bytes), sample.preparedSha256, `Changed sample: ${sample.id}`);
  }
  const largest = [...files].sort((a, b) => b[1] - a[1])[0];
  return { passed: true, combinations: PUBLIC_LOOKS, luts, assets, jsonAssetReferences: references, files: files.size, bytes: [...files.values()].reduce((sum, size) => sum + size, 0), largestFile: { path: largest[0], bytes: largest[1] } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await verifyCloudflare(process.argv[2], process.argv[3]), null, 2));
}
