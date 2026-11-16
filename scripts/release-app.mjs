// Build a signed desktop app update and put it where the Cloudflare build publishes it.
//
//   npm run release:app -- [--version X.Y.Z] [--notes "text"] [--deploy] [--github]
//
// 1. Optionally set the version in package.json, src-tauri/Cargo.toml and tauri.conf.json
//    (they must match: the updater compares against the version built into the app).
// 2. `tauri build` with the updater signing key (outside the repository, see below), which
//    makes the signed update for this machine: sosang.app.tar.gz on macOS, the NSIS
//    setup .exe on 64-bit Windows, each with its .sig.
// 3. Copy it to app-release/releases/<version>/ and write app-release/latest.json. Platforms
//    of the same version already in app-release/latest.json or published on the server are
//    kept (their downloads are fetched), so macOS and Windows can be released one after the
//    other from different machines with the same key.
// 4. With --deploy, build and deploy the site, which publishes both under /app/.
// 5. With --github, put this machine's installer (macOS DMG, Windows setup .exe) on the one
//    GitHub release page (tag `app`) and update its version line (scripts/github-release.mjs).
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
  lock: path.join(root, 'package-lock.json'),
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
  // package-lock.json repeats the root version at the top and under packages[""].
  const lock = JSON.parse(await fs.readFile(files.lock, 'utf8'));
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  await fs.writeFile(files.lock, JSON.stringify(lock, null, 2) + '\n');
}

/** What this machine builds: updater platform key, bundle type and the signed file it makes. */
function target(version) {
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
  assert(arch, `Unsupported architecture: ${process.arch}`);
  if (process.platform === 'darwin') {
    // The updater needs sosang.app.tar.gz; the DMG is only built for the GitHub release page.
    const dmgArch = { aarch64: 'aarch64', x86_64: 'x64' }[arch];
    return {
      key: `darwin-${arch}`, bundle: github ? 'app,dmg' : 'app',
      file: path.join(root, 'target/release/bundle/macos/sosang.app.tar.gz'), name: `sosang_${version}_darwin-${arch}.app.tar.gz`,
      installer: path.join(root, `target/release/bundle/dmg/sosang_${version}_${dmgArch}.dmg`),
    };
  }
  if (process.platform === 'win32' && arch === 'x86_64') {
    // The NSIS installer is both the first download and the update the updater runs.
    const file = path.join(root, `target/release/bundle/nsis/sosang_${version}_x64-setup.exe`);
    return { key: 'windows-x86_64', bundle: 'nsis', file, name: `sosang_${version}_windows-x86_64-setup.exe`, installer: file };
  }
  assert.fail(`Releases are built on macOS or 64-bit Windows, not ${process.platform}-${process.arch}`);
}

/** Entries for the other platforms of the same version, so a release from one machine does not
 *  drop what another machine already published. Their downloads are copied into releaseDir,
 *  because the site build publishes only what app-release/ holds. */
async function otherPlatforms(version, ownKey, releaseDir) {
  const sources = [];
  const local = await fs.readFile(path.join(root, APP_UPDATE_SOURCE), 'utf8').catch(() => null);
  if (local) sources.push({ from: APP_UPDATE_SOURCE, doc: JSON.parse(local) });
  const response = await fetch(`${APP_SERVER}/app/latest.json`, { cache: 'no-store' }).catch(() => null);
  if (response?.status === 200) sources.push({ from: `${APP_SERVER}/app/latest.json`, doc: await response.json() });
  const kept = {};
  for (const { from, doc } of sources) {
    if (doc.version !== version) continue;
    validateUpdateManifest(doc);
    for (const [key, entry] of Object.entries(doc.platforms)) {
      if (key === ownKey || kept[key]) continue;
      const url = new URL(entry.url);
      const file = path.join(releaseDir, path.basename(url.pathname));
      if (!existsSync(file)) {
        assert.equal(url.origin, APP_SERVER, `${key} download is not on ${APP_SERVER}: ${url.href}`);
        const got = await fetch(url);
        assert(got.ok, `Could not download the published ${key} update (${got.status}): ${url.href}`);
        await fs.writeFile(file, Buffer.from(await got.arrayBuffer()));
      }
      kept[key] = entry;
      console.log(`Keeping ${key} ${version} from ${from}`);
    }
  }
  return kept;
}

const github = process.argv.includes('--github');
const requested = option('--version');
if (requested) await setVersion(requested);
const versions = await readVersions();
assert(versions.pkg === versions.cargo && versions.cargo === versions.tauri, `Versions differ: package.json ${versions.pkg}, Cargo.toml ${versions.cargo}, tauri.conf.json ${versions.tauri}. Pass --version X.Y.Z to set all three.`);
const version = versions.tauri;

const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || path.join(os.homedir(), '.tauri/sosang-updater.key');
assert(existsSync(keyPath), `Updater signing key not found: ${keyPath}`);
assert(!path.resolve(keyPath).startsWith(root + path.sep), 'Keep the signing key outside the repository');

const own = target(version);
console.log(`Building sosang ${version} (${own.key})…`);
process.env.PATH = `${path.join(os.homedir(), '.cargo', 'bin')}${path.delimiter}${process.env.PATH}`;
run(['node_modules/@tauri-apps/cli/tauri.js', 'build', '--bundles', own.bundle], { TAURI_SIGNING_PRIVATE_KEY: keyPath });

const signature = (await fs.readFile(own.file + '.sig', 'utf8')).trim();
const releaseDir = path.join(root, APP_RELEASE_DIR, 'releases', version);
await fs.mkdir(releaseDir, { recursive: true });
await fs.copyFile(own.file, path.join(releaseDir, own.name));

const others = await otherPlatforms(version, own.key, releaseDir);
const manifest = {
  version,
  notes: option('--notes') || '',
  pub_date: new Date().toISOString(),
  platforms: { ...others, [own.key]: { signature, url: `${APP_SERVER}/app/releases/${version}/${own.name}` } },
};
validateUpdateManifest(manifest);
await fs.writeFile(path.join(root, APP_UPDATE_SOURCE), JSON.stringify(manifest, null, 2) + '\n');
const size = (await fs.stat(own.file)).size;
console.log(`Update ${version}: ${path.relative(root, path.join(releaseDir, own.name))} (${(size / 1024 / 1024).toFixed(1)} MB), ${APP_UPDATE_SOURCE}`);
console.log(`Platforms in this release: ${Object.keys(manifest.platforms).sort().join(', ')}`);

if (process.argv.includes('--deploy')) run(['scripts/run-web.mjs', 'deploy:cloudflare']);
else console.log('Publish it with: npm run deploy:cloudflare');
if (github) {
  const { updateGithubRelease } = await import('./github-release.mjs');
  await updateGithubRelease(own.key, version, own.installer);
}
