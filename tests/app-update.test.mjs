import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import worker from '../server/worker.mjs';

const APP_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];
import crypto from 'node:crypto';
import { validateUpdateManifest, publishUpdateManifest, hostedReleaseFiles, assertKeepsPublishedRelease, verifyUpdateSignature } from '../scripts/app-update.mjs';

/** A throwaway minisign key in the format Tauri uses, and a signer for update files. */
function testSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const id = crypto.randomBytes(8);
  const b64 = text => Buffer.from(text).toString('base64');
  const pubkey = b64(`untrusted comment: test key\n${Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64')}\n`);
  const sign = data => {
    const sig = crypto.sign(null, crypto.createHash('blake2b512').update(data).digest(), privateKey);
    const comment = 'timestamp:1\tfile:test';
    const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
    return b64(`untrusted comment: test\n${Buffer.concat([Buffer.from('ED'), id, sig]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`);
  };
  return { pubkey, sign };
}

const manifest = {
  version: '0.2.0',
  notes: 'test',
  pub_date: '2026-11-15T00:00:00Z',
  platforms: { 'darwin-aarch64': { signature: 'dW50cnVzdGVkIGNvbW1lbnQ=', url: 'https://example.com/sosang.app.tar.gz' } },
};

test('the locale endpoint lets the desktop app read it and no other site', async () => {
  for (const origin of APP_ORIGINS) {
    const response = await worker.fetch(new Request('https://sosang.example/api/locale', { headers: { Origin: origin } }), {});
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(response.headers.get('Vary'), 'Origin');
  }
  for (const origin of ['https://evil.example', 'null', 'tauri://localhost.evil.example']) {
    const response = await worker.fetch(new Request('https://sosang.example/api/locale', { headers: { Origin: origin } }), {});
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null, origin);
  }
});

test('update information is served without caching, and 204 means there is no update yet', async () => {
  const assets = body => ({ fetch: request => {
    assert.equal(new URL(request.url).pathname, '/app/latest.json');
    assert.equal(new URL(request.url).search, '', 'query strings are not passed to the asset store');
    return body === null ? new Response('missing', { status: 404 }) : new Response(body, { headers: { ETag: 'e1' } });
  } });
  const none = await worker.fetch(new Request('https://sosang.example/app/latest.json?x=1'), { ASSETS: assets(null) });
  assert.equal(none.status, 204);
  assert.equal(await none.text(), '');

  const some = await worker.fetch(new Request('https://sosang.example/app/latest.json'), { ASSETS: assets(JSON.stringify(manifest)) });
  assert.equal(some.status, 200);
  assert.equal(some.headers.get('Cache-Control'), 'no-cache');
  assert.match(some.headers.get('Content-Type'), /^application\/json/);
  assert.equal(some.headers.get('ETag'), 'e1');
  assert.deepEqual(await some.json(), manifest);

  const post = await worker.fetch(new Request('https://sosang.example/app/latest.json', { method: 'POST' }), { ASSETS: assets(null) });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET, HEAD');
});

test('the Worker module exports only functions, as workerd requires', async () => {
  const module = await import('../server/worker.mjs');
  for (const [name, value] of Object.entries(module)) {
    assert(typeof value === 'function' || (name === 'default' && typeof value.fetch === 'function'), `export ${name} would stop the Worker from starting`);
  }
});

test('static files allow cross-origin reads without credentials', async () => {
  const headers = await fs.readFile(new URL('../public/_headers', import.meta.url), 'utf8');
  assert.match(headers, /^\/\*\n(?:  .+\n)*  Access-Control-Allow-Origin: \*$/m);
  assert.doesNotMatch(headers, /Allow-Credentials/i);
});

test('update manifests need semver, signatures and https downloads', () => {
  assert.equal(validateUpdateManifest(manifest), '0.2.0');
  const bad = [
    { ...manifest, version: 'latest' },
    { ...manifest, platforms: {} },
    { ...manifest, platforms: { 'darwin-aarch64': { ...manifest.platforms['darwin-aarch64'], signature: '' } } },
    { ...manifest, platforms: { 'darwin-aarch64': { ...manifest.platforms['darwin-aarch64'], url: 'http://example.com/a.tar.gz' } } },
    { ...manifest, platforms: { 'macos': manifest.platforms['darwin-aarch64'] } },
    { ...manifest, pub_date: 'yesterday' },
  ];
  for (const doc of bad) assert.throws(() => validateUpdateManifest(doc));
});

