import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fetchVerifiedAsset, extractZipEntry } from '../src/assets.ts'
import { buildCameraPackage, composeStdText, parseCubeTable, readZipEntries, writeZip, CAMERA_FILES } from '../src/cameraStd.ts'
import { renameZipEntries } from '../src/downloadZip.ts'
import type { Asset, Catalog } from '../src/types.ts'

const root = new URL('../public/', import.meta.url)
const load = async (path: string) => { const file = await fs.readFile(new URL('.' + path, root)); return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer }
const hash = (bytes: ArrayBuffer | Uint8Array) => createHash('sha256').update(new Uint8Array(bytes)).digest('hex')
const catalog = JSON.parse(await fs.readFile(new URL('catalog.json', root), 'utf8')) as Catalog
const combo = catalog.combinations.find(c => c.stdByCamera)!
const camera = 'G9II'
const model = catalog.cameraAdapters!.models.find(m => m.id === camera)!
const published = combo.stdByCamera![camera]

test('browser composition reproduces the published camera STD cube byte for byte', async () => {
  const vlog = parseCubeTable(new TextDecoder().decode(await fetchVerifiedAsset(combo.files!.vlog, load)))
  const adapter = parseCubeTable(new TextDecoder().decode(await fetchVerifiedAsset(model.asset, load)))
  const text = composeStdText(vlog, adapter, camera, combo.files!.vlog.name)
  assert.equal(hash(new TextEncoder().encode(text)), published.std.sha256)
  assert.equal(text.split('\n')[1], '#LUMIXPHOTOSTYLE STD')
})

test('camera-std and camera-package assets rebuild the camera ZIP from shared files and notes', async () => {
  const cameraZip = await load(published.zip.path)
  const notes = writeZip(readZipEntries(cameraZip).filter(e => CAMERA_FILES.includes(e.name)).map(e => ({ ...e, name: `${camera}/${e.name}` })))
  const notesPath = '/__notes.zip'
  const loader = (path: string) => path === notesPath ? Promise.resolve(notes) : load(path)
  const base = combo.files!.zip
  const std: Asset = { path: base.path, name: published.std.name, bytes: published.std.bytes, sha256: published.std.sha256, encoding: 'camera-std',
    transferBytes: base.bytes, transferSha256: base.sha256, compose: { camera, vlog: combo.files!.vlog, adapter: model.asset } }
  assert.equal(hash(await fetchVerifiedAsset(std, loader)), published.std.sha256)
  const pack: Asset = { path: notesPath, name: published.zip.name, bytes: published.zip.bytes, sha256: published.zip.sha256, encoding: 'camera-package',
    transferBytes: notes.byteLength, transferSha256: hash(notes), package: { camera, base, std } }
  const rebuilt = await fetchVerifiedAsset(pack, loader)
  const original = readZipEntries(cameraZip)
  assert.deepEqual(readZipEntries(rebuilt).map(e => e.name), original.map(e => e.name))
  for (const entry of original) {
    const a = await extractZipEntry(rebuilt, entry.name, entry.size), b = await extractZipEntry(cameraZip, entry.name, entry.size)
    assert.equal(hash(a), hash(b), entry.name)
  }
  // The download renames the cubes inside the rebuilt archive.
  const renamed = renameZipEntries(rebuilt, { [published.std.name]: 'TestG9.cube' })
  assert.ok(readZipEntries(renamed).some(e => e.name === 'TestG9.cube'))
  // A changed adapter or notes archive is rejected.
  await assert.rejects(fetchVerifiedAsset({ ...std, sha256: '0'.repeat(64) }, loader))
  await assert.rejects(fetchVerifiedAsset({ ...pack, transferSha256: '0'.repeat(64) }, loader))
})

test('the composed package is not reachable without notes for the camera', async () => {
  const empty = writeZip([])
  await assert.rejects(buildCameraPackage(await load(combo.files!.zip.path), empty, camera, published.std.name, new Uint8Array(4)))
})
