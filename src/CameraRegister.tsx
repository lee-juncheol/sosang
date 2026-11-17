import { useEffect, useState } from 'react'
import type { Translate } from './i18n'
import { CameraError, cameraListLuts, cameraLutName, cameraRegister, FIRST_USER_ENTRY, isApp, type CameraLibrary, type CameraProgress, type CameraRegisterResult } from './platform.ts'
import { CameraBusyOverlay } from './CameraBusyOverlay'
import './cameraRegister.css'

type Props = {
  t: Translate
  /** Download file name of the selected LUT; the default Library name. */
  filename: string
  format: 'std' | 'vlog' | 'zip'
  /** A file for the current selection exists and can be fetched. */
  ready: boolean
  /** Model strings of the export camera (e.g. "DC-S1M2"); a STD LUT is only for that camera. */
  cameraAliases: readonly string[]
  cameraName: string
  getCube: () => Promise<string>
}

type Phase = 'idle' | 'reading' | 'registering'

export function errorText(t: Translate, error: unknown): string {
  const code = error instanceof CameraError ? error.code : 'internal'
  switch (code) {
    case 'no_camera': return t("카메라를 찾지 못했습니다. USB로 연결하고 카메라의 USB 모드를 PC(Tether)로 설정해 주세요.")
    case 'busy': return t("다른 카메라 작업이 진행 중입니다. 끝난 뒤 다시 시도해 주세요.")
    case 'not_verified': return t("이 카메라 기종이나 펌웨어에는 아직 등록할 수 없습니다.")
    case 'unsupported_model': return t("아직 지원하지 않는 카메라입니다.")
    case 'bad_cube': return t("이 LUT 파일은 카메라에 등록할 수 없는 형식입니다.")
    case 'bad_name': return t("이름은 영문, 숫자, 기호로 95자 이내여야 합니다.")
    case 'bad_slot': return t("선택한 칸에 등록할 수 없습니다. 목록을 다시 읽어 주세요.")
    case 'slot_changed': return t("목록을 읽은 뒤 카메라의 LUT가 바뀌었습니다. 아무것도 쓰지 않았습니다. 목록을 다시 읽어 주세요.")
    case 'other_camera': return t("이 백업은 다른 카메라나 다른 펌웨어에서 만든 것이라 되돌릴 수 없습니다.")
    case 'bad_backup': return t("백업 파일을 읽지 못했습니다.")
    case 'unknown_layout': return t("이 카메라의 설정 형식은 아직 읽을 수 없습니다. 지원하는 기종인지 확인해 주세요.")
    case 'rolled_back': return t("쓰기 후 확인에 실패해, 쓰기 전 카메라 설정으로 되돌렸습니다. 이 기종에서는 아직 등록이 잘 되지 않습니다.")
    case 'verify_failed': return t("쓰기 후 다시 읽은 내용이 보낸 내용과 다릅니다. 카메라의 LUT 라이브러리를 확인해 주세요.")
    default: return t("카메라와 통신하지 못했습니다. 케이블과 카메라 전원을 확인한 뒤 다시 시도해 주세요.")
  }
}

/** Shown for a Panasonic body whose model and firmware were not verified: writing needs the
 *  user's consent. */
export function ExperimentalConsent({ t, camera, checked, disabled, onChange, className }: { t: Translate; camera: CameraLibrary['camera']; checked: boolean; disabled: boolean; onChange: (on: boolean) => void; className: string }) {
  return <label className={className}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)}/>
    <span>{t("{0} 펌웨어 {1}은 아직 확인하지 않은 조합입니다. 실험적으로 쓰기를 허용합니다. 쓰기 전에 설정을 백업하고, 다시 읽어 확인에 실패하면 이전 설정으로 되돌립니다.", [camera.model, camera.firmware])}</span>
  </label>
}

