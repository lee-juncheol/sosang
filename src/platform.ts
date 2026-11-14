// Differences between the website and the desktop app (Tauri), in one place.
// The website serves data from its own origin; the app bundles only the UI and reads catalog,
// LUTs and photos from the sosang server. Everything here is safe to import from tests and
// workers (no window access at module load).

type TauriInternals = { invoke: (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<unknown> }
type TauriWindow = { __TAURI_INTERNALS__?: TauriInternals }

// Set by vite.app.config.ts for the app build; undefined in the website build and in tests.
declare const __SOSANG_SERVER__: string | undefined
/** Origin that serves catalog, LUTs and photos. Empty on the website (same origin). */
export const SERVER_ORIGIN = (typeof __SOSANG_SERVER__ === 'string' ? __SOSANG_SERVER__ : '').replace(/\/$/, '')

function tauri(): TauriInternals | undefined {
  return typeof globalThis === 'object' ? (globalThis as TauriWindow).__TAURI_INTERNALS__ : undefined
}

/** True inside the desktop app. */
export function isApp(): boolean {
  return !!tauri()
}

/** Resolve a site-absolute path ("/luts/...") against the data server. Other URLs pass through. */
export function serverUrl<T extends string | undefined | null>(path: T): T {
  if (!SERVER_ORIGIN || typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return path
  return (SERVER_ORIGIN + path) as T
}

/** In the app, links that would leave the page (new tab, download, other site) open in the
 *  default browser instead; a WebView ignores them otherwise. Call once at startup. */
export function installAppLinkHandler(): void {
  const app = tauri()
  if (!app) return
  document.addEventListener('click', event => {
    const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!link || event.defaultPrevented) return
    const url = new URL(link.href, document.baseURI)
    if (url.origin === location.origin && link.target !== '_blank' && !link.hasAttribute('download')) return
    event.preventDefault()
    if (url.protocol === 'https:') void app.invoke('open_external', { url: url.href })
  })
}

/** Save a file. The website uses a download link; the app shows a save dialog.
 *  Returns false when the user cancelled the dialog. */
export async function saveFile(filename: string, data: BlobPart, type: string): Promise<boolean> {
  const app = tauri()
  if (app) {
    const bytes = new Uint8Array(await new Blob([data]).arrayBuffer())
    const saved = await app.invoke('save_file', bytes, { headers: { 'x-filename': encodeURIComponent(filename) } })
    return saved !== null
  }
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return true
}

// Camera commands (app only). Shapes match src-tauri/src/camera.rs.
export type CameraStatus = { manufacturer: string; model: string; firmware: string; writeSupported: boolean }
export type CameraEntry = { index: number; name: string; styleCode: number; inUse: boolean }
export type CameraLibrary = { camera: CameraStatus; entries: CameraEntry[]; freeSlots: number[]; selected: number | null }
export type CameraDeleteResult = { index: number; name: string; backup: string }
export type CameraRegisterResult = { index: number; name: string; backup: string; otherChanges: number }
export type CameraErrorCode = 'no_camera' | 'timeout' | 'session' | 'not_verified' | 'unsupported_model' | 'bad_cube' | 'bad_name' | 'bad_slot' | 'verify_failed' | 'unsupported_platform' | 'busy' | 'camera_error' | 'internal'
export type CameraProgress = 'reading' | 'writing' | 'verifying' | 'done'

export class CameraError extends Error {
  readonly code: CameraErrorCode
  constructor(code: CameraErrorCode, message: string) { super(message); this.code = code }
}

async function cameraCall<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const app = tauri()
  if (!app) throw new CameraError('unsupported_platform', 'Camera access needs the sosang app')
  try {
    return await app.invoke(cmd, args) as T
  } catch (e) {
    const err = e as { code?: CameraErrorCode; message?: string } | string
    if (typeof err === 'object' && err && err.code) throw new CameraError(err.code, err.message || err.code)
    throw new CameraError('internal', String(typeof err === 'object' ? err?.message : err))
  }
}

export const cameraStatus = () => cameraCall<CameraStatus>('camera_status')
export const cameraListLuts = () => cameraCall<CameraLibrary>('camera_list_luts')

async function withProgress<T>(run: () => Promise<T>, onProgress?: (step: CameraProgress) => void): Promise<T> {
  let unlisten: (() => void) | undefined
  if (onProgress) {
    const { listen } = await import('@tauri-apps/api/event')
    unlisten = await listen<CameraProgress>('camera-progress', event => onProgress(event.payload))
  }
  try {
    return await run()
  } finally {
    unlisten?.()
  }
}

/** Register a .cube text in one Library slot; `onProgress` receives the steps as they happen. */
export function cameraRegister(cube: string, slot: number, name: string, overwrite: boolean, onProgress?: (step: CameraProgress) => void): Promise<CameraRegisterResult> {
  return withProgress(() => cameraCall<CameraRegisterResult>('camera_register_lut', { cube, slot, name, overwrite }), onProgress)
}

/** Empty one Library slot (the entry selected in the camera is refused). */
export function cameraDelete(slot: number, onProgress?: (step: CameraProgress) => void): Promise<CameraDeleteResult> {
  return withProgress(() => cameraCall<CameraDeleteResult>('camera_delete_lut', { slot }), onProgress)
}

/** Entries 0 (built-in Vlog_709) and 1 (ARRI 709) came with the camera and are never changed. */
export const FIRST_USER_ENTRY = 2
/** Grid size and Photo Style tag of a .cube text, read before sending it to the camera. */
export function cubeSummary(text: string): { size: number | null; style: string | null } {
  const size = text.match(/^\s*LUT_3D_SIZE\s+(\d+)/m)
  const style = text.match(/^\s*#LUMIXPHOTOSTYLE\s+(\S+)/m)
  return { size: size ? Number(size[1]) : null, style: style ? style[1] : null }
}

/** Library names the camera accepts: printable ASCII, at most 95 characters. */
export function cameraLutName(filename: string): string {
  return filename.replace(/[^\x20-\x7e]/g, '_').trim().slice(0, 95)
}
