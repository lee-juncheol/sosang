import { useEffect, useRef, useState } from 'react'
import type { Asset, Sample } from './types'

export interface Photo { sample: Sample; pixels: Uint8ClampedArray<ArrayBuffer>; originalWidth: number; originalHeight: number }
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp'
const MAX_BYTES = 30 * 1024 * 1024
const MAX_EDGE = 2048

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('미리보기 이미지를 만들지 못했습니다.')), 'image/png'))
}

export function usePhotoUpload(onSelected: () => void) {
  const [photo, setPhoto] = useState<Photo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const liveUrl = useRef('')
  useEffect(() => () => { sequence.current++; URL.revokeObjectURL(liveUrl.current) }, [])

  function clear() {
    sequence.current++
    URL.revokeObjectURL(liveUrl.current); liveUrl.current = ''
    setPhoto(null); setError(''); setLoading(false)
  }
  async function upload(file: File) {
    const request = ++sequence.current
    setError(''); setLoading(true)
    let bitmap: ImageBitmap | undefined
    try {
      if (!/\.(jpe?g|png|webp)$/i.test(file.name) || (file.type && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type))) throw new Error('JPG, PNG, WebP 사진을 선택해 주세요. HEIC·RAW는 JPG로 변환한 뒤 사용할 수 있습니다.')
      if (file.size > MAX_BYTES) throw new Error('사진 한 장은 30 MB까지 선택할 수 있습니다.')
      if (!file.size) throw new Error('비어 있는 파일입니다. 다른 사진을 선택해 주세요.')
      try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }) }
      catch { throw new Error('사진을 읽지 못했습니다. 손상되지 않은 JPG, PNG, WebP 파일을 선택해 주세요.') }
      if (request !== sequence.current) return
      if (bitmap.width * bitmap.height > 80_000_000) throw new Error('8,000만 화소 이하의 사진을 선택해 주세요.')
      const originalWidth = bitmap.width, originalHeight = bitmap.height
      const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })
      if (!context) throw new Error('이 브라우저에서 사진 미리보기를 지원하지 않습니다.')
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      const blob = await canvasBlob(canvas)
      if (request !== sequence.current) return
      const path = URL.createObjectURL(blob)
      URL.revokeObjectURL(liveUrl.current); liveUrl.current = path
      setPhoto({ sample: { id: `upload-${request}`, name: file.name, category: '내 사진 · Standard / sRGB', credit: '내 기기에서 처리한 사진 · 서버 전송 없음', source: null, path, width: canvas.width, height: canvas.height, inputKind: 'uploaded-srgb', previewLut: 'std' }, pixels, originalWidth, originalHeight })
      onSelected()
    } catch (e) { if (request === sequence.current) setError(e instanceof Error ? e.message : '사진을 불러오지 못했습니다.') }
    finally { bitmap?.close(); if (request === sequence.current) setLoading(false) }
  }
  return { photo, loading, error, upload, clear }
}

export function usePhotoLook(photo: Photo | null, asset: Asset | undefined) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ key: string; path?: string; error?: string }>({ key: '' })
  const key = photo && asset ? `${photo.sample.id}-${asset.sha256}-${attempt}` : ''
  useEffect(() => {
    if (!photo || !asset) return
    let active = true, resultUrl = ''
    let worker: Worker | undefined
    const fail = (message: string) => { if (active) setState({ key, error: message }) }
    try {
      worker = new Worker(new URL('./lut.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = async (event: MessageEvent<{ pixels?: Uint8ClampedArray<ArrayBuffer>; error?: string }>) => {
        if (!active) return
        if (event.data.error) { fail(event.data.error); return }
        try {
          if (!event.data.pixels) throw new Error('LUT 처리 결과를 읽지 못했습니다.')
          const canvas = document.createElement('canvas'); canvas.width = photo.sample.width; canvas.height = photo.sample.height
          const context = canvas.getContext('2d', { colorSpace: 'srgb' })
          if (!context) throw new Error('미리보기를 만들지 못했습니다.')
          context.putImageData(new ImageData(event.data.pixels, canvas.width, canvas.height), 0, 0)
          const blob = await canvasBlob(canvas)
          if (active) { resultUrl = URL.createObjectURL(blob); setState({ key, path: resultUrl }) }
        } catch (e) { fail(e instanceof Error ? e.message : '미리보기를 만들지 못했습니다.') }
      }
      worker.onerror = () => fail('LUT 처리 중 문제가 생겼습니다. 다시 시도해 주세요.')
      const pixels = photo.pixels.slice()
      worker.postMessage({ pixels, asset }, [pixels.buffer])
    } catch { fail('이 브라우저에서 LUT 처리를 시작하지 못했습니다.') }
    return () => { active = false; worker?.terminate(); URL.revokeObjectURL(resultUrl) }
  }, [photo, asset, key])
  return { path: key && state.key === key ? state.path : undefined, error: key && state.key === key ? state.error : undefined, retry: () => setAttempt(n => n + 1) }
}