export function CameraRegister({ t, filename, format, ready, cameraAliases, cameraName, getCube }: Props) {
  const [library, setLibrary] = useState<CameraLibrary | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [step, setStep] = useState<CameraProgress | null>(null)
  const [slot, setSlot] = useState<number | null>(null)
  const [name, setName] = useState(() => cameraLutName(filename))
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)
  const [experimentalOk, setExperimentalOk] = useState(false)
  const [result, setResult] = useState<CameraRegisterResult | null>(null)
  const [error, setError] = useState<{ text: string; detail: string } | null>(null)

  useEffect(() => { setName(cameraLutName(filename)); setResult(null) }, [filename])
  useEffect(() => { setConfirmOverwrite(false) }, [slot])

  if (!isApp()) return null

  const busy = phase !== 'idle'
  const fail = (e: unknown) => setError({ text: errorText(t, e), detail: e instanceof Error ? e.message : String(e) })

  async function readLibrary() {
    setPhase('reading'); setError(null); setResult(null)
    try {
      const next = await cameraListLuts()
      if (!library || library.camera.model !== next.camera.model || library.camera.firmware !== next.camera.firmware) setExperimentalOk(false)
      setLibrary(next)
      setSlot(current => current !== null && next.entries[current] && (next.freeSlots.includes(current) || current >= FIRST_USER_ENTRY) ? current : next.freeSlots[0] ?? null)
    } catch (e) { fail(e) }
    finally { setPhase('idle') }
  }

  const entry = library && slot !== null ? library.entries[slot] : undefined
  const overwrite = !!entry?.inUse
  const experimental = !!library && !library.camera.writeSupported && library.camera.writeExperimental
  const modelMismatch = !!library && format === 'std' && !cameraAliases.includes(library.camera.model)
  const blocked = format === 'zip' ? t("ZIP은 카메라에 등록할 수 없습니다. STD 또는 V-Log 형식을 골라 주세요.")
    : !ready ? t("이 조합은 등록할 파일이 없습니다.")
    : experimental && !experimentalOk ? t("확인하지 않은 기종이라, 아래에서 실험적 쓰기에 동의해야 등록할 수 있습니다.")
    : library && !library.camera.writeSupported && !experimental ? t("{0} 펌웨어 {1}에는 아직 등록할 수 없습니다. 목록 읽기만 할 수 있습니다.", [library.camera.model, library.camera.firmware])
    : modelMismatch ? t("선택한 카메라({0})와 연결된 카메라({1})가 다릅니다. LUT 내보내기에서 카메라를 바꿔 주세요.", [cameraName, library!.camera.model])
    : ''

  async function register() {
    if (!library || slot === null || blocked || (overwrite && !confirmOverwrite)) return
    setPhase('registering'); setStep(null); setError(null); setResult(null)
    try {
      const cube = await getCube()
      const done = await cameraRegister(cube, slot, name, overwrite, library.entries[slot]?.inUse ? library.entries[slot].name : null, experimental, setStep)
      setResult(done)
      const freeSlots = library.freeSlots.filter(s => s !== done.index)
      setLibrary({
        ...library,
        entries: library.entries.map(e => e.index === done.index ? { ...e, name: done.name, inUse: true } : e),
        freeSlots,
      })
      // Move on to the next empty slot so the panel does not offer to overwrite what was just added.
      setSlot(freeSlots[0] ?? null)
      setConfirmOverwrite(false)
    } catch (e) { fail(e) }
    finally { setPhase('idle'); setStep(null) }
  }

  const progress = phase === 'reading' ? t("카메라의 LUT 목록을 읽는 중… (약 6초)")
    : step === 'writing' ? t("카메라에 쓰는 중… 케이블을 빼거나 카메라를 끄지 마세요.")
    : step === 'verifying' ? t("다시 읽어 확인하는 중…")
    : step === 'restoring' ? t("확인에 실패해 이전 설정으로 되돌리는 중… 케이블을 빼지 마세요.")
    : phase === 'registering' ? t("카메라 설정을 읽고 백업하는 중…")
    : ''
  const userEntries = library?.entries.filter(e => e.inUse && e.index >= FIRST_USER_ENTRY) ?? []

  return <section className="camera-register" aria-labelledby="camera-register-title" aria-busy={busy}>
    {phase === 'registering' && <CameraBusyOverlay t={t} status={progress} step={step}/>}
    <div className="camera-register-heading">
      <h3 id="camera-register-title">{t("카메라에 바로 등록")}</h3>
      {library && <span>{library.camera.model} · {t("펌웨어 {0}", [library.camera.firmware])}</span>}
    </div>
    {!library ? <>
      <p className="camera-register-help">{t("USB로 연결한 LUMIX의 LUT 라이브러리에 SD 카드 없이 바로 넣습니다. 먼저 카메라의 목록을 읽습니다.")}</p>
      <button type="button" className="camera-register-secondary" disabled={busy} onClick={() => void readLibrary()}>{t("카메라 LUT 목록 읽기")}</button>
    </> : <>
      <label className="output-label" htmlFor="camera-slot">{t("등록할 칸")}</label>
      <select id="camera-slot" value={slot ?? ''} disabled={busy} onChange={e => setSlot(e.target.value === '' ? null : Number(e.target.value))}>
        {!library.freeSlots.length && slot === null && <option value="">{t("빈 칸이 없습니다")}</option>}
        {library.freeSlots.length > 0 && <optgroup label={t("빈 칸")}>{library.freeSlots.map(index => <option key={index} value={index}>{t("{0}번 · 빈 칸", [index])}</option>)}</optgroup>}
        {userEntries.length > 0 && <optgroup label={t("덮어쓰기")}>{userEntries.map(e => <option key={e.index} value={e.index}>{t("{0}번 · {1}", [e.index, e.name])}</option>)}</optgroup>}
      </select>
      <label className="output-label" htmlFor="camera-lut-name">{t("카메라에 표시할 이름")}</label>
      <input id="camera-lut-name" className="camera-register-name" value={name} maxLength={95} disabled={busy} spellCheck={false}
        onChange={e => setName(e.target.value.replace(/[^\x20-\x7e]/g, ''))}/>
      {overwrite && <label className="camera-register-confirm"><input type="checkbox" checked={confirmOverwrite} disabled={busy} onChange={e => setConfirmOverwrite(e.target.checked)}/>
        <span>{t("{0}번 칸의 ‘{1}’을 지우고 덮어씁니다.", [entry!.index, entry!.name])}</span></label>}
      {experimental && <ExperimentalConsent t={t} camera={library.camera} checked={experimentalOk} disabled={busy} onChange={setExperimentalOk} className="camera-register-confirm"/>}
      {blocked && <p className="camera-register-blocked">{blocked}</p>}
      <button type="button" className="camera-register-primary" disabled={busy || !!blocked || slot === null || !name.trim() || (overwrite && !confirmOverwrite)} onClick={() => void register()}>
        {phase === 'registering' ? t("등록 중…") : t("카메라에 등록 (약 25초)")}
      </button>
      <button type="button" className="camera-register-link" disabled={busy} onClick={() => void readLibrary()}>{t("목록 다시 읽기")}</button>
    </>}
    <p className="camera-register-status" role="status" aria-live="polite">{progress}</p>
    {result && <div className="camera-register-done" role="status">
      <p>{t("{0}번 칸에 ‘{1}’을 등록했습니다. 카메라 메뉴의 LUT 라이브러리에서 확인하세요.", [result.index, result.name])}</p>
      <small>{t("등록 전 카메라 설정 백업: {0}", [result.backup])}</small>
    </div>}
    {error && <div className="camera-register-error" role="alert"><p>{error.text}</p><small>{error.detail}</small></div>}
  </section>
}
