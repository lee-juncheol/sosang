#!/usr/bin/env node
// Count LUT downloads the website and app report (D1 database `sosang-usage`, table `downloads`).
//   node scripts/download-report.mjs            per LUT: downloads, website/app, last download
//   node scripts/download-report.mjs --days 7   only the last 7 days
//   node scripts/download-report.mjs --daily    downloads per day
//   node scripts/download-report.mjs --recent   the latest 30 rows
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
  ? 'SELECT received, lut, format, kind, source FROM downloads ORDER BY id DESC LIMIT 30'
  : args.includes('--daily')
    ? `SELECT substr(received, 1, 10) AS day, COUNT(*) AS downloads, SUM(source = 'web') AS web, SUM(source = 'app') AS app FROM downloads ${since} GROUP BY day ORDER BY day DESC`
    : `SELECT lut, COUNT(*) AS downloads, SUM(source = 'web') AS web, SUM(source = 'app') AS app, MAX(received) AS last FROM downloads ${since} GROUP BY lut ORDER BY downloads DESC, lut`;

const run = spawnSync(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'sosang-usage', '--remote', '--json', '--command', sql, '--config', 'wrangler.jsonc'], { cwd: root, encoding: 'utf8' });
if (run.status !== 0) {
  if (/no such table/.test(run.stdout + run.stderr)) { console.log('No downloads yet.'); process.exit(0); }
  process.stderr.write(run.stderr || run.stdout); process.exit(run.status || 1);
}
const rows = JSON.parse(run.stdout)[0]?.results ?? [];
if (!rows.length) { console.log('No downloads yet.'); process.exit(0); }
console.table(rows);
if (!args.includes('--recent')) console.log(`Total: ${rows.reduce((sum, row) => sum + row.downloads, 0)} downloads (UTC dates).`);
