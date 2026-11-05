import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPhotoContract, inspectWebp, verifyGallery } from '../scripts/verify-gallery.mjs';

const root = path.resolve(new URL('../public', import.meta.url).pathname);
async function current() {
  return {
    gallery: JSON.parse(await fs.readFile(path.join(root, 'gallery/manifest.json'), 'utf8')),
    catalog: JSON.parse(await fs.readFile(path.join(root, 'catalog.json'), 'utf8')),
  };
}

test('published gallery derivatives and replacement Standard samples retain their exact provenance', async () => {
  const result = await verifyGallery(root);
  assert.deepEqual(result, { photos: 108, standardSamples: 13, films: 5, verifiedImages: 243 });
});

test('gallery keeps the captured film and user-confirmed recommended paper, including paperless Velvia', async () => {
  const { gallery, catalog } = await current();
  assertPhotoContract(gallery, catalog);
  const velvia = gallery.items.find(item => item.filmId === 'fujifilm_velvia_100');
  assert(velvia && velvia.paperId === null && velvia.combinationId === 'fujifilm_velvia_100__direct_scan');
  for (const mutate of [
    item => { item.filmId = 'kodak_portra_400'; },
    item => { item.paperId = 'kodak_portra_endura'; },
    item => { item.combinationId = 'fujifilm_c200__digital_scan'; },
    item => { item.exif.LUT1Name = 'Unknown.cube'; },
    item => { item.exif.LUT1Opacity = 50; },
    item => { item.exif.LUT2Opacity = 100; },
    item => { item.previewLut = 'std'; },
    item => { item.exif.GPSLatitude = 37; },
    item => { item.path = '/gallery/../original.jpg'; },
  ]) {
    const changed = structuredClone(gallery);
    mutate(changed.items.find(item => item.filmId === 'fujifilm_c200'));
    assert.throws(() => assertPhotoContract(changed, catalog));
  }
});

test('a LUT-on photograph cannot enter the Standard preview inputs', async () => {
  const { gallery, catalog } = await current();
  for (const mutate of [
    sample => { sample.cameraMetadata.LUT1Opacity = 100; },
    sample => { sample.cameraMetadata.LUT2Opacity = 100; },
    sample => { sample.cameraMetadata.PhotoStyle = 'V-Log'; },
    sample => { sample.cameraId = 'S5II'; },
    sample => { sample.sourceFilename = gallery.items[0].sourceFilename; },
    sample => { sample.inputKind = 'review-jpeg'; },
  ]) {
    const changed = structuredClone(catalog);
    mutate(changed.samples.find(sample => sample.inputKind === 'camera-std'));
    assert.throws(() => assertPhotoContract(gallery, changed));
  }
});

test('derivative inspection rejects EXIF/XMP metadata and corrupted containers', async () => {
  const { gallery } = await current(), item = gallery.items[0];
  const bytes = await fs.readFile(path.join(root, item.path));
  assert.deepEqual(inspectWebp(bytes), { width: item.width, height: item.height });
  for (const type of ['EXIF', 'XMP ']) {
    const chunk = Buffer.alloc(10); chunk.write(type); chunk.writeUInt32LE(2, 4); chunk.write('xx', 8);
    const withMetadata = Buffer.concat([bytes, chunk]);
    withMetadata.writeUInt32LE(withMetadata.length - 8, 4);
    assert.throws(() => inspectWebp(withMetadata), /private EXIF\/XMP/);
  }
  assert.throws(() => inspectWebp(bytes.subarray(0, bytes.length - 1)), /Truncated/);
});
