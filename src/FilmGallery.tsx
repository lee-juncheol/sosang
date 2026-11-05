import { useEffect, useRef, useState } from 'react'
import type { Catalog } from './types'
import type { Locale, Translate } from './i18n'
import { paperLabel } from './lutNames'
import './filmGallery.css'

export interface GalleryPhoto {
  id: string; sourceFilename: string; filmId: string; paperId: string | null; combinationId: string
  path: string; thumbnailPath: string; width: number; height: number; cameraId: string; cameraName: string; capturedAt: string
  exif: Record<string, string | number | null>; sourceSha256: string; preparedSha256: string
}
interface GalleryManifest {
  schemaVersion: 1; id: string; title: { ko: string; en: string }; cameraId: string; cameraName: string
  source: 'user-provided'; paperEvidence: 'user-confirmed-recommended'; items: GalleryPhoto[]
  counts: { photos: number; standardSamples: number; films: number }
}

const shortName = (name: string) => name.replace(/^(Kodak|Fujifilm) (Professional )?/, '')
const safePath = (path: unknown): path is string => typeof path === 'string' && path.startsWith('/gallery/') && !path.includes('..')

function GalleryImage({ photo, full, t }: { photo: GalleryPhoto; full?: boolean; t: Translate }) {
  const [failed, setFailed] = useState(false)
  return failed ? <span className="gallery-image-error" role="status">{t("사진을 불러오지 못했습니다.")}</span> : <img src={full ? photo.path : photo.thumbnailPath} alt={full ? photo.sourceFilename : ''} width={photo.width} height={photo.height} loading={full ? 'eager' : 'lazy'} decoding="async" onError={() => setFailed(true)}/>
}

