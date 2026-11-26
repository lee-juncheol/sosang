import { useRef, useState, type DragEvent } from 'react'
import type { Locale, Translate } from './i18n'
import { errorText } from './CameraRegister'
import { cameraLutName, cardFindSettings, cardListLuts, cardRegisterLuts, cubeSummary, serverUrl, type CardFile, type CardLibrary } from './platform.ts'
import './sdCard.css'

/** A .cube file waiting to go into the card file. `error` set = it cannot be used. */
type QueueItem = { id: number; fileName: string; text: string; error: string; name: string; slot: number | null }

const MAX_CUBE_BYTES = 8 * 1024 * 1024
const MANUAL_SAVE_RESTORE = {
  ko: 'https://eww.pavc.panasonic.co.jp/dscoi/DC-S1M2/html/DC-S1M2_DVQP3242_kor/0136.html#00045',
  en: 'https://eww.pavc.panasonic.co.jp/dscoi/DC-S1M2/html/DC-S1M2_DVQP3227_eng/0136.html#00045',
}

/** The camera-side steps around the app: save settings to the card, then load them back. */
function CardGuide({ locale, t }: { locale: Locale; t: Translate }) {
  return <section className="card-guide" aria-labelledby="card-guide-title">
    <h2 id="card-guide-title">{t("카드의 카메라 설정 파일로 넣기")}</h2>
    <p className="card-guide-lead">{t("USB 테더 연결이 없는 카메라(예: LUMIX L10)는 카메라의 [카메라 설정을 저장/복원] 기능을 거쳐 LUT를 넣습니다. 카메라가 카드에 저장한 설정 파일에 앱이 LUT를 더하고, 카메라가 그 파일을 다시 불러옵니다.")}</p>
    <ol className="card-steps">
      <li>
        <h3>{t("카메라에서 설정을 카드에 저장")}</h3>
        <p>{t("메뉴의 [설정] → [설정] 탭에서 [카메라 설정을 저장/복원] → [저장]을 고릅니다. [새 파일]을 고르면 파일 이름(영문 대문자와 숫자, 8자까지)을 정해 저장하고, 이미 있는 파일을 고르면 그 파일에 덮어씁니다. 카드 하나에 10개까지 저장할 수 있습니다.")}</p>
      </li>
      <li>
        <h3>{t("카드를 컴퓨터에 넣기")}</h3>
        <p>{t("저장한 설정은 카드의 AD_LUMIX › CAMSET 폴더에 ‘파일 이름.DAT’로 들어 있습니다. 앱이 이 폴더를 찾아 줍니다.")}</p>
        <figure className="card-folder">
          <img src={serverUrl('/guides/card-settings-folder.png')} width="1200" height="420" alt={t("카드의 LUMIX › AD_LUMIX › CAMSET 폴더 안에 있는 CAMSET01.DAT 파일")} loading="lazy" decoding="async"/>
          <figcaption>{t("macOS Finder에서 본 카드. Windows 탐색기에서도 같은 폴더(카드 › AD_LUMIX › CAMSET)에 있습니다.")}</figcaption>
        </figure>
      </li>
      <li>
        <h3>{t("앱에서 LUT 넣기")}</h3>
        <p>{t("아래에서 설정 파일을 고르고 .cube 파일을 넣을 칸을 정합니다. 이미 LUT가 있는 칸을 고르면 덮어씁니다. 바꾸기 전 원본 파일은 이 컴퓨터에 백업합니다.")}</p>
      </li>
      <li>
        <h3>{t("카메라에서 불러오기")}</h3>
        <p>{t("카드를 안전하게 꺼내 카메라에 넣고 [카메라 설정을 저장/복원] → [로드]에서 같은 파일을 고릅니다. 넣은 LUT는 LUT 라이브러리에 표시된 상태로 들어갑니다.")}</p>
      </li>
    </ol>
    <ul className="card-notes">
      <li>{t("[로드]는 LUT만이 아니라 저장할 때의 카메라 설정 전체를 다시 적용합니다. 설정을 저장한 뒤에는 카메라 설정을 바꾸지 말고 바로 LUT를 넣어 불러오세요.")}</li>
      <li>{t("불러온 뒤 촬영하기 전에 카메라 설정이 맞는지 확인하세요.")}</li>
      <li>{t("LUMIX L10에서 확인했습니다. 다른 LUMIX 기종도 설정 파일 구조가 같으면 같은 방법으로 넣을 수 있습니다.")}</li>
    </ul>
    <a className="card-guide-source" href={MANUAL_SAVE_RESTORE[locale]} target="_blank" rel="noreferrer">{t("[카메라 설정을 저장/복원] 설명 출처: Panasonic S1II 공식 설명서 ↗")}</a>
  </section>
}

