// Update the single GitHub release page of the desktop app (tag `app`) with this machine's
// installer, so the page and its download links never change between versions.
//
//   node scripts/github-release.mjs <platform> <version> <installer>
//   (release-app.mjs runs it with --github)
//
// - The installer is uploaded under a fixed name (ASSETS), replacing the previous one.
// - In the release text, only this platform's marked spans are rewritten:
//     <!--windows-x86_64-->…<!--/windows-x86_64-->         version · size · date
//     <!--windows-x86_64:sha-->…<!--/windows-x86_64:sha-->  SHA-256
//   They can appear several times (English and Korean); every copy is updated. Other
//   platforms' spans are left alone, so macOS and Windows can release separately.
// Needs the GitHub CLI (`gh`) signed in to an account that can edit the repository.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REPO = 'lee-juncheol/sosang';
export const TAG = 'app';
/** Fixed download names on the release page, per updater platform. */
export const ASSETS = {
  'darwin-aarch64': 'sosang-mac-apple-silicon.dmg',
  'windows-x86_64': 'sosang-windows-x64-setup.exe',
};

function gh(args, input) {
  const windowsDefault = 'C:\\Program Files\\GitHub CLI\\gh.exe';
  const exe = process.env.GH || (process.platform === 'win32' && existsSync(windowsDefault) ? windowsDefault : 'gh');
  const result = spawnSync(exe, [...args, '-R', REPO], { encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `gh ${args[0]} ${args[1]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Replace every marked span for `key` in `body`; fails when the marker is missing. */
export function replaceSpan(body, key, value) {
  const open = `<!--${key}-->`, close = `<!--/${key}-->`;
  const pattern = new RegExp(`${open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
  assert(pattern.test(body), `The release text has no ${open} … ${close} span`);
  return body.replace(pattern, `${open}${value}${close}`);
}

export async function updateGithubRelease(platform, version, installer) {
  const name = ASSETS[platform];
  assert(name, `No GitHub asset name for ${platform}`);
  const bytes = await fs.readFile(installer);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sosang-gh-'));
  try {
    const asset = path.join(dir, name);
    await fs.writeFile(asset, bytes);
    gh(['release', 'upload', TAG, asset, '--clobber']);
    // Local calendar date of the machine releasing (UTC can be a day off).
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let body = JSON.parse(gh(['release', 'view', TAG, '--json', 'body'])).body;
    body = replaceSpan(body, platform, `**${version}** · ${(bytes.length / 1024 / 1024).toFixed(1)} MB · ${date}`);
    body = replaceSpan(body, `${platform}:sha`, createHash('sha256').update(bytes).digest('hex'));
    const notes = path.join(dir, 'notes.md');
    await fs.writeFile(notes, body);
    gh(['release', 'edit', TAG, '--notes-file', notes]);
    console.log(`GitHub release "${TAG}": ${name} is now ${version}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [platform, version, installer] = process.argv.slice(2);
  assert(platform && version && installer, 'Usage: node scripts/github-release.mjs <platform> <version> <installer>');
  await updateGithubRelease(platform, version, installer);
}
