import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { Locale, Translate } from './i18n'
import './lutUsageGuide.css'
import './whatsNew.css'
import { serverUrl } from './platform.ts'

// Bump when there is a new announcement; each visitor sees each version once.
export const WHATS_NEW_VERSION = '2026-11-print-std'
export const WHATS_NEW_STORAGE_KEY = 'film-lab-whats-new'

function alreadySeen() {
  try { return window.localStorage.getItem(WHATS_NEW_STORAGE_KEY) === WHATS_NEW_VERSION || window.localStorage.getItem(WHATS_NEW_STORAGE_KEY) === 'skip' } catch { return true }
}

/** One-time "what's new" layer with a short screen recording (first visit only). */
export function WhatsNew({ locale, ready, t }: { locale: Locale; ready: boolean; t: Translate }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    if (!ready || alreadySeen() || !dialog.current || dialog.current.open) return
    dialog.current.showModal()
  }, [ready])
  function remember() { try { window.localStorage.setItem(WHATS_NEW_STORAGE_KEY, WHATS_NEW_VERSION) } catch { /* Show again next time in privacy modes. */ } }
  return createPortal(<dialog ref={dialog} className="usage-dialog whats-new-dialog" aria-labelledby={titleId} onClose={remember} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close() }}>
    <div className="usage-shell">
      <header className="usage-heading"><div><span className="eyebrow">{t("업데이트 · 2026년 11월")}</span><h2 id={titleId}>{t("새로워진 점")}</h2></div><button className="usage-close" type="button" aria-label={t("업데이트 안내 닫기")} onClick={() => dialog.current?.close()}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
      <div className="usage-content">
        <video key={locale} className="whats-new-video" src={serverUrl(`/whats-new/2026-11-${locale}.mp4`)} poster={serverUrl(`/whats-new/2026-11-${locale}.jpg`)} width="960" height="800" autoPlay muted loop playsInline preload="metadata" aria-label={t("새 슬라이더와 STD 변환 개선을 보여 주는 짧은 영상")}/>
        <ul className="whats-new-list">
          <li><strong>{t("새 슬라이더 E · F")}</strong><p>{t("현상 방법 아래 ‘인화 미세 조정’에 E(인화 노출)와 F(페이드)가 생겼어요. E는 인화 단계에서 밝기를, F는 가장 어두운 검정을 올려 바랜 느낌을 줍니다. 미리보기와 다운로드 LUT에 바로 반영돼요.")}</p></li>
          <li><strong>{t("STD 변환 개선")}</strong><p>{t("카메라 Standard 사진을 V-Log로 바꾸는 변환의 하늘 구간을 다듬어, 맑은 하늘에 생기던 청록 띠를 없앴어요. 모든 카메라의 STD LUT에 적용됐으니 이전에 받은 STD LUT는 다시 받아 주세요.")}</p><p className="whats-new-credit">{t("이 문제를 찾고 확인하는 데 Reddit의 u/lifterzerothreefive 님이 제보와 테스트 사진으로 큰 도움을 주셨어요. 고맙습니다!")}</p></li>
        </ul>
      </div>
      <footer className="usage-footer"><span className="whats-new-note">{t("이 안내는 한 번만 표시됩니다.")}</span><button type="button" onClick={() => dialog.current?.close()}>{t("확인")}</button></footer>
    </div>
  </dialog>, document.body)
}
