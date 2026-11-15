import { useEffect, useState } from 'react'
import type { Translate } from './i18n'
import { appCheckUpdate, appInstallUpdate, CameraError, isApp, type AppUpdate, type AppUpdateProgress } from './platform.ts'
import './updateBanner.css'

const CHECK_DELAY_MS = 3000
const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)

/** Desktop app only: checks once after start-up and offers a newer version. Nothing is shown
 *  when the app is up to date or the server can't be reached. */
export function UpdateBanner({ t }: { t: Translate }) {
  const [update, setUpdate] = useState<AppUpdate | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<AppUpdateProgress | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isApp()) return
    const timer = window.setTimeout(() => { appCheckUpdate().then(setUpdate).catch(() => {}) }, CHECK_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [])

  if (!update || dismissed) return null

  async function install() {
    setInstalling(true); setError(''); setProgress(null)
    try {
      await appInstallUpdate(setProgress)
    } catch (e) {
      const code = e instanceof CameraError ? e.code : ''
      setError(code === 'busy' ? t("카메라 작업이 끝난 뒤 다시 시도해 주세요.") : t("업데이트를 설치하지 못했습니다. 잠시 뒤 다시 시도해 주세요."))
      setInstalling(false)
    }
  }

  const status = !installing ? ''
    : progress?.total ? t("내려받는 중… {0} / {1} MB", [mb(progress.downloaded), mb(progress.total)])
    : progress ? t("내려받는 중… {0} MB", [mb(progress.downloaded)])
    : t("업데이트를 준비하는 중…")

  return <div className="update-banner" role="region" aria-label={t("앱 업데이트")}>
    <p>
      <b>{t("새 버전 {0}이 나왔습니다.", [update.version])}</b>{' '}
      <span>{t("지금 버전은 {0}입니다. 설치하면 앱이 다시 시작됩니다.", [update.currentVersion])}</span>
    </p>
    <span className="update-banner-status" role="status" aria-live="polite">{error || status}</span>
    <span className="update-banner-actions">
      <button type="button" className="primary" disabled={installing} onClick={() => void install()}>{installing ? t("설치 중…") : t("업데이트하고 다시 시작")}</button>
      <button type="button" disabled={installing} onClick={() => setDismissed(true)}>{t("나중에")}</button>
    </span>
  </div>
}
