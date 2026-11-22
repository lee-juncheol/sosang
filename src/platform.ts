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
export type CameraStatus = { manufacturer: string; model: string; firmware: string; writeSupported: boolean; writeExperimental: boolean }
export type CameraEntry = { index: number; name: string; styleCode: number; inUse: boolean }
/** `locked`: entries whose LUT data another entry uses since LUTs were reordered in the camera's
 *  menu; nothing is written there. `reordered`: such a reorder happened, so moving is refused. */
export type CameraLibrary = { camera: CameraStatus; entries: CameraEntry[]; freeSlots: number[]; selected: number[] | null; locked: number[]; reordered: boolean }
export type CameraDeleteResult = { deleted: { index: number; name: string }[]; backup: string }
export type CameraRegisterResult = { index: number; name: string; backup: string; otherChanges: number }
export type CameraErrorCode = 'no_camera' | 'timeout' | 'session' | 'not_verified' | 'unsupported_model' | 'bad_cube' | 'bad_name' | 'bad_slot' | 'slot_changed' | 'reordered' | 'bad_backup' | 'other_camera' | 'verify_failed' | 'rolled_back' | 'unconfirmed' | 'unknown_layout' | 'unsupported_platform' | 'busy' | 'camera_error' | 'update_failed' | 'no_update' | 'internal'
export type CameraProgress = 'reading' | 'writing' | 'verifying' | 'restoring' | 'done'

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

/** Register a .cube text in one Library slot; `onProgress` receives the steps as they happen.
 *  `expected` is what the slot held when the list was read (`null` = empty); the camera
 *  refuses the write if that changed meanwhile. `experimental` = the user agreed to write to a
 *  body that is not verified (`writeExperimental`). */
export function cameraRegister(cube: string, slot: number, name: string, overwrite: boolean, expected: string | null, experimental: boolean, onProgress?: (step: CameraProgress) => void): Promise<CameraRegisterResult> {
  return withProgress(() => cameraCall<CameraRegisterResult>('camera_register_lut', { cube, slot, name, overwrite, expected, experimental }), onProgress)
}

export type CameraRegisterManyResult = { registered: { index: number; name: string }[]; backup: string; otherChanges: number }

/** Register several .cube texts in one write. Every file and slot is checked first; if one is
 *  refused, nothing is written. */
export function cameraRegisterMany(items: { cube: string; slot: number; name: string; expected: string | null }[], overwrite: boolean, experimental: boolean, onProgress?: (step: CameraProgress) => void): Promise<CameraRegisterManyResult> {
  return withProgress(() => cameraCall<CameraRegisterManyResult>('camera_register_luts', { items, overwrite, experimental }), onProgress)
}

/** Empty one or more Library slots in one write. The entry selected in the camera is refused,
 *  and if any slot is refused nothing changes. */
export function cameraDelete(slots: number[], names: string[], experimental: boolean, onProgress?: (step: CameraProgress) => void): Promise<CameraDeleteResult> {
  return withProgress(() => cameraCall<CameraDeleteResult>('camera_delete_luts', { slots, names, experimental }), onProgress)
}

export type CameraRearrangeResult = { moved: { index: number; name: string | null }[]; backup: string }

/** Move LUTs between slots in one write. `order[k]` is the slot whose LUT ends up in slot k
 *  (`null` = empty); `names` is every slot as last read (`null` = empty), so nothing is written
 *  if the camera changed meanwhile. Built-in slots and LUTs selected on the camera stay put. */
export function cameraRearrange(order: (number | null)[], names: (string | null)[], experimental: boolean, onProgress?: (step: CameraProgress) => void): Promise<CameraRearrangeResult> {
  return withProgress(() => cameraCall<CameraRearrangeResult>('camera_rearrange_luts', { order, names, experimental }), onProgress)
}

/** A settings backup taken before a change; `action` says which change (English, from Rust). */
export type CameraBackup = { id: string; model: string; firmware: string; created: number; action: string }
export const cameraListBackups = () => cameraCall<CameraBackup[]>('camera_list_backups')
/** Write a backup back to the same camera (serial, model and firmware must match). */
export function cameraRestoreBackup(id: string, onProgress?: (step: CameraProgress) => void): Promise<{ backup: string }> {
  return withProgress(() => cameraCall<{ backup: string }>('camera_restore_backup', { id }), onProgress)
}

