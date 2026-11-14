import { useRef, useState } from 'react'
import type { Translate } from './i18n'
import { errorText } from './CameraRegister'
import { cameraDelete, cameraListLuts, cameraLutName, cameraRegister, cubeSummary, FIRST_USER_ENTRY, type CameraEntry, type CameraLibrary, type CameraProgress } from './platform.ts'
import './lutManager.css'

type Busy = null | { kind: 'reading' } | { kind: 'deleting'; index: number } | { kind: 'adding'; index: number }
type Done = { kind: 'deleted' | 'added'; index: number; name: string; backup: string }
type PickedFile = { fileName: string; text: string; size: number | null; style: string | null }

const MAX_CUBE_BYTES = 8 * 1024 * 1024

function styleLabel(t: Translate, code: number): string {
  switch (code) {
    case 0: return 'STD'
    case 49: return 'V-Log'
    case 37: return 'ARRI 709'
    case 10: return 'V-Log → 709'
    default: return t("기타 ({0})", [code])
  }
}

export function LutManager({ t }: { t: Translate }) {
  const [library, setLibrary] = useState<CameraLibrary | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [step, setStep] = useState<CameraProgress | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const [picked, setPicked] = useState<PickedFile | null>(null)
  const [fileError, setFileError] = useState('')
  const [slot, setSlot] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)
  const [done, setDone] = useState<Done | null>(null)
  const [error, setError] = useState<{ text: string; detail: string } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const fail = (e: unknown) => setError({ text: errorText(t, e), detail: e instanceof Error ? e.message : String(e) })

  async function read() {
    setBusy({ kind: 'reading' }); setError(null); setDone(null); setConfirmDelete(null)
    try {
      const next = await cameraListLuts()
      setLibrary(next)
      setSlot(current => current !== null && current >= FIRST_USER_ENTRY && current < next.entries.length ? current : next.freeSlots[0] ?? null)
    } catch (e) { fail(e) }
    finally { setBusy(null) }
  }

  async function remove(entry: CameraEntry) {
    if (!library) return
    setBusy({ kind: 'deleting', index: entry.index }); setStep(null); setError(null); setDone(null); setConfirmDelete(null)
    try {
      const result = await cameraDelete(entry.index, setStep)
      setDone({ kind: 'deleted', index: result.index, name: result.name, backup: result.backup })
      setLibrary({
        ...library,
        entries: library.entries.map(e => e.index === entry.index ? { ...e, name: '', inUse: false, styleCode: 49 } : e),
        freeSlots: [...library.freeSlots, entry.index].sort((a, b) => a - b),
      })
    } catch (e) { fail(e) }
    finally { setBusy(null); setStep(null) }
  }

  async function pickFile(file: File | undefined) {
    setFileError(''); setPicked(null); setDone(null)
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.cube')) { setFileError(t("확장자가 .cube인 파일만 넣을 수 있습니다.")); return }
    if (file.size > MAX_CUBE_BYTES) { setFileError(t("파일이 너무 큽니다. 33 격자 .cube 파일인지 확인해 주세요.")); return }
    const text = await file.text()
    const summary = cubeSummary(text)
    if (summary.size !== 33) { setFileError(t("카메라는 33 × 33 × 33 격자 LUT만 받습니다. 이 파일은 {0}입니다.", [summary.size ?? t("격자 정보 없음")])); return }
    if (summary.style && summary.style !== 'STD' && summary.style !== 'VLOG') { setFileError(t("#LUMIXPHOTOSTYLE {0} 태그는 아직 지원하지 않습니다. STD, VLOG 또는 태그 없는 파일만 넣을 수 있습니다.", [summary.style])); return }
    setPicked({ fileName: file.name, text, ...summary })
    setName(cameraLutName(file.name))
  }

  async function add() {
    if (!library || !picked || slot === null) return
    const overwrite = !!library.entries[slot]?.inUse
    if (overwrite && !confirmOverwrite) return
    setBusy({ kind: 'adding', index: slot }); setStep(null); setError(null); setDone(null)
    try {
      const result = await cameraRegister(picked.text, slot, name, overwrite, setStep)
      setDone({ kind: 'added', index: result.index, name: result.name, backup: result.backup })
      const freeSlots = library.freeSlots.filter(s => s !== result.index)
      setLibrary({
        ...library,
        entries: library.entries.map(e => e.index === result.index ? { ...e, name: result.name, inUse: true, styleCode: picked.style === 'STD' ? 0 : 49 } : e),
        freeSlots,
      })
      setSlot(freeSlots[0] ?? null)
      setPicked(null); setName(''); setConfirmOverwrite(false)
      if (fileInput.current) fileInput.current.value = ''
    } catch (e) { fail(e) }
    finally { setBusy(null); setStep(null) }
  }

  const canWrite = !!library?.camera.writeSupported
  const target = library && slot !== null ? library.entries[slot] : undefined
  const overwrite = !!target?.inUse
  const progress = busy?.kind === 'reading' ? t("카메라의 LUT 목록을 읽는 중… (약 6초)")
    : busy && step === 'writing' ? t("카메라에 쓰는 중… 케이블을 빼거나 카메라를 끄지 마세요.")
    : busy && step === 'verifying' ? t("다시 읽어 확인하는 중…")
    : busy ? t("카메라 설정을 읽고 백업하는 중…")
    : ''
  const used = library ? library.entries.filter(e => e.inUse).length : 0

  return <div className="lut-manager">
    <div className="lut-manager-intro">
      <div>
        <h1>{t("LUT 관리")}</h1>
        <p>{t("USB로 연결한 카메라의 LUT 라이브러리를 보고, LUT를 지우거나 내 .cube 파일을 넣습니다. 바꾸기 전에 카메라 설정을 이 컴퓨터에 백업합니다.")}</p>
      </div>
      <button type="button" className="lut-manager-read" disabled={!!busy} onClick={() => void read()}>{library ? t("목록 다시 읽기") : t("카메라 LUT 목록 읽기")}</button>
    </div>

    <p className="lut-manager-status" role="status" aria-live="polite">{progress}</p>
    {done && <div className="lut-manager-done" role="status">
      <p>{done.kind === 'deleted' ? t("{0}번 칸의 ‘{1}’을 지웠습니다.", [done.index, done.name]) : t("{0}번 칸에 ‘{1}’을 등록했습니다. 카메라 메뉴의 LUT 라이브러리에서 확인하세요.", [done.index, done.name])}</p>
      <small>{t("바꾸기 전 카메라 설정 백업: {0}", [done.backup])}</small>
    </div>}
    {error && <div className="lut-manager-error" role="alert"><p>{error.text}</p><small>{error.detail}</small></div>}

    {library && <div className="lut-manager-body">
      <section className="lut-manager-list" aria-labelledby="lut-list-title">
        <div className="lut-manager-list-heading">
          <h2 id="lut-list-title">{t("카메라 LUT 목록")}</h2>
          <span>{library.camera.model} · {t("펌웨어 {0}", [library.camera.firmware])} · {t("{0}개 사용 · 빈 칸 {1}개", [used, library.freeSlots.length])}</span>
        </div>
        {!canWrite && <p className="lut-manager-warning">{t("{0} 펌웨어 {1}에는 아직 등록하거나 지울 수 없습니다. 목록 읽기만 할 수 있습니다.", [library.camera.model, library.camera.firmware])}</p>}
        <table>
          <thead><tr><th scope="col">{t("번호")}</th><th scope="col">{t("이름")}</th><th scope="col">{t("기준")}</th><th scope="col"><span className="visually-hidden">{t("작업")}</span></th></tr></thead>
          <tbody>{library.entries.map(entry => {
            const builtIn = entry.index < FIRST_USER_ENTRY
            const selected = library.selected === entry.index
            const rowBusy = busy && busy.kind !== 'reading' && busy.index === entry.index
            return <tr key={entry.index} className={`${entry.inUse ? '' : 'empty'}${selected ? ' selected' : ''}${slot === entry.index && picked ? ' target' : ''}`}>
              <td className="lut-index">{entry.index}</td>
              <td className="lut-name">{entry.inUse ? <span title={entry.name}>{entry.name}</span> : <span className="lut-empty">{t("빈 칸")}</span>}
                {builtIn && <span className="lut-badge">{t("카메라 기본")}</span>}
                {selected && <span className="lut-badge selected">{t("카메라에서 선택됨")}</span>}</td>
              <td className="lut-style">{entry.inUse ? styleLabel(t, entry.styleCode) : '—'}</td>
              <td className="lut-actions">
                {rowBusy ? <span className="lut-row-busy">{busy!.kind === 'deleting' ? t("지우는 중…") : t("넣는 중…")}</span>
                  : confirmDelete === entry.index ? <span className="lut-confirm">
                    <button type="button" className="danger" disabled={!!busy} onClick={() => void remove(entry)}>{t("지우기")}</button>
                    <button type="button" disabled={!!busy} onClick={() => setConfirmDelete(null)}>{t("취소")}</button>
                  </span>
                  : entry.inUse && !builtIn ? <button type="button" disabled={!!busy || !canWrite || selected} title={selected ? t("카메라에서 다른 LUT를 고른 뒤 지울 수 있습니다.") : undefined}
                    aria-label={t("{0}번 ‘{1}’ 지우기", [entry.index, entry.name])} onClick={() => { setConfirmDelete(entry.index); setDone(null) }}>{t("삭제")}</button>
                  : !entry.inUse ? <button type="button" disabled={!!busy || !canWrite} aria-label={t("{0}번 칸에 넣기", [entry.index])} onClick={() => { setSlot(entry.index); setConfirmOverwrite(false); fileInput.current?.focus() }}>{t("여기에 넣기")}</button>
                  : null}
              </td>
            </tr>
          })}</tbody>
        </table>
        {library.selected !== null && <p className="lut-manager-note">{t("카메라에서 선택된 LUT는 지울 수 없습니다. 카메라 메뉴에서 다른 LUT를 고른 뒤 목록을 다시 읽어 주세요.")}</p>}
      </section>

      <section className="lut-manager-add" aria-labelledby="lut-add-title">
        <h2 id="lut-add-title">{t("내 LUT 넣기")}</h2>
        <p className="lut-manager-help">{t("33 × 33 × 33 격자 .cube 파일을 넣을 수 있습니다. 파일의 #LUMIXPHOTOSTYLE 태그가 STD면 Standard, VLOG나 태그가 없으면 V-Log 기준으로 등록됩니다.")}</p>
        <label className="output-label" htmlFor="lut-file">{t(".cube 파일")}</label>
        <input id="lut-file" ref={fileInput} type="file" accept=".cube" disabled={!!busy || !canWrite} onChange={e => void pickFile(e.target.files?.[0])}/>
        {fileError && <p className="lut-manager-warning" role="alert">{fileError}</p>}
        {picked && <p className="lut-manager-file">{picked.fileName} · 33³ · {picked.style === 'STD' ? 'STD' : 'V-Log'}</p>}
        <label className="output-label" htmlFor="lut-slot">{t("등록할 칸")}</label>
        <select id="lut-slot" value={slot ?? ''} disabled={!!busy || !canWrite} onChange={e => { setSlot(e.target.value === '' ? null : Number(e.target.value)); setConfirmOverwrite(false) }}>
          {slot === null && <option value="">{t("빈 칸이 없습니다")}</option>}
          {library.freeSlots.length > 0 && <optgroup label={t("빈 칸")}>{library.freeSlots.map(index => <option key={index} value={index}>{t("{0}번 · 빈 칸", [index])}</option>)}</optgroup>}
          <optgroup label={t("덮어쓰기")}>{library.entries.filter(e => e.inUse && e.index >= FIRST_USER_ENTRY).map(e => <option key={e.index} value={e.index}>{t("{0}번 · {1}", [e.index, e.name])}</option>)}</optgroup>
        </select>
        <label className="output-label" htmlFor="lut-name">{t("카메라에 표시할 이름")}</label>
        <input id="lut-name" className="lut-manager-name" value={name} maxLength={95} spellCheck={false} disabled={!!busy || !picked}
          onChange={e => setName(e.target.value.replace(/[^\x20-\x7e]/g, ''))}/>
        {overwrite && target && <label className="lut-manager-confirm"><input type="checkbox" checked={confirmOverwrite} disabled={!!busy} onChange={e => setConfirmOverwrite(e.target.checked)}/>
          <span>{t("{0}번 칸의 ‘{1}’을 지우고 덮어씁니다.", [target.index, target.name])}</span></label>}
        <button type="button" className="lut-manager-primary" disabled={!!busy || !canWrite || !picked || slot === null || !name.trim() || (overwrite && !confirmOverwrite)} onClick={() => void add()}>
          {busy?.kind === 'adding' ? t("등록 중…") : t("카메라에 넣기 (약 25초)")}
        </button>
      </section>
    </div>}
  </div>
}
