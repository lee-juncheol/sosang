// Checks the split catalog (/catalog/index.json + /catalog/films/*.json, src/catalogSplit.ts).
// verifySplit: legacy builds, where it must equal the split of the published catalog.json.
// verifySlim: builds without catalog.json, where only the baked looks' LUTS / camera notes ZIPs remain.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { splitCatalog, mergeFilmDetail, bakedLookIds, CATALOG_INDEX_PATH, CATALOG_LAYOUT, filmDetailPath } from '../src/catalogSplit.ts';
import { LUT_LICENSES } from './prepare-cloudflare.mjs';
import { readPackHeader, PRINT_TIMING_METHOD } from './verify-print-timing.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function readSplit(rootDir) {
  const root = path.resolve(rootDir);
  const index = JSON.parse(await fs.readFile(path.join(root, CATALOG_INDEX_PATH.slice(1)), 'utf8'));
  assert.equal(index.layout, CATALOG_LAYOUT, 'Catalog index layout');
  const films = {};
  const directory = path.dirname(path.join(root, filmDetailPath('x').slice(1)));
  for (const name of (await fs.readdir(directory)).sort()) {
    assert.match(name, /^[a-z0-9_]+\.json$/, `Unexpected catalog file: ${name}`);
    const detail = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
    assert.equal(`${detail.film}.json`, name, `Film detail name: ${name}`);
    films[detail.film] = detail;
  }
  return { index, films };
}

/** Every look and pack merged into the index: the complete catalog the browser can see. */
export function mergeAll(index, films) {
  return Object.values(films).reduce((catalog, detail) => mergeFilmDetail(catalog, detail), index);
}

async function checkLicenses(root, index) {
  assert.equal(index.lutLicenses?.length, LUT_LICENSES.length, 'LUT licences missing from the catalog index');
  for (const [i, asset] of index.lutLicenses.entries()) {
    assert.equal(asset.path, LUT_LICENSES[i]);
    const bytes = await fs.readFile(path.join(root, asset.path.slice(1)));
    assert.equal(bytes.length, asset.bytes); assert.equal(hash(bytes), asset.sha256, `Changed licence: ${asset.path}`);
  }
}

// Each browser-made look must find its recipe and its pair's pack.
function checkLooks(merged) {
  const baked = bakedLookIds(merged), packs = merged.printTiming?.packs ?? {};
  let synth = 0;
  for (const combo of merged.combinations) {
    assert.equal(!!combo.synth, !baked.has(combo.id), `Baked/browser-made flag: ${combo.id}`);
    if (combo.synth) {
      synth++;
      assert(packs[combo.castBaseId || combo.labAimBaseId || combo.id], `Browser-made look without a pack: ${combo.id}`);
      assert(!combo.files && !combo.stdByCamera, `Browser-made look has files: ${combo.id}`);
      if (combo.labAimBaseId) assert(combo.labAim, `Lab-aim recipe missing: ${combo.id}`);
      if (combo.castBaseId) assert(combo.filmCast, `Film-cast recipe missing: ${combo.id}`);
    } else if (combo.status === 'ready') {
      assert(combo.files && combo.stdByCamera?.[merged.cameraAdapters.defaultCamera], `Baked look without files: ${combo.id}`);
    }
  }
  return { synth, baked: baked.size };
}

export async function verifySplit(rootDir, catalog) {
  const root = path.resolve(rootDir);
  const { index, films } = await readSplit(root);
  const { lutLicenses, sourceCode, ...rest } = index;
  assert.deepEqual(sourceCode, catalog.sourceCode, 'Source code link differs between the catalogs');
  const { sourceCode: _source, ...withoutSource } = catalog;
  const expected = splitCatalog(withoutSource);
  assert(JSON.stringify(rest) === JSON.stringify(expected.index), 'Catalog index differs from the split of catalog.json');
  assert.deepEqual(Object.keys(films).sort(), Object.keys(expected.films).sort(), 'Film detail files differ');
  for (const [film, detail] of Object.entries(films)) assert(JSON.stringify(detail) === JSON.stringify(expected.films[film]), `Film detail differs: ${film}`);
  await checkLicenses(root, index);
  return { films: Object.keys(films).length, indexBytes: JSON.stringify(index).length, ...checkLooks(mergeAll(index, films)) };
}

export async function verifySlim(rootDir, files) {
  const root = path.resolve(rootDir);
  const { index, films } = await readSplit(root);
  await checkLicenses(root, index);
  const merged = mergeAll(index, films);
  const looks = checkLooks(merged);
  const expected = new Set();
  const checked = new Map();
  async function asset(item) {
    const relative = item.path.slice(1);
    if (!checked.has(relative)) { const bytes = await fs.readFile(path.join(root, relative)); checked.set(relative, { bytes: bytes.length, sha256: hash(bytes) }); }
    const digest = checked.get(relative);
    assert.equal(digest.bytes, item.encoding ? item.transferBytes : item.bytes, `Asset size: ${relative}`);
    assert.equal(digest.sha256, item.encoding ? item.transferSha256 : item.sha256, `Asset hash: ${relative}`);
    if (relative.startsWith('luts/')) expected.add(relative);
  }
  for (const combo of merged.combinations) {
    if (combo.synth || combo.status !== 'ready') continue;
    assert(!combo.files.qa && !combo.files.provenance, `Loose QA links remain: ${combo.id}`);
    for (const item of Object.values(combo.files)) await asset(item);
    for (const entry of Object.values(combo.stdByCamera)) { await asset(entry.std); await asset(entry.zip); }
  }
  const published = [...files.keys()].filter(name => name.startsWith('luts/'));
  assert.deepEqual(published.sort(), [...expected].sort(), 'Published LUT files differ from the baked looks');
  for (const [id, { asset: pack }] of Object.entries(merged.printTiming.packs)) {
    const bytes = await fs.readFile(path.join(root, pack.path.slice(1)));
    assert.equal(hash(bytes), pack.sha256, `Changed print timing pack: ${id}`);
    const header = readPackHeader(bytes);
    assert.equal(header.method, PRINT_TIMING_METHOD); assert.equal(header.id, id);
  }
  assert(!files.has('catalog.json'), 'Old catalog remains');
  return { films: Object.keys(films).length, lutFiles: published.length, packs: Object.keys(merged.printTiming.packs).length, ...looks };
}
