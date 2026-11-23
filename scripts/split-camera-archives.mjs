// Public build only: drop the per-camera ZIPs (each is the default LUTS ZIP with a
// different STD cube and three camera notes). The browser composes the STD from the
// look's VLOG cube and the camera adapter (src/cameraStd.ts) and rebuilds the ZIP;
// the camera notes of every non-default camera stay in one small NNNNCAMS.zip per look.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CAMERA_FILES, readZipEntries, writeZip } from '../src/cameraStd.ts';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const local = (root, url) => path.join(root, url.replace(/^\//, ''));
const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

/** Relative paths of the camera ZIPs the public build leaves out. */
export function cameraArchivePaths(catalog) {
  const paths = new Set();
  if (!catalog.cameraAdapters) return paths;
  const defaultCamera = catalog.cameraAdapters.defaultCamera;
  for (const combo of catalog.combinations) for (const [camera, entry] of Object.entries(combo.stdByCamera || {})) {
    if (camera !== defaultCamera) paths.add(entry.zip.path.replace(/^\//, ''));
  }
  return paths;
}

export const notesName = combo => `${String(combo.number).padStart(4, '0')}CAMS.zip`;

/** Rewrites catalog entries in place and writes the notes ZIPs into output. */
export async function splitCameraArchives(catalog, sourceDir, outputDir) {
  let notes = 0, removed = 0, removedBytes = 0;
  if (!catalog.cameraAdapters) return { notes, removed, removedBytes };
  const { defaultCamera, models } = catalog.cameraAdapters;
  for (const combo of catalog.combinations) {
    if (!combo.stdByCamera) continue;
    const base = combo.files.zip;
    assert(!base.encoding, `Default ZIP must be a plain file: ${combo.id}`);
    const baseBytes = await fs.readFile(local(sourceDir, base.path));
    assert.equal(hash(baseBytes), base.sha256, `Changed default ZIP: ${combo.id}`);
    const baseEntries = readZipEntries(arrayBuffer(baseBytes));
    const noteEntries = [];
    for (const model of models) {
      const camera = model.id;
      if (camera === defaultCamera) continue;
      const entry = combo.stdByCamera[camera];
      assert.equal(entry.std.encoding, 'zip-entry', `Already split: ${combo.id}`);
      const bytes = await fs.readFile(local(sourceDir, entry.zip.path));
      assert.equal(hash(bytes), entry.zip.sha256, `Changed camera ZIP: ${combo.id}/${camera}`);
      const entries = readZipEntries(arrayBuffer(bytes));
      // Everything except the STD cube and the camera notes must be the default ZIP's bytes.
      assert.deepEqual(entries.map(e => e.name), baseEntries.map(e => e.name), `Camera ZIP layout differs: ${combo.id}/${camera}`);
      entries.forEach((item, i) => {
        if (item.name === entry.std.name) return;
        if (CAMERA_FILES.includes(item.name)) { noteEntries.push({ ...item, name: `${camera}/${item.name}` }); return; }
        const shared = baseEntries[i];
        assert(item.crc === shared.crc && item.size === shared.size && item.method === shared.method && Buffer.from(item.data).equals(Buffer.from(shared.data)), `Shared file differs: ${combo.id}/${camera}/${item.name}`);
      });
      removed++; removedBytes += bytes.length;
    }
    const notesBytes = Buffer.from(writeZip(noteEntries));
    const notesPath = `/luts/${combo.id}/${notesName(combo)}`;
    await fs.writeFile(local(outputDir, notesPath), notesBytes);
    notes++;
    const transfer = { transferBytes: notesBytes.length, transferSha256: hash(notesBytes) };
    // The sources (VLOG, adapter, default ZIP) are filled in by hydrateCameraAssets when the catalog is read.
    for (const model of models) {
      const camera = model.id;
      if (camera === defaultCamera) continue;
      const entry = combo.stdByCamera[camera];
      const std = { path: base.path, name: entry.std.name, bytes: entry.std.bytes, sha256: entry.std.sha256, encoding: 'camera-std',
        transferBytes: base.bytes, transferSha256: base.sha256 };
      entry.std = std;
      // bytes/sha256 describe the pipeline's ZIP; the browser's copy has the same files.
      entry.zip = { path: notesPath, name: entry.zip.name, bytes: entry.zip.bytes, sha256: entry.zip.sha256, encoding: 'camera-package',
        ...transfer };
    }
    await fs.writeFile(path.join(outputDir, 'luts', combo.id, 'metadata.json'), JSON.stringify(combo, null, 2) + '\n');
  }
  return { notes, removed, removedBytes };
}

/**
 * For verify-cloudflare: put the pipeline's camera entries back after checking that each
 * browser-made entry names the same cube (name, size, hash) and ZIP. verify-camera-std
 * rebuilds every one of them and checks the hashes.
 */
export function restoreCameraArchives(published, expected) {
  const result = structuredClone(published);
  if (!expected.cameraAdapters) return result;
  const defaultCamera = expected.cameraAdapters.defaultCamera;
  const byId = new Map(expected.combinations.map(combo => [combo.id, combo]));
  for (const combo of result.combinations) {
    const source = byId.get(combo.id);
    if (!source?.stdByCamera || !combo.stdByCamera) continue;
    for (const [camera, entry] of Object.entries(combo.stdByCamera)) {
      if (camera === defaultCamera) continue;
      const original = source.stdByCamera[camera];
      assert(original, `Unexpected camera entry: ${combo.id}/${camera}`);
      assert.equal(entry.std.encoding, 'camera-std', `Camera STD must be browser-made: ${combo.id}/${camera}`);
      assert.equal(entry.zip.encoding, 'camera-package', `Camera ZIP must be browser-made: ${combo.id}/${camera}`);
      for (const key of ['name', 'bytes', 'sha256']) {
        assert.equal(entry.std[key], original.std[key], `Camera STD ${key}: ${combo.id}/${camera}`);
        assert.equal(entry.zip[key], original.zip[key], `Camera ZIP ${key}: ${combo.id}/${camera}`);
      }
      combo.stdByCamera[camera] = { ...entry, std: original.std, zip: original.zip };
    }
  }
  return result;
}
