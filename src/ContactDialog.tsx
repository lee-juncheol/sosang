import { useEffect, useRef, useState } from 'react'
import type { Translate } from './i18n'
import { ContactError, contactContext, sendContact, type ContactContext, type ContactErrorCode } from './platform.ts'
import './contactDialog.css'

const MAX_MESSAGE = 4000

function contextLine(context: ContactContext, t: Translate): string {
  const parts = [context.source === 'app' ? (context.version ? t("sosang 앱 {0}", [context.version]) : t("sosang 앱")) : t("웹사이트")]
  if (context.os) parts.push(context.os)
  if (context.camera) parts.push(context.firmware ? t("{0} 펌웨어 {1}", [context.camera, context.firmware]) : context.camera)
  return parts.join(' · ')
}

function errorText(code: ContactErrorCode, t: Translate): string {
  if (code === 'rate_limited') return t("잠시 뒤에 다시 보내 주세요.")
  if (code === 'bad_request') return t("내용을 5자 이상 4,000자 이하로 적고, 이메일 주소를 확인해 주세요.")
  if (code === 'network') return t("네트워크 연결을 확인한 뒤 다시 시도해 주세요.")
  return t("지금은 문의를 받을 수 없습니다. 잠시 뒤에 다시 시도해 주세요.")
}

/** Contact form in a modal dialog. Messages go to the sosang Worker (`/api/contact`). */
export function ContactDialog({ open, onClose, locale, t }: { open: boolean; onClose: () => void; locale: string; t: Translate }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [website, setWebsite] = useState('')
  const [context, setContext] = useState<ContactContext | null>(null)
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState<ContactErrorCode | null>(null)

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) {
      element.showModal()
      if (state === 'sent') { setState('idle'); setMessage('') }
      setError(null)
      let current = true
      void contactContext(locale).then(next => { if (current) setContext(next) })
      return () => { current = false }
    }
    if (!open && element.open) element.close()
  }, [open, locale])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (state === 'sending') return
    const text = message.trim()
    if (text.length < 5) { setError('bad_request'); return }
    setState('sending'); setError(null)
    try {
      await sendContact(text, email.trim(), context ?? await contactContext(locale), website)
      setState('sent')
    } catch (e) {
      setState('idle')
      setError(e instanceof ContactError ? e.code : 'unavailable')
    }
  }

  return <dialog ref={dialog} className="details-dialog contact-dialog" aria-labelledby="contact-title" onClose={onClose} onClick={e => { if (e.target === dialog.current) onClose() }}>
    <div className="dialog-inner">
      <div className="dialog-heading"><div><span className="eyebrow">sosang</span><h2 id="contact-title">{t("문의 · 버그 제보")}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label={t("문의 창 닫기")}>×</button></div>
      {state === 'sent' ? <div className="contact-sent" role="status">
        <p>{t("보냈습니다. 고맙습니다!")}</p>
        <p>{email.trim() ? t("답장이 필요하면 {0}(으)로 연락드릴게요.", [email.trim()]) : t("이메일을 적지 않아 답장은 드릴 수 없지만, 내용은 꼭 읽어 볼게요.")}</p>
        <button type="button" className="contact-submit" onClick={onClose}>{t("닫기")}</button>
      </div> : <form className="contact-form" onSubmit={submit} noValidate>
        <p className="contact-intro">{t("궁금한 점, 버그, 바라는 기능을 자유롭게 적어 주세요. 버그라면 어떤 화면에서 무엇을 눌렀을 때 생겼는지 적어 주시면 빨리 찾을 수 있어요.")}</p>
        <label className="contact-field"><span>{t("내용")}</span>
          <textarea value={message} onChange={e => setMessage(e.target.value)} maxLength={MAX_MESSAGE} rows={7} required placeholder={t("예: LUT 관리에서 31번 이름이 깨져 보여요.")}/>
          <small>{message.length.toLocaleString()} / {MAX_MESSAGE.toLocaleString()}</small>
        </label>
        <label className="contact-field"><span>{t("답장받을 이메일 (선택)")}</span>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={200} autoComplete="email" inputMode="email" placeholder="name@example.com"/>
        </label>
        <label className="contact-trap" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={website} onChange={e => setWebsite(e.target.value)}/></label>
        {context && <p className="contact-context"><span>{t("함께 보내는 정보")}</span>{contextLine(context, t)}</p>}
        <p className="contact-privacy">{t("보내 주신 내용과 이메일은 답변에만 쓰고 180일 뒤 지웁니다. 카메라 시리얼 번호, 사진, IP 주소는 보내거나 저장하지 않습니다.")}</p>
        {error && <p className="contact-error" role="alert">{errorText(error, t)}</p>}
        <button type="submit" className="contact-submit" disabled={state === 'sending'}>{state === 'sending' ? t("보내는 중…") : t("보내기")}</button>
      </form>}
    </div>
  </dialog>
}
