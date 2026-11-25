import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Locale, Translate } from './i18n'
import { serverUrl } from './platform.ts'
import './lutUsageGuide.css'
import './featureGuide.css'
import './appPromo.css'

// Fixed-name installers on the GitHub release page (tag "app"); scripts/github-release.mjs overwrites them each release.
const RELEASE_PAGE = 'https://github.com/lee-juncheol/sosang/releases/tag/app'
const DOWNLOADS = {
  mac: 'https://github.com/lee-juncheol/sosang/releases/download/app/sosang-mac-apple-silicon.dmg',
  windows: 'https://github.com/lee-juncheol/sosang/releases/download/app/sosang-windows-x64-setup.exe',
}
type Guide = 'lut-manager' | 'photo-sending'
export const APP_PROMO_STORAGE_KEY = 'sosang-app-promo-seen'

// Storage errors (privacy modes) count as seen, so the layer never opens on every visit.
function promoSeen() { try { return window.localStorage.getItem(APP_PROMO_STORAGE_KEY) === '1' } catch { return true } }
function rememberPromo() { try { window.localStorage.setItem(APP_PROMO_STORAGE_KEY, '1') } catch { /* See promoSeen. */ } }

function visitorOs(): 'mac' | 'windows' | null {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/iPhone|iPad|Android/i.test(ua)) return null
  return /Windows/i.test(ua) ? 'windows' : /Macintosh|Mac OS X/i.test(ua) ? 'mac' : null
}

