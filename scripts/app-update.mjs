// Update information for the sosang desktop app (Tauri updater, static JSON format).
// `release:app` (scripts/release-app.mjs) writes app-release/latest.json and the signed
// downloads under app-release/releases/; the Cloudflare build publishes both under /app/,
// and server/worker.mjs answers 204 (no update) while there is no manifest.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

export const APP_RELEASE_DIR = 'app-release';
export const APP_UPDATE_SOURCE = 'app-release/latest.json';
export const APP_UPDATE_TARGET = 'app/latest.json';
/** Origin the app downloads updates from (the sosang Worker). */
export const APP_SERVER = 'https://sosang.film-lab-jc.workers.dev';
/** Downloads served by the Worker live under this path, mirrored from app-release/releases/. */
export const APP_RELEASES_PATH = '/app/releases/';

const PLATFORM = /^(darwin|windows|linux)-(aarch64|x86_64|i686|armv7)(-[a-z]+)?$/;
const SEMVER = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const SAFE_SEGMENT = /^[0-9A-Za-z._-]+$/;

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
    if (url.origin === APP_SERVER) releaseFile(url);
  }
  return doc.version;
}

/** Path below app-release/ (and below /app/ on the server) of a download the Worker serves. */
function releaseFile(url) {
  assert(url.pathname.startsWith(APP_RELEASES_PATH) && !url.search && !url.hash, `Downloads on ${APP_SERVER} must be under ${APP_RELEASES_PATH}: ${url.href}`);
  const parts = url.pathname.slice('/app/'.length).split('/');
  assert(parts.length === 3 && parts.every(p => SAFE_SEGMENT.test(p) && p !== '.' && p !== '..'), `Unsafe download path: ${url.pathname}`);
  return parts.join('/');
}

/** Files under app/ that a manifest needs from this server (`releases/<version>/<file>`). */
export function hostedReleaseFiles(doc) {
  return Object.values(doc.platforms).map(p => new URL(p.url)).filter(u => u.origin === APP_SERVER).map(releaseFile);
}

/** Throw when deploying `local` (app-release/latest.json, or null) would take away what `live`
 *  (the published manifest) offers: an older version, or a platform of the same version. */
export function assertKeepsPublishedRelease(local, live) {
  const hint = `Copy the current ${APP_RELEASE_DIR}/ here or run release:app first`;
  assert(local, `This deploy has no app release but ${live.version} is published. ${hint}.`);
  const parts = version => version.replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number);
  const [a, b] = [parts(local.version), parts(live.version)];
  const order = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  assert(order >= 0, `This deploy would roll the app back from ${live.version} to ${local.version}. ${hint}.`);
  if (order > 0) return;
  const missing = Object.keys(live.platforms).filter(name => !local.platforms[name]);
  assert.equal(missing.length, 0, `This deploy would drop ${missing.join(', ')} from app ${live.version}. ${hint}.`);
}

/** Copy the release's update manifest and its downloads into the public build when there is
 *  a release. Returns the version, or null without a release. */
export async function publishUpdateManifest(projectDir, outputDir) {
  const source = path.join(projectDir, APP_UPDATE_SOURCE);
  const text = await fs.readFile(source, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (text === null) return null;
  const doc = JSON.parse(text);
  const version = validateUpdateManifest(doc);
  for (const file of hostedReleaseFiles(doc)) {
    const target = path.join(outputDir, 'app', file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(projectDir, APP_RELEASE_DIR, file), target);
  }
  const target = path.join(outputDir, APP_UPDATE_TARGET);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
  return version;
}
