#!/usr/bin/env node
// Summarize the anonymous camera usage the desktop app reports (D1 database `sosang-usage`).
//   node scripts/usage-report.mjs            per body and firmware: rows per kind of call and result
//   node scripts/usage-report.mjs --days 7   only the last 7 days
//   node scripts/usage-report.mjs --recent   the latest 30 rows
// Needs `npm run cloudflare:login` once.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const daysAt = args.indexOf('--days');
const days = daysAt === -1 ? null : Number(args[daysAt + 1]);
if (days !== null && !(Number.isInteger(days) && days > 0)) { console.error('Usage: --days <whole number>'); process.exit(2); }
const since = days ? `WHERE received >= datetime('now', '-${days} days')` : '';
const sql = args.includes('--recent')
  ? 'SELECT received, event, model, firmware, support, result, ms, version, os FROM usage ORDER BY id DESC LIMIT 30'
  : `SELECT model, firmware, support, event, result, COUNT(*) AS rows, MAX(received) AS last FROM usage ${since} GROUP BY model, firmware, support, event, result ORDER BY model, firmware, event, result`;

const run = spawnSync(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'sosang-usage', '--remote', '--json', '--command', sql, '--config', 'wrangler.jsonc'], { cwd: root, encoding: 'utf8' });
if (run.status !== 0) {
  if (/no such table/.test(run.stdout + run.stderr)) { console.log('No reports yet.'); process.exit(0); }
  process.stderr.write(run.stderr || run.stdout); process.exit(run.status || 1);
}
const rows = JSON.parse(run.stdout)[0]?.results ?? [];
if (!rows.length) console.log('No reports yet.');
else console.table(rows);
console.log('Each row is sent at most once a day per computer, so counts are computer-days, not calls.');