test('downloads on the sosang server must be release files, and are copied into the build', async () => {
  const { pubkey, sign } = testSigner();
  const hosted = { ...manifest, platforms: { 'darwin-aarch64': { signature: sign(Buffer.from('bundle')), url: 'https://sosang.film-lab-jc.workers.dev/app/releases/0.2.0/sosang.app.tar.gz' } } };
  assert.deepEqual(hostedReleaseFiles(hosted), ['releases/0.2.0/sosang.app.tar.gz']);
  for (const url of ['https://sosang.film-lab-jc.workers.dev/catalog.json', 'https://sosang.film-lab-jc.workers.dev/app/releases/../latest.json', 'https://sosang.film-lab-jc.workers.dev/app/releases/0.2.0/a/b.tar.gz', 'https://sosang.film-lab-jc.workers.dev/app/releases/0.2.0/a.tar.gz?x=1']) {
    assert.throws(() => validateUpdateManifest({ ...hosted, platforms: { 'darwin-aarch64': { signature: 'c2ln', url } } }), undefined, url);
  }
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'sosang-update-'));
  const output = path.join(project, 'dist-cloudflare');
  try {
    await fs.mkdir(path.join(project, 'app-release/releases/0.2.0'), { recursive: true });
    await fs.mkdir(path.join(project, 'src-tauri'));
    await fs.writeFile(path.join(project, 'src-tauri/tauri.conf.json'), JSON.stringify({ plugins: { updater: { pubkey } } }));
    await fs.writeFile(path.join(project, 'app-release/latest.json'), JSON.stringify(hosted));
    await assert.rejects(publishUpdateManifest(project, output), /ENOENT/, 'a missing download stops the build');
    await fs.writeFile(path.join(project, 'app-release/releases/0.2.0/sosang.app.tar.gz'), 'older build');
    await assert.rejects(publishUpdateManifest(project, output), /does not match its signature/, 'a stale file under the signed name stops the build');
    await fs.writeFile(path.join(project, 'app-release/releases/0.2.0/sosang.app.tar.gz'), 'bundle');
    await fs.writeFile(path.join(project, 'app-release/releases/0.2.0/old.tar.gz'), 'not referenced');
    assert.equal(await publishUpdateManifest(project, output), '0.2.0');
    assert.equal(await fs.readFile(path.join(output, 'app/releases/0.2.0/sosang.app.tar.gz'), 'utf8'), 'bundle');
    await assert.rejects(fs.access(path.join(output, 'app/releases/0.2.0/old.tar.gz')));
  } finally { await fs.rm(project, { recursive: true, force: true }); }
});

test('the Cloudflare build publishes the release manifest only when there is one', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'sosang-update-'));
  const output = path.join(project, 'dist-cloudflare');
  await fs.mkdir(output);
  assert.equal(await publishUpdateManifest(project, output), null);
  await assert.rejects(fs.access(path.join(output, 'app/latest.json')));
  await fs.mkdir(path.join(project, 'app-release'));
  await fs.writeFile(path.join(project, 'app-release/latest.json'), JSON.stringify(manifest));
  assert.equal(await publishUpdateManifest(project, output), '0.2.0');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'app/latest.json'), 'utf8')), manifest);
  await fs.writeFile(path.join(project, 'app-release/latest.json'), JSON.stringify({ ...manifest, version: 'x' }));
  await assert.rejects(publishUpdateManifest(project, output));
  await fs.rm(project, { recursive: true, force: true });
});

test('update files are checked against their signature and the app key', () => {
  const { pubkey, sign } = testSigner();
  const data = Buffer.from('update bundle');
  const signature = sign(data);
  assert.doesNotThrow(() => verifyUpdateSignature(data, signature, pubkey, 'ok'));
  assert.throws(() => verifyUpdateSignature(Buffer.from('update bundle!'), signature, pubkey, 'x'), /does not match/);
  assert.throws(() => verifyUpdateSignature(data, signature, testSigner().pubkey, 'x'), /different key/);
  const lines = Buffer.from(signature, 'base64').toString().split('\n');
  lines[2] = 'trusted comment: edited';
  assert.throws(() => verifyUpdateSignature(data, Buffer.from(lines.join('\n')).toString('base64'), pubkey, 'x'), /comment was altered/);
  assert.throws(() => verifyUpdateSignature(data, 'c2ln', pubkey, 'x'), /malformed/);
});

test('a deploy cannot take away the published app release', () => {
  const release = (version, ...names) => ({ version, pub_date: '2026-11-19T00:00:00Z', platforms: Object.fromEntries(names.map(name => [name, { signature: `${name}-a` }])) });
  const live = release('0.1.2', 'darwin-aarch64', 'windows-x86_64');
  assert.throws(() => assertKeepsPublishedRelease(null, live), /no app release/);
  assert.throws(() => assertKeepsPublishedRelease(release('0.1.0', 'darwin-aarch64', 'windows-x86_64'), live), /roll the app back/);
  assert.throws(() => assertKeepsPublishedRelease(release('0.1.2', 'darwin-aarch64'), live), /drop windows-x86_64/);
  assert.doesNotThrow(() => assertKeepsPublishedRelease(release('0.1.2', 'darwin-aarch64', 'windows-x86_64'), live));
  assert.doesNotThrow(() => assertKeepsPublishedRelease(release('0.1.10', 'darwin-aarch64'), live));
  // Same version, another build of one platform: only a newer release may replace it.
  const rebuilt = (pub_date) => ({ ...release('0.1.2', 'darwin-aarch64', 'windows-x86_64'), pub_date, platforms: { ...release('0.1.2', 'darwin-aarch64').platforms, 'windows-x86_64': { signature: 'windows-b' } } });
  assert.throws(() => assertKeepsPublishedRelease(live, { ...rebuilt('2026-11-20T00:00:00Z') }), /replace the published windows-x86_64 build/);
  assert.doesNotThrow(() => assertKeepsPublishedRelease(rebuilt('2026-11-20T00:00:00Z'), live));
});