export function SdCardManager({ locale, t }: { locale: Locale; t: Translate }) {
  const [files, setFiles] = useState<CardFile[] | null>(null)
  const [library, setLibrary] = useState<CardLibrary | null>(null)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [busy, setBusy] = useState<null | 'finding' | 'reading' | 'writing'>(null)
  const [error, setError] = useState<{ text: string; detail: string } | null>(null)
  const [done, setDone] = useState<{ file: string; entries: { index: number; name: string }[]; backup: string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const nextId = useRef(1)

  const fail = (e: unknown) => setError({ text: cardErrorText(t, e), detail: e instanceof Error ? e.message : String(e) })

  async function find() {
    setBusy('finding'); setError(null); setDone(null)
    try {
      const found = await cardFindSettings()
      setFiles(found)
      const readable = found.filter(f => !f.error)
      if (readable.length === 1) await open(readable[0].path, false)
      else setLibrary(null)
    } catch (e) { fail(e) } finally { setBusy(null) }
  }

  async function open(path: string, own = true) {
    if (own) { setBusy('reading'); setError(null); setDone(null) }
    try {
      const lib = await cardListLuts(path)
      setLibrary(lib)
      setQueue(current => assignSlots(current.map(q => ({ ...q, slot: null })), lib))
    } catch (e) { setLibrary(null); fail(e) } finally { if (own) setBusy(null) }
  }

  async function readFile(file: File): Promise<Omit<QueueItem, 'id' | 'slot'>> {
    const base = { fileName: file.name, text: '', error: '', name: cameraLutName(file.name) }
    if (!file.name.toLowerCase().endsWith('.cube')) return { ...base, error: t("확장자가 .cube인 파일만 넣을 수 있습니다.") }
    if (file.size > MAX_CUBE_BYTES) return { ...base, error: t("파일이 너무 큽니다. 33 격자 .cube 파일인지 확인해 주세요.") }
    const text = await file.text()
    const summary = cubeSummary(text)
    if (summary.size !== 33) return { ...base, error: t("카메라는 33 × 33 × 33 격자 LUT만 받습니다. 이 파일은 {0}입니다.", [summary.size ?? t("격자 정보 없음")]) }
    if (summary.style && summary.style !== 'STD' && summary.style !== 'VLOG') return { ...base, error: t("#LUMIXPHOTOSTYLE {0} 태그는 아직 지원하지 않습니다. STD, VLOG 또는 태그 없는 파일만 넣을 수 있습니다.", [summary.style]) }
    return { ...base, text }
  }

  function assignSlots(items: QueueItem[], lib: CardLibrary | null): QueueItem[] {
    if (!lib) return items
    const taken = new Set(items.map(q => q.slot).filter((x): x is number => x !== null))
    const free = lib.freeSlots.filter(x => !taken.has(x))
    return items.map(q => q.error || q.slot !== null ? q : { ...q, slot: free.shift() ?? null })
  }

  async function addFiles(list: File[]) {
    if (!list.length) return
    setDone(null); setError(null)
    const read = await Promise.all(list.map(readFile))
    setQueue(current => assignSlots([...current, ...read.map(r => ({ ...r, id: nextId.current++, slot: null }))], library))
    if (fileInput.current) fileInput.current.value = ''
  }

  const update = (id: number, patch: Partial<QueueItem>) => setQueue(current => current.map(q => q.id === id ? { ...q, ...patch } : q))
  const remove = (id: number) => setQueue(current => current.filter(q => q.id !== id))

  const ready = queue.filter(q => !q.error)
  const slotCounts = new Map<number, number>()
  for (const q of ready) if (q.slot !== null) slotCounts.set(q.slot, (slotCounts.get(q.slot) ?? 0) + 1)
  const problems = ready.filter(q => q.slot === null || (slotCounts.get(q.slot) ?? 0) > 1 || !q.name.trim())

  async function write() {
    if (!library || !ready.length || problems.length) return
    setBusy('writing'); setError(null); setDone(null)
    try {
      const result = await cardRegisterLuts(library.path, ready.map(q => ({ cube: q.text, slot: q.slot!, name: q.name.trim() })))
      setDone({ file: library.file, entries: result.registered, backup: result.backup })
      setQueue(current => current.filter(q => q.error))
      setLibrary(await cardListLuts(library.path))
    } catch (e) { fail(e) } finally { setBusy(null) }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault(); setDragging(false)
    if (!busy && library) void addFiles(Array.from(event.dataTransfer.files))
  }

  const used = library ? library.entries.filter(e => e.inUse).length : 0
  const status = busy === 'finding' ? t("카드에서 설정 파일을 찾는 중…") : busy === 'reading' ? t("설정 파일을 읽는 중…") : busy === 'writing' ? t("카드에 쓰는 중… 카드를 빼지 마세요.") : ''

  return <div className={`lut-manager sd-card${dragging ? ' dragging' : ''}`} onDragOver={library ? e => { if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); setDragging(true) } } : undefined} onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false) }} onDrop={library ? onDrop : undefined}>
    <CardGuide locale={locale} t={t}/>

    <section className="card-work" aria-labelledby="card-work-title">
      <div className="card-work-heading">
        <h2 id="card-work-title">{t("카드의 설정 파일")}</h2>
        <button type="button" className="lut-manager-read" disabled={!!busy} onClick={() => void find()}>{files ? t("카드 다시 찾기") : t("카드에서 설정 파일 찾기")}</button>
      </div>
      <p className="lut-manager-status" role="status" aria-live="polite">{status}</p>
      {error && <div className="lut-manager-error" role="alert"><p>{error.text}</p><small>{error.detail}</small></div>}
      {done && <div className="lut-manager-done" role="status">
        <p>{t("‘{0}’에 LUT {1}개를 넣었습니다: {2}. 카드를 안전하게 꺼낸 뒤 카메라에서 [카메라 설정을 저장/복원] → [로드]로 이 파일을 불러오세요.", [done.file, done.entries.length, done.entries.map(e => `${e.index} ${e.name}`).join(', ')])}</p>
        <small>{t("바꾸기 전 설정 파일 백업: {0}", [done.backup])}</small>
      </div>}

      {files && !files.length && <p className="lut-manager-warning">{t("카드에서 설정 파일을 찾지 못했습니다. 카메라에서 설정을 카드에 저장했는지, 카드가 컴퓨터에 연결되어 있는지 확인해 주세요.")}</p>}
      {files && files.length > 0 && <ul className="card-files">{files.map(f => <li key={f.path}>
        <button type="button" aria-pressed={library?.path === f.path} disabled={!!busy || !!f.error} onClick={() => void open(f.path)}>
          <strong>{f.file}</strong>
          <span>{f.volume}{f.model ? ` · ${f.model}` : ''}{f.modified ? ` · ${new Date(f.modified).toLocaleString(locale)}` : ''}</span>
          {f.error && <em>{cardErrorText(t, Object.assign(new Error(f.error), { code: f.error }))}</em>}
        </button>
      </li>)}</ul>}

      {library && <div className="lut-manager-body card-body">
        <section className="lut-manager-list" aria-labelledby="card-list-title">
          <div className="lut-manager-list-heading">
            <h3 id="card-list-title">{t("LUT 목록")}</h3>
            <span>{library.model} · {library.file} · {t("{0}개 사용 · 빈 칸 {1}개", [used, library.freeSlots.length])}</span>
          </div>
          <table>
            <thead><tr><th>{t("칸")}</th><th>{t("이름")}</th></tr></thead>
            <tbody>{library.entries.filter(e => e.inUse || library.freeSlots.includes(e.index)).map(e => <tr key={e.index} className={e.inUse ? undefined : 'empty'}>
              <td>{e.index}</td><td>{e.inUse ? e.name : t("비어 있음")}</td>
            </tr>)}</tbody>
          </table>
        </section>

        <section className="lut-manager-add" aria-labelledby="card-add-title">
          <h3 id="card-add-title">{t("LUT 넣기")}</h3>
          <p className="lut-manager-help">{t(".cube 파일을 고르거나 이 화면에 끌어다 놓으세요. 빈 칸부터 채우고, 칸을 바꾸면 기존 LUT를 덮어씁니다.")}</p>
          <input ref={fileInput} type="file" accept=".cube" multiple hidden onChange={e => void addFiles(Array.from(e.target.files ?? []))}/>
          <button type="button" className="lut-manager-read" disabled={!!busy} onClick={() => fileInput.current?.click()}>{t(".cube 파일 고르기")}</button>
          {queue.length > 0 && <ul className="card-queue">{queue.map(q => <li key={q.id}>
            <span className="card-queue-file">{q.fileName}</span>
            {q.error ? <em>{q.error}</em> : <>
              <label>{t("이름")}<input value={q.name} maxLength={95} disabled={!!busy} onChange={e => update(q.id, { name: e.target.value })}/></label>
              <label>{t("칸")}<select value={q.slot ?? ''} disabled={!!busy} onChange={e => update(q.id, { slot: e.target.value === '' ? null : Number(e.target.value) })}>
                <option value="">{t("고르기")}</option>
                <optgroup label={t("빈 칸")}>{library.freeSlots.map(s => <option key={s} value={s}>{s}</option>)}</optgroup>
                <optgroup label={t("덮어쓰기")}>{library.entries.filter(e => e.inUse && e.index >= 2).map(e => <option key={e.index} value={e.index}>{t("{0}번 · {1}", [e.index, e.name])}</option>)}</optgroup>
              </select></label>
            </>}
            <button type="button" className="card-queue-remove" disabled={!!busy} aria-label={t("{0} 빼기", [q.fileName])} onClick={() => remove(q.id)}>×</button>
          </li>)}</ul>}
          {problems.length > 0 && <p className="lut-manager-warning">{t("칸이 없거나 겹치거나 이름이 빈 파일이 있습니다.")}</p>}
          <button type="button" className="lut-manager-primary" disabled={!!busy || !ready.length || problems.length > 0} onClick={() => void write()}>{t("카드의 설정 파일에 넣기 ({0}개)", [ready.length])}</button>
        </section>
      </div>}
    </section>
  </div>
}

function cardErrorText(t: Translate, e: unknown): string {
  const code = (e as { code?: string })?.code
  if (code === 'unknown_layout' || code === 'unsupported_model') return t("이 설정 파일은 아직 읽을 수 없는 형식입니다.")
  if (code === 'verify_failed') return t("카드에 쓴 내용을 다시 읽어 보니 달라서, 원래 파일로 되돌렸습니다.")
  return errorText(t, e)
}
