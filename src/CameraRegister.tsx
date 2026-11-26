import { useEffect, useState } from 'react'
import type { Translate } from './i18n'
import { CameraError, cameraListLuts, cameraLutName, cameraRegister, cardFindSettings, cardListLuts, cardRegisterLuts, FIRST_USER_ENTRY, isApp, type CameraLibrary, type CameraProgress, type CameraRegisterResult, type CardFile, type CardLibrary } from './platform.ts'
import { CameraBusyOverlay } from './CameraBusyOverlay'
import './cameraRegister.css'

type Props = {
  t: Translate
  /** Download file name of the selected LUT; the default Library name. */
  filename: string
  format: 'std' | 'vlog' | 'zip'
  /** A file for the current selection exists and can be fetched. */
  ready: boolean
  getCube: () => Promise<string>
}

type Phase = 'idle' | 'reading' | 'registering'

/** A card settings file shown like a camera Library, so the same panel can register into it. */
function cardAsLibrary(card: CardLibrary): CameraLibrary {
  return {
    camera: { manufacturer: 'Panasonic', model: card.model, firmware: '', writeSupported: true, writeExperimental: false },
    entries: card.entries, freeSlots: card.freeSlots, selected: null, locked: [], reordered: false,
  }
}

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
    case 'unconfirmed': return t("쓰는 도중 카메라와 연결이 끊겨, 설정이 바뀌었는지 확인하지 못했습니다. 카메라를 다시 연결해 LUT 목록을 읽어 보고, 이상하면 LUT 관리의 백업으로 되돌려 주세요.")
    case 'reordered': return t("카메라 메뉴에서 순서를 바꾼 칸이라, 앱에서 쓰면 다른 LUT를 덮어쓰게 됩니다. 아무것도 쓰지 않았습니다. 빈 칸을 고르거나 카메라 메뉴에서 바꿔 주세요.")
    case 'card_io': return t("카드를 읽거나 쓰지 못했습니다. 카드가 연결되어 있고 쓰기 잠금이 꺼져 있는지 확인해 주세요.")
    case 'card_file': return t("카메라 설정 파일이 아닙니다.")
    case 'verify_failed': return t("쓰기 후 다시 읽은 내용이 보낸 내용과 다릅니다. 카메라의 LUT 라이브러리를 확인해 주세요.")
    default: return t("카메라와 통신하지 못했습니다. 케이블과 카메라 전원을 확인한 뒤 다시 시도해 주세요.")
  }
}

