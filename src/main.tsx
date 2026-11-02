import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Asset, Catalog, Combination, Sample, Stock } from './types'
import './style.css'

const paths: Record<string, React.ReactNode> = {
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
const stockColor = (stock: Stock) => stock.brand === 'Fujifilm' ? '#7cb79e' : stock.id.includes('vision') || stock.id.includes('verita') ? '#a5a3c5' : stock.id.includes('gold') || stock.id.includes('ektar') ? '#dda363' : '#cfb88c'

function FilmMark({ stock }: { stock: Stock }) {
  const iso = stock.name.match(/(?:^|[^0-9])(\d{2,3})(?:D|T|F|H)?\b/)?.[1] || '35'
  return <span className="film-mark" style={{ '--stock-color': stockColor(stock) } as React.CSSProperties}><span className="film-cap"/><span className="film-body"><span>{stock.brand === 'Kodak' ? 'K' : 'F'}</span><b>{iso}</b><i/></span></span>
}

function Preview({ sample, combo, mode }: { sample: Sample; combo: Combination; mode: 'compare' | 'look' }) {
  const [split, setSplit] = useState(50)
  const [loaded, setLoaded] = useState({ source: false, result: false })
  const [failed, setFailed] = useState(false)
  const result = combo.previews?.[sample.id]
  const available = combo.status === 'ready' && !!result
  const ready = loaded.source && (!available || loaded.result)
  return <div className={`preview ${mode}`} aria-busy={!ready && !failed}>
    <img className="preview-image" src={sample.path} alt={`${sample.name}: 기준 sRGB 이미지`} onLoad={() => setLoaded(s => ({ ...s, source: true }))} onError={() => setFailed(true)} />
    {available && <div className="result-image" style={{ clipPath: mode === 'compare' ? `inset(0 0 0 ${split}%)` : undefined }}><img className="preview-image" src={result.path} alt={`${sample.name}: 선택한 필름과 인화지 LUT 적용`} onLoad={() => setLoaded(s => ({ ...s, result: true }))} onError={() => setFailed(true)} /></div>}
    {ready && available && !failed && <>
      {mode === 'compare' && <><span className="image-tag before">기준 sRGB</span><div className="divider" style={{ left: `${split}%` }}><span>‹ ›</span></div><input className="comparison-range" type="range" min="0" max="100" value={split} onChange={e => setSplit(+e.target.value)} aria-label="이미지 비교 경계" aria-valuetext={`기준 이미지 ${split}%, 필름 적용 ${100 - split}%`} /></>}
      <span className="image-tag after"><i/> 필름 적용</span>
    </>}
    {(!ready || failed || !available) && <div className="preview-overlay"><Icon name={failed ? 'info' : available ? 'image' : 'film'} size={28}/><strong>{failed ? '이미지를 불러오지 못했습니다' : available ? '미리보기를 불러오는 중' : combo.status === 'unsupported' ? '이 조합은 아직 지원하지 않아요' : '아직 준비되지 않은 조합입니다'}</strong><p>{failed ? '네트워크 연결을 확인하고 샘플을 다시 선택해 주세요.' : !available ? combo.reason : '선택한 조합의 실제 LUT 적용 이미지를 가져옵니다.'}</p></div>}
  </div>
}

function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [filmId, setFilmId] = useState('kodak_portra_400')
  const [paperId, setPaperId] = useState('kodak_portra_endura')
  const [brand, setBrand] = useState('모두')
  const [search, setSearch] = useState('')
  const [sampleId, setSampleId] = useState('coffee')
  const [mode, setMode] = useState<'compare' | 'look'>('compare')
  const [format, setFormat] = useState<'vlog' | 'std' | 'zip'>('zip')
  const [downloading, setDownloading] = useState(false)
  const [notice, setNotice] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const controller = new AbortController()
    setLoadError('')
    fetch('/catalog.json', { signal: controller.signal }).then(async r => {
      if (!r.ok) throw new Error(`카탈로그를 불러올 수 없습니다 (${r.status})`)
      const data = await r.json() as Catalog
      if (data.schemaVersion !== 1 || !data.films.length || !data.papers.length || !data.combinations.length) throw new Error('지원하지 않는 카탈로그입니다.')
      setCatalog(data)
    }).catch(e => { if (e.name !== 'AbortError') setLoadError(e.message) })
    return () => controller.abort()
  }, [attempt])

  async function download(asset: Asset) {
    setDownloading(true); setNotice('')
    try {
      const response = await fetch(asset.path)
      if (!response.ok) throw new Error('파일을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.')
      const buffer = await response.arrayBuffer()
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))).map(n => n.toString(16).padStart(2, '0')).join('')
      if (digest !== asset.sha256 || buffer.byteLength !== asset.bytes) throw new Error('파일 검증에 실패했습니다. 페이지를 새로고침해 주세요.')
      const url = URL.createObjectURL(new Blob([buffer], { type: asset.name.endsWith('.zip') ? 'application/zip' : 'text/plain' }))
      const a = document.createElement('a'); a.href = url; a.download = asset.name; document.body.append(a); a.click(); a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setNotice(`${asset.name} · 검증된 파일을 다운로드했습니다.`)
    } catch (e) { setNotice(e instanceof Error ? e.message : '다운로드하지 못했습니다.') }
    finally { setDownloading(false) }
  }

  if (!catalog) return <main className="initial-state"><div className="brand-logo">F<span>↗</span></div><h1>Film Lab</h1><p role="status">{loadError || '필름 실험실을 준비하고 있습니다.'}</p>{loadError && <button onClick={() => setAttempt(n => n + 1)}>다시 불러오기</button>}</main>
  const film = catalog.films.find(f => f.id === filmId) || catalog.films[0]
  const paper = catalog.papers.find(p => p.id === paperId) || catalog.papers[0]
  const combo = catalog.combinations.find(c => c.film === film.id && c.paper === paper.id)!
  const sample = catalog.samples.find(s => s.id === sampleId) || catalog.samples[0]
  const selectedAsset = combo.files?.[format]
  const filtered = catalog.films.filter(f => (brand === '모두' || f.brand === brand) && f.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (a.id === 'kodak_portra_400' ? -1 : b.id === 'kodak_portra_400' ? 1 : a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name)))
  const formatName = format === 'vlog' ? 'V-Log' : format === 'std' ? 'Standard' : 'V-Log + Standard'
  function selectFilm(id: string) { setFilmId(id); setNotice('') }

  return <>
    <header className="topbar"><a className="brand-link" href="/" aria-label="Film Lab 홈"><div className="brand-logo">F<span>↗</span></div><span className="brand-word">film<span>lab</span><small>COLOR, YOUR WAY.</small></span></a><div className="topbar-right"><span className="camera-badge"><Icon name="camera" size={15}/> LUMIX S1M2</span><span className="version">BETA 0.1</span><button className="about-button" onClick={() => dialog.current?.showModal()}><Icon name="info" size={17}/><span>제작 정보</span></button></div></header>
    <main>
      <div className="intro"><div><span className="eyebrow">THE FILM & PAPER STUDIO</span><h1>당신의 다음 색.</h1><p>필름을 고르고, 인화지를 더하고. 나만의 룩을 카메라에 담아보세요.</p></div><div className="catalog-stat"><span className="live-dot"/>실제 엔진으로 생성한 <b>{catalog.counts.ready}개 조합</b><small>33³ LUT · sRGB 출력</small></div></div>
      <div className="workspace">
        <aside className="film-library" aria-label="필름 선택">
          <div className="section-label"><span><b>01</b> 필름 라이브러리</span><small>{catalog.films.length}</small></div>
          <label className="search-field"><Icon name="search" size={16}/><input placeholder="필름 검색" aria-label="필름 검색" value={search} onChange={e => setSearch(e.target.value)}/>{search && <button aria-label="검색 지우기" onClick={() => setSearch('')}><Icon name="close" size={14}/></button>}</label>
          <div className="brand-filters" aria-label="필름 브랜드">{['모두','Kodak','Fujifilm'].map(b => <button key={b} aria-pressed={brand === b} className={brand === b ? 'active' : ''} onClick={() => setBrand(b)}>{b}</button>)}</div>
          <div className="film-list">{filtered.length ? filtered.map(f => <button key={f.id} className={`film-option ${f.id === film.id ? 'selected' : ''}`} aria-pressed={f.id === film.id} onClick={() => selectFilm(f.id)}><FilmMark stock={f}/><span className="film-copy"><small>{f.brand.toUpperCase()}</small><strong>{shortName(f.name)}</strong><span>{f.type === 'positive' ? '슬라이드 · 미지원' : f.use === 'movie' ? '컬러 네거티브 · 시네마' : '컬러 네거티브'}</span></span>{f.id === film.id && <span className="selected-check"><Icon name="check" size={12}/></span>}</button>) : <div className="no-results">검색 결과가 없습니다.<button onClick={() => { setSearch(''); setBrand('모두') }}>모든 필름 보기</button></div>}</div>
          <div className="library-foot"><Icon name="film" size={16}/><span>프로파일 제공 <a href="https://github.com/andreavolpato/spektrafilm" target="_blank" rel="noreferrer">spektrafilm ↗</a></span></div>
        </aside>

        <section className="preview-panel" aria-label="룩 미리보기">
          <div className="preview-heading"><div><span className="eyebrow">YOUR SELECTED LOOK</span><h2>{shortName(film.name)} <span>×</span> {shortName(paper.name)}</h2></div><span className="look-number">LOOK {String(combo.number).padStart(3,'0')}</span></div>
          <div className="preview-toolbar"><span><i className={combo.status === 'ready' ? 'live-dot' : 'muted-dot'}/>{combo.status === 'ready' ? 'LUT 미리보기' : '미지원 / 미생성'}</span><div className="view-switch"><button title="비교 보기" aria-label="비교 보기" aria-pressed={mode === 'compare'} className={mode === 'compare' ? 'active' : ''} onClick={() => setMode('compare')}><Icon name="compare" size={16}/><span>비교</span></button><button title="적용 결과만 보기" aria-label="적용 결과만 보기" aria-pressed={mode === 'look'} className={mode === 'look' ? 'active' : ''} onClick={() => setMode('look')}><Icon name="image" size={16}/><span>적용</span></button></div></div>
          <Preview key={`${combo.id}-${sample.id}`} sample={sample} combo={combo} mode={mode}/>
          <div className="preview-caption"><span>{sample.category}</span><span>{combo.status !== 'ready' ? '준비된 네거티브 필름을 선택해 주세요' : mode === 'compare' ? '경계를 드래그해 비교하세요 ↔' : '선택한 LUT 적용 결과'}</span></div>
          <div className="samples-heading"><span className="section-label">샘플 이미지</span><span>같은 빛, 다른 표현</span></div>
          <div className="sample-grid">{catalog.samples.map(s => <button key={s.id} className={`sample-option ${sample.id === s.id ? 'selected' : ''}`} aria-pressed={sample.id === s.id} onClick={() => setSampleId(s.id)}><div><img src={s.path} alt="" loading="lazy"/>{sample.id === s.id && <span><Icon name="check" size={12}/></span>}</div><strong>{s.name}</strong></button>)}</div>
          <div className="preview-note"><Icon name="info" size={15}/><p>sRGB 샘플을 V-Log로 재인코딩한 뒤 LUT를 적용했습니다. 실촬영 V-Log·STD 비교가 아닙니다. <button onClick={() => dialog.current?.showModal()}>생성 방식 보기</button></p></div>
          <div className="sample-credit">{sample.credit}{sample.source && <a href={sample.source} target="_blank" rel="noreferrer">출처 <Icon name="external" size={10}/></a>}</div>
        </section>

        <aside className="recipe-panel" aria-label="인화지와 다운로드">
          <div className="paper-section"><div className="section-label"><span><b>02</b> 인화지 선택</span><small>{catalog.papers.length}</small></div><p className="section-description">필름의 색을 완성하는 마지막 단계</p>
            <div className="paper-list" role="radiogroup" aria-label="인화지">{catalog.papers.map(p => <label className={`paper-option ${p.id === paper.id ? 'selected' : ''}`} key={p.id}><input type="radio" name="paper" value={p.id} checked={p.id === paper.id} onChange={() => { setPaperId(p.id); setNotice('') }}/><span className="paper-radio"/><span><strong>{shortName(p.name)}</strong><small>{p.brand} {p.id === film.recommendedPrint && <em>권장 조합</em>}</small></span></label>)}</div>
          </div>
          <div className="export-section"><div className="section-label"><span><b>03</b> LUT 내보내기</span><Icon name="download" size={16}/></div><div className="export-spec"><span>출력 <b>sRGB</b></span><span>격자 <b>33 × 33 × 33</b></span></div><label className="output-label" htmlFor="output-format">카메라 입력 베이스</label><select id="output-format" value={format} onChange={e => { setFormat(e.target.value as typeof format); setNotice('') }}><option value="zip">V-Log + Standard (ZIP)</option><option value="vlog">V-Log / V-Gamut (.cube)</option><option value="std">Standard / sRGB (.cube)</option></select>
            <button className="download-button" disabled={!selectedAsset || combo.status !== 'ready' || downloading} onClick={() => selectedAsset && void download(selectedAsset)}><Icon name="download" size={18}/><span>{downloading ? '파일 검증 중…' : combo.status === 'ready' ? 'LUT 다운로드' : '다운로드 준비 전'}</span>{!downloading && <Icon name="arrow" size={17}/>}</button>
            <div className="download-meta">{selectedAsset ? <><span>{formatName}</span><span>{sizeLabel(selectedAsset.bytes)}</span></> : <span>{combo.status === 'unsupported' ? '이 조합은 지원하지 않습니다.' : '생성된 파일이 없습니다.'}</span>}</div>
            <p className="download-notice" role="status" aria-live="polite">{notice}</p>
            <div className="camera-notice"><span className="amber-dot"/><p>S1M2 실기 검증 전<strong>STD는 수식 기반 근사 변환입니다.</strong></p><button onClick={() => dialog.current?.showModal()} aria-label="검증 상세 보기"><Icon name="info" size={16}/></button></div>
          </div>
        </aside>
      </div>
      <footer className="page-footer"><span>Made for the way you see.</span><p>Derived from spektrafilm by Andrea Volpato · <a href="/licenses/SPEKTRAFILM_LICENSE.txt" target="_blank" rel="noreferrer">LUTs CC BY-SA 4.0</a></p><button onClick={() => dialog.current?.showModal()}>출처와 검증 <Icon name="external" size={12}/></button></footer>
    </main>

    <dialog ref={dialog} className="details-dialog" onClick={e => { if (e.target === dialog.current) dialog.current?.close() }}>
      <div className="dialog-inner"><div className="dialog-heading"><div><span className="eyebrow">BEHIND THE LOOK</span><h2>출처와 생성 정보</h2></div><button className="icon-button" onClick={() => dialog.current?.close()} aria-label="상세 정보 닫기"><Icon name="close"/></button></div>
      <p className="detail-intro">{film.name} + {paper.name}</p>
      <dl className="details-grid"><dt>엔진</dt><dd>spektrafilm {catalog.engineVersion}<code>{catalog.engineCommit}</code></dd><dt>V-Log 입력</dt><dd>Panasonic V-Log / V-Gamut</dd><dt>STD 입력</dt><dd>Standard/sRGB 수식 기반 근사 모델</dd><dt>출력</dt><dd>sRGB · 33³ · Full range 0–1</dd><dt>생성 상태</dt><dd>{combo.status === 'ready' ? '파일 검사 완료 · 보간 오차 측정 완료' : combo.reason}</dd><dt>실기 검증</dt><dd className="amber-text">S1M2 / S1II에서 아직 검증하지 않았습니다.</dd></dl>
      {combo.qa && <><h3>측정된 보간 오차</h3><p>출력 sRGB의 최대 채널 절대 오차. 4,350개 입력과 사면체 보간을 사용했습니다. 아래 수치는 카메라 색 정확도가 아닙니다.</p><table><thead><tr><th>비교</th><th>평균</th><th>99백분위</th><th>최대</th></tr></thead><tbody>{[['V-Log ↔ 직접 엔진',combo.qa.vlogVsDirectEngine.tetrahedral],['STD ↔ 연속 합성',combo.qa.stdVsContinuousComposition.tetrahedral]].map(([name,m]) => { const metric = m as { mean: number; p99: number; max: number }; return <tr key={String(name)}><td>{String(name)}</td><td>{metric.mean.toFixed(5)}</td><td>{metric.p99.toFixed(5)}</td><td>{metric.max.toFixed(5)}</td></tr> })}</tbody></table>{combo.qa.warnings.map(w => <p key={w} className="amber-text">{w}</p>)}</>}
      <h3>어떻게 만들었나요?</h3><p>spektrafilm의 기본 필름과 인화지 프로파일을 실제로 계산했습니다. 그레인·할레이션·블러·자동 노출을 끄고 픽셀별 색과 톤만 LUT에 담았습니다.</p><p>STD는 sRGB 디코딩 → V-Gamut 변환 → V-Log 인코딩을 V-Log LUT 앞에 합성했습니다. Panasonic Standard 내부 톤 곡선의 역변환이 아니며, 이미 손실된 하이라이트는 복원되지 않습니다.</p><h3>미리보기와 라이선스</h3><p>미리보기는 표시용 sRGB 이미지에 동일한 변환 경로를 적용한 예시입니다. 카메라 RAW나 실측 STD 이미지는 아닙니다. 샘플은 CC0/퍼블릭 도메인이며 사진별 출처를 화면 아래에 표시했습니다.</p><p>LUT는 Andrea Volpato의 spektrafilm 프로파일에서 파생했으며 CC BY-SA 4.0으로 제공합니다. Film Lab에서 LUT 생성·STD 합성을 수행했습니다. 공식 제휴 제품이 아닙니다.</p>
      <div className="detail-links"><a href="https://github.com/andreavolpato/spektrafilm" target="_blank" rel="noreferrer">원본 엔진 ↗</a><a href="/licenses/SPEKTRAFILM_LICENSE.txt" target="_blank" rel="noreferrer">LUT 라이선스 ↗</a>{combo.files && <><a href={combo.files.qa.path} target="_blank" rel="noreferrer">QA 보고서 ↗</a><a href={combo.files.provenance.path} target="_blank" rel="noreferrer">생성 설정 · 해시 ↗</a></>}</div>
      </div>
    </dialog>
  </>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>)
