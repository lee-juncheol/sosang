import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Asset, Catalog, Combination, NegativeProcessMode, OfficialProcessMode, Sample, Stock } from './types'
import { fetchVerifiedAsset } from './assets'
import { PHOTO_ACCEPT, usePhotoLook, usePhotoUpload, useSamplePhoto } from './usePhoto'
import { findLook, processModeFor } from './lookSelection'
import { runtimeMessage, sampleText, useLocale, type Locale, type Translate } from './i18n'
import './style.css'

const paths: Record<string, React.ReactNode> = {
  upload: <><path d="M12 16V4m-5 5 5-5 5 5"/><path d="M4 16v5h16v-5"/></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5"/><path d="M5 16v5h14v-5"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/></>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  compare: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 2v20M4 15l4-4 4 4m0-2 4-4 4 5"/></>,
  image: <><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="10" r="1"/><path d="m4 17 5-4 3 2 4-6 5 7"/></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
  camera: <><path d="M3 7h4l2-3h6l2 3h4v14H3z"/><circle cx="12" cy="13" r="4"/></>,
  film: <><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 3v18M16 3v18M4 8h4m8 0h4M4 16h4m8 0h4"/></>,
  external: <><path d="M14 3h7v7m0-7L10 14"/><path d="M10 4H4v16h16v-6"/></>,
}
function Icon({ name, size = 18 }: { name: string; size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg> }
const shortName = (name: string) => name.replace(/^(Kodak|Fujifilm) (Professional )?/, '')
const sizeLabel = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`
function FilmMark({ stock }: { stock: Stock }) {
  return <span className={`film-mark ${stock.type}`} aria-hidden="true"><Icon name={stock.type === 'official' ? 'camera' : 'film'} size={18}/></span>
}

function Preview({ sample, combo, mode, resultPath, processingError, retry, lookLabel, locale, t }: { locale: Locale; t: Translate; sample: Sample; combo: Combination; mode: 'original' | 'compare' | 'look'; resultPath?: string; processingError?: string; retry?: () => void; lookLabel: string }) {
  const [split, setSplit] = useState(50)
  const [loaded, setLoaded] = useState({ source: false, result: false })
  const [failed, setFailed] = useState(false)
  const available = combo.status === 'ready'
  const showResult = available && mode !== 'original'
  const ready = loaded.source && (!showResult || loaded.result)
  const beforeLabel = sample.inputKind === 'camera-std' ? t("STD 원본 · LUT OFF") : sample.inputKind === 'uploaded-srgb' ? t("내 사진 · 원본") : t("기준 sRGB")
  const error = failed ? t("이미지를 불러오지 못했습니다. 다시 시도해 주세요.") : runtimeMessage(locale, processingError)
  const sampleName = sampleText(sample, 'name', locale)
  return <div className={`preview ${mode}`} aria-busy={!ready && !error}>
    <img className="preview-image" src={sample.path} alt={`${sampleName}: ${beforeLabel}`} onLoad={() => setLoaded(s => ({ ...s, source: true }))} onError={() => setFailed(true)} />
    {showResult && resultPath && <div className="result-image" style={{ clipPath: mode === 'compare' ? `inset(0 0 0 ${split}%)` : undefined }}><img className="preview-image" src={resultPath} alt={t("{0}: {1} STD LUT 적용", [sampleName, lookLabel])} onLoad={() => setLoaded(s => ({ ...s, result: true }))} onError={() => setFailed(true)} /></div>}
    {ready && available && !failed && <>
      {mode !== 'look' && <span className="image-tag before">{beforeLabel}</span>}
      {mode === 'compare' && <><div className="divider" style={{ left: `${split}%` }}><span>‹ ›</span></div><input className="comparison-range" type="range" min="0" max="100" value={split} onChange={e => setSplit(+e.target.value)} aria-label={t("이미지 비교 경계")} aria-valuetext={t("기준 이미지 {0}%, 필름 적용 {1}%", [split, 100 - split])} /></>}
      {showResult && <span className="image-tag after"><i/> {t("LUT 적용 · 100%")}</span>}
    </>}
    {(!ready || failed || (mode !== 'original' && (!available || error))) && <div className="preview-overlay"><Icon name={error ? 'info' : available ? 'image' : 'film'} size={28}/><strong>{error ? t("미리보기를 만들지 못했습니다") : available ? (sample.inputKind === 'uploaded-srgb' ? t("내 사진에 LUT를 적용하는 중") : combo.previewMode === 'runtime-std' ? t("샘플 사진에 LUT를 적용하는 중") : t("미리보기를 불러오는 중")) : combo.status === 'unsupported' ? t("이 조합은 아직 지원하지 않아요") : t("아직 준비되지 않은 조합입니다")}</strong><p>{error || (!available ? runtimeMessage(locale, combo.reason) : sample.inputKind === 'uploaded-srgb' ? t("사진은 내 기기 안에서만 처리합니다.") : combo.previewMode === 'runtime-std' ? t("다운로드와 동일한 STD LUT로 브라우저에서 계산합니다.") : t("선택한 조합의 실제 LUT 적용 이미지를 가져옵니다."))}</p>{error && retry && <button className="retry-button" onClick={retry}>{t("다시 시도")}</button>}</div>}
  </div>
}

function App() {
  const { locale, ready: localeReady, setLocale, t, message } = useLocale()
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [studioMode, setStudioMode] = useState<'model' | 'official'>('official')
  const [filmIds, setFilmIds] = useState({ model: 'kodak_portra_400', official: 'gfx_classic_chrome' })
  const [paperId, setPaperId] = useState('fujifilm_crystal_archive_typeii')
  const [negativeMode, setNegativeMode] = useState<NegativeProcessMode>('negative_print')
  const [officialMode, setOfficialMode] = useState<OfficialProcessMode>('official_print')
  const [brand, setBrand] = useState('모두')
  const [search, setSearch] = useState('')
  const [sampleId, setSampleId] = useState('std_playground')
  const [mode, setMode] = useState<'original' | 'compare' | 'look'>('compare')
  const [format, setFormat] = useState<'vlog' | 'std' | 'zip'>('std')
  const [downloading, setDownloading] = useState(false)
  const [notice, setNotice] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const filmLibrary = useRef<HTMLElement>(null)
  const previewPanel = useRef<HTMLElement>(null)
  const [dragging, setDragging] = useState(false)
  const upload = usePhotoUpload(() => { setSampleId('@upload'); setMode('compare') })
  const activePhoto = sampleId === '@upload' ? upload.photo : null
  const libraryFilms = catalog?.films.filter(f => studioMode === 'official' ? f.type === 'official' : f.type !== 'official') || []
  const selectedFilm = libraryFilms.find(f => f.id === filmIds[studioMode]) || libraryFilms[0]
  const selectedPaper = catalog?.papers.find(p => p.id === paperId) || catalog?.papers[0]
  const preference = studioMode === 'official' ? officialMode : negativeMode
  const processMode = selectedFilm ? processModeFor(selectedFilm, preference) : 'official_print'
  const activeCombo = catalog && selectedFilm && selectedPaper ? findLook(catalog.combinations, selectedFilm, selectedPaper.id, preference) : undefined
  const builtinSample = catalog?.samples.find(s => s.id === sampleId) || catalog?.samples[0] || null
  const runtimePreview = !!activePhoto || activeCombo?.previewMode === 'runtime-std'
  const samplePhoto = useSamplePhoto(!activePhoto && activeCombo?.previewMode === 'runtime-std' ? builtinSample : null)
  const photoLook = usePhotoLook(activePhoto || samplePhoto.photo, activeCombo?.status === 'ready' ? activeCombo.files?.std : undefined)
  const processingError = runtimePreview ? samplePhoto.error || photoLook.error : undefined
  const retryPreview = runtimePreview ? () => { if (samplePhoto.error) samplePhoto.retry(); else photoLook.retry() } : undefined

  useEffect(() => {
    const controller = new AbortController()
    setLoadError('')
    fetch('/catalog.json', { signal: controller.signal }).then(async r => {
      if (!r.ok) throw new Error(`카탈로그를 불러올 수 없습니다 (${r.status})`)
      const data = await r.json() as Catalog
      if (data.schemaVersion !== 2 || !data.films.length || !data.papers.length || !data.combinations.length) throw new Error('지원하지 않는 카탈로그입니다.')
      if (!data.films.some(f => f.type === 'official')) setStudioMode('model')
      const combinations = data.combinations.filter(c => c.processMode !== 'reference_interpretation')
      const counts = Object.fromEntries(Object.keys(data.counts).map(status => [status, combinations.filter(c => c.status === status).length]))
      setCatalog({ ...data, combinations, counts, referenceStudy: undefined })
    }).catch(e => { if (e.name !== 'AbortError') setLoadError(e instanceof SyntaxError ? '카탈로그 형식을 읽지 못했습니다. 다시 불러와 주세요.' : e.message) })
    return () => controller.abort()
  }, [attempt])

  async function download(asset: Asset) {
    setDownloading(true); setNotice('')
    try {
      const buffer = await fetchVerifiedAsset(asset)
      const url = URL.createObjectURL(new Blob([buffer], { type: asset.name.endsWith('.zip') ? 'application/zip' : 'text/plain' }))
      const a = document.createElement('a'); a.href = url; a.download = asset.name; document.body.append(a); a.click(); a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setNotice(`${asset.name} · 검증된 파일을 다운로드했습니다.`)
    } catch (e) { setNotice(e instanceof Error ? e.message : '다운로드하지 못했습니다.') }
    finally { setDownloading(false) }
  }

  if (!localeReady) return <main className="initial-state" aria-busy="true"><h1>filmlab<span className="brand-period">.</span></h1><p role="status">…</p></main>
  if (!catalog) return <main className="initial-state"><h1>filmlab<span className="brand-period">.</span></h1><p role="status">{message(loadError) || t("필름 실험실을 준비하고 있습니다.")}</p>{loadError && <button onClick={() => setAttempt(n => n + 1)}>{t("다시 불러오기")}</button>}</main>
  const film = selectedFilm!
  const paper = selectedPaper!
  const officialLook = catalog.fujiStudy?.looks.find(look => look.film === film.id)
  const isOfficial = film.type === 'official'
  const isSlide = film.type === 'positive'
  const isDigital = processMode !== 'negative_print' && processMode !== 'official_print'
  const isNegativeDigital = processMode === 'negative_digital'
  const combo: Combination = activeCombo || { id: `${film.id}__${processMode}`, film: film.id, paper: isDigital ? null : paper.id, processMode, number: 0, status: 'not-generated', reason: t("선택한 처리 방식의 LUT가 아직 준비되지 않았습니다.") }
  const processLabel = isOfficial ? (isDigital ? t("FUJIFILM 공식 LUT · 인화지 없음") : t("FUJIFILM 공식 LUT + {0}", [shortName(paper.name)])) : isSlide ? t("인화지 없음 · 슬라이드 직접 스캔") : isNegativeDigital ? t("Film Lab 디지털 변환 · 실험") : paper.name
  const referenceLabel = isOfficial ? t("공식 LUT 합성 계산") : isNegativeDigital ? t("디지털 변환 기준") : t("직접 엔진")
  const sample = activePhoto?.sample || builtinSample!
  const resultPath = runtimePreview ? photoLook.path : combo.previews?.[sample.id]?.path
  const selectedAsset = combo.files?.[format]
  const filtered = libraryFilms.filter(f => (brand === '모두' || f.brand === brand) && f.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (a.id === 'kodak_portra_400' ? -1 : b.id === 'kodak_portra_400' ? 1 : a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name)))
  const formatName = format === 'vlog' ? 'V-Log' : format === 'std' ? 'Standard' : 'V-Log + Standard'
  function selectFilm(id: string) { setFilmIds(ids => ({ ...ids, [studioMode]: id })); setNotice(''); if (window.matchMedia('(max-width: 650px)').matches) previewPanel.current?.scrollIntoView({ block: 'start' }) }
  function selectStudio(next: typeof studioMode) { setStudioMode(next); setBrand('모두'); setSearch(''); setNotice('') }

  return <>
    <header className="topbar"><a className="brand-link" href="/" aria-label={t("Film Lab 홈")}><span className="brand-word">filmlab<span className="brand-period">.</span></span><span className="brand-descriptor">{t("컬러 스튜디오")}</span></a><div className="topbar-right"><span className="privacy-badge"><span className="live-dot"/>{t("사진은 내 기기에만")}</span><div className="locale-switch" role="group" aria-label={t("언어 선택")}><button type="button" aria-label={t("한국어로 전환")} aria-pressed={locale === 'ko'} className={locale === 'ko' ? 'active' : ''} onClick={() => setLocale('ko')}>KO</button><button type="button" aria-label={t("영어로 전환")} aria-pressed={locale === 'en'} className={locale === 'en' ? 'active' : ''} onClick={() => setLocale('en')}>EN</button></div><button className="about-button" aria-label={t("제작 정보")} onClick={() => dialog.current?.showModal()}><Icon name="info" size={17}/><span>{t("제작 정보")}</span></button></div></header>
    <main>
      <div className="intro"><div><h1>{t("당신의 다음 색.")}</h1><p>{t("필름을 고르고, 인화지를 더하고, 내 사진으로 확인하세요.")}</p></div><div className="catalog-stat"><b>{catalog.counts.ready}</b><span>{t("가지 컬러 조합")}<small>33³ LUT · sRGB</small></span></div></div>
      <div className="studio-switch" role="group" aria-label={t("색상 모델 선택")}>
        {catalog.fujiStudy && <button className={studioMode === 'official' ? 'selected' : ''} aria-pressed={studioMode === 'official'} onClick={() => selectStudio('official')}><span>{t("FUJI 공식 LUT")}</span><small>{catalog.fujiStudy.looks.length}</small></button>}
        <button className={studioMode === 'model' ? 'selected' : ''} aria-pressed={studioMode === 'model'} onClick={() => selectStudio('model')}><span>{t("필름 & 인화지")}</span><small>{catalog.films.filter(f => f.type !== 'official').length}</small></button>
      </div>
      <div className="workspace">
        <aside id="film-library" className="film-library" ref={filmLibrary} tabIndex={-1} aria-label={t("필름 선택")}>
          <div className="section-label"><span>{isOfficial ? t("필름 시뮬레이션") : t("필름 라이브러리")}</span><small>{libraryFilms.length}</small></div>{isOfficial ? <p className="library-description">{t("GFX ETERNA 55 · Film Lab 합성")}</p> : null}
          <label className="search-field"><Icon name="search" size={16}/><input placeholder={t("필름 검색")} aria-label={t("필름 검색")} value={search} onChange={e => setSearch(e.target.value)}/>{search && <button aria-label={t("검색 지우기")} onClick={() => setSearch('')}><Icon name="close" size={14}/></button>}</label>
          {!isOfficial && <div className="brand-filters" aria-label={t("필름 브랜드")}>{['모두','Kodak','Fujifilm'].map(b => <button key={b} aria-pressed={brand === b} className={brand === b ? 'active' : ''} onClick={() => setBrand(b)}>{t(b)}</button>)}</div>}
          <div className="film-list">{filtered.length ? filtered.map(f => <button key={f.id} className={`film-option ${f.id === film.id ? 'selected' : ''}`} aria-pressed={f.id === film.id} onClick={() => selectFilm(f.id)}><FilmMark stock={f}/><span className="film-copy"><small>{f.brand.toUpperCase()}</small><strong>{shortName(f.name)}</strong><span>{isOfficial ? t("GFX 필름 시뮬레이션") : f.type === 'positive' ? t("슬라이드 · 직접 스캔") : f.use === 'movie' ? t("컬러 네거티브 · 시네마") : t("컬러 네거티브")}</span></span>{f.id === film.id && <span className="selected-check"><Icon name="check" size={12}/></span>}</button>) : <div className="no-results">{t("검색 결과가 없습니다.")}<button onClick={() => { setSearch(''); setBrand('모두') }}>{t("모든 필름 보기")}</button></div>}</div>
          <div className="library-foot"><Icon name="film" size={16}/>{isOfficial ? <span>{t("공식 배포처")} <a href={catalog.fujiStudy?.sourceUrl} target="_blank" rel="noreferrer">FUJIFILM ↗</a></span> : <span>{t("프로파일 제공")} <a href="https://github.com/andreavolpato/spektrafilm" target="_blank" rel="noreferrer">spektrafilm ↗</a></span>}</div>
        </aside>

        <section className="preview-panel" ref={previewPanel} aria-label={t("룩 미리보기")}>
          <div className="preview-heading"><div><span className="eyebrow">{isOfficial ? t("FUJIFILM 시뮬레이션") : film.brand.toUpperCase()}</span><h2>{shortName(film.name)}</h2><p className="selected-paper">{isDigital ? (isOfficial ? t("공식 LUT · 인화지 없음") : isSlide ? t("슬라이드 직접 스캔") : t("디지털 스캔 · 실험")) : `+ ${shortName(paper.name)}`}</p></div><button className="upload-button" disabled={upload.loading} onClick={() => fileInput.current?.click()}><Icon name="upload" size={16}/><span>{upload.loading ? t("읽는 중…") : upload.photo ? t("사진 바꾸기") : t("사진 업로드")}</span></button></div>
          <div className="preview-toolbar"><button className="film-jump" aria-controls="film-library" aria-label={t("필름 선택")} onClick={() => { filmLibrary.current?.focus({ preventScroll: true }); filmLibrary.current?.scrollIntoView({ block: 'start' }) }}>{t("필름 고르기")}<Icon name="chevron" size={13}/></button><span className="preview-status"><i className={combo.status === 'ready' ? 'live-dot' : 'muted-dot'}/>{combo.status === 'ready' ? t("JPG 톤 보호") : t("미지원 / 미생성")}</span><div className="view-switch"><button title={t("원본 보기")} aria-label={t("원본 보기")} aria-pressed={mode === 'original'} className={mode === 'original' ? 'active' : ''} onClick={() => setMode('original')}>{t("원본")}</button><button title={t("비교 보기")} aria-label={t("비교 보기")} aria-pressed={mode === 'compare'} className={mode === 'compare' ? 'active' : ''} onClick={() => setMode('compare')}><Icon name="compare" size={16}/>{t("비교")}</button><button title={t("적용 결과만 보기")} aria-label={t("적용 결과만 보기")} aria-pressed={mode === 'look'} className={mode === 'look' ? 'active' : ''} onClick={() => setMode('look')}>{t("적용")}</button></div></div>
          <Preview locale={locale} t={t} key={`${combo.id}-${sample.id}-${resultPath || processingError || 'pending'}`} sample={sample} combo={combo} mode={mode} resultPath={resultPath} processingError={processingError} retry={retryPreview} lookLabel={`${film.name} · ${processLabel}`}/>
          <div className="preview-caption"><span>{sampleText(sample, 'category', locale)}</span><span>{combo.status !== 'ready' ? t("선택한 룩의 준비 상태를 확인해 주세요") : mode === 'compare' ? t("경계를 드래그해 비교하세요 ↔") : mode === 'original' ? t("LUT 적용 전 원본") : t("다운로드용 STD LUT · 100% 적용")}</span></div>
          <div className={`photo-upload ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragging(true) }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false) }} onDrop={e => { e.preventDefault(); setDragging(false); const file = e.dataTransfer.files[0]; if (file) void upload.upload(file) }}>
            <input ref={fileInput} className="file-input" type="file" accept={PHOTO_ACCEPT} aria-label={t("사진 파일 선택")} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void upload.upload(file) }}/>
            <p className="upload-hint"><Icon name="upload" size={15}/><span>{t("여기에 사진을 놓아보세요")} <small>{t("JPG · PNG · WebP / 최대 30 MB · 기기 안에서 처리")}</small></span></p>
            {upload.photo && <div className="uploaded-photo"><button className={`uploaded-choice ${activePhoto ? 'selected' : ''}`} aria-pressed={!!activePhoto} onClick={() => setSampleId('@upload')}><img src={upload.photo.sample.path} alt=""/><span><strong>{upload.photo.sample.name}</strong><small>{upload.photo.originalWidth} × {upload.photo.originalHeight} {t("· 미리보기")} {upload.photo.sample.width} × {upload.photo.sample.height}</small></span>{activePhoto && <Icon name="check" size={15}/>}</button><button className="remove-photo" aria-label={t("업로드한 사진 제거")} onClick={() => { upload.clear(); if (activePhoto) setSampleId('std_playground') }}><Icon name="close" size={16}/></button></div>}
            <p className="upload-error" role="alert">{message(upload.error)}</p>
            <span className="sr-only" role="status">{upload.loading ? t("사진을 읽고 있습니다.") : upload.photo ? t("{0} 사진을 불러왔습니다.", [upload.photo.sample.name]) : ''}</span>
          </div>
          <div className="samples-heading"><span className="section-label">{t("샘플로 둘러보기")}</span><span>LUMIX S1M2 · STD</span></div>
          <div className="sample-grid">{catalog.samples.map(s => <button key={s.id} className={`sample-option ${sample.id === s.id ? 'selected' : ''}`} aria-pressed={sample.id === s.id} onClick={() => setSampleId(s.id)}><div><img src={s.path} alt="" loading="lazy"/>{sample.id === s.id && <span><Icon name="check" size={12}/></span>}</div><strong>{sampleText(s, 'name', locale)}</strong></button>)}</div>
          <div className="preview-note"><Icon name="info" size={15}/><p>{activePhoto ? t("내 사진에 STD LUT를 100% 적용합니다. 미리보기는 최대 2,048px입니다.") : sample.inputKind === 'synthetic-srgb' ? t("sRGB 테스트 패턴에 다운로드와 같은 STD LUT를 100% 적용합니다.") : t("Standard 원본에 다운로드와 같은 STD LUT를 100% 적용합니다.")} <button onClick={() => dialog.current?.showModal()}>{t("생성 방식")}</button></p></div>
          {isOfficial && catalog.fujiStudy && <details className="official-evidence"><summary>{t("FUJIFILM 공식 LUT · 출처와 합성 방식")} <Icon name="chevron" size={14}/></summary><div className="evidence-content"><p>{t("색상 변환에는 FUJIFILM이 {0}용으로 배포한 필름 시뮬레이션 LUT를 사용했습니다. 위 사진은 LUMIX STD 또는 업로드한 sRGB 사진에 적용한 결과입니다.", [catalog.fujiStudy.model])}</p><p>{t("JPG의 암부와 밝은 부분이 과도하게 변하지 않도록 Film Lab의 톤 보호를 적용합니다. 인화지를 켜면 spektrafilm의 인화·스캔 모델도 거칩니다. 완성된 결과는 Film Lab의 합성 룩이며, 실제 GFX 촬영 결과나 FUJIFILM의 공식 JPG·인화 레시피를 재현한 것은 아닙니다.")}</p><details><summary>{t("공식 다운로드 출처 · v")}{catalog.fujiStudy.packageVersion} {t("· 파일 정보")}</summary><article><a href={catalog.fujiStudy.sourceUrl} target="_blank" rel="noreferrer">{t("FUJIFILM 공식 LUT 다운로드 페이지 ↗")}</a><dl><dt>{t("대상")}</dt><dd>{catalog.fujiStudy.model}</dd><dt>{t("배포 버전")}</dt><dd>{catalog.fujiStudy.packageVersion}</dd><dt>{t("원본 LUT")}</dt><dd>{officialLook?.sourceFile || t("생성 설정에서 확인")}</dd><dt>LUT SHA-256</dt><dd><code>{officialLook?.sourceSha256}</code></dd><dt>{t("패키지 SHA-256")}</dt><dd><code>{catalog.fujiStudy.sourceSha256}</code></dd></dl></article></details><p className="reference-limit">{t("공식 LUT와 관련 데이터의 권리는 FUJIFILM에 있습니다. Film Lab의 입력·인화 변환과 FUJIFILM의 공식 LUT를 구분해 표시합니다.")}</p></div></details>}
          <div className="sample-credit">{sampleText(sample, 'credit', locale)}{sample.source && <a href={sample.source} target="_blank" rel="noreferrer">{t("출처")} <Icon name="external" size={10}/></a>}</div>
        </section>

        <aside className="recipe-panel" aria-label={t("처리 방식과 다운로드")}>
          <div className="paper-section"><div className="section-label"><span>{t("처리 방식")}</span><small>{isOfficial ? 'FUJI LUT' : isDigital ? 'SCAN' : 'PRINT'}</small></div>
            {isOfficial ? <fieldset className="process-switch"><legend className="sr-only">{t("공식 LUT 처리 방식")}</legend>
              <label className={`process-option ${isDigital ? 'selected' : ''}`}><input type="radio" name="official-mode" value="official_direct" aria-label={t("공식 LUT만")} checked={isDigital} onChange={() => { setOfficialMode('official_direct'); setNotice('') }}/><span>{t("공식 LUT만")}</span></label>
              <label className={`process-option ${!isDigital ? 'selected' : ''}`}><input type="radio" name="official-mode" value="official_print" aria-label={t("공식 LUT와 인화지")} checked={!isDigital} onChange={() => { setOfficialMode('official_print'); setNotice('') }}/><span>{t("공식 LUT + 인화지")}</span></label>
            </fieldset> : <fieldset className="process-switch"><legend className="sr-only">{t("처리 방식 선택")}</legend>
              <label className={`process-option ${!isDigital ? 'selected' : ''}`}><input type="radio" name="process-mode" value="negative_print" aria-label={t("인화지 인화")} disabled={isSlide} checked={!isDigital} onChange={() => { setNegativeMode('negative_print'); setNotice('') }}/><span>{t("인화지 인화")}</span></label>
              <label className={`process-option ${isDigital ? 'selected' : ''}`}><input type="radio" name="process-mode" value="digital_scan" aria-label={t("디지털 스캔")} checked={isDigital} onChange={() => { if (!isSlide) setNegativeMode('negative_digital'); setNotice('') }}/><span>{t("디지털 스캔")}</span></label>
            </fieldset>}
            {isDigital ? <div className={`direct-scan-note ${isNegativeDigital ? 'experimental-scan' : ''}`} role="status"><Icon name={isOfficial ? 'camera' : 'film'} size={22}/><strong>{processLabel}</strong><p>{isOfficial ? t("공식 LUT를 색상 기준으로 사용하고 JPG 톤을 보호합니다. 인화지를 더하지 않은 합성 결과를 비교해 보세요.") : isSlide ? t("슬라이드는 현상한 필름 자체를 스캔합니다. 인화지 프로파일은 적용하지 않습니다.") : t("인화지 없이 네거티브를 양화로 바꾸는 Film Lab의 실험 모드입니다. 모든 필름에 공통된 고정 변환을 사용하며, 사진별 자동 노출은 적용하지 않습니다.")}</p></div> : <p className="section-description">{t("인화지 · 프린트 필름")}</p>}
            <fieldset className="paper-fieldset" disabled={isDigital} aria-label={isDigital ? t("인화지·프린트 필름 선택 (직접 출력에서는 사용하지 않음)") : t("인화지·프린트 필름")}><div className="paper-list" role="radiogroup" aria-label={t("인화지·프린트 필름")}>{catalog.papers.map(p => <label className={`paper-option ${!isDigital && p.id === paper.id ? 'selected' : ''}`} key={p.id}><input type="radio" name="paper" value={p.id} checked={!isDigital && p.id === paper.id} onChange={() => { setPaperId(p.id); setNotice('') }}/><span className="paper-radio"/><span><strong>{shortName(p.name)}</strong><small>{/2383|2393/.test(p.id) ? t("영화용 프린트 필름") : p.brand} {!isDigital && p.id === film.recommendedPrint && <em>{isOfficial ? t("Film Lab 기본") : t("권장 조합")}</em>}</small></span></label>)}</div></fieldset>
            {!isDigital && <p className="paper-balance-note">{isOfficial ? t("인화지 모델의 색을 적용하면서 JPG의 암부와 밝은 부분을 보호합니다. 사진별 자동 노출은 사용하지 않습니다.") : t("중간 회색을 맞추는 인화 보정으로 같은 인화지의 필름 룩은 비슷해질 수 있습니다.")} <button onClick={() => dialog.current?.showModal()}>{t("생성 기준 보기")}</button></p>}
          </div>
          <div className="export-section"><div className="section-label"><span>{t("LUT 내보내기")}</span><Icon name="download" size={16}/></div><div className="export-spec"><span>{t("출력")} <b>sRGB</b></span><span>{t("격자")} <b>33 × 33 × 33</b></span></div><label className="output-label" htmlFor="output-format">{t("카메라 입력 베이스")}</label><select id="output-format" value={format} onChange={e => { setFormat(e.target.value as typeof format); setNotice('') }}><option value="zip">{isOfficial ? t("Standard + 실험 V-Log (ZIP)") : 'V-Log + Standard (ZIP)'}</option><option value="vlog">{isOfficial ? t("V-Log / V-Gamut · 실험 (.cube)") : 'V-Log / V-Gamut (.cube)'}</option><option value="std">Standard / sRGB (.cube)</option></select>
            <p className="export-process">{shortName(film.name)} <span>· {isDigital ? t("인화지 없음") : shortName(paper.name)}</span></p>{(isOfficial) && format !== 'std' && <p className="reference-export-note">{t("사진 비교는 STD 기준입니다. V-Log용은 별도 입력 변환을 거치며, 극단적인 색·노출에서 33³ 보간 오차가 더 큽니다. 생성 정보의 측정값을 확인해 주세요.")}</p>}
            <button className="download-button" aria-label={t("{0} LUT 다운로드", [processLabel])} disabled={!selectedAsset || combo.status !== 'ready' || downloading} onClick={() => selectedAsset && void download(selectedAsset)}><Icon name="download" size={18}/><span>{downloading ? t("파일 검증 중…") : combo.status === 'ready' ? t("LUT 다운로드") : t("다운로드 준비 전")}</span>{!downloading && <Icon name="arrow" size={17}/>}</button>
            <div className="download-meta">{selectedAsset ? <><span>{formatName}</span><span>{sizeLabel(selectedAsset.bytes)}</span></> : <span>{combo.status === 'unsupported' ? t("이 조합은 지원하지 않습니다.") : t("생성된 파일이 없습니다.")}</span>}</div>
            <p className="download-notice" role="status" aria-live="polite">{message(notice)}</p>
            <div className="camera-notice"><span className="amber-dot"/><p>{isOfficial ? t("GFX / S1M2 실기 검증 전") : t("S1M2 실기 검증 전")}<strong>{isOfficial ? t("Film Lab의 JPG·인화지 근사 변환") : t("STD는 수식 기반 근사 변환입니다.")}</strong></p><button onClick={() => dialog.current?.showModal()} aria-label={t("검증 상세 보기")}><Icon name="info" size={16}/></button></div>
          </div>
        </aside>
      </div>
      <footer className="page-footer"><span>filmlab. <small>{t("나만의 색을 찾아보세요.")}</small></span><p>{isOfficial ? <>{t("공식 LUT © FUJIFILM · 인화지 모델:")} <a href="https://github.com/andreavolpato/spektrafilm" target="_blank" rel="noreferrer">spektrafilm / Andrea Volpato</a></> : <>{t("Andrea Volpato의 spektrafilm에서 파생 ·")} <a href="/licenses/SPEKTRAFILM_LICENSE.txt" target="_blank" rel="noreferrer">LUTs CC BY-SA 4.0</a></>}</p><button onClick={() => dialog.current?.showModal()}>{t("출처와 검증")} <Icon name="external" size={12}/></button></footer>
    </main>

    <dialog ref={dialog} className="details-dialog" onClick={e => { if (e.target === dialog.current) dialog.current?.close() }}>
      <div className="dialog-inner"><div className="dialog-heading"><div><span className="eyebrow">{t("룩의 제작 과정")}</span><h2>{t("출처와 생성 정보")}</h2></div><button className="icon-button" onClick={() => dialog.current?.close()} aria-label={t("상세 정보 닫기")}><Icon name="close"/></button></div>
      <p className="detail-intro">{film.name} · {processLabel}</p>
      <dl className="details-grid"><dt>{t("기준 모델")}</dt><dd>{isOfficial ? <>FUJIFILM {catalog.fujiStudy?.model} · LUT v{catalog.fujiStudy?.packageVersion}<code>{catalog.fujiStudy?.methodId}</code></> : <>spektrafilm {catalog.engineVersion}<code>{catalog.engineCommit}</code></>}</dd><dt>{t("V-Log 입력")}</dt><dd>Panasonic V-Log / V-Gamut{(isOfficial) && t(" · 실험적 출력 · 색 경계의 보간 오차 검토 필요")}</dd><dt>{t("STD 입력")}</dt><dd>{isOfficial ? t("Standard/sRGB → 공통 PROVIA 입력 변환 → 공식 LUT·선택 인화 모델 → JPG 톤 보호") : t("Standard/sRGB 수식 근사 → 선택 모델 → JPG 톤 보호")}<code>{isOfficial ? catalog.fujiStudy?.methodId : catalog.adapter}</code></dd><dt>{t("STD 톤 / 노출")}</dt><dd>{t("Film Lab JPG 톤 보호 · 사진별 노출 조정 없음 · V-Log에는 미적용")}</dd><dt>{t("출력")}</dt><dd>{t("sRGB · 33³ · 전체 범위 0–1")}</dd><dt>{t("처리 방식")}</dt><dd>{isOfficial ? (isDigital ? t("공통 JPG 입력 변환 → FUJIFILM 공식 LUT → JPG 톤 보호 (인화지 없음)") : t("공통 JPG 입력 변환 → FUJIFILM 공식 LUT → spektrafilm 인화·스캔 → JPG 톤 보호")) : isSlide ? t("슬라이드 현상 → 필름 직접 스캔 → STD JPG 톤 보호 (인화지 없음)") : isNegativeDigital ? t("네거티브 현상 → Film Lab 양화 변환 → STD JPG 톤 보호 (실험 · 인화지 없음)") : t("네거티브 현상 → 인화지 인화 → 스캔 → STD JPG 톤 보호")}</dd><dt>{t("생성 상태")}</dt><dd>{combo.status === 'ready' ? t("파일 검사 완료 · 보간 오차 측정 완료") : message(combo.reason)}</dd><dt>{t("실기 검증")}</dt><dd className="amber-text">{isOfficial ? t("GFX ETERNA 55 및 S1M2의 실기 촬영과 대조하지 않았습니다.") : t("S1M2 / S1II에서 아직 검증하지 않았습니다.")}</dd></dl>
      {combo.qa && <><h3>{t("측정된 보간 오차")}</h3><p>{t("출력 sRGB의 최대 채널 절대 오차. 4,350개 입력과 사면체 보간을 사용했습니다. 선택한 모델과 STD의 JPG 톤 보호까지 포함한 기준 계산을 LUT가 얼마나 잘 근사하는지 측정하며, 실물 필름이나 카메라 색을 검증한 수치는 아닙니다.")}</p><table><thead><tr><th>{t("비교")}</th><th>{t("평균")}</th><th>{t("99백분위")}</th><th>{t("최대")}</th></tr></thead><tbody>{[[`V-Log ↔ ${referenceLabel}`,combo.qa.vlogVsDirectEngine.tetrahedral],...(combo.qa.stdVsDirectEngine ? [[t("STD ↔ JPG 보호 기준 계산"),combo.qa.stdVsDirectEngine.tetrahedral]] : [])].map(([name,m]) => { const metric = m as { mean: number; p99: number; max: number }; return <tr key={String(name)}><td>{String(name)}</td><td>{metric.mean.toFixed(5)}</td><td>{metric.p99.toFixed(5)}</td><td>{metric.max.toFixed(5)}</td></tr> })}</tbody></table>{combo.qa.warnings.map(w => <p key={w} className="amber-text">{message(w)}</p>)}</>}
      {isOfficial && <><h3>{t("공식 LUT와 Film Lab의 추가 계산")}</h3><p>{t("FUJIFILM이 배포한 GFX ETERNA 55 필름 시뮬레이션 LUT를 색상 변환에 사용합니다. 이 LUT는 F-Log2 / F-Gamut 입력용입니다. 완성된 JPG에 로그용 톤 처리를 그대로 겹치면 그림자가 과하게 어두워질 수 있어, PROVIA의 중성 회색 응답을 기준으로 역산한 공통 입력 변환을 먼저 적용합니다. 같은 입력 변환을 10종 모두에 사용하고, 선택한 룩의 출력에는 아래의 JPG 톤 보호를 추가합니다. 카메라 센서·화이트밸런스·영상 처리를 되돌리는 역변환은 아니며, 이미 사라진 디테일은 복원하지 않습니다. V-Log 입력에는 이 JPG 보상을 적용하지 않습니다. “공식 LUT만”의 STD에도 JPG 입력·출력 변환과 톤 보호가 포함됩니다. 원본 공식 LUT의 대비를 그대로 전달하는 파일이 아니라 Film Lab의 합성 LUT입니다.")}</p><p>{t("인화지 모드에서는 공식 LUT의 BT.709 / 감마 2.2 출력을 선형광으로 되돌린 후 spektrafilm의 인화지 현상·분광 스캔 모델을 적용합니다. 재료별 중성 노출 응답을 한 번 역산해, 검정·중간 회색·흰색을 부드럽게 연결하는 고정 톤 곡선을 사용합니다. 이 인화 모델의 출력에는 재료의 검정·흰색 한계와 염료에 따른 색 변화가 남습니다. STD에서는 이후 JPG 톤 보호가 암부와 밝은 부분을 다시 조정하므로 최종 결과의 검정·흰색과 중성 색조는 재료 모델 출력 그대로가 아닙니다. 인화 연결의 노출 응답은 사진이나 시뮬레이션마다 다시 맞추지 않습니다. 이 연결 방식은 Film Lab의 가상 프린터 가정이며 실측 인화 공정이나 FUJIFILM 공식 레시피가 아닙니다. 2383·2393은 영화용 프린트 필름입니다.")}</p><p>{t("디지털 필름 시뮬레이션을 기반으로 합니다. FUJIFILM 원본 LUT의 파일명·SHA-256과 배포 출처는 미리보기 아래에서 확인할 수 있습니다.")}</p></>}
      <><h3>{t("JPG 톤 보호 · BETA 0.6")}</h3><p>{t("이미 완성된 JPG에 필름·인화의 대비가 다시 겹쳐 어두운 부분이 뭉치거나, 디지털 스캔의 갈색 블랙이 남는 현상을 줄입니다. 원본 밝기와 각 룩의 고정 회색 응답을 기준으로 조정하며 사진별 노출·화이트밸런스·샤픈은 적용하지 않습니다. 샘플, 업로드 미리보기, 다운로드는 같은 STD LUT를 사용합니다. 원본 파일과 V-Log LUT에는 이 보호를 적용하지 않습니다.")}</p><details><summary>{t("톤 보호의 계산 기준과 한계")}</summary><p>{t("각 룩의 회색 4,097개를 계산한 고정 기준을 사용합니다. 인화·슬라이드·후지 모드는 모델의 중성 톤 변화 20%를 남기고, 네거티브 디지털 모드는 0%를 남깁니다. 이어 원본의 지각 밝기(OKLab L)에서 벗어나는 폭을 부드럽게 제한합니다. 20%는 LUT 적용 강도가 아니라 중성 톤을 보상하는 계수입니다.")}</p><p>{t("같은 입력 밝기의 중성 색편향을 제거하고, sRGB 밖의 색은 밝기·색상 방향을 유지하며 채도를 줄입니다. 따라서 필름·인화지와 공식 LUT의 대비·색편향을 그대로 보존한 결과는 아닙니다. 실제 카메라의 역변환이나 실측 인화 보정이 아닌 Film Lab의 JPG 표시 정책이며, 원본에서 이미 사라진 디테일은 되살릴 수 없습니다.")}</p><code>film-lab-jpg-tone-protection-v1</code></details></>
      {isNegativeDigital && <><h3>{t("디지털 스캔 기준")}</h3><p>{t("D50 조명과 가상 RGB 센서로 필름을 읽고, 필름 베이스의 색을 제거합니다. 필름마다 18.4% 회색 한 점을 기준으로 색과 밝기의 균형을 맞춘 뒤, 모든 필름에 공통된 톤 곡선으로 양화 변환합니다. 회색 기준 보정값은 필름마다 다르지만 사진마다 다시 계산하지 않습니다. 실측 스캐너 프로파일이 아닌 Film Lab의 고정된 실험적 해석입니다.")}</p></>}
      <h3>{t("기존 모델은 어떻게 만들었나요?")}</h3><p>{t("spektrafilm의 기본 프로파일을 계산합니다. 인화지 인화는 네거티브 필름과 인화지를 조합합니다. 슬라이드는 필름 자체를 직접 스캔합니다. 네거티브 디지털 스캔은 인화지를 거치지 않고 Film Lab의 고정 양화 변환을 적용하는 별도 실험 모드이며, 원본 엔진의 기본 인화 방식과 구분합니다. 그레인·할레이션·블러·사진별 자동 노출은 적용하지 않습니다.")}</p><p>{t("STD는 sRGB 33³ 격자를 선형광으로 디코딩하고 V-Gamut으로 변환한 뒤, 필름 계산과 선택한 출력 변환 및 JPG 톤 보호를 직접 실행해 생성합니다. 중간 V-Log LUT 격자를 거치지 않아 두 번 보간하던 오차를 줄였습니다. Panasonic Standard 내부 톤 곡선의 역변환이 아니며, 이미 손실된 하이라이트는 복원되지 않습니다.")}</p><p>{t("STD 입력은 기존과 같은 선형 배율 1.0배를 유지합니다. upstream sRGB LUT의 기본 입력 배율은 2.88배(약 +1.53 EV)이지만, 이를 추가 적용하지 않았습니다. 카메라 STD 렌더링의 기준 노출이 실측되지 않았으므로 두 설정의 밝기 차이를 정확도 우열로 해석하지 않습니다.")}</p><p>{t("인화지 인화 모드에서 같은 인화지를 사용하면 엔진의 필름별 중성 인화 필터와 중간 회색 기준 노출 정규화가 밝기·색편향을 맞춥니다. 그래서 필름별 차이가 작을 수 있습니다. 기존 모델의 STD에는 공통 JPG 톤 보호를 추가하며, 차이를 키우기 위해 필름 이름별 채도 값을 지정하지 않습니다. 실제 필름 촬영·현상·스캔 결과와의 일치는 별도 검증이 필요합니다.")}</p><h3>{t("내 사진 업로드")}</h3><p>{t("JPG·PNG·WebP 파일을 브라우저에서 읽고 sRGB로 처리합니다. 사진은 서버로 전송하거나 저장하지 않으며 페이지를 닫거나 새로고침하면 사라집니다. 미리보기는 긴 변 최대 2,048px이며 원본 파일은 변경하지 않습니다. 내 사진의 EXIF나 LUT OFF 여부는 자동 검증하지 않습니다. RAW·HEIC는 JPG로 변환해 주세요.")}</p><h3>{t("미리보기와 라이선스")}</h3><p>{t("촬영 샘플은 사용자 소유의 LUMIX S1M2 Standard 원본입니다. EXIF에서 Standard와 두 LUT의 강도 0을 확인했습니다. 다운로드용 STD LUT를 사면체 보간으로 직접 적용하며 추가 감마·V-Log 변환이나 강도 조절은 하지 않습니다. 웹 미리보기는 축소된 사진을 사용합니다. 브라우저에서 직접 계산한 결과는 PNG로 표시하고, 사전 생성 결과는 WebP로 제공합니다. 카메라 내부에서 LUT를 적용한 촬영 결과와의 일치 검증은 별도입니다.")}</p><p>{t("사용자 촬영 사진의 권리는 촬영자에게 있습니다. 사진에는 LUT의 CC BY-SA 라이선스가 적용되지 않습니다. 기술 테스트 패턴은 CC0입니다.")}</p><p>{t("기존 spektrafilm 모델의 LUT는 Andrea Volpato의 프로파일에서 파생했으며 CC BY-SA 4.0으로 제공합니다. Film Lab에서 LUT 생성과 STD 입력의 직접 계산을 수행했으며, 네거티브 디지털 모드에는 별도의 고정 양화 변환을 추가했습니다. FUJIFILM 공식 LUT와 그 관련 데이터는 FUJIFILM의 권리와 이용 조건을 따릅니다. 이를 포함하는 새 합성 LUT에 CC BY-SA 라이선스를 일괄 부여하지 않습니다. 인화지 모델의 spektrafilm 출처·라이선스 표기는 유지합니다. 공식 제휴 제품이 아닙니다.")}</p>
      <div className="detail-links"><a href="https://github.com/andreavolpato/spektrafilm" target="_blank" rel="noreferrer">{t("원본 엔진 ↗")}</a><a href="/licenses/SPEKTRAFILM_LICENSE.txt" target="_blank" rel="noreferrer">{t("spektrafilm 라이선스 ↗")}</a>{catalog.sourceCode && <a href={catalog.sourceCode.path} download>{t("Film Lab 소스 코드 · GPLv3 ↓")}</a>}{isOfficial && <a href={catalog.fujiStudy?.sourceUrl} target="_blank" rel="noreferrer">{t("FUJIFILM 공식 배포처 ↗")}</a>}{combo.files && <><a href={combo.files.qa.path} target="_blank" rel="noreferrer">{t("QA 보고서 ↗")}</a><a href={combo.files.provenance.path} target="_blank" rel="noreferrer">{t("생성 설정 · 해시 ↗")}</a></>}</div>
      </div>
    </dialog>
  </>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>)
