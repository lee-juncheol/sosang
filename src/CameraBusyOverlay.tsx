import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { Translate } from './i18n'
import type { CameraProgress } from './platform.ts'
import './cameraBusyOverlay.css'

/** Covers the app while camera settings are being written. Writing replaces the camera's
 *  whole settings file, so changes made on the camera during it would be undone. */
const ORDER = ['backup', 'writing', 'verifying'] as const

/** Backup → write → read back, from the backend's camera-progress events (null = backing up). */
function CameraSteps({ t, step }: { t: Translate; step: CameraProgress | null }) {
  const restoring = step === 'restoring'
  const at = step === 'writing' ? 1 : step === 'verifying' || restoring ? 2 : step === 'done' ? 3 : 0
  const labels = [t("백업"), t("쓰기"), restoring ? t("이전 설정 복구") : t("다시 읽어 확인")]
  return <ol className={`camera-steps${restoring ? ' restoring' : ''}`} aria-label={t("진행 단계")}>
    {ORDER.map((key, i) => <li key={key} className={i < at ? 'done' : i === at ? 'current' : ''} aria-current={i === at ? 'step' : undefined}><i aria-hidden="true"/>{labels[i]}</li>)}
  </ol>
}

export function CameraBusyOverlay({ t, status, step }: { t: Translate; status: string; step?: CameraProgress | null }) {
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
      {step !== undefined && <CameraSteps t={t} step={step}/>}
      <p className="camera-busy-status" role="status" aria-live="polite">{status}</p>
    </div>
  </div>, document.body)
}