// App updates (app only). Shapes match src-tauri/src/update.rs.
export type AppUpdate = { version: string; currentVersion: string; notes: string | null }
export type AppUpdateProgress = { downloaded: number; total: number | null }
/** Newer version announced by the update server, or null when up to date. */
export const appCheckUpdate = () => cameraCall<AppUpdate | null>('app_check_update')
/** Download, verify and install the update, then restart the app (does not return on success). */
export async function appInstallUpdate(onProgress?: (p: AppUpdateProgress) => void): Promise<void> {
  let unlisten: (() => void) | undefined
  if (onProgress) {
    const { listen } = await import('@tauri-apps/api/event')
    unlisten = await listen<AppUpdateProgress>('update-progress', event => onProgress(event.payload))
  }
  try {
    await cameraCall<void>('app_install_update')
  } finally {
    unlisten?.()
  }
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

// Photo sending (app only). Shapes match src-tauri/src/courier.rs.
export type CourierPhoto = { path: string; name: string; subfolder: string; modified: number | null }
export type CourierInfo = { make: string | null; model: string | null; lens: string | null; exposure: [number, number] | null; fNumber: number | null; focalLength: number | null; iso: number | null; taken: string | null }
export type CourierPreview = { width: number; height: number; info: CourierInfo; jpeg: Blob }
export type CourierErrorCode = 'courier_unreadable' | 'courier_unsupported' | 'courier_encode' | 'courier_read' | 'courier_write' | 'unsupported_platform' | 'internal'

export class CourierError extends Error {
  readonly code: CourierErrorCode
  constructor(code: CourierErrorCode, message: string) { super(message); this.code = code }
}

async function courierCall<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const app = tauri()
  if (!app) throw new CourierError('unsupported_platform', 'Photo sending needs the sosang app')
  try {
    return await app.invoke(cmd, args) as T
  } catch (e) {
    const err = e as { code?: CourierErrorCode; message?: string } | string
    if (typeof err === 'object' && err && err.code) throw new CourierError(err.code, err.message || err.code)
    throw new CourierError('internal', String(typeof err === 'object' ? err?.message : err))
  }
}

/** Folder picker; null when cancelled. */
export const courierPickFolder = () => courierCall<string | null>('courier_pick_folder')
/** JPG photos in a folder; `exclude` skips one folder tree (the destination inside the source). */
export const courierList = (folder: string, recursive: boolean, exclude: string | null) => courierCall<CourierPhoto[]>('courier_list', { folder, recursive, exclude })
/** Photos already in the destination folder. */
export const courierListSaved = (folder: string) => courierCall<CourierPhoto[]>('courier_list_saved', { folder })
/** Small upright JPEG for the list. */
export async function courierThumbnail(path: string): Promise<Blob> {
  const bytes = await courierCall<ArrayBuffer>('courier_thumbnail', { path })
  return new Blob([bytes], { type: 'image/jpeg' })
}
/** Upright preview at most `edge` pixels long, with the full upright size and capture details. */
export async function courierPreview(path: string, edge: number): Promise<CourierPreview> {
  const bytes = new Uint8Array(await courierCall<ArrayBuffer>('courier_preview', { path, edge }))
  const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as Omit<CourierPreview, 'jpeg'>
  return { ...header, jpeg: new Blob([bytes.subarray(4 + length)], { type: 'image/jpeg' }) }
}
/** Send one photo; returns the saved path. `webp` = WebP quality, null keeps JPG. */
export const courierExport = (source: string, destination: string, level: number, webp: number | null) => courierCall<string>('courier_export', { source, destination, level, webp })

/** Same value as `level_zoom` in crates/photo-courier: the enlargement that hides the corners a
 *  level rotation would expose. */
export function levelZoom(width: number, height: number, degrees: number): number {
  const angle = Math.max(-15, Math.min(15, degrees)) * Math.PI / 180
  return Math.abs(Math.cos(angle)) + Math.abs(Math.sin(angle)) * Math.max(width / height, height / width)
}
