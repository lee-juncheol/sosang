import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { usageRow } from '../server/worker.mjs';

function database() {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      const statement = { sql, values: [], bind(...values) { statement.values = values; return statement; }, async run() { statements.push(statement); return {}; } };
      return statement;
    },
  };
}

const good = { event: 'register', model: 'DC-S1M2', firmware: '1.5', support: 'supported', result: 'ok', ms: 24810, version: '0.1.9', os: 'macOS' };

function send(body, { origin = 'tauri://localhost', method = 'POST', env = { USAGE: database() } } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' };
  if (origin) headers.Origin = origin;
  const init = { method, headers };
  if (method === 'POST') init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return worker.fetch(new Request('https://sosang.example/api/usage', init), env);
}

test('a report from the app is stored as one row without anything about the sender', async () => {
  const env = { USAGE: database() };
  const response = await send(good, { env });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'tauri://localhost');
  const insert = env.USAGE.statements.find(s => s.sql.startsWith('INSERT'));
  assert.match(insert.values[0], /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(insert.values.slice(1), ['register', 'DC-S1M2', '1.5', 'supported', 'ok', 24810, '0.1.9', 'macOS']);
  assert(!JSON.stringify(insert.values).includes('203.0.113.7'));
});

test('only the desktop app may report', async () => {
  for (const origin of ['https://sosang.example', 'https://evil.example', null]) {
    const env = { USAGE: database() };
    assert.equal((await send(good, { origin, env })).status, 403);
    assert.equal(env.USAGE.statements.length, 0);
  }
  assert.equal((await send(undefined, { method: 'OPTIONS' })).status, 204);
  assert.equal((await send(undefined, { method: 'GET' })).status, 405);
});

test('reports outside the fixed shape are refused', () => {
  assert.deepEqual(usageRow(good), good);
  assert.deepEqual(usageRow({ ...good, event: 'card_register', model: 'DC-L10', firmware: '' }), { ...good, event: 'card_register', model: 'DC-L10', firmware: '' });
  assert.deepEqual(usageRow({ event: 'status', result: 'no_camera', ms: 900, version: '0.1.9' }), { event: 'status', model: '', firmware: '', support: '', result: 'no_camera', ms: 900, version: '0.1.9', os: '' });
  for (const change of [
    { event: 'photo' }, { result: 'OK!' }, { ms: -1 }, { ms: 1.5 }, { ms: 4_000_000 }, { version: 'dev' },
    { model: 'x'.repeat(41) }, { model: 'serial\n123' }, { firmware: 7 }, { support: 'maybe' }, { os: '<script>' },
  ]) assert.equal(usageRow({ ...good, ...change }), null, JSON.stringify(change));
  for (const value of [null, [], 'text']) assert.equal(usageRow(value), null);
});

test('the rate limit and a missing database stop a report before it is stored', async () => {
  const env = { USAGE: database(), USAGE_LIMIT: { async limit() { return { success: false }; } } };
  assert.equal((await send(good, { env })).status, 429);
  assert.equal(env.USAGE.statements.length, 0);
  assert.equal((await send(good, { env: {} })).status, 503);
  assert.equal((await send('{bad', {})).status, 400);
});
