import { fetchVerifiedAsset } from './assets.ts'
import { crc32, deflateRaw, writeZip, type ZipEntry } from './cameraStd.ts'
import { serverUrl } from './platform.ts'
import type { Asset } from './types'

// Same licences every published LUTS ZIP carries (scripts/prepare-cloudflare.mjs LUT_LICENSES).
const DEFAULT_LICENSES = ['/licenses/SPEKTRAFILM_LICENSE.txt', '/licenses/spektrafilm-LICENSE.txt', '/camera-adapters/V-Log-Alchemy-LICENSE.txt']

export async function lutLicenseFiles(assets: Asset[] | undefined): Promise<{ name: string; bytes: Uint8Array }[]> {
  if (assets?.length) return Promise.all(assets.map(async asset => ({ name: asset.name, bytes: new Uint8Array(await fetchVerifiedAsset(asset)) })))
  return Promise.all(DEFAULT_LICENSES.map(async path => {
    const response = await fetch(serverUrl(path))
    if (!response.ok) throw new Error('라이선스 파일을 가져오지 못했습니다. 다시 시도해 주세요.')
    return { name: path.split('/').pop()!, bytes: new Uint8Array(await response.arrayBuffer()) }
  }))
}

// DOS date/time of 2026-11-25 00:00, fixed so the same settings give the same ZIP.
const ZIP_DATE = ((2026 - 1980) << 9) | (11 << 5) | 25

/** A LUT ZIP made in the browser: STD and V-Log cubes, a README and the licences (lutLicenseFiles). */
export async function buildLutZip(files: { name: string; text: string }[], readme: string, licenses: { name: string; bytes: Uint8Array }[]): Promise<ArrayBuffer> {
  const encoder = new TextEncoder()
  const all = [...files.map(file => ({ name: file.name, bytes: encoder.encode(file.text) })), { name: 'README.txt', bytes: encoder.encode(readme) }, ...licenses]
  const entries: ZipEntry[] = await Promise.all(all.map(async ({ name, bytes }) => {
    const deflated = await deflateRaw(bytes)
    return { name, method: deflated ? 8 : 0, time: 0, date: ZIP_DATE, crc: crc32(bytes), size: bytes.length, data: deflated ?? bytes, external: 0, madeBy: 20 }
  }))
  return writeZip(entries)
}
