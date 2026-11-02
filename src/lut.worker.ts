import { fetchVerifiedAsset } from './assets'
import { applyStdLut, parseStdCube } from './lut'
import type { Asset } from './types'

self.onmessage = async (event: MessageEvent<{ asset: Asset; pixels: Uint8ClampedArray }>) => {
  try {
    const bytes = await fetchVerifiedAsset(event.data.asset)
    const result = applyStdLut(event.data.pixels, parseStdCube(new TextDecoder().decode(bytes)))
    self.postMessage({ pixels: result }, { transfer: [result.buffer] })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : '사진에 LUT를 적용하지 못했습니다.' })
  }
}
