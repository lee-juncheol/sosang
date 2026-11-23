// Can the browser rebuild every camera STD cube byte-for-byte?
// Recomposes L_STD = L_VLOG(A_camera(x)) with the browser module src/cameraStd.ts and compares the SHA-256 with the published catalog (stdByCamera).
// Usage: node scripts/check-browser-std.mjs [dist-cloudflare] [--limit N]
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { composeStdText, parseCubeTable } from '../src/cameraStd.ts'

const root = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'dist-cloudflare'
const limitAt = process.argv.indexOf('--limit')
const limit = limitAt > 0 ? Number(process.argv[limitAt + 1]) : Infinity

export function readZipEntry(buffer, name) {
  let eocd = buffer.length - 22
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('No zip directory')
  let p = buffer.readUInt32LE(eocd + 16)
  const count = buffer.readUInt16LE(eocd + 10)
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(p + 10), size = buffer.readUInt32LE(p + 20)
    const nameLength = buffer.readUInt16LE(p + 28), extra = buffer.readUInt16LE(p + 30), comment = buffer.readUInt16LE(p + 32)
    const local = buffer.readUInt32LE(p + 42)
    const entry = buffer.toString('utf8', p + 46, p + 46 + nameLength)
    if (entry === name) {
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
      const data = buffer.subarray(start, start + size)
      return method === 0 ? data : inflateRawSync(data)
    }
    p += 46 + nameLength + extra + comment
  }
  throw new Error(`Missing ${name}`)
}

const catalog = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'))
const adapters = Object.fromEntries(catalog.cameraAdapters.models.map(m =>
  [m.id, parseCubeTable(readFileSync(join(root, m.asset.path)).toString('utf8'))]))
let same = 0, different = 0, done = 0
const failures = []
const started = Date.now()
for (const combo of catalog.combinations) {
  if (done >= limit) break
  done++
  const vlogInfo = combo.files.vlog
  const vlogBytes = readZipEntry(readFileSync(join(root, vlogInfo.path)), vlogInfo.name)
  if (createHash('sha256').update(vlogBytes).digest('hex') !== vlogInfo.sha256) throw new Error(`VLOG hash ${combo.id}`)
  const vlog = parseCubeTable(vlogBytes.toString('utf8'))
  for (const [camera, info] of Object.entries(combo.stdByCamera)) {
    const bytes = Buffer.from(composeStdText(vlog, adapters[camera], camera, vlogInfo.name), 'ascii')
    if (createHash('sha256').update(bytes).digest('hex') === info.std.sha256) { same++; continue }
    different++
    const published = readZipEntry(readFileSync(join(root, info.std.path)), info.std.name).toString('ascii').split('\n')
    const mine = bytes.toString('ascii').split('\n')
    let rows = 0, maxDiff = 0, first = null
    for (let i = 0; i < Math.max(published.length, mine.length); i++) {
      if (published[i] === mine[i]) continue
      rows++
      first ??= { line: i + 1, published: published[i], browser: mine[i] }
      const a = (published[i] || '').split(' ').map(Number), b = (mine[i] || '').split(' ').map(Number)
      for (let j = 0; j < 3; j++) maxDiff = Math.max(maxDiff, Math.abs(a[j] - b[j]) || 0)
    }
    failures.push({ id: combo.id, camera, rows, maxDiff, first })
  }
  if (done % 50 === 0) console.error(`${done} looks, ${same} same, ${different} different, ${((Date.now() - started) / 1000).toFixed(0)}s`)
}
console.log(JSON.stringify({ looks: done, cubes: same + different, same, different,
  maxDiff: Math.max(0, ...failures.map(f => f.maxDiff)), rowsDifferent: failures.reduce((s, f) => s + f.rows, 0),
  examples: failures.slice(0, 8), seconds: (Date.now() - started) / 1000 }, null, 2))
