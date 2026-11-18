// Stop a site deploy that would replace the published desktop app release with an older one.
// app-release/ is not in git, so each checkout can hold a different (or no) release.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_SERVER, APP_UPDATE_SOURCE, assertKeepsPublishedRelease } from './app-update.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const response = await fetch(`${APP_SERVER}/app/latest.json`, { cache: 'no-store' });
if (response.status === 200) {
  const text = await fs.readFile(path.join(root, APP_UPDATE_SOURCE), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  assertKeepsPublishedRelease(text && JSON.parse(text), await response.json());
} else if (response.status !== 204 && response.status !== 404) {
  throw new Error(`Could not read the published app release (${response.status})`);
}
