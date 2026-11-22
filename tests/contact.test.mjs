import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { contactMessage } from '../server/worker.mjs';

const URL_ = 'https://sosang.example/api/contact';

function store() {
  const items = new Map();
  return { items, async put(key, value, options) { items.set(key, { value: JSON.parse(value), options }); } };
}

function send(body, { origin = 'https://sosang.example', method = 'POST', type = 'application/json', env = { CONTACT: store() }, ctx } = {}) {
  const headers = { 'CF-Connecting-IP': '203.0.113.9' };
  if (origin) headers.Origin = origin;
  if (type) headers['Content-Type'] = type;
  const init = { method, headers };
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return worker.fetch(new Request(URL_, init), env, ctx);
}

const good = { message: '이름이 깨져 보입니다.', email: 'me@example.com', context: { source: 'app', version: '0.1.5', os: 'macOS', camera: 'DC-S1M2', firmware: '1.5', locale: 'ko' } };

test('a message from the site is stored for 180 days with its context and nothing about the sender', async () => {
  const env = { CONTACT: store() };
  const response = await send(good, { env });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const [[key, { value, options }]] = [...env.CONTACT.items];
  assert.match(key, /^msg:\d{4}-\d\d-\d\dT[\d:.]+Z-[0-9a-f]{8}$/);
  assert.equal(options.expirationTtl, 180 * 86400);
  assert.deepEqual(Object.keys(value).sort(), ['context', 'email', 'message', 'received']);
  assert.equal(value.message, good.message);
  assert.deepEqual(value.context, good.context);
  assert(!JSON.stringify(value).includes('203.0.113.9'));
});

test('the desktop app may send and gets CORS headers; other sites may not', async () => {
  for (const origin of ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']) {
    const preflight = await send(undefined, { origin, method: 'OPTIONS', type: null });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
    const response = await send(good, { origin });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  }
  for (const origin of ['https://evil.example', null, 'null']) {
    const env = { CONTACT: store() };
    const response = await send(good, { origin, env });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(env.CONTACT.items.size, 0);
  }
  assert.equal((await send(undefined, { origin: 'https://evil.example', method: 'OPTIONS', type: null })).status, 405);
});

test('only JSON POSTs are accepted', async () => {
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
    const response = await send(good, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'POST');
  }
  assert.equal((await send('message=hi', { type: 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await send('{not json')).status, 400);
  assert.equal((await send('x'.repeat(17 * 1024))).status, 413);
});

test('bad fields are refused and nothing is stored', async () => {
  const cases = [
    {}, [], null, 'text',
    { message: '짧음' },
    { message: 'x'.repeat(4001) },
    { message: 42 },
    { ...good, email: 'not-an-email' },
    { ...good, email: 'a@b.c'.padStart(201, 'a') },
    { ...good, context: { version: 'x'.repeat(81) } },
    { ...good, context: { camera: 7 } },
  ];
  for (const body of cases) {
    const env = { CONTACT: store() };
    assert.equal((await send(body, { env })).status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(env.CONTACT.items.size, 0);
  }
});

test('unknown context fields and control characters are dropped; the email is optional', () => {
  const fields = contactMessage({ message: '  줄1\r\n줄2\u0000  ', context: { serial: 'X123', os: 'Windows\n11', camera: '' }, extra: 1 });
  assert.deepEqual(fields, { message: '줄1\n줄2', context: { os: 'Windows11' } });
});

test('the hidden field makes a bot think it worked without storing anything', async () => {
  const env = { CONTACT: store() };
  const response = await send({ ...good, website: 'spam.example' }, { env });
  assert.equal(response.status, 200);
  assert.equal(env.CONTACT.items.size, 0);
});

test('the rate limit is keyed by address and refuses before anything is stored', async () => {
  const keys = [];
  const env = { CONTACT: store(), CONTACT_LIMIT: { async limit({ key }) { keys.push(key); return { success: false }; } } };
  const response = await send(good, { env });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'rate_limited' });
  assert.deepEqual(keys, ['203.0.113.9']);
  assert.equal(env.CONTACT.items.size, 0);
});

test('without the store the form reports it is unavailable', async () => {
  assert.equal((await send(good, { env: {} })).status, 503);
});

test('with a webhook the message is also posted there without pinging anyone', async () => {
  const realFetch = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); };
  try {
    const waits = [];
    const env = { CONTACT: store(), CONTACT_WEBHOOK: 'https://discord.example/hook' };
    const response = await send(good, { env, ctx: { waitUntil: promise => waits.push(promise) } });
    assert.equal(response.status, 200);
    await Promise.all(waits);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, 'https://discord.example/hook');
    assert.deepEqual(posts[0].body.allowed_mentions, { parse: [] });
    assert.match(posts[0].body.content, /DC-S1M2/);
    assert.match(posts[0].body.content, /이름이 깨져 보입니다/);
    // A failing webhook does not fail the message, which is already stored.
    globalThis.fetch = async () => { throw new Error('down'); };
    assert.equal((await send(good, { env })).status, 200);
    assert.equal(env.CONTACT.items.size, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
