import { useRef, useState, type DragEvent } from 'react'
import type { Translate } from './i18n'
import { errorText } from './CameraRegister'
import { cameraDelete, cameraListLuts, cameraLutName, cameraRegisterMany, cubeSummary, FIRST_USER_ENTRY, type CameraLibrary, type CameraProgress } from './platform.ts'
import './lutManager.css'

type Busy = null | { kind: 'reading' } | { kind: 'deleting'; indices: number[] } | { kind: 'adding'; indices: number[] }
type Done = { kind: 'deleted' | 'added'; entries: { index: number; name: string }[]; backup: string }
/** A file waiting to go to the camera. `error` set = the file cannot be used. */
type QueueItem = { id: number; fileName: string; text: string; style: string | null; error: string; name: string; slot: number | null }

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
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set())
  const [confirmBulk, setConfirmBulk] = useState(false)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [preferSlot, setPreferSlot] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)
  const nextId = useRef(1)
  const [done, setDone] = useState<Done | null>(null)
  const [error, setError] = useState<{ text: string; detail: string } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const fail = (e: unknown) => setError({ text: errorText(t, e), detail: e instanceof Error ? e.message : String(e) })

  async function read() {
    setBusy({ kind: 'reading' }); setError(null); setDone(null); setConfirmDelete(null); setConfirmBulk(false); setChecked(new Set())
    try {
      const next = await cameraListLuts()
      setLibrary(next)
      setQueue(current => assignSlots(current.map(q => ({ ...q, slot: null })), next, null))
    } catch (e) { fail(e) }
    finally { setBusy(null) }
  }

  async function remove(indices: number[]) {
    if (!library || !indices.length) return
    setBusy({ kind: 'deleting', indices }); setStep(null); setError(null); setDone(null); setConfirmDelete(null); setConfirmBulk(false)
    try {
      const result = await cameraDelete(indices, setStep)
      const gone = new Set(result.deleted.map(d => d.index))
      setDone({ kind: 'deleted', entries: result.deleted, backup: result.backup })
      setLibrary({
        ...library,
        entries: library.entries.map(e => gone.has(e.index) ? { ...e, name: '', inUse: false, styleCode: 49 } : e),
        freeSlots: [...library.freeSlots, ...gone].sort((a, b) => a - b),
      })
      setChecked(new Set())
    } catch (e) { fail(e) }
    finally { setBusy(null); setStep(null) }
  }

  function toggle(index: number, on: boolean) {
    setChecked(current => {
      const next = new Set(current)
      if (on) next.add(index); else next.delete(index)
      return next
    })
    setConfirmBulk(false); setDone(null)
  }

  async function readFile(file: File): Promise<Omit<QueueItem, 'id' | 'slot'>> {
    const base = { fileName: file.name, text: '', style: null, error: '', name: cameraLutName(file.name) }
    if (!file.name.toLowerCase().endsWith('.cube')) return { ...base, error: t("확장자가 .cube인 파일만 넣을 수 있습니다.") }
    if (file.size > MAX_CUBE_BYTES) return { ...base, error: t("파일이 너무 큽니다. 33 격자 .cube 파일인지 확인해 주세요.") }
    const text = await file.text()
    const summary = cubeSummary(text)
    if (summary.size !== 33) return { ...base, error: t("카메라는 33 × 33 × 33 격자 LUT만 받습니다. 이 파일은 {0}입니다.", [summary.size ?? t("격자 정보 없음")]) }
    if (summary.style && summary.style !== 'STD' && summary.style !== 'VLOG') return { ...base, error: t("#LUMIXPHOTOSTYLE {0} 태그는 아직 지원하지 않습니다. STD, VLOG 또는 태그 없는 파일만 넣을 수 있습니다.", [summary.style]) }
    return { ...base, text, style: summary.style }
  }

  /** Give every usable item without a slot the next empty slot (`prefer` first). */
  function assignSlots(items: QueueItem[], lib: CameraLibrary | null, prefer: number | null): QueueItem[] {
    if (!lib) return items
    const taken = new Set(items.map(q => q.slot).filter((x): x is number => x !== null))
    const free = lib.freeSlots.filter(x => !taken.has(x))
    if (prefer !== null && free.includes(prefer)) {
      free.splice(free.indexOf(prefer), 1)
      free.unshift(prefer)
    }
    return items.map(q => q.error || q.slot !== null ? q : { ...q, slot: free.shift() ?? null })
  }

  async function addFiles(files: File[]) {
    if (!files.length) return
    setDone(null); setError(null)
    const read = await Promise.all(files.map(readFile))
    const added = read.map(r => ({ ...r, id: nextId.current++, slot: null }))
    setQueue(current => assignSlots([...current, ...added], library, preferSlot))
    setPreferSlot(null); setConfirmOverwrite(false)
    if (fileInput.current) fileInput.current.value = ''
  }

  function updateItem(id: number, patch: Partial<QueueItem>) {
    setQueue(current => current.map(q => q.id === id ? { ...q, ...patch } : q))
    setConfirmOverwrite(false)
  }

  function onDrop(event: DragEvent) {
    event.preventDefault(); setDragging(false)
    if (!busy && canWrite) void addFiles(Array.from(event.dataTransfer.files))
  }
  function onDragOver(event: DragEvent) {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = !busy && canWrite ? 'copy' : 'none'
    setDragging(true)
  }

  async function add() {
    if (!library || !ready.length || problems.length || (overwrites.length && !confirmOverwrite)) return
    const items = ready.map(q => ({ cube: q.text, slot: q.slot!, name: q.name }))
    setBusy({ kind: 'adding', indices: items.map(i => i.slot) }); setStep(null); setError(null); setDone(null)
    try {
      const result = await cameraRegisterMany(items, overwrites.length > 0, setStep)
      setDone({ kind: 'added', entries: result.registered, backup: result.backup })
      const styles = new Map(ready.map(q => [q.slot!, q.style === 'STD' ? 0 : 49]))
      const names = new Map(result.registered.map(r => [r.index, r.name]))
      setLibrary({
        ...library,
        entries: library.entries.map(e => names.has(e.index) ? { ...e, name: names.get(e.index)!, inUse: true, styleCode: styles.get(e.index) ?? 49 } : e),
        freeSlots: library.freeSlots.filter(x => !names.has(x)),
      })
      setQueue(current => current.filter(q => q.error))
      setConfirmOverwrite(false)
    } catch (e) { fail(e) }
    finally { setBusy(null); setStep(null) }
  }

  const canWrite = !!library?.camera.writeSupported
  const ready = queue.filter(q => !q.error)
  const slotCounts = new Map<number, number>()
  for (const q of ready) if (q.slot !== null) slotCounts.set(q.slot, (slotCounts.get(q.slot) ?? 0) + 1)
  const problems = ready.filter(q => q.slot === null || (slotCounts.get(q.slot) ?? 0) > 1 || !q.name.trim())
  const overwrites = library ? ready.filter(q => q.slot !== null && library.entries[q.slot]?.inUse) : []
  const queuedSlots = new Set(ready.map(q => q.slot))
  const progress = busy?.kind === 'reading' ? t("카메라의 LUT 목록을 읽는 중… (약 6초)")
    : busy && step === 'writing' ? t("카메라에 쓰는 중… 케이블을 빼거나 카메라를 끄지 마세요.")
    : busy && step === 'verifying' ? t("다시 읽어 확인하는 중…")
    : busy ? t("카메라 설정을 읽고 백업하는 중…")
    : ''
  const used = library ? library.entries.filter(e => e.inUse).length : 0
  const deletable = library ? library.entries.filter(e => e.inUse && e.index >= FIRST_USER_ENTRY && e.index !== library.selected) : []
  const checkedEntries = deletable.filter(e => checked.has(e.index))
  const allChecked = deletable.length > 0 && checkedEntries.length === deletable.length
  const doneText = !done ? ''
    : done.kind === 'added' && done.entries.length === 1 ? t("{0}번 칸에 ‘{1}’을 등록했습니다. 카메라 메뉴의 LUT 라이브러리에서 확인하세요.", [done.entries[0].index, done.entries[0].name])
    : done.kind === 'added' ? t("LUT {0}개를 등록했습니다: {1}", [done.entries.length, done.entries.map(e => `${e.index} ${e.name}`).join(', ')])
    : done.entries.length === 1 ? t("{0}번 칸의 ‘{1}’을 지웠습니다.", [done.entries[0].index, done.entries[0].name])
    : t("LUT {0}개를 지웠습니다: {1}", [done.entries.length, done.entries.map(e => `${e.index} ${e.name}`).join(', ')])

  return <div className={`lut-manager${dragging ? ' dragging' : ''}`} onDragOver={library ? onDragOver : undefined} onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false) }} onDrop={library ? onDrop : undefined}>
    <div className="lut-manager-intro">
      <div>
        <h1>{t("LUT 관리")}</h1>
        <p>{t("USB로 연결한 카메라의 LUT 라이브러리를 보고, LUT를 지우거나 내 .cube 파일을 넣습니다. 바꾸기 전에 카메라 설정을 이 컴퓨터에 백업합니다.")}</p>
      </div>
      <button type="button" className="lut-manager-read" disabled={!!busy} onClick={() => void read()}>{library ? t("목록 다시 읽기") : t("카메라 LUT 목록 읽기")}</button>
    </div>

    <p className="lut-manager-status" role="status" aria-live="polite">{progress}</p>
    {done && <div className="lut-manager-done" role="status">
      <p>{doneText}</p>
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
        {canWrite && deletable.length > 0 && <div className={`lut-bulk${checkedEntries.length ? ' active' : ''}`} role="region" aria-label={t("여러 개 지우기")}>
          {confirmBulk ? <>
            <p>{t("선택한 LUT {0}개를 지웁니다: {1}", [checkedEntries.length, checkedEntries.map(e => `${e.index} ${e.name}`).join(', ')])}</p>
            <span className="lut-confirm">
              <button type="button" className="danger" disabled={!!busy} onClick={() => void remove(checkedEntries.map(e => e.index))}>{t("{0}개 지우기", [checkedEntries.length])}</button>
              <button type="button" disabled={!!busy} onClick={() => setConfirmBulk(false)}>{t("취소")}</button>
            </span>
          </> : !checkedEntries.length ? <p className="lut-bulk-hint">{t("왼쪽 칸을 체크하면 여러 LUT를 한 번에 지울 수 있습니다.")}</p> : <>
            <p>{t("{0}개 선택됨", [checkedEntries.length])}</p>
            <span className="lut-confirm">
              <button type="button" className="danger" disabled={!!busy} onClick={() => { setConfirmBulk(true); setConfirmDelete(null) }}>{t("선택한 LUT 지우기")}</button>
              <button type="button" disabled={!!busy} onClick={() => setChecked(new Set())}>{t("선택 해제")}</button>
            </span>
          </>}
        </div>}
        <table>
          <thead><tr><th scope="col" className="lut-check">{canWrite && deletable.length > 0 && <input type="checkbox" aria-label={t("지울 수 있는 LUT 모두 선택")} checked={allChecked} disabled={!!busy}
            onChange={e => { setChecked(e.target.checked ? new Set(deletable.map(d => d.index)) : new Set()); setConfirmBulk(false); setDone(null) }}/>}</th><th scope="col">{t("번호")}</th><th scope="col">{t("이름")}</th><th scope="col">{t("기준")}</th><th scope="col"><span className="visually-hidden">{t("작업")}</span></th></tr></thead>
          <tbody>{library.entries.map(entry => {
            const builtIn = entry.index < FIRST_USER_ENTRY
            const selected = library.selected === entry.index
            const rowBusy = busy && busy.kind !== 'reading' && busy.indices.includes(entry.index)
            const canDelete = canWrite && entry.inUse && !builtIn && !selected
            return <tr key={entry.index} className={`${entry.inUse ? '' : 'empty'}${selected ? ' selected' : ''}${queuedSlots.has(entry.index) ? ' target' : ''}`}>
              <td className="lut-check">{canDelete && <input type="checkbox" aria-label={t("{0}번 ‘{1}’ 선택", [entry.index, entry.name])} checked={checked.has(entry.index)} disabled={!!busy} onChange={e => toggle(entry.index, e.target.checked)}/>}</td>
              <td className="lut-index">{entry.index}</td>
              <td className="lut-name">{entry.inUse ? <span title={entry.name}>{entry.name}</span> : <span className="lut-empty">{t("빈 칸")}</span>}
                {builtIn && <span className="lut-badge">{t("카메라 기본")}</span>}
                {selected && <span className="lut-badge selected">{t("카메라에서 선택됨")}</span>}</td>
              <td className="lut-style">{entry.inUse ? styleLabel(t, entry.styleCode) : '—'}</td>
              <td className="lut-actions">
                {rowBusy ? <span className="lut-row-busy">{busy!.kind === 'deleting' ? t("지우는 중…") : t("넣는 중…")}</span>
                  : confirmDelete === entry.index ? <span className="lut-confirm">
                    <button type="button" className="danger" disabled={!!busy} onClick={() => void remove([entry.index])}>{t("지우기")}</button>
                    <button type="button" disabled={!!busy} onClick={() => setConfirmDelete(null)}>{t("취소")}</button>
                  </span>
                  : entry.inUse && !builtIn ? <button type="button" disabled={!!busy || !canWrite || selected} title={selected ? t("카메라에서 다른 LUT를 고른 뒤 지울 수 있습니다.") : undefined}
                    aria-label={t("{0}번 ‘{1}’ 지우기", [entry.index, entry.name])} onClick={() => { setConfirmDelete(entry.index); setConfirmBulk(false); setDone(null) }}>{t("삭제")}</button>
                  : !entry.inUse ? <button type="button" disabled={!!busy || !canWrite} aria-label={t("{0}번 칸에 넣기", [entry.index])} onClick={() => { setPreferSlot(entry.index); fileInput.current?.click() }}>{t("여기에 넣기")}</button>
                  : null}
              </td>
            </tr>
          })}</tbody>
        </table>
        {library.selected !== null && <p className="lut-manager-note">{t("카메라에서 선택된 LUT는 지울 수 없습니다. 카메라 메뉴에서 다른 LUT를 고른 뒤 목록을 다시 읽어 주세요.")}</p>}
      </section>

      <section className="lut-manager-add" aria-labelledby="lut-add-title">
        <h2 id="lut-add-title">{t("내 LUT 넣기")}</h2>
        <p className="lut-manager-help">{t("33 × 33 × 33 격자 .cube 파일을 넣을 수 있습니다. 파일의 #LUMIXPHOTOSTYLE 태그가 STD면 Standard, VLOG나 태그가 없으면 V-Log 기준으로 등록됩니다. 여러 파일은 빈 칸에 차례로 배정되고, 한 번에 카메라에 씁니다.")}</p>
        <div className={`lut-drop${dragging ? ' over' : ''}`}>
          <p>{t(".cube 파일을 여기에 끌어다 놓으세요")}</p>
          <span>{t("여러 개를 한 번에 넣을 수 있습니다.")}</span>
          <button type="button" disabled={!!busy || !canWrite} onClick={() => fileInput.current?.click()}>{t("파일 고르기")}</button>
          <input ref={fileInput} type="file" accept=".cube" multiple hidden onChange={e => void addFiles(Array.from(e.target.files ?? []))}/>
        </div>
        {queue.length > 0 && <ul className="lut-queue" aria-label={t("넣을 LUT")}>
          {queue.map(q => {
            const duplicate = q.slot !== null && (slotCounts.get(q.slot) ?? 0) > 1
            const replaces = q.slot !== null && !q.error ? library.entries[q.slot] : undefined
            return <li key={q.id} className={q.error ? 'invalid' : ''}>
              <div className="lut-queue-head">
                <span className="lut-queue-file" title={q.fileName}>{q.fileName}</span>
                {!q.error && <span className="lut-badge">{q.style === 'STD' ? 'STD' : 'V-Log'}</span>}
                <button type="button" className="lut-queue-remove" disabled={!!busy} aria-label={t("{0} 빼기", [q.fileName])} onClick={() => setQueue(current => current.filter(x => x.id !== q.id))}>×</button>
              </div>
              {q.error ? <p className="lut-manager-warning">{q.error}</p> : <div className="lut-queue-fields">
                <select aria-label={t("{0}을 넣을 칸", [q.fileName])} value={q.slot ?? ''} disabled={!!busy} onChange={e => updateItem(q.id, { slot: e.target.value === '' ? null : Number(e.target.value) })}>
                  {q.slot === null && <option value="">{t("칸을 고르세요")}</option>}
                  {library.freeSlots.length > 0 && <optgroup label={t("빈 칸")}>{library.freeSlots.map(index => <option key={index} value={index}>{t("{0}번 · 빈 칸", [index])}</option>)}</optgroup>}
                  <optgroup label={t("덮어쓰기")}>{library.entries.filter(e => e.inUse && e.index >= FIRST_USER_ENTRY).map(e => <option key={e.index} value={e.index}>{t("{0}번 · {1}", [e.index, e.name])}</option>)}</optgroup>
                </select>
                <input className="lut-manager-name" aria-label={t("{0}의 카메라 표시 이름", [q.fileName])} value={q.name} maxLength={95} spellCheck={false} disabled={!!busy}
                  onChange={e => updateItem(q.id, { name: e.target.value.replace(/[^\x20-\x7e]/g, '') })}/>
                {q.slot === null && <p className="lut-manager-warning">{t("빈 칸이 모자랍니다. 덮어쓸 칸을 고르거나 이 파일을 빼 주세요.")}</p>}
                {duplicate && <p className="lut-manager-warning">{t("다른 파일과 같은 칸입니다.")}</p>}
                {replaces?.inUse && <p className="lut-queue-replace">{t("‘{0}’을 덮어씁니다.", [replaces.name])}</p>}
              </div>}
            </li>
          })}
        </ul>}
        {overwrites.length > 0 && <label className="lut-manager-confirm"><input type="checkbox" checked={confirmOverwrite} disabled={!!busy} onChange={e => setConfirmOverwrite(e.target.checked)}/>
          <span>{t("이미 있는 LUT {0}개를 지우고 덮어씁니다: {1}", [overwrites.length, overwrites.map(q => `${q.slot} ${library.entries[q.slot!].name}`).join(', ')])}</span></label>}
        <button type="button" className="lut-manager-primary" disabled={!!busy || !canWrite || !ready.length || problems.length > 0 || (overwrites.length > 0 && !confirmOverwrite)} onClick={() => void add()}>
          {busy?.kind === 'adding' ? t("등록 중…") : ready.length > 1 ? t("카메라에 {0}개 넣기 (약 25초)", [ready.length]) : t("카메라에 넣기 (약 25초)")}
        </button>
      </section>
    </div>}
  </div>
}
