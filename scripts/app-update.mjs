// Update information for the sosang desktop app (Tauri updater, static JSON format).
// `release:app` (scripts/release-app.mjs) writes app-release/latest.json and the signed
// downloads under app-release/releases/; the Cloudflare build publishes both under /app/,
// and server/worker.mjs answers 204 (no update) while there is no manifest.
import crypto from 'node:crypto';
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

/** Throw unless `data` matches `signature` (a latest.json signature: base64 of the minisign
 *  .sig file Tauri writes, Ed25519 over the file's BLAKE2b-512) under `publicKey` (the
 *  updater pubkey from tauri.conf.json). The app would refuse a download that fails this. */
export function verifyUpdateSignature(data, signature, publicKey, label) {
  const lines = text => Buffer.from(text.trim(), 'base64').toString('utf8').split('\n').map(line => line.trim()).filter(Boolean);
  const key = Buffer.from(lines(publicKey).find(line => !line.startsWith('untrusted comment:')) ?? '', 'base64');
  assert(key.length === 42 && key.subarray(0, 2).toString() === 'Ed', 'The updater public key is not a minisign Ed25519 key');
  const [, sigLine, trusted, globalLine] = lines(signature);
  const sig = Buffer.from(sigLine ?? '', 'base64');
  assert(sig.length === 74 && ['ED', 'Ed'].includes(sig.subarray(0, 2).toString()) && trusted?.startsWith('trusted comment: '), `${label}: malformed signature`);
  assert(sig.subarray(2, 10).equals(key.subarray(2, 10)), `${label}: signed with a different key`);
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]);
  const pub = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  const message = sig.subarray(0, 2).toString() === 'ED' ? crypto.createHash('blake2b512').update(data).digest() : data;
  assert(crypto.verify(null, message, pub, sig.subarray(10)), `${label}: the file does not match its signature`);
  const comment = Buffer.from(trusted.slice('trusted comment: '.length));
  assert(crypto.verify(null, Buffer.concat([sig.subarray(10), comment]), pub, Buffer.from(globalLine ?? '', 'base64')), `${label}: the signature comment was altered`);
}

/** Throw when deploying `local` (app-release/latest.json, or null) would take away what `live`
 *  (the published manifest) offers: an older version, a platform of the same version, or a
 *  platform build of the same version replaced by one released earlier (another machine's
 *  stale copy). A different build of the same version passes only from a newer release. */
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
  const changed = Object.keys(live.platforms).filter(name => local.platforms[name].signature !== live.platforms[name].signature);
  const newer = Date.parse(local.pub_date) > Date.parse(live.pub_date);
  assert(changed.length === 0 || newer, `This deploy would replace the published ${changed.join(', ')} build of ${live.version} with a different one from an earlier release. ${hint}.`);
}

/** Copy the release's update manifest and its downloads into the public build when there is
 *  a release. Returns the version, or null without a release. */
export async function publishUpdateManifest(projectDir, outputDir) {
  const source = path.join(projectDir, APP_UPDATE_SOURCE);
  const text = await fs.readFile(source, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (text === null) return null;
  const doc = JSON.parse(text);
  const version = validateUpdateManifest(doc);
  const hosted = Object.entries(doc.platforms).filter(([, entry]) => new URL(entry.url).origin === APP_SERVER);
  const publicKey = hosted.length ? JSON.parse(await fs.readFile(path.join(projectDir, 'src-tauri/tauri.conf.json'), 'utf8')).plugins.updater.pubkey : null;
  for (const [name, entry] of hosted) {
    const file = releaseFile(new URL(entry.url));
    const data = await fs.readFile(path.join(projectDir, APP_RELEASE_DIR, file));
    // A stale file under the same name would be served with the new signature and refused by every app.
    verifyUpdateSignature(data, entry.signature, publicKey, `${name} ${file}`);
    const target = path.join(outputDir, 'app', file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }
  const target = path.join(outputDir, APP_UPDATE_TARGET);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
  return version;
}