/** Website-only topbar button and layer that introduces the desktop app, with its how-to videos and download links. */
export function AppPromoButton({ locale, ready, t }: { locale: Locale; ready: boolean; t: Translate }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const titleId = useId()
  const [open, setOpen] = useState(false)
  const [guide, setGuide] = useState<Guide>('lut-manager')
  const [version, setVersion] = useState('')
  const os = visitorOs()

  function show() { if (!dialog.current || dialog.current.open) return; dialog.current.showModal(); setOpen(true); rememberPromo() }
  // First visit on a computer: open once by itself. If another layer (the one-time "what's new") is
  // already open, wait until it closes so the two never stack. Phones skip it: the app is desktop only.
  useEffect(() => {
    if (!ready || promoSeen() || window.matchMedia('(max-width: 650px)').matches) return
    let waiting: HTMLDialogElement | null = null
    const timer = window.setTimeout(() => {
      waiting = document.querySelector<HTMLDialogElement>('dialog[open]')
      if (waiting) waiting.addEventListener('close', show, { once: true })
      else show()
    }, 800)
    return () => { window.clearTimeout(timer); waiting?.removeEventListener('close', show) }
  }, [ready])
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous; video.current?.pause() }
  }, [open])
  useEffect(() => {
    if (!open || version) return
    const controller = new AbortController()
    fetch(serverUrl('/app/latest.json'), { signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (typeof data?.version === 'string' && /^\d+\.\d+\.\d+$/.test(data.version)) setVersion(data.version) })
      .catch(() => { /* The version line is optional. */ })
    return () => controller.abort()
  }, [open, version])
  useEffect(() => { if (open) void video.current?.play().catch(() => { /* Autoplay may be refused; controls stay usable. */ }) }, [open, guide, locale])

  const features: [string, string][] = [
    [t("카메라에 LUT 바로 넣기"), t("USB로 연결한 LUMIX 카메라에 SD 카드 없이 .cube LUT를 넣어요. 여러 개를 한 번에 넣고 지울 수 있어요.")],
    [t("스튜디오에서 바로 등록"), t("이 사이트와 같은 스튜디오가 앱 안에 있어요. 고른 필름 룩을 내려받지 않고 ‘카메라에 바로 등록’으로 넣어요.")],
    [t("순서 바꾸기와 백업"), t("카메라 메뉴의 LUT 순서를 바꾸고, 쓰기 전마다 백업해 두었다가 언제든 되돌려요.")],
    [t("사진 보내기"), t("SD 카드의 사진을 키보드로 빠르게 골라 수평을 맞추고, 원하는 폴더로 JPG·WebP로 보내요.")],
    [t("자동 업데이트"), t("새 버전이 나오면 앱이 알려 주고 스스로 업데이트해요.")],
  ]
  const videos: Record<Guide, { tab: string; label: string }> = {
    'lut-manager': { tab: t("LUT 관리"), label: t("카메라 LUT 목록을 읽고, 지우고, 위치를 바꾸고, .cube 파일을 넣는 과정을 보여 주는 영상") },
    'photo-sending': { tab: t("사진 보내기"), label: t("원본 폴더에서 사진을 골라 대기열에 넣고, 수평을 맞춰 전송 폴더로 보내는 과정을 보여 주는 영상") },
  }
  const downloads = [
    { id: 'mac' as const, name: 'macOS', detail: t("Apple Silicon (M1 이후) · DMG") },
    { id: 'windows' as const, name: 'Windows', detail: t("64비트 · 설치 파일") },
  ].sort((a, b) => (b.id === os ? 1 : 0) - (a.id === os ? 1 : 0))

  return <>
    <button type="button" className="about-button app-promo-button" aria-haspopup="dialog" aria-label={t("데스크톱 앱 받기")} onClick={show}>
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/></svg>
      <span>{t("앱 받기")}</span>
    </button>
    {createPortal(<dialog ref={dialog} className="usage-dialog feature-guide-dialog app-promo-dialog" aria-labelledby={titleId} onClose={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close() }}>
      <div className="usage-shell">
        <header className="usage-heading"><div><span className="eyebrow">{t("sosang 데스크톱 앱 · 무료")}</span><h2 id={titleId}>{t("만든 LUT를 카메라에 바로 넣으세요")}</h2></div><button className="usage-close" type="button" aria-label={t("닫기")} onClick={() => dialog.current?.close()}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
        <div className="usage-content">
          <div className="app-promo-tabs" role="tablist" aria-label={t("사용 영상")}>{(Object.keys(videos) as Guide[]).map(id => <button key={id} type="button" role="tab" aria-selected={guide === id} className={guide === id ? 'active' : ''} onClick={() => setGuide(id)}>{videos[id].tab}</button>)}</div>
          {open && <video ref={video} key={`${guide}-${locale}`} className="feature-guide-video" src={serverUrl(`/guides/${guide}-${locale}.mp4`)} poster={serverUrl(`/guides/${guide}-${locale}.jpg`)} width="1280" height="832" autoPlay muted loop playsInline controls preload="metadata" aria-label={videos[guide].label}/>}
          <ul className="app-promo-features">{features.map(([title, detail]) => <li key={title}><strong>{title}</strong><p>{detail}</p></li>)}</ul>
          <p className="feature-guide-note">{t("LUMIX S1II(DC-S1M2)에서 확인했어요. 카메라 USB 모드는 PC(Tether)로 두세요. 처음 열 때 macOS는 ‘시스템 설정 → 개인정보 보호 및 보안’에서 ‘그래도 열기’를, Windows는 SmartScreen 창에서 ‘추가 정보 → 실행’을 눌러 주세요. 아직 코드 서명과 공증을 하지 않아서 뜨는 안내예요.")}</p>
        </div>
        <footer className="app-promo-footer">
          <div className="app-promo-downloads">
            {downloads.map((item, index) => <a key={item.id} className={`app-promo-download${index === 0 && os ? ' primary' : ''}`} href={DOWNLOADS[item.id]} rel="noreferrer">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M5 20h14"/></svg>
              <span><strong>{t("{0}용 받기", [item.name])}</strong><small>{item.detail}</small></span>
            </a>)}
          </div>
          <p className="app-promo-meta">{version ? t("최신 버전 {0}", [version]) + ' · ' : ''}<a href={RELEASE_PAGE} target="_blank" rel="noreferrer">{t("릴리스 페이지 ↗")}</a></p>
        </footer>
      </div>
    </dialog>, document.body)}
  </>
}
