// Camera Standard cubes made in the browser: L_STD(x) = L_VLOG(A_camera(x)).
// Same arithmetic order and nine-decimal text as pipeline/camera_std.py, so the
// result is byte-identical to the cubes the pipeline publishes (checked for every
// look and camera by scripts/check-browser-std.mjs and verify-camera-std.mjs).

import type { Asset } from './types.ts'

const N = 33

/** Rows of a 33^3 .cube as table[B, G, R, channel]; header lines are skipped. */
export function parseCubeTable(text: string): Float64Array {
  const table = new Float64Array(N * N * N * 3)
  let i = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || /^[A-Z_]/.test(line)) {
      if (line.startsWith('LUT_3D_SIZE') && line.split(/\s+/)[1] !== String(N)) throw new Error('Camera STD needs 33-point cubes')
      continue
    }
    const parts = line.split(/\s+/)
    if (parts.length !== 3 || i + 3 > table.length) throw new Error('Unexpected cube row')
    for (const part of parts) {
      const value = Number(part)
      if (!Number.isFinite(value)) throw new Error('Unexpected cube value')
      table[i++] = value
    }
  }
  if (i !== table.length) throw new Error('Incomplete cube')
  return table
}

const clip = (v: number) => v < 0 ? 0 : v > 1 ? 1 : v

/** alchemy_trilinear: out starts at 0; loops B, G, R; weight = wr * wg * wb. */
function trilinear(table: Float64Array, r: number, g: number, b: number, out: Float64Array) {
  const pr = clip(r) * (N - 1), pg = clip(g) * (N - 1), pb = clip(b) * (N - 1)
  const br = Math.min(Math.floor(pr), N - 2), bg = Math.min(Math.floor(pg), N - 2), bb = Math.min(Math.floor(pb), N - 2)
  const fr = pr - br, fg = pg - bg, fb = pb - bb
  let o0 = 0, o1 = 0, o2 = 0
  for (let db = 0; db < 2; db++) {
    const wb = db ? fb : 1 - fb
    for (let dg = 0; dg < 2; dg++) {
      const wg = dg ? fg : 1 - fg
      for (let dr = 0; dr < 2; dr++) {
        const wr = dr ? fr : 1 - fr
        const w = wr * wg * wb
        const k = (((bb + db) * N + (bg + dg)) * N + (br + dr)) * 3
        o0 += w * table[k]; o1 += w * table[k + 1]; o2 += w * table[k + 2]
      }
    }
  }
  out[0] = o0; out[1] = o1; out[2] = o2
}

/** alchemy_tetrahedral: axes by descending fraction, ties keep R before G before B. */
function tetrahedral(table: Float64Array, rgb: Float64Array, out: Float64Array) {
  const pos = [clip(rgb[0]) * (N - 1), clip(rgb[1]) * (N - 1), clip(rgb[2]) * (N - 1)]
  const c = pos.map(p => Math.min(Math.floor(p), N - 2))
  const f = [pos[0] - c[0], pos[1] - c[1], pos[2] - c[2]]
  const order = [0, 1, 2].sort((a, b) => (f[b] - f[a]) || (a - b))
  let k = ((c[2] * N + c[1]) * N + c[0]) * 3
  let p0 = table[k], p1 = table[k + 1], p2 = table[k + 2]
  let o0 = p0, o1 = p1, o2 = p2
  for (const axis of order) {
    c[axis] += 1
    k = ((c[2] * N + c[1]) * N + c[0]) * 3
    const n0 = table[k], n1 = table[k + 1], n2 = table[k + 2], fa = f[axis]
    o0 += fa * (n0 - p0); o1 += fa * (n1 - p1); o2 += fa * (n2 - p2)
    p0 = n0; p1 = n1; p2 = n2
  }
  out[0] = o0; out[1] = o1; out[2] = o2
}

// numpy '%.9f' prints the sign of a negative zero.
const fixed = (v: number) => (Object.is(v, -0) ? '-' : '') + v.toFixed(9)

