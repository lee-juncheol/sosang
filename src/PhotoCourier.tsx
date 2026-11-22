import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Locale, Translate } from './i18n'
import { courierExport, CourierError, courierList, courierListSaved, courierPickFolder, courierPreview, levelZoom, type CourierInfo, type CourierPhoto } from './platform.ts'
import { folderName, formatExposure, formatLevel, requestThumbnail, roundLevel, sortPhotos, type SortOrder } from './courierUtils.ts'
import './photoCourier.css'
import { FeatureGuide } from './FeatureGuide'

const PREVIEW_EDGE = 2560
const SUBFOLDERS_KEY = 'sosang-send-subfolders'
const WEBP_KEY = 'sosang-send-webp'
const isMac = typeof navigator === 'object' && /Mac/i.test(navigator.platform || navigator.userAgent)
const SEND_KEYS = isMac ? '⌘Enter' : 'Ctrl+Enter'

function readSetting<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw) as T } catch { return fallback }
}
function writeSetting(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Settings are a convenience only. */ }
}

type Shown = { path: string; url: string; width: number; height: number; info: CourierInfo }
type Progress = { done: number; total: number }

function errorText(t: Translate, e: unknown, name: string): string {
  const code = e instanceof CourierError ? e.code : 'internal'
  switch (code) {
    case 'courier_unreadable': return t("사진을 읽을 수 없습니다. 손상되었거나 JPG가 아닙니다: {0}", [name])
    case 'courier_unsupported': return t("이 JPG 형식은 처리할 수 없습니다: {0}", [name])
    case 'courier_read': return t("파일이나 폴더를 읽을 수 없습니다: {0}", [name])
    case 'courier_write': return t("전송 폴더에 저장할 수 없습니다: {0}", [name])
    case 'courier_encode': return t("저장용 이미지를 만들지 못했습니다: {0}", [name])
    default: return t("처리 중 오류가 났습니다: {0}", [name])
  }
}

function FolderIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.4l2 2h8.6A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>
}
function CloseIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
}

function Thumb({ photo }: { photo: CourierPhoto }) {
  const box = useRef<HTMLSpanElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setUrl(null); setFailed(false)
    const element = box.current
    if (!element) return
    let cancel = () => {}
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return
      observer.disconnect()
      cancel = requestThumbnail(photo, next => next ? setUrl(next) : setFailed(true))
    }, { rootMargin: '300px 0px' })
    observer.observe(element)
    return () => { observer.disconnect(); cancel() }
  }, [photo])
  return <span ref={box} className={`courier-thumb${failed ? ' failed' : ''}`}>{url ? <img src={url} alt="" draggable={false}/> : <i>JPG</i>}</span>
}

