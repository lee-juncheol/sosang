import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Locale, Translate } from './i18n'
import { PATCH_NOTES, PATCH_NOTES_STORAGE_KEY, latestPatchNote } from './patchNotes.ts'
import './lutUsageGuide.css'
import './patchNotes.css'

function seenId(): string | null {
  try { return window.localStorage.getItem(PATCH_NOTES_STORAGE_KEY) } catch { return latestPatchNote() }
}

/** Topbar button beside the language switch; opens the update history. A dot marks an unread entry. */
export function PatchNotesButton({ locale, t }: { locale: Locale; t: Translate }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [seen, setSeen] = useState(seenId)
  const unread = seen !== latestPatchNote()
  function open() {
    dialog.current?.showModal()
    try { window.localStorage.setItem(PATCH_NOTES_STORAGE_KEY, latestPatchNote()) } catch { /* Shows the dot again next time in privacy modes. */ }
    setSeen(latestPatchNote())
  }
  return <>
    <button type="button" className="about-button patch-notes-button" aria-label={unread ? t("업데이트 내역 (새 소식 있음)") : t("업데이트 내역")} onClick={open}>
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/></svg>
      <span>{t("업데이트 내역")}</span>
      {unread && <i className="patch-notes-dot" aria-hidden="true"/>}
    </button>
    {createPortal(<dialog ref={dialog} className="usage-dialog patch-notes-dialog" aria-labelledby={titleId} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close() }}>
      <div className="usage-shell">
        <header className="usage-heading"><div><span className="eyebrow">sosang</span><h2 id={titleId}>{t("업데이트 내역")}</h2></div><button className="usage-close" type="button" aria-label={t("업데이트 내역 닫기")} onClick={() => dialog.current?.close()}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
        <div className="usage-content">
          <ol className="patch-notes-list">
            {PATCH_NOTES.map((note, index) => <li key={note.id} className={index === 0 ? 'latest' : undefined}>
              <div className="patch-notes-meta"><time dateTime={note.date}>{note.date}</time>{note.app && <span className="patch-notes-app">{t("앱 {0}", [note.app])}</span>}</div>
              <ul>{note.items[locale].map(item => <li key={item}>{item}</li>)}</ul>
            </li>)}
          </ol>
        </div>
      </div>
    </dialog>, document.body)}
  </>
}
