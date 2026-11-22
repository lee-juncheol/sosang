#!/usr/bin/env node
// Print the contact-form messages stored in the deployed Worker's CONTACT KV store, newest first.
//   node scripts/contact-inbox.mjs            the latest 20
//   node scripts/contact-inbox.mjs --all      every stored message
//   node scripts/contact-inbox.mjs --delete <key>
// Needs `npm run cloudflare:login` once. Messages expire by themselves after 180 days.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');

function kv(...args) {
  const result = spawnSync(process.execPath, [wrangler, 'kv', ...args, '--binding', 'CONTACT', '--remote', '--config', 'wrangler.jsonc'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stderr || result.stdout); process.exit(result.status || 1); }
  return result.stdout;
}

const args = process.argv.slice(2);
if (args[0] === '--delete') {
  if (!args[1]?.startsWith('msg:')) { console.error('Usage: --delete msg:<key>'); process.exit(2); }
  kv('key', 'delete', args[1]);
  console.log(`Deleted ${args[1]}`);
  process.exit(0);
}

const keys = JSON.parse(kv('key', 'list', '--prefix', 'msg:')).map(entry => entry.name).sort().reverse();
const shown = args.includes('--all') ? keys : keys.slice(0, 20);
console.log(`${keys.length} message(s)${shown.length < keys.length ? `, showing the latest ${shown.length}` : ''}\n`);
for (const key of shown) {
  const entry = JSON.parse(kv('key', 'get', key));
  const facts = Object.entries(entry.context || {}).map(([name, value]) => `${name}: ${value}`).join(' · ');
  console.log(`── ${key}`);
  if (facts) console.log(facts);
  console.log(`reply: ${entry.email || '(none)'}\n`);
  console.log(entry.message, '\n');
}