export function CameraRegister({ t, filename, format, ready, getCube }: Props) {
  const [library, setLibrary] = useState<CameraLibrary | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [step, setStep] = useState<CameraProgress | null>(null)
  const [slot, setSlot] = useState<number | null>(null)
  const [name, setName] = useState(() => cameraLutName(filename))
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)
  const [result, setResult] = useState<CameraRegisterResult | null>(null)
  const [error, setError] = useState<{ text: string; detail: string } | null>(null)
  /** Set while registering into a card settings file instead of the camera over USB. */
  const [card, setCard] = useState<{ files: CardFile[]; path: string } | null>(null)

  useEffect(() => { setName(cameraLutName(filename)); setResult(null) }, [filename])
  useEffect(() => { setConfirmOverwrite(false) }, [slot])

  if (!isApp()) return null

  const busy = phase !== 'idle'
  const fail = (e: unknown) => setError({ text: errorText(t, e), detail: e instanceof Error ? e.message : String(e) })

  function adopt(next: CameraLibrary) {
    setLibrary(next)
    setSlot(current => current !== null && next.entries[current] && (next.freeSlots.includes(current) || current >= FIRST_USER_ENTRY) ? current : next.freeSlots[0] ?? null)
  }

  /** Read the newest camera settings file on a connected card (or `path`). */
  async function readCard(path?: string) {
    setPhase('reading'); setError(null); setResult(null)
    try {
      const files = path && card ? card.files : (await cardFindSettings()).filter(f => !f.error)
      const chosen = path ?? files[0]?.path
      if (!chosen) {
        setCard(null); setLibrary(null)
        setError({ text: t("카드에서 카메라 설정 파일을 찾지 못했습니다. 카메라의 [카메라 설정을 저장/복원] → [저장]으로 설정을 카드에 저장한 뒤, 카드를 컴퓨터에 넣어 주세요."), detail: 'AD_LUMIX/CAMSET/*.DAT' })
        return
      }
      const next = await cardListLuts(chosen)
      setCard({ files, path: chosen })
      adopt(cardAsLibrary(next))
    } catch (e) { fail(e) }
    finally { setPhase('idle') }
  }

  async function readLibrary() {
    if (card) return readCard(card.path)
    setPhase('reading'); setError(null); setResult(null)
    try {
      const next = await cameraListLuts()
      adopt(next)
    } catch (e) { fail(e) }
    finally { setPhase('idle') }
  }

  const entry = library && slot !== null ? library.entries[slot] : undefined
  const overwrite = !!entry?.inUse
  const experimental = !!library && !library.camera.writeSupported && library.camera.writeExperimental
  // Any LUT goes to any Panasonic body: a STD LUT made for another model, a Fujifilm simulation
  // on the L10, or a body not yet verified (writes are backed up and checked either way).
  const blocked = format === 'zip' ? t("ZIP은 카메라에 등록할 수 없습니다. STD 또는 V-Log 형식을 골라 주세요.")
    : !ready ? t("이 조합은 등록할 파일이 없습니다.")
    : library && !library.camera.writeSupported && !experimental ? t("{0} 펌웨어 {1}에는 아직 등록할 수 없습니다. 목록 읽기만 할 수 있습니다.", [library.camera.model, library.camera.firmware])
    : ''

  async function register() {
    if (!library || slot === null || blocked || (overwrite && !confirmOverwrite)) return
    setPhase('registering'); setStep(null); setError(null); setResult(null)
    let cube: string
    try {
      cube = await getCube()
    } catch (e) {
      // Nothing reached the camera: the file itself could not be fetched, checked or built.
      setError({ text: t("등록할 LUT 파일을 준비하지 못해 카메라에는 아무것도 쓰지 않았습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요."), detail: e instanceof Error ? t(e.message) : String(e) })
      setPhase('idle')
      return
    }
    try {
      const done: CameraRegisterResult = card
        ? await cardRegisterLuts(card.path, [{ cube, slot, name: name.trim() }]).then(r => ({ index: r.registered[0].index, name: r.registered[0].name, backup: r.backup, otherChanges: 0 }))
        : await cameraRegister(cube, slot, name, overwrite, library.entries[slot]?.inUse ? library.entries[slot].name : null, experimental, setStep)
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

  const progress = card && phase === 'reading' ? t("카드의 설정 파일을 읽는 중…")
    : card && phase === 'registering' ? t("카드에 쓰는 중… 카드를 빼지 마세요.")
    : phase === 'reading' ? t("카메라의 LUT 목록을 읽는 중… (약 6초)")
    : step === 'writing' ? t("카메라에 쓰는 중… 케이블을 빼거나 카메라를 끄지 마세요.")
    : step === 'verifying' ? t("다시 읽어 확인하는 중…")
    : step === 'restoring' ? t("확인에 실패해 이전 설정으로 되돌리는 중… 케이블을 빼지 마세요.")
    : phase === 'registering' ? t("카메라 설정을 읽고 백업하는 중…")
    : ''
  const userEntries = library?.entries.filter(e => e.inUse && e.index >= FIRST_USER_ENTRY && !library.locked.includes(e.index)) ?? []

  return <section className="camera-register" aria-labelledby="camera-register-title" aria-busy={busy}>
    {phase === 'registering' && !card && <CameraBusyOverlay t={t} status={progress} step={step}/>}
    <div className="camera-register-heading">
      <h3 id="camera-register-title">{t("카메라에 바로 등록")}</h3>
      {library && <span>{card ? `${library.camera.model} · ${t("카드 설정 파일")}` : `${library.camera.model} · ${t("펌웨어 {0}", [library.camera.firmware])}`}</span>}
    </div>
    {!library ? <>
      <p className="camera-register-help">{t("USB로 연결한 LUMIX의 LUT 라이브러리에 SD 카드 없이 바로 넣습니다. 먼저 카메라의 목록을 읽습니다.")}</p>
      <button type="button" className="camera-register-secondary" disabled={busy} onClick={() => void readLibrary()}>{t("카메라 LUT 목록 읽기")}</button>
      <p className="camera-register-help">{t("USB 테더 연결이 없는 카메라(예: L10)는 카메라가 카드에 저장한 설정 파일에 넣고, 카메라에서 [로드]로 불러옵니다.")}</p>
      <button type="button" className="camera-register-secondary" disabled={busy} onClick={() => void readCard()}>{t("설정 파일에 바로 등록")}</button>
    </> : <>
      {card && card.files.length > 1 && <>
        <label className="output-label" htmlFor="camera-card-file">{t("카드의 설정 파일")}</label>
        <select id="camera-card-file" value={card.path} disabled={busy} onChange={e => void readCard(e.target.value)}>
          {card.files.map(f => <option key={f.path} value={f.path}>{`${f.file} · ${f.model}`}</option>)}
        </select>
      </>}
      {card && card.files.length === 1 && <p className="camera-register-help">{t("카드의 ‘{0}’에 등록합니다.", [card.files[0].file])}</p>}
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
      {blocked && <p className="camera-register-blocked">{blocked}</p>}
      <button type="button" className="camera-register-primary" disabled={busy || !!blocked || slot === null || !name.trim() || (overwrite && !confirmOverwrite)} onClick={() => void register()}>
        {phase === 'registering' ? t("등록 중…") : card ? t("설정 파일에 등록") : t("카메라에 등록 (약 25초)")}
      </button>
      <button type="button" className="camera-register-link" disabled={busy} onClick={() => void readLibrary()}>{t("목록 다시 읽기")}</button>
      <button type="button" className="camera-register-link" disabled={busy} onClick={() => { setCard(null); setLibrary(null); setResult(null); setError(null) }}>{card ? t("USB 연결로 바꾸기") : t("다른 방법 고르기")}</button>
    </>}
    <p className="camera-register-status" role="status" aria-live="polite">{progress}</p>
    {result && <div className="camera-register-done" role="status">
      {card ? <p>{t("설정 파일의 {0}번 칸에 ‘{1}’을 넣었습니다. 카드를 안전하게 꺼낸 뒤 카메라에서 [카메라 설정을 저장/복원] → [로드]로 불러오세요.", [result.index, result.name])}</p>
        : <p>{t("{0}번 칸에 ‘{1}’을 등록했습니다. 카메라 메뉴의 LUT 라이브러리에서 확인하세요.", [result.index, result.name])}</p>}
      <small>{card ? t("바꾸기 전 설정 파일 백업: {0}", [result.backup]) : t("등록 전 카메라 설정 백업: {0}", [result.backup])}</small>
    </div>}
    {error && <div className="camera-register-error" role="alert"><p>{error.text}</p><small>{error.detail}</small></div>}
  </section>
}