export function FilmGallery({ catalog, locale, t, onUseLook }: { catalog: Catalog; locale: Locale; t: Translate; onUseLook: (photo: GalleryPhoto) => void }) {
  const [manifest, setManifest] = useState<GalleryManifest | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [filter, setFilter] = useState('all')
  const [activeId, setActiveId] = useState<string | null>(null)
  const lightbox = useRef<HTMLDialogElement>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  
  useEffect(() => {
    const controller = new AbortController()
    setError(false)
    fetch('/gallery/manifest.json', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Gallery unavailable')
      const data = await response.json() as GalleryManifest
      if (data.schemaVersion !== 1 || !Array.isArray(data.items) || !data.counts || data.items.some(item => !safePath(item.path) || !safePath(item.thumbnailPath) || !item.id || !catalog.films.some(film => film.id === item.filmId))) throw new Error('Invalid gallery')
      if (!controller.signal.aborted) setManifest(data)
    }).catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [attempt, catalog])

  const photos = manifest?.items || []
  const films = catalog.films.filter(film => photos.some(photo => photo.filmId === film.id))
  const visible = filter === 'all' ? photos : photos.filter(photo => photo.filmId === filter)
  const activeIndex = visible.findIndex(photo => photo.id === activeId)
  const active = visible[activeIndex]
  const activeFilm = catalog.films.find(film => film.id === active?.filmId)
  const paperName = (photo: GalleryPhoto) => {
    if (!photo.paperId) return t("인화지 없음 · 슬라이드 직접 스캔")
    const paper = catalog.papers.find(item => item.id === photo.paperId)
    return paper ? paperLabel(paper, true) : photo.paperId
  }

  useEffect(() => {
    const element = lightbox.current
    if (!element) return
    if (active && !element.open) element.showModal()
    if (!active && element.open) element.close()
    if (!active) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [active])

  function close() { lightbox.current?.close(); setActiveId(null); opener.current?.focus({ preventScroll: true }) }
  function move(delta: number) { if (visible.length) setActiveId(visible[(activeIndex + delta + visible.length) % visible.length].id) }
  const value = (key: string) => active?.exif[key] == null || active.exif[key] === '' ? '—' : String(active.exif[key])
  const aperture = (input: string) => input === '—' ? input : input.startsWith('f/') ? input : `f/${input}`
  const exposure = (input: string) => {
    const number = Number(input)
    return input === '—' ? input : number > 0 && number < 1 ? `1/${Math.round(1 / number)} s` : /s$/.test(input) ? input : `${input} s`
  }

  return <section className="film-gallery" aria-labelledby="gallery-title">
    <div className="gallery-intro"><h1 id="gallery-title">{t("LUT 적용 예제 갤러리")}</h1><div className="gallery-total"><b>{photos.length || '—'}</b><span>{t("장의 실촬영")}<small>{manifest?.cameraName || 'LUMIX S1II'}</small></span></div></div>
    {error ? <div className="gallery-state" role="alert"><h2>{t("갤러리를 불러오지 못했습니다.")}</h2><p>{t("연결을 확인하고 다시 시도해 주세요.")}</p><button onClick={() => setAttempt(number => number + 1)}>{t("다시 불러오기")}</button></div> : !manifest ? <div className="gallery-state" role="status" aria-busy="true">{t("사진을 불러오는 중…")}</div> : !photos.length ? <div className="gallery-state" role="status">{t("아직 등록된 갤러리 사진이 없습니다.")}</div> : <>
      <div className="gallery-filter-bar"><div className="gallery-filters" role="group" aria-label={t("갤러리 필름 필터")}><button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>{t("전체")}<small>{photos.length}</small></button>{films.map(film => <button key={film.id} aria-pressed={filter === film.id} onClick={() => setFilter(film.id)}>{shortName(film.name)}<small>{photos.filter(photo => photo.filmId === film.id).length}</small></button>)}</div><span className="gallery-count" role="status">{t("{0}장", [visible.length])}</span></div>
      <div className="gallery-grid">{visible.map((photo, index) => {
        const film = catalog.films.find(item => item.id === photo.filmId)!
        return <article className="gallery-card" key={photo.id}><button className="gallery-open" aria-label={t("{0} · {1} 크게 보기", [film.name, photo.sourceFilename])} onClick={event => { opener.current = event.currentTarget; setActiveId(photo.id) }}><span className="gallery-frame"><GalleryImage photo={photo} t={t}/><span className="gallery-expand" aria-hidden="true">↗</span></span><span className="gallery-card-caption"><span><strong>{shortName(film.name)}</strong><small>{photo.paperId ? `+ ${paperName(photo)}` : t("슬라이드 직접 스캔")}</small></span><span className="gallery-card-index">{String(index + 1).padStart(2, '0')}</span></span></button></article>
      })}</div>
      <div className="gallery-footnote"><p>{t("사진에는 촬영 시 LUT가 이미 적용되어 있습니다. 갤러리에서는 추가 변환 없이 표시하며, 실제 필름 촬영이나 실물 인화 결과가 아닙니다.")}</p><span>{t("사진 © 촬영자 · 무단 재사용 금지")}</span></div>
    </>}
    <dialog className="gallery-lightbox" ref={lightbox} aria-labelledby="gallery-photo-title" onCancel={event => { event.preventDefault(); close() }} onClose={() => setActiveId(null)} onClick={event => { if (event.target === lightbox.current) close() }} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1) } }}>
      {active && <div className="gallery-lightbox-inner"><div className="gallery-lightbox-top"><span>{t("LUT 적용 예제 갤러리")}<span>{activeIndex + 1} / {visible.length}</span></span><button className="gallery-close" autoFocus onClick={close} aria-label={t("사진 닫기")}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><div className="gallery-lightbox-body"><div className="gallery-lightbox-image"><GalleryImage key={active.id} photo={active} full t={t}/><button className="gallery-previous" onClick={() => move(-1)} aria-label={t("이전 사진")}>‹</button><button className="gallery-next" onClick={() => move(1)} aria-label={t("다음 사진")}>›</button></div><aside className="gallery-photo-info"><span className="eyebrow">{activeFilm?.brand.toUpperCase()}</span><h2 id="gallery-photo-title">{shortName(activeFilm?.name || active.filmId)}</h2><p className="gallery-photo-paper">{active.paperId ? `+ ${paperName(active)}` : paperName(active)}</p><span className="gallery-recipe-note">{active.paperId ? t("촬영자 확인 · 추천 인화지") : t("슬라이드 룩 · 인화지 미사용")}</span><button className="gallery-use-look" onClick={() => { close(); onUseLook(active) }}>{t("이 룩으로 내 사진 보기")}<span aria-hidden="true">↗</span></button><p className="gallery-use-note">{t("스튜디오에서 STD 원본에 이 조합을 적용합니다.")}</p><dl className="gallery-exif"><dt>{t("촬영 카메라")}</dt><dd>{active.cameraName}</dd><dt>{t("촬영 파일")}</dt><dd>{active.sourceFilename}</dd><dt>{t("촬영 일시")}</dt><dd>{active.capturedAt?.replace('T', ' ') || '—'}</dd><dt>{t("노출")}</dt><dd>{aperture(value('FNumber'))} · {exposure(value('ExposureTime'))}<br/>ISO {value('ISO')} · {value('ExposureCompensation')} EV</dd><dt>{t("렌즈")}</dt><dd>{value('LensModel')}</dd><dt>{t("화이트밸런스")}</dt><dd>{value('WhiteBalance') === 'Auto' ? t("자동") : value('WhiteBalance')}</dd><dt>{t("포토스타일")}</dt><dd>{value('PhotoStyle')}</dd><dt>LUT 1</dt><dd>{value('LUT1Name')}<small>{t("적용 강도")} {value('LUT1Opacity')}%</small></dd><dt>LUT 2</dt><dd>{value('LUT2Name') === '—' && Number(active.exif.LUT2Opacity) === 0 ? 'OFF' : value('LUT2Name')}</dd></dl><p className="gallery-exif-note">{t("필름 이름은 EXIF, 인화지 조합은 촬영자 확인을 근거로 표시합니다. 인화지 이름은 EXIF에 기록되지 않습니다.")}</p></aside></div></div>}
    </dialog>
  </section>
}
