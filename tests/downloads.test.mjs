import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { downloadRow } from '../server/worker.mjs';

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

const good = { lut: 'Portra400PA.cube', kind: 'file', source: 'web' };

function send(body, { origin = 'https://sosang.example', method = 'POST', env = { USAGE: database() } } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' };
  if (origin) headers.Origin = origin;
  const init = { method, headers };
  if (method === 'POST') init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return worker.fetch(new Request('https://sosang.example/api/download', init), env);
}

test('a download from the site is stored as one row without anything about the person', async () => {
  const env = { USAGE: database() };
  assert.equal((await send(good, { env })).status, 200);
  const insert = env.USAGE.statements.find(s => s.sql.startsWith('INSERT'));
  assert.match(insert.values[0], /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(insert.values.slice(1), ['Portra400PA.cube', 'std', 'file', 'web']);
  assert(!JSON.stringify(insert.values).includes('203.0.113.7'));
});

test('the site and the app may report, other sites may not', async () => {
  const app = await send({ ...good, source: 'app' }, { origin: 'tauri://localhost' });
  assert.equal(app.status, 200);
  assert.equal(app.headers.get('Access-Control-Allow-Origin'), 'tauri://localhost');
  for (const origin of ['https://evil.example', null]) {
    const env = { USAGE: database() };
    assert.equal((await send(good, { origin, env })).status, 403);
    assert.equal(env.USAGE.statements.length, 0);
  }
  assert.equal((await send(undefined, { method: 'GET' })).status, 405);
});

test('download reports outside the fixed shape are refused', () => {
  assert.deepEqual(downloadRow(good), { ...good, format: 'std' });
  assert.equal(downloadRow({ ...good, lut: 'Portra400PAVLOG.cube' }).format, 'vlog');
  assert.equal(downloadRow({ ...good, lut: 'Portra400PA-S5M2.zip', kind: 'made' }).format, 'zip');
  for (const change of [
    { lut: 'a.txt' }, { lut: '../x.cube' }, { lut: 'my file.cube' }, { lut: `${'x'.repeat(81)}.cube` },
    { kind: 'other' }, { source: 'phone' }, { lut: 7 },
  ]) assert.equal(downloadRow({ ...good, ...change }), null, JSON.stringify(change));
  for (const value of [null, [], 'text']) assert.equal(downloadRow(value), null);
});

test('the rate limit and a missing database stop a download report', async () => {
  const env = { USAGE: database(), USAGE_LIMIT: { async limit() { return { success: false }; } } };
  assert.equal((await send(good, { env })).status, 429);
  assert.equal(env.USAGE.statements.length, 0);
  assert.equal((await send(good, { env: {} })).status, 503);
  assert.equal((await send('{bad', {})).status, 400);
});
