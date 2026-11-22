import { useEffect, useState } from 'react'
import type { Translate } from './i18n'
import { isApp } from './platform.ts'
import './appClosingNotice.css'

/** Desktop app only: the window was closed during a camera operation. The app finishes the
 *  operation and closes the camera's session before it quits (`app-closing` event). */
export function AppClosingNotice({ t }: { t: Translate }) {
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    if (!isApp()) return
    let unlisten: (() => void) | undefined
    let gone = false
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('app-closing', () => setClosing(true)))
      .then(stop => { if (gone) stop(); else unlisten = stop })
      .catch(() => {})
    return () => { gone = true; unlisten?.() }
  }, [])
  if (!closing) return null
  return <p className="app-closing-notice" role="status">{t("카메라 작업이 끝나면 앱이 닫힙니다.")}</p>
}
