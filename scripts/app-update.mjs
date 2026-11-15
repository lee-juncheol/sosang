// Update information for the sosang desktop app (Tauri updater, static JSON format).
// The release step writes app-release/latest.json; the Cloudflare build publishes it at
// /app/latest.json, and server/worker.mjs answers 204 (no update) while there is none.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

export const APP_UPDATE_SOURCE = 'app-release/latest.json';
export const APP_UPDATE_TARGET = 'app/latest.json';

const PLATFORM = /^(darwin|windows|linux)-(aarch64|x86_64|i686|armv7)(-[a-z]+)?$/;
const SEMVER = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** Throw unless `doc` is an update manifest the Tauri updater accepts, with https downloads
 *  and a signature for every platform. Returns the version. */
export function validateUpdateManifest(doc) {
  assert(doc && typeof doc === 'object' && !Array.isArray(doc), 'Update manifest must be an object');
  assert(typeof doc.version === 'string' && SEMVER.test(doc.version), `Update manifest version is not semver: ${doc.version}`);
  if (doc.notes !== undefined) assert.equal(typeof doc.notes, 'string', 'Update notes must be text');
  if (doc.pub_date !== undefined) assert(typeof doc.pub_date === 'string' && !Number.isNaN(Date.parse(doc.pub_date)), 'Update pub_date must be an RFC 3339 date');
  assert(doc.platforms && typeof doc.platforms === 'object', 'Update manifest needs platforms');
  const names = Object.keys(doc.platforms);
  assert(names.length > 0, 'Update manifest lists no platform');
  for (const name of names) {
    assert.match(name, PLATFORM, `Unknown updater platform: ${name}`);
    const entry = doc.platforms[name];
    assert(entry && typeof entry.signature === 'string' && entry.signature.trim().length > 0, `Missing signature for ${name}`);
    let url;
    try { url = new URL(entry.url); } catch { assert.fail(`Invalid download URL for ${name}`); }
    assert.equal(url.protocol, 'https:', `Download for ${name} must use https`);
  }
  return doc.version;
}

/** Copy the release's update manifest into the public build when there is one. */
export async function publishUpdateManifest(projectDir, outputDir) {
  const source = path.join(projectDir, APP_UPDATE_SOURCE);
  const text = await fs.readFile(source, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (text === null) return null;
  const version = validateUpdateManifest(JSON.parse(text));
  const target = path.join(outputDir, APP_UPDATE_TARGET);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
  return version;
}
