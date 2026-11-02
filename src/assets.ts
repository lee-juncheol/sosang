import type { Asset } from './types'

// Shared by downloads and the upload renderer, including packed production LUTs.
export async function fetchVerifiedAsset(asset: Asset): Promise<ArrayBuffer> {
  const response = await fetch(asset.path)
  if (!response.ok) throw new Error('LUT 파일을 가져오지 못했습니다. 다시 시도해 주세요.')
  let buffer = await response.arrayBuffer()
  const magic = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength))
  if (asset.encoding === 'gzip' && magic[0] === 0x1f && magic[1] === 0x8b) {
    buffer = await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
  }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))).map(n => n.toString(16).padStart(2, '0')).join('')
  if (digest !== asset.sha256 || buffer.byteLength !== asset.bytes) throw new Error('LUT 파일 검증에 실패했습니다. 페이지를 새로고침해 주세요.')
  return buffer
}