/** Text of the camera STD cube, exactly as pipeline/camera_std.serialize_std writes it. */
export function composeStdText(vlog: Float64Array, adapter: Float64Array, camera: string, vlogName: string): string {
  if (!/^[A-Z0-9-]+$/.test(camera) || !/^[A-Za-z0-9]+\.cube$/.test(vlogName)) throw new Error('Invalid camera STD name')
  const lines = [`TITLE "${camera} Standard - ${vlogName.replace(/\.cube$/, '')}"`, '#LUMIXPHOTOSTYLE STD',
    'LUT_3D_SIZE 33', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1',
    '# Modified by Film Lab: camera V-Log Alchemy adapter composed with the attributed creative VLOG renderer.']
  const mid = new Float64Array(3), out = new Float64Array(3)
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    trilinear(adapter, r / (N - 1), g / (N - 1), b / (N - 1), mid)
    tetrahedral(vlog, mid, out)
    lines.push(`${fixed(clip(out[0]))} ${fixed(clip(out[1]))} ${fixed(clip(out[2]))}`)
  }
  return lines.join('\n') + '\n'
}

type HydratableCatalog = { cameraAdapters?: { models: { id: string; asset: Asset }[] }; combinations: { files?: { vlog: Asset; zip: Asset }; stdByCamera?: Record<string, { std: Asset; zip: Asset }> }[] }

/**
 * The catalog lists browser-made camera files without repeating their sources;
 * link each to the look's VLOG cube, the camera adapter and the default ZIP.
 */
export function hydrateCameraAssets<T extends HydratableCatalog>(catalog: T): T {
  const adapters = new Map((catalog.cameraAdapters?.models || []).map(model => [model.id, model.asset]))
  for (const combo of catalog.combinations) {
    if (!combo.stdByCamera || !combo.files) continue
    for (const [camera, entry] of Object.entries(combo.stdByCamera)) {
      if (entry.std.encoding === 'camera-std') {
        const adapter = adapters.get(camera)
        if (!adapter) throw new Error(`Missing camera adapter: ${camera}`)
        entry.std.compose = { camera, vlog: combo.files.vlog, adapter }
      }
      if (entry.zip.encoding === 'camera-package') entry.zip.package = { camera, base: combo.files.zip, std: entry.std }
    }
  }
  return catalog
}

// ---- ZIP (ZIP32, stored or deflated, no extra fields) ----

export interface ZipEntry { name: string; method: number; time: number; date: number; crc: number; size: number; data: Uint8Array; external: number; madeBy: number }

const badZip = () => new Error('카메라 LUT 묶음 파일을 읽지 못했습니다. 페이지를 새로고침해 주세요.')

/** Raw entries of an authenticated archive; compressed data is kept as is. */
export function readZipEntries(buffer: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buffer), bytes = new Uint8Array(buffer)
  const within = (offset: number, size: number) => { if (offset < 0 || size < 0 || offset + size > bytes.length) throw badZip() }
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break }
  }
  if (end < 0) throw badZip()
  const count = view.getUint16(end + 10, true)
  let cursor = view.getUint32(end + 16, true)
  const entries: ZipEntry[] = [], names = new Set<string>()
  for (let i = 0; i < count; i++) {
    within(cursor, 46)
    if (view.getUint32(cursor, true) !== 0x02014b50) throw badZip()
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true)
    const compressed = view.getUint32(cursor + 20, true), size = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true)
    const local = view.getUint32(cursor + 42, true)
    if (flags !== 0 || (method !== 0 && method !== 8) || compressed === 0xffffffff || size === 0xffffffff) throw badZip()
    within(cursor + 46, nameLength)
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    if (names.has(name)) throw badZip()
    names.add(name)
    within(local, 30)
    if (view.getUint32(local, true) !== 0x04034b50) throw badZip()
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    within(start, compressed)
    entries.push({ name, method, time: view.getUint16(cursor + 12, true), date: view.getUint16(cursor + 14, true),
      crc: view.getUint32(cursor + 16, true), size, data: bytes.slice(start, start + compressed),
      external: view.getUint32(cursor + 38, true), madeBy: view.getUint16(cursor + 4, true) })
    cursor += 46 + nameLength + extra + comment
  }
  return entries
}

