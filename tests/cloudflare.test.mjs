import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publicCatalog, prepareCloudflare } from '../scripts/prepare-cloudflare.mjs';
import { assetRelativePath, verifyCloudflare } from '../scripts/verify-cloudflare.mjs';

const fixture = () => ({
  schemaVersion: 2,
  films: [{ id: 'film', type: 'negative' }, { id: 'gfx_test', type: 'official' }],
  combinations: [
    ...Array.from({ length: 152 }, (_, index) => ({ id: `film_${index}`, film: 'film', processMode: 'negative_print', status: 'ready' })),
    ...Array.from({ length: 90 }, (_, index) => ({ id: `gfx_test_${index}`, film: 'gfx_test', processMode: index ? 'official_print' : 'official_direct', status: 'ready' })),
  ],
  counts: { ready: 242, failed: 0, unsupported: 0, 'not-generated': 0 },
  samples: [],
  fujiStudy: { private: true },
});

test('public catalog removes both official modes and their films without mutating the personal catalog', () => {
  const source = fixture(), before = structuredClone(source);
  const { catalog, removedIds } = publicCatalog(source);
  assert.deepEqual(source, before);
  assert.equal(catalog.combinations.length, 152);
  assert.equal(removedIds.size, 90);
  assert.deepEqual(catalog.films, [source.films[0]]);
  assert(!('fujiStudy' in catalog));
  assert.deepEqual(catalog.combinations, before.combinations.slice(0, 152));
  assert.equal(catalog.counts.ready, 152);
});

test('an official film is removed even when its process metadata is mislabeled', () => {
  const source = fixture();
  source.combinations[152].processMode = 'negative_print';
  assert.equal(publicCatalog(source).removedIds.size, 90);
});

test('unexpected catalog scope or unsafe LUT directory aborts the public build', () => {
  const source = fixture();
  source.combinations.pop();
  assert.throws(() => publicCatalog(source), /90 private/);
  const unsafe = fixture();
  unsafe.combinations[0].id = '../outside';
  assert.throws(() => publicCatalog(unsafe), /Unsafe LUT directory/);
});

test('asset lookup permits cache query strings but rejects traversal and external paths', () => {
  assert.equal(assetRelativePath('/samples/photo.webp?v=123'), 'samples/photo.webp');
  for (const url of ['/../private', '/%2e%2e/private', '//host/file', 'https://host/file', '/a\\private']) assert.throws(() => assetRelativePath(url));
});

test('public preparation removes actual private files and refuses to overwrite the personal build', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'film-lab-public-'));
  const source = path.join(temporary, 'dist'), output = path.join(temporary, 'dist-cloudflare');
  const catalog = fixture();
  try {
    await fs.mkdir(path.join(source, 'research'), { recursive: true });
    await fs.writeFile(path.join(source, 'research/fujifilm-official.json'), '{"private":true}');
    await fs.writeFile(path.join(source, 'catalog.json'), JSON.stringify(catalog));
    for (const combo of catalog.combinations) {
      await fs.mkdir(path.join(source, 'luts', combo.id), { recursive: true });
      await fs.writeFile(path.join(source, 'luts', combo.id, 'payload.txt'), combo.id);
    }
    await assert.rejects(prepareCloudflare(source, source), /Output must be named/);
    await prepareCloudflare(source, output);
    assert.equal((await fs.readdir(path.join(source, 'luts'))).length, 242);
    assert.equal((await fs.readdir(path.join(output, 'luts'))).length, 152);
    await assert.rejects(fs.access(path.join(output, 'research/fujifilm-official.json')));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(source, 'catalog.json'), 'utf8')), catalog);
    // A private directory copied back after filtering must fail verification.
    await fs.mkdir(path.join(output, 'luts', 'gfx_test_0'));
    await assert.rejects(verifyCloudflare(output, source), /directory inventory/);
    await fs.rmdir(path.join(output, 'luts', 'gfx_test_0'));
    await fs.writeFile(path.join(output, 'accidental-export.json'), JSON.stringify({ originalPath: '/Users/private/photo.jpg' }));
    await assert.rejects(verifyCloudflare(output, source), /Private local path/);
    await fs.writeFile(path.join(output, 'accidental-export.json'), JSON.stringify({ path: '/missing-image.webp' }));
    await assert.rejects(verifyCloudflare(output, source), /Missing JSON asset/);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
