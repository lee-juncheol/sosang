import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Locale, Translate } from './i18n'
import './lutUsageGuide.css'
import './featureGuide.css'
import { serverUrl } from './platform.ts'

type Guide = 'lut-manager' | 'photo-sending'

/** "사용방법" button that opens a layer with a short screen recording and the steps it shows.
 *  The recordings live on the sosang server under /guides/ (one per language). */
export function FeatureGuide({ guide, locale, t }: { guide: Guide; locale: Locale; t: Translate }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [open, setOpen] = useState(false)
  const titleId = useId()
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    void video.current?.play().catch(() => { /* Autoplay may be refused; the controls stay usable. */ })
    return () => { document.body.style.overflow = previous; video.current?.pause() }
  }, [open])

  const content = guide === 'lut-manager' ? {
    eyebrow: t("LUT 관리 · USB"),
    title: t("카메라 LUT 관리하는 법"),
    label: t("카메라 LUT 목록을 읽고, 지우고, 위치를 바꾸고, .cube 파일을 넣는 과정을 보여 주는 영상"),
    steps: [
      [t("카메라 연결"), t("카메라 USB 모드를 PC(Tether)로 두고 USB로 연결하세요. LUMIX Tether 앱은 꺼 주세요.")],
      [t("목록 읽기"), t("‘카메라 LUT 목록 읽기’를 누르면 약 6초 뒤 칸 번호와 이름이 나옵니다. 카메라에서 고른 LUT에는 ‘카메라에서 선택됨’이 붙고, 이 칸은 지울 수 없습니다.")],
      [t("지우기"), t("한 칸은 ‘삭제’로, 여러 칸은 왼쪽 칸을 체크한 뒤 아래에 나오는 확인 창으로 한 번에 지웁니다.")],
      [t("위치 바꾸기"), t("‘위치 바꾸기’를 누르고 줄을 끌어다 놓거나 ↑↓로 두 칸을 맞바꾼 뒤, ‘카메라에 적용’으로 한 번에 씁니다.")],
      [t("내 LUT 넣기"), t(".cube 파일을 끌어다 놓거나 ‘파일 고르기’로 고르면 빈 칸에 차례로 배정됩니다. ‘카메라에 넣기’로 씁니다.")],
      [t("백업과 되돌리기"), t("카메라에 쓸 때마다 그 전 설정을 이 컴퓨터에 백업합니다. ‘백업 목록 보기’에서 그 시점으로 되돌릴 수 있습니다.")],
    ],
    note: t("카메라에 쓰는 동안(약 25초)에는 카메라를 만지거나 케이블을 빼지 마세요."),
  } : {
    eyebrow: t("사진 보내기 · JPG"),
    title: t("사진 골라 보내는 법"),
    label: t("원본 폴더에서 사진을 골라 대기열에 넣고, 수평을 맞춰 전송 폴더로 보내는 과정을 보여 주는 영상"),
    steps: [
      [t("원본 폴더 고르기"), t("‘폴더 선택’으로 SD 카드나 사진 폴더를 고르세요. 하위 폴더까지 읽을지 정할 수 있습니다.")],
      [t("사진 고르기"), t("↑↓ 키로 사진을 넘겨 보고, → 키로 대기열에 넣습니다. ← 키는 대기를 취소합니다.")],
      [t("수평 맞추기"), t("기울어진 사진은 수평 슬라이더나 ± 버튼으로 0.1°씩 돌리세요. 격자를 켜면 맞추기 쉽습니다.")],
      [t("전송 폴더와 형식"), t("오른쪽에서 사진을 저장할 폴더를 고르고, 필요하면 WebP로 변환을 켜세요.")],
      [t("보내기"), t("‘보내기’를 누르거나 ⌘Enter(Windows는 Ctrl+Enter)로 대기열의 사진을 한 번에 보냅니다.")],
    ],
    note: t("원본 파일은 옮기거나 지우지 않습니다. 같은 이름이 있으면 파일명_1처럼 번호를 붙입니다."),
  }

  return <>
    <button className="usage-button" type="button" aria-haspopup="dialog" onClick={() => { dialog.current?.showModal(); setOpen(true) }}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/></svg>
      {t("사용방법")}
    </button>
    {createPortal(<dialog ref={dialog} className="usage-dialog feature-guide-dialog" aria-labelledby={titleId} onClose={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close() }}>
      <div className="usage-shell">
        <header className="usage-heading"><div><span className="eyebrow">{content.eyebrow}</span><h2 id={titleId}>{content.title}</h2></div><button className="usage-close" type="button" aria-label={t("사용방법 닫기")} onClick={() => dialog.current?.close()}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
        <div className="usage-content">
          {open && <video ref={video} key={locale} className="feature-guide-video" src={serverUrl(`/guides/${guide}-${locale}.mp4`)} poster={serverUrl(`/guides/${guide}-${locale}.jpg`)} width="1280" height="832" autoPlay muted loop playsInline controls preload="metadata" aria-label={content.label}/>}
          <ol className="feature-guide-steps">{content.steps.map(([title, detail], i) => <li key={title}><span>{i + 1}</span><div><strong>{title}</strong><p>{detail}</p></div></li>)}</ol>
          <p className="feature-guide-note">{content.note}</p>
        </div>
        <footer className="usage-footer"><span/><button type="button" onClick={() => dialog.current?.close()}>{t("확인")}</button></footer>
      </div>
    </dialog>, document.body)}
  </>
}