export function PhotoCourier({ locale, t }: { locale: Locale; t: Translate }) {
  const [source, setSource] = useState<string | null>(null)
  const [destination, setDestination] = useState<string | null>(null)
  const [subfolders, setSubfolders] = useState(() => readSetting(SUBFOLDERS_KEY, true))
  const [photos, setPhotos] = useState<CourierPhoto[]>([])
  const [loading, setLoading] = useState(false)
  const [order, setOrder] = useState<SortOrder>('date')
  const [saved, setSaved] = useState<CourierPhoto[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [queue, setQueue] = useState<string[]>([])
  const [queueOpen, setQueueOpen] = useState(false)
  const [levels, setLevels] = useState<Record<string, number>>({})
  const [grid, setGrid] = useState(true)
  const [webp, setWebp] = useState<{ on: boolean; quality: 72 | 100 }>(() => readSetting(WEBP_KEY, { on: false, quality: 72 }))
  const [progress, setProgress] = useState<Progress | null>(null)
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [shown, setShown] = useState<Shown | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [box, setBox] = useState({ width: 0, height: 0 })
  const stage = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const loadId = useRef(0)

  const sorted = useMemo(() => sortPhotos(photos, order), [photos, order])
  const selectedIndex = selectedPath ? sorted.findIndex(p => p.path === selectedPath) : -1
  const selected = selectedIndex >= 0 ? sorted[selectedIndex] : null
  const byPath = useMemo(() => new Map(photos.map(p => [p.path, p])), [photos])
  const queued = useMemo(() => new Set(queue), [queue])
  const level = selected ? levels[selected.path] ?? 0 : 0

  useEffect(() => writeSetting(SUBFOLDERS_KEY, subfolders), [subfolders])
  useEffect(() => writeSetting(WEBP_KEY, webp), [webp])

  const loadSource = useCallback(async (folder: string, recursive: boolean, exclude: string | null) => {
    const id = ++loadId.current
    setLoading(true); setPhotos([]); setSelectedPath(null); setError('')
    setStatus(t("JPG 사진 목록을 읽는 중…"))
    try {
      const found = await courierList(folder, recursive, exclude)
      if (id !== loadId.current) return
      setPhotos(found)
      setStatus(found.length ? t("JPG {0}장 · ↑↓ 탐색, → 대기열 추가", [found.length]) : t("이 폴더에는 JPG 사진이 없습니다"))
    } catch (e) {
      if (id !== loadId.current) return
      setStatus(t("원본 폴더를 읽을 수 없습니다")); setError(errorText(t, e, folderName(folder)))
    } finally {
      if (id === loadId.current) setLoading(false)
    }
  }, [t])

  const loadSaved = useCallback(async (folder: string) => {
    try { setSaved(await courierListSaved(folder)) } catch (e) { setSaved([]); setError(errorText(t, e, folderName(folder))) }
  }, [t])

  useEffect(() => { if (source) void loadSource(source, subfolders, destination) }, [source, subfolders, destination, loadSource])
  useEffect(() => { if (destination) void loadSaved(destination) }, [destination, loadSaved])

  async function chooseSource() {
    if (sending) return
    try {
      const folder = await courierPickFolder()
      if (!folder) return
      if (folder !== source) { setQueue([]); setQueueOpen(false) }
      setSource(folder)
      if (folder === source) void loadSource(folder, subfolders, destination)
    } catch (e) { setError(errorText(t, e, '')) }
  }
  async function chooseDestination() {
    if (sending) return
    try {
      const folder = await courierPickFolder()
      if (folder) { setDestination(folder); if (folder === destination) void loadSaved(folder) }
    } catch (e) { setError(errorText(t, e, '')) }
  }

  const move = useCallback((delta: number) => {
    if (loading || !sorted.length) return
    const next = selectedIndex < 0 ? 0 : Math.min(Math.max(selectedIndex + delta, 0), sorted.length - 1)
    setSelectedPath(sorted[next].path)
  }, [loading, sorted, selectedIndex])

  const enqueue = useCallback(() => {
    if (sending || !selected || queued.has(selected.path)) return
    setQueue(q => [...q, selected.path]); setStatus(t("대기열에 추가: {0}", [selected.name]))
  }, [sending, selected, queued, t])
  const dequeue = useCallback(() => {
    if (sending || !selected || !queued.has(selected.path)) return
    setQueue(q => q.filter(p => p !== selected.path)); setStatus(t("대기열에서 뺐습니다: {0}", [selected.name]))
  }, [sending, selected, queued, t])

  const send = useCallback(async () => {
    if (sending || !queue.length || !destination) return
    const items = [...queue]
    setSending(true); setError(''); setProgress({ done: 0, total: items.length })
    let done = 0
    for (const path of items) {
      const name = byPath.get(path)?.name || folderName(path)
      setStatus(t("전송 중 · {0}/{1} · {2}", [done + 1, items.length, name]))
      try {
        await courierExport(path, destination, levels[path] ?? 0, webp.on ? webp.quality : null)
      } catch (e) {
        setError(errorText(t, e, name))
        setStatus(t("{0}장 완료 · 남은 {1}장은 다시 보낼 수 있습니다", [done, items.length - done]))
        break
      }
      done++
      setQueue(q => q.filter(p => p !== path))
      setProgress({ done, total: items.length })
    }
    if (done === items.length) setStatus(t("전송 완료 · {0}장", [done]))
    setSending(false)
    void loadSaved(destination)
  }, [sending, queue, destination, byPath, levels, webp, t, loadSaved])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); return }
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, select, textarea, [contenteditable="true"]'))) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const actions: Record<string, () => void> = { ArrowUp: () => move(-1), ArrowDown: () => move(1), ArrowRight: enqueue, ArrowLeft: dequeue }
      const action = actions[event.key]
      if (action) { event.preventDefault(); action() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [send, move, enqueue, dequeue])

  // Keep the selected row visible while stepping with the arrow keys.
  useEffect(() => {
    if (!selectedPath) return
    list.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(selectedPath)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selectedPath])

  // Preview: wait a moment while stepping quickly, then load the selected photo.
  useEffect(() => {
    setPreviewError('')
    if (!selected) return
    let live = true
    const path = selected.path, name = selected.name
    const timer = window.setTimeout(() => {
      courierPreview(path, PREVIEW_EDGE).then(preview => {
        if (!live) return
        const url = URL.createObjectURL(preview.jpeg)
        setPreviewError('')
        setShown(old => { if (old) URL.revokeObjectURL(old.url); return { path, url, width: preview.width, height: preview.height, info: preview.info } })
      }, e => { if (live) setPreviewError(errorText(t, e, name)) })
    }, 70)
    return () => { live = false; window.clearTimeout(timer) }
  }, [selected, t])
  const shownUrl = useRef('')
  useEffect(() => { shownUrl.current = shown?.url || '' }, [shown])
  useEffect(() => () => { if (shownUrl.current) URL.revokeObjectURL(shownUrl.current) }, [])

  useLayoutEffect(() => {
    const element = stage.current
    if (!element) return
    const observer = new ResizeObserver(() => setBox({ width: element.clientWidth, height: element.clientHeight }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // While the next photo loads the previous one stays up, to avoid flicker when stepping
  // quickly; once its preview has failed, the previous photo must not stand in for it.
  const visible = selected && shown && (shown.path === selected.path || !previewError) ? shown : null
  const frame = visible && box.width && box.height ? (() => {
    const aspect = visible.width / visible.height
    const width = Math.min(box.width, box.height * aspect)
    return { width: Math.floor(width), height: Math.floor(width / aspect) }
  })() : null
  const shownLevel = visible ? levels[visible.path] ?? 0 : 0
  const zoom = visible ? levelZoom(visible.width, visible.height, shownLevel) : 1
  const info = visible?.info
  const camera = [info?.model, info?.lens].filter(Boolean).join(' · ')
  const exposure = [info?.exposure ? formatExposure(info.exposure) : '', info?.fNumber ? `f/${Number(info.fNumber.toFixed(1))}` : '', info?.iso ? `ISO ${info.iso}` : '', info?.focalLength ? `${Math.round(info.focalLength)} mm` : ''].filter(Boolean).join('  ')

  function setLevel(value: number) {
    if (!selected || sending) return
    const next = roundLevel(value)
    setLevels(all => { const copy = { ...all }; if (next === 0) delete copy[selected.path]; else copy[selected.path] = next; return copy })
  }

  const percent = progress ? Math.round(progress.done / Math.max(1, progress.total) * 100) : 0

  return <section className="courier" aria-label={t("사진 보내기")}>
    <aside className="courier-side">
      <div className="courier-guide"><FeatureGuide guide="photo-sending" locale={locale} t={t}/></div>
      <div className="courier-card courier-source">
        <div className="courier-card-head">
          <div><h2>{t("원본 폴더")}</h2><p title={source || undefined}>{source ? folderName(source) : t("SD카드나 사진 폴더를 고르세요")}</p></div>
          <button className="courier-folder" onClick={chooseSource} disabled={sending}><FolderIcon/>{t("폴더 선택")}</button>
        </div>
        <div className="courier-options">
          <label className="courier-check"><input type="checkbox" checked={subfolders} disabled={sending} onChange={e => setSubfolders(e.target.checked)}/>{t("하위 폴더 포함")}</label>
          <div className="courier-segmented" role="group" aria-label={t("정렬")}>
            <button aria-pressed={order === 'date'} className={order === 'date' ? 'active' : ''} onClick={() => { setOrder('date'); setSelectedPath(null); list.current?.scrollTo({ top: 0 }) }}>{t("날짜순")}</button>
            <button aria-pressed={order === 'name'} className={order === 'name' ? 'active' : ''} onClick={() => { setOrder('name'); setSelectedPath(null); list.current?.scrollTo({ top: 0 }) }}>{t("이름순")}</button>
          </div>
        </div>
        <ul ref={list} className="courier-list" aria-label={t("원본 사진")}>
          {sorted.map(photo => <li key={photo.path} data-path={photo.path}>
            <button className={`courier-row${photo.path === selectedPath ? ' selected' : ''}`} aria-current={photo.path === selectedPath || undefined} onClick={event => { setSelectedPath(photo.path); event.currentTarget.blur() }}>
              <Thumb photo={photo}/>
              <span className="courier-row-text"><strong>{photo.name}</strong>{photo.subfolder && <small>{photo.subfolder}</small>}</span>
              <span className="courier-row-marks">{levels[photo.path] ? <em>{formatLevel(levels[photo.path])}</em> : null}{queued.has(photo.path) && <b title={t("전송 대기")}>{t("대기")}</b>}</span>
            </button>
          </li>)}
          {!loading && source && !sorted.length && <li className="courier-empty">{t("이 폴더에는 JPG 사진이 없습니다")}</li>}
          {loading && <li className="courier-empty">{t("읽는 중…")}</li>}
        </ul>
      </div>
      <div className="courier-card courier-destination">
        <div className="courier-card-head">
          <div><h2>{t("전송 폴더")}</h2><p title={destination || undefined}>{destination ? folderName(destination) : t("사진을 저장할 폴더를 고르세요")}</p></div>
          <button className="courier-folder" onClick={chooseDestination} disabled={sending}><FolderIcon/>{t("폴더 선택")}</button>
        </div>
        {destination && <ul className="courier-saved" aria-label={t("저장된 사진")}>
          {saved.length ? [...saved].sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0)).map(photo => <li key={photo.path}>{photo.name}</li>) : <li className="courier-empty">{t("아직 저장된 사진이 없습니다")}</li>}
        </ul>}
      </div>
    </aside>

    <div className="courier-center">
      <div className="courier-queue-bar">
        <button className="courier-queue-toggle" aria-expanded={queueOpen} onClick={() => setQueueOpen(v => !v)} disabled={!queue.length && !queueOpen}>
          {t("전송 대기")} <b>{queue.length}</b><span aria-hidden="true">{queueOpen ? '▴' : '▾'}</span>
        </button>
        <span className="courier-status" role="status">{status}</span>
      </div>
      {queueOpen && <div className="courier-queue">
        {queue.length ? <>
          <ul>{queue.map(path => { const photo = byPath.get(path); return <li key={path}>
            {photo && <Thumb photo={photo}/>}
            <span><strong>{photo?.name || folderName(path)}</strong>{levels[path] ? <small>{t("수평")} {formatLevel(levels[path])}</small> : null}</span>
            <button aria-label={t("대기 취소: {0}", [photo?.name || folderName(path)])} disabled={sending} onClick={() => setQueue(q => q.filter(p => p !== path))}><CloseIcon/></button>
          </li> })}</ul>
          <button className="courier-clear" disabled={sending} onClick={() => setQueue([])}>{t("모두 비우기")}</button>
        </> : <p>{t("→ 키로 선택한 사진을 대기열에 넣으세요")}</p>}
      </div>}
      <div ref={stage} className="courier-stage">
        {visible && frame ? <div className="courier-frame" style={{ width: frame.width, height: frame.height }}>
          <img src={visible.url} alt={selected?.name || ''} draggable={false} style={{ transform: shownLevel ? `rotate(${-shownLevel}deg) scale(${zoom})` : undefined }}/>
          {grid && shownLevel !== 0 && <div className="courier-grid" aria-hidden="true"/>}
        </div> : <p className="courier-placeholder">{source ? t("목록에서 사진을 고르세요") : t("왼쪽에서 원본 폴더를 먼저 고르세요")}</p>}
        {visible && (camera || exposure || info?.taken) && <div className="courier-exif">
          {camera && <span>{camera}</span>}{exposure && <span>{exposure}</span>}{info?.taken && <span>{info.taken.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1.$2.$3')}</span>}
        </div>}
        {previewError && <p className="courier-preview-error">{previewError}</p>}
      </div>
      <div className="courier-caption">{selected ? <><strong>{selected.name}</strong><span>{selectedIndex + 1} / {sorted.length}{visible ? ` · ${visible.width}×${visible.height}` : ''}</span></> : <span>{t("↑↓ 사진 선택 · → 대기열 추가 · ← 대기 취소 · {0} 전송", [SEND_KEYS])}</span>}</div>
    </div>

    <aside className="courier-panel">
      <div className="courier-card">
        <div className="courier-panel-head"><h2>{t("수평")}</h2>
          <button className="courier-level-value" disabled={!selected || !level || sending} onClick={() => setLevel(0)} title={t("0으로 되돌리기")}>{formatLevel(level)}</button>
        </div>
        <input className="courier-range" type="range" min={-15} max={15} step={0.1} value={level} disabled={!selected || sending} onChange={e => setLevel(Number(e.target.value))} aria-label={t("수평 회전 각도")} aria-valuetext={formatLevel(level)}/>
        <div className="courier-nudge">
          <button disabled={!selected || sending} onClick={() => setLevel(level - 0.1)} aria-label={t("시계 방향으로 0.1° 돌리기")}>−0.1°</button>
          <button disabled={!selected || sending} onClick={() => setLevel(level + 0.1)} aria-label={t("반시계 방향으로 0.1° 돌리기")}>+0.1°</button>
        </div>
        <label className="courier-check"><input type="checkbox" checked={grid} onChange={e => setGrid(e.target.checked)}/>{t("격자 보기")}</label>
        <p className="courier-note">{t("기울어진 수평선을 바로잡습니다. 빈 모서리가 생기지 않게 조금 확대하므로 가장자리가 잘립니다. 격자는 미리보기에만 보입니다.")}</p>
      </div>
      <div className="courier-card">
        <h2>{t("저장 형식")}</h2>
        <label className="courier-check"><input type="checkbox" checked={webp.on} disabled={sending} onChange={e => setWebp(w => ({ ...w, on: e.target.checked }))}/>{t("WebP로 변환")}</label>
        <div className="courier-segmented" role="group" aria-label={t("WebP 품질")}>
          {([72, 100] as const).map(q => <button key={q} disabled={!webp.on || sending} aria-pressed={webp.on && webp.quality === q} className={webp.on && webp.quality === q ? 'active' : ''} onClick={() => setWebp(w => ({ ...w, quality: q }))}>{q}%</button>)}
        </div>
        <p className="courier-note">{webp.on ? t("모든 사진을 WebP로 저장합니다. 100%는 가장 높은 손실 압축 품질이며 무손실은 아닙니다.") : t("수평을 바꾸지 않은 사진은 원본을 그대로 복사하고, 바꾼 사진은 원본 해상도의 JPG로 저장합니다.")}</p>
      </div>
      <div className="courier-card courier-send">
        {progress && <div className="courier-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}><span style={{ width: `${percent}%` }}/></div>}
        {progress && <p className="courier-progress-text">{t("{0} / {1}장 완료", [progress.done, progress.total])}</p>}
        <button className="courier-send-button" disabled={sending || !queue.length || !destination} onClick={() => void send()}>
          {sending ? t("보내는 중…") : t("보내기")}<kbd>{SEND_KEYS}</kbd>
        </button>
        {!destination && queue.length > 0 && <p className="courier-note">{t("전송 폴더를 먼저 고르세요")}</p>}
        {error && <p className="courier-error" role="alert">{error}</p>}
        <p className="courier-note">{t("원본 파일은 옮기거나 지우지 않습니다. 같은 이름이 있으면 파일명_1처럼 번호를 붙입니다.")}</p>
      </div>
    </aside>
  </section>
}
