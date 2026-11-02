import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { applyStdLut, parseStdCube } from '../src/lut.ts'
import { fetchVerifiedAsset } from '../src/assets.ts'

const reference = JSON.parse(await readFile(new URL('./fixtures/colour-reference.json', import.meta.url), 'utf8'))
for (const fixture of reference.fixtures) {
  test(`matches independent colour-science tetrahedral output: ${fixture.path}`, async () => {
    const text = await readFile(new URL(`../public/${fixture.path}`, import.meta.url), 'utf8')
    const pixels = new Uint8ClampedArray(reference.pixels)
    const result = applyStdLut(pixels, parseStdCube(text))
    assert.deepEqual([...result], fixture.expected)
    assert.deepEqual([...pixels], reference.pixels, 'source pixels stay unchanged')
  })
}
const text = await readFile(new URL(`../public/${reference.fixtures[0].path}`, import.meta.url), 'utf8')
test('rejects V-Log, malformed dimensions, rows, domain and non-finite data', () => {
  for (const invalid of [text.replace('PHOTOSTYLE STD', 'PHOTOSTYLE VLOG'), text.replace('LUT_3D_SIZE 33', 'LUT_3D_SIZE 32'), text.replace('DOMAIN_MAX 1.000000', 'DOMAIN_MAX 2.000000'), `${text}\nNaN 0 0`, text.split('\n').slice(0, -3).join('\n')]) assert.throws(() => parseStdCube(invalid))
})
test('identity cube preserves channels, alpha and endpoints', () => {
  const table = new Float64Array(33 ** 3 * 3)
  let i = 0
  for (let b = 0; b < 33; b++) for (let g = 0; g < 33; g++) for (let r = 0; r < 33; r++) { table[i++] = r / 32; table[i++] = g / 32; table[i++] = b / 32 }
  const pixels = new Uint8ClampedArray(reference.pixels)
  assert.deepEqual(applyStdLut(pixels, { size: 33, table }), pixels)
})
test('reads raw, packed gzip and host-decoded LUTs; rejects corrupt bytes and HTTP failures', async () => {
  const originalFetch = globalThis.fetch
  const buffer = Buffer.from(text)
  const asset = { name: 'testSTD.cube', path: '/test.cube.gz', bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), encoding: 'gzip' as const }
  try {
    for (const data of [buffer, gzipSync(buffer)]) {
      globalThis.fetch = async () => new Response(data)
      assert.equal(new TextDecoder().decode(await fetchVerifiedAsset(asset)), text)
    }
    globalThis.fetch = async () => new Response('broken')
    await assert.rejects(fetchVerifiedAsset(asset), /검증/)
    globalThis.fetch = async () => new Response('', { status: 404 })
    await assert.rejects(fetchVerifiedAsset(asset), /가져오지/)
  } finally { globalThis.fetch = originalFetch }
})