export function writeZip(entries: ZipEntry[]): ArrayBuffer {
  const encoder = new TextEncoder()
  const names = entries.map(entry => encoder.encode(entry.name))
  const localSize = entries.reduce((sum, entry, i) => sum + 30 + names[i].length + entry.data.length, 0)
  const centralSize = names.reduce((sum, name) => sum + 46 + name.length, 0)
  const out = new Uint8Array(localSize + centralSize + 22), view = new DataView(out.buffer)
  const offsets: number[] = []
  let p = 0
  entries.forEach((entry, i) => {
    offsets.push(p)
    view.setUint32(p, 0x04034b50, true); view.setUint16(p + 4, 20, true); view.setUint16(p + 6, 0, true)
    view.setUint16(p + 8, entry.method, true); view.setUint16(p + 10, entry.time, true); view.setUint16(p + 12, entry.date, true)
    view.setUint32(p + 14, entry.crc, true); view.setUint32(p + 18, entry.data.length, true); view.setUint32(p + 22, entry.size, true)
    view.setUint16(p + 26, names[i].length, true); view.setUint16(p + 28, 0, true)
    out.set(names[i], p + 30); out.set(entry.data, p + 30 + names[i].length)
    p += 30 + names[i].length + entry.data.length
  })
  const central = p
  entries.forEach((entry, i) => {
    view.setUint32(p, 0x02014b50, true); view.setUint16(p + 4, entry.madeBy, true); view.setUint16(p + 6, 20, true)
    view.setUint16(p + 8, 0, true); view.setUint16(p + 10, entry.method, true); view.setUint16(p + 12, entry.time, true); view.setUint16(p + 14, entry.date, true)
    view.setUint32(p + 16, entry.crc, true); view.setUint32(p + 20, entry.data.length, true); view.setUint32(p + 24, entry.size, true)
    view.setUint16(p + 28, names[i].length, true)
    view.setUint32(p + 38, entry.external, true); view.setUint32(p + 42, offsets[i], true)
    out.set(names[i], p + 46)
    p += 46 + names[i].length
  })
  view.setUint32(p, 0x06054b50, true); view.setUint16(p + 8, entries.length, true); view.setUint16(p + 10, entries.length, true)
  view.setUint32(p + 12, p - central, true); view.setUint32(p + 16, central, true)
  return out.buffer
}

let crcTable: Uint32Array | undefined
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
  }
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  if (typeof CompressionStream === 'undefined') return undefined
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch { return undefined }
}

/** Files that differ per camera; the rest of the package is shared with the default LUTS ZIP. */
export const CAMERA_FILES = ['qa.json', 'provenance.json', 'README.txt']

/**
 * The camera ZIP the pipeline publishes, rebuilt from the default LUTS ZIP (VLOG,
 * licences, changelog), the look's camera notes ZIP (<camera>/qa.json, ...) and the
 * composed STD cube. Entry order and metadata follow the base archive.
 */
export async function buildCameraPackage(base: ArrayBuffer, notes: ArrayBuffer, camera: string, stdName: string, std: Uint8Array): Promise<ArrayBuffer> {
  const baseEntries = readZipEntries(base), noteEntries = readZipEntries(notes)
  const entries = await Promise.all(baseEntries.map(async entry => {
    if (entry.name === stdName) {
      const deflated = await deflateRaw(std)
      return { ...entry, method: deflated ? 8 : 0, crc: crc32(std), size: std.length, data: deflated ?? std }
    }
    if (!CAMERA_FILES.includes(entry.name)) return entry
    const note = noteEntries.find(item => item.name === `${camera}/${entry.name}`)
    if (!note) throw badZip()
    return { ...note, name: entry.name }
  }))
  return writeZip(entries)
}
