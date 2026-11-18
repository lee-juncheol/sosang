import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import worker from '../server/worker.mjs';

const APP_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];
import { validateUpdateManifest, publishUpdateManifest, hostedReleaseFiles, assertKeepsPublishedRelease } from '../scripts/app-update.mjs';

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
  const hosted = { ...manifest, platforms: { 'darwin-aarch64': { signature: 'c2ln', url: 'https://sosang.film-lab-jc.workers.dev/app/releases/0.2.0/sosang.app.tar.gz' } } };
  assert.deepEqual(hostedReleaseFiles(hosted), ['releases/0.2.0/sosang.app.tar.gz']);
  for (const url of ['https://sosang.film-lab-jc.workers.dev/catalog.json', 'https://sosang.film-lab-jc.workers.dev/app/releases/../latest.json', 'https://sosang.film-lab-jc.workers.dev/app/releases/0.2.0/a/b.tar.gz', 'https://sosang.film-lab-jc.workers.dev/app/releases/0.2.0/a.tar.gz?x=1']) {
    assert.throws(() => validateUpdateManifest({ ...hosted, platforms: { 'darwin-aarch64': { signature: 'c2ln', url } } }), undefined, url);
  }
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'sosang-update-'));
  const output = path.join(project, 'dist-cloudflare');
  try {
    await fs.mkdir(path.join(project, 'app-release/releases/0.2.0'), { recursive: true });
    await fs.writeFile(path.join(project, 'app-release/latest.json'), JSON.stringify(hosted));
    await assert.rejects(publishUpdateManifest(project, output), /ENOENT/, 'a missing download stops the build');
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

test('a deploy cannot take away the published app release', () => {
  const release = (version, ...names) => ({ version, platforms: Object.fromEntries(names.map(name => [name, {}])) });
  const live = release('0.1.2', 'darwin-aarch64', 'windows-x86_64');
  assert.throws(() => assertKeepsPublishedRelease(null, live), /no app release/);
  assert.throws(() => assertKeepsPublishedRelease(release('0.1.0', 'darwin-aarch64', 'windows-x86_64'), live), /roll the app back/);
  assert.throws(() => assertKeepsPublishedRelease(release('0.1.2', 'darwin-aarch64'), live), /drop windows-x86_64/);
  assert.doesNotThrow(() => assertKeepsPublishedRelease(release('0.1.2', 'darwin-aarch64', 'windows-x86_64'), live));
  assert.doesNotThrow(() => assertKeepsPublishedRelease(release('0.1.10', 'darwin-aarch64'), live));
});
