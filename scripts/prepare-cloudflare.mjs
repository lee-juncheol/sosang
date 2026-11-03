import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export const PUBLIC_LOOKS = 238;
export const REMOVED_REFERENCE_LOOKS = 4;

// Keep the personal catalog intact; the public distribution is a separate build.
export function publicCatalog(source) {
  assert.equal(source.schemaVersion, 2, 'Unsupported catalog schema');
  const catalog = structuredClone(source);
  const referenceIds = new Set((catalog.referenceStudy?.looks || []).map(look => `${look.film}__reference`));
  const removed = catalog.combinations.filter(combo => combo.processMode === 'reference_interpretation' || referenceIds.has(combo.id) || combo.id.endsWith('__reference'));
  const removedIds = new Set(removed.map(combo => combo.id));
  assert.equal(removed.length, REMOVED_REFERENCE_LOOKS, 'Expected the 4 removed reference interpretations');
  for (const combo of catalog.combinations) assert.match(combo.id, /^[a-z0-9_]+$/, 'Unsafe LUT directory name');
  catalog.combinations = catalog.combinations.filter(combo => !removedIds.has(combo.id));
  delete catalog.referenceStudy;
  catalog.counts = Object.fromEntries(Object.keys(source.counts).map(status => [status, 0]));
  for (const combo of catalog.combinations) catalog.counts[combo.status] = (catalog.counts[combo.status] || 0) + 1;
  assert.equal(catalog.combinations.length, PUBLIC_LOOKS, 'Expected 238 public combinations');
  assert.equal(catalog.counts.ready, PUBLIC_LOOKS, 'All public combinations must be ready');
  assert(catalog.combinations.every(combo => catalog.films.some(film => film.id === combo.film)), 'A public combination references a removed film');
  return { catalog, removedIds };
}

export async function prepareCloudflare(sourceDir = 'dist', outputDir = 'dist-cloudflare') {
  const source = path.resolve(sourceDir), output = path.resolve(outputDir);
  // Only replace the dedicated sibling build directory, never source/public/.
  assert.equal(path.basename(output), 'dist-cloudflare', 'Output must be named dist-cloudflare');
  assert.equal(path.dirname(source), path.dirname(output), 'Source and output must be sibling directories');
  assert.notEqual(source, output, 'Source and output must be different');
  const sourceInfo = await fs.lstat(source);
  assert(sourceInfo.isDirectory() && !sourceInfo.isSymbolicLink(), 'Source must be a real directory');
  const outputInfo = await fs.lstat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  assert(!outputInfo || outputInfo.isDirectory() && !outputInfo.isSymbolicLink(), 'Output must be a real directory');
  const sourceCatalog = JSON.parse(await fs.readFile(path.join(source, 'catalog.json'), 'utf8'));
  const { catalog, removedIds } = publicCatalog(sourceCatalog);
  const lutEntries = await fs.readdir(path.join(source, 'luts'), { withFileTypes: true });
  assert.deepEqual(lutEntries.map(entry => entry.name).sort(), sourceCatalog.combinations.map(combo => combo.id).sort(), 'Unexpected source LUT files or directories');
  assert(lutEntries.every(entry => entry.isDirectory()), 'LUT entries must be directories');
  await fs.rm(output, { recursive: true, force: true });
  await fs.cp(source, output, {
    recursive: true,
    filter: async entry => {
      const relative = path.relative(source, entry).split(path.sep).join('/');
      const info = await fs.lstat(entry);
      assert(!info.isSymbolicLink(), `Do not publish a symlink: ${relative}`);
      if (relative === 'research/reference-looks.json') return false;
      if (relative.startsWith('luts/') && removedIds.has(relative.split('/')[1])) return false;
      assert(!relative.split('/').some(part => part === 'sample-study' || part === '.cache' || part === '.git'), `Private data in input: ${relative}`);
      return true;
    },
  });
  await fs.writeFile(path.join(output, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  return { output, combinations: catalog.combinations.length, excluded: removedIds.size, counts: catalog.counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await prepareCloudflare(process.argv[2], process.argv[3]), null, 2));
}
