// Build a signed desktop app update and put it where the Cloudflare build publishes it.
//
//   npm run release:app -- [--version X.Y.Z] [--notes "text"] [--deploy]
//
// 1. Optionally set the version in package.json, src-tauri/Cargo.toml and tauri.conf.json
//    (they must match: the updater compares against the version built into the app).
// 2. `tauri build` with the updater signing key (outside the repository, see below), which
//    makes sosang.app.tar.gz and its .sig.
// 3. Copy the archive to app-release/releases/<version>/ and write app-release/latest.json.
// 4. With --deploy, build and deploy the site, which publishes both under /app/.
//
// Signing key: TAURI_SIGNING_PRIVATE_KEY_PATH, default ~/.tauri/sosang-updater.key. Its
// password comes from TAURI_SIGNING_PRIVATE_KEY_PASSWORD, or the Tauri CLI asks for it.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP_RELEASE_DIR, APP_SERVER, APP_UPDATE_SOURCE, validateUpdateManifest } from './app-update.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+$/;

function option(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function run(args, env = {}) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

const files = {
  package: path.join(root, 'package.json'),
  cargo: path.join(root, 'src-tauri/Cargo.toml'),
  tauri: path.join(root, 'src-tauri/tauri.conf.json'),
};

async function readVersions() {
  const pkg = JSON.parse(await fs.readFile(files.package, 'utf8')).version;
  const cargo = (await fs.readFile(files.cargo, 'utf8')).match(/^version = "([^"]+)"/m)?.[1];
  const tauri = JSON.parse(await fs.readFile(files.tauri, 'utf8')).version;
  return { pkg, cargo, tauri };
}

async function setVersion(version) {
  assert.match(version, SEMVER, `Version must look like 1.2.3: ${version}`);
  const swap = async (file, from, to) => {
    const text = await fs.readFile(file, 'utf8');
    assert(from.test(text), `No version field in ${path.relative(root, file)}`);
    await fs.writeFile(file, text.replace(from, to));
  };
  await swap(files.package, /("version":\s*")[^"]+(")/, `$1${version}$2`);
  await swap(files.cargo, /^version = "[^"]+"/m, `version = "${version}"`);
  await swap(files.tauri, /("version":\s*")[^"]+(")/, `$1${version}$2`);
}

function platformKey() {
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
  assert(process.platform === 'darwin' && arch, 'Releases are built on macOS for now');
  return `darwin-${arch}`;
}

const requested = option('--version');
if (requested) await setVersion(requested);
const versions = await readVersions();
assert(versions.pkg === versions.cargo && versions.cargo === versions.tauri, `Versions differ: package.json ${versions.pkg}, Cargo.toml ${versions.cargo}, tauri.conf.json ${versions.tauri}. Pass --version X.Y.Z to set all three.`);
const version = versions.tauri;

const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || path.join(os.homedir(), '.tauri/sosang-updater.key');
assert(existsSync(keyPath), `Updater signing key not found: ${keyPath}`);
assert(!path.resolve(keyPath).startsWith(root + path.sep), 'Keep the signing key outside the repository');

console.log(`Building sosang ${version} (${platformKey()})…`);
process.env.PATH = `${path.join(os.homedir(), '.cargo', 'bin')}${path.delimiter}${process.env.PATH}`;
// Only the .app bundle: the updater needs sosang.app.tar.gz, not the DMG installer.
run(['node_modules/@tauri-apps/cli/tauri.js', 'build', '--bundles', 'app'], { TAURI_SIGNING_PRIVATE_KEY: keyPath });

const bundle = path.join(root, 'target/release/bundle/macos');
const archive = path.join(bundle, 'sosang.app.tar.gz');
const signature = (await fs.readFile(archive + '.sig', 'utf8')).trim();
const fileName = `sosang_${version}_${platformKey()}.app.tar.gz`;
const releaseDir = path.join(root, APP_RELEASE_DIR, 'releases', version);
await fs.mkdir(releaseDir, { recursive: true });
await fs.copyFile(archive, path.join(releaseDir, fileName));

const manifest = {
  version,
  notes: option('--notes') || '',
  pub_date: new Date().toISOString(),
  platforms: { [platformKey()]: { signature, url: `${APP_SERVER}/app/releases/${version}/${fileName}` } },
};
validateUpdateManifest(manifest);
await fs.writeFile(path.join(root, APP_UPDATE_SOURCE), JSON.stringify(manifest, null, 2) + '\n');
const size = (await fs.stat(archive)).size;
console.log(`Update ${version}: ${path.relative(root, path.join(releaseDir, fileName))} (${(size / 1024 / 1024).toFixed(1)} MB), ${APP_UPDATE_SOURCE}`);

if (process.argv.includes('--deploy')) run(['scripts/run-web.mjs', 'deploy:cloudflare']);
else console.log('Publish it with: npm run deploy:cloudflare');
