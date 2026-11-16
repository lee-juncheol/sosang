// Helpers for the photo sending view (PhotoCourier.tsx) that need no React.
import { courierThumbnail, type CourierPhoto } from './platform.ts'

export type SortOrder = 'date' | 'name'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Top-level files first, then each subfolder in natural order, then the file name. */
export function byPath(a: CourierPhoto, b: CourierPhoto): number {
  if (a.subfolder !== b.subfolder) {
    if (!a.subfolder || !b.subfolder) return a.subfolder ? 1 : -1
    return collator.compare(a.subfolder, b.subfolder)
  }
  return collator.compare(a.name, b.name)
}

/** Date = newest modification first (unknown dates last); name = natural path order. */
export function sortPhotos(photos: readonly CourierPhoto[], order: SortOrder): CourierPhoto[] {
  const sorted = [...photos]
  if (order === 'name') return sorted.sort(byPath)
  return sorted.sort((a, b) => (b.modified ?? -Infinity) - (a.modified ?? -Infinity) || byPath(a, b))
}

/** "+1.2°", "0.0°", "−0.4°" */
export function formatLevel(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded).toFixed(1)}°`
}

/** "1/250 s", "0.5 s", "2 s" */
export function formatExposure([n, d]: [number, number]): string {
  if (!n || !d) return ''
  const seconds = n / d
  if (seconds < 1 && Math.abs(d / n - Math.round(d / n)) < 0.01) return `1/${Math.round(d / n)} s`
  return `${Number(seconds.toFixed(seconds < 1 ? 2 : 1))} s`
}

/** Last folder name of a path from either platform. */
export function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

export const roundLevel = (value: number) => Math.max(-15, Math.min(15, Math.round(value * 10) / 10))

// Thumbnails: a few at a time, newest request first, cached as object URLs.
const THUMB_CACHE_LIMIT = 800
const THUMB_PARALLEL = 3
const thumbCache = new Map<string, string>()
type Waiter = { key: string; path: string; done: (url: string | null) => void }
let waiting: Waiter[] = []
let active = 0

function pump() {
  while (active < THUMB_PARALLEL && waiting.length) {
    const job = waiting.pop()!
    const cached = thumbCache.get(job.key)
    if (cached) { job.done(cached); continue }
    active++
    courierThumbnail(job.path).then(blob => {
      const url = URL.createObjectURL(blob)
      thumbCache.set(job.key, url)
      if (thumbCache.size > THUMB_CACHE_LIMIT) {
        const oldest = thumbCache.keys().next().value!
        URL.revokeObjectURL(thumbCache.get(oldest)!)
        thumbCache.delete(oldest)
      }
      job.done(url)
    }, () => job.done(null)).finally(() => { active--; pump() })
  }
}

/** Ask for a thumbnail; the returned function withdraws a request that has not started. */
export function requestThumbnail(photo: CourierPhoto, done: (url: string | null) => void): () => void {
  const key = `${photo.path}\n${photo.modified ?? ''}`
  const cached = thumbCache.get(key)
  if (cached) { done(cached); return () => {} }
  let live = true
  const waiter: Waiter = { key, path: photo.path, done: url => { if (live) done(url) } }
  waiting.push(waiter)
  pump()
  return () => { live = false; waiting = waiting.filter(w => w !== waiter) }
}
