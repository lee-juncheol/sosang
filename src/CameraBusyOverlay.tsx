import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { Translate } from './i18n'
import './cameraBusyOverlay.css'

/** Covers the app while camera settings are being written. Writing replaces the camera's
 *  whole settings file, so changes made on the camera during it would be undone. */
export function CameraBusyOverlay({ t, status }: { t: Translate; status: string }) {
  const card = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    card.current?.focus()
    return () => previous?.focus?.()
  }, [])
  return createPortal(<div className="camera-busy-overlay" role="presentation">
    <div ref={card} className="camera-busy-card" role="alertdialog" aria-modal="true" aria-labelledby="camera-busy-title" aria-describedby="camera-busy-text" tabIndex={-1}>
      <div className="camera-busy-spinner" aria-hidden="true"/>
      <h2 id="camera-busy-title">{t("카메라를 조작하지 마세요")}</h2>
      <p id="camera-busy-text">{t("카메라 설정 전체를 읽고 다시 쓰는 중입니다. 끝날 때까지 카메라의 버튼과 메뉴를 만지거나, 케이블을 빼거나, 전원을 끄지 마세요. 그 사이 카메라에서 바꾼 설정은 되돌아갑니다.")}</p>
      <p className="camera-busy-status" role="status" aria-live="polite">{status}</p>
    </div>
  </div>, document.body)
}
