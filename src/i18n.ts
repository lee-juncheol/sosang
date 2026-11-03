import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { english } from './translations/en.ts'
import type { Sample } from './types.ts'

export type Locale = 'ko' | 'en'
export type Translate = (message: string | undefined, values?: readonly unknown[]) => string
export const LOCALE_STORAGE_KEY = 'film-lab-locale'
export const isLocale = (value: unknown): value is Locale => value === 'ko' || value === 'en'
export const browserLocale = (language: string): Locale => language.toLowerCase().startsWith('ko') ? 'ko' : 'en'

export function readSavedLocale(storage: Pick<Storage, 'getItem'> | undefined): Locale | null {
  try { const value = storage?.getItem(LOCALE_STORAGE_KEY); return isLocale(value) ? value : null }
  catch { return null }
}

// Manual choices are authoritative, including while the location request is
// pending. Automatic defaults are deliberately not persisted as user choices.
export function createLocalePreference(saved: unknown) {
  let current: Locale | null = isLocale(saved) ? saved : null
  let manual = current !== null
  return {
    select(locale: Locale) { current = locale; manual = true; return locale },
    async resolve(request: () => Promise<unknown>, language: string): Promise<Locale> {
      if (manual && current) return current
      let next = browserLocale(language)
      try {
        const data = await request()
        if (data && typeof data === 'object' && 'locale' in data && isLocale(data.locale)) next = data.locale
      } catch { /* Offline, timeout, and unavailable geolocation use the browser. */ }
      if (!manual) current = next
      return current || next
    },
  }
}

export function translate(locale: Locale, message: string | undefined, values: readonly unknown[] = []): string {
  if (!message) return ''
  const template = locale === 'en' ? english[message] || message : message
  return template.replace(/\{(\d+)\}/g, (token, index: string) => Number(index) < values.length ? String(values[Number(index)]) : token)
}

// Rendering translations here keeps worker requests, pixel buffers, filenames,
// and the original catalog independent of the selected interface language.
export function runtimeMessage(locale: Locale, message: string | undefined): string {
  if (!message) return ''
  if (['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.', 'The network connection was lost.'].includes(message)) return translate(locale, '네트워크 연결을 확인한 뒤 다시 시도해 주세요.')
  if (message === 'Film Lab · generated technical test pattern · CC0') return translate(locale, 'Film Lab · 생성된 기술 테스트 패턴 · CC0')
  const exact = translate(locale, message)
  if (exact !== message || locale === 'ko') return exact
  const catalog = message.match(/^카탈로그를 불러올 수 없습니다 \((\d+)\)$/)
  if (catalog) return translate(locale, '카탈로그를 불러올 수 없습니다 ({0})', [catalog[1]])
  const sample = message.match(/^샘플 사진을 불러오지 못했습니다 \((\d+)\)\.$/)
  if (sample) return translate(locale, '샘플 사진을 불러오지 못했습니다 ({0}).', [sample[1]])
  const download = message.match(/^([\s\S]+) · 검증된 파일을 다운로드했습니다\.$/)
  if (download) return translate(locale, '{0} · 검증된 파일을 다운로드했습니다.', [download[1]])
  const credit = message.match(/^사용자 촬영 · ([\s\S]+)$/)
  if (credit) return translate(locale, '사용자 촬영 · {0}', [credit[1]])
  return exact
}

export function sampleText(sample: Sample, field: 'name' | 'category' | 'credit', locale: Locale): string {
  if (field === 'name' && sample.inputKind === 'uploaded-srgb') return sample.name
  return runtimeMessage(locale, sample[field])
}

export function useLocale() {
  const [saved] = useState(() => {
    try { return readSavedLocale(window.localStorage) } catch { return null }
  })
  const preference = useRef<ReturnType<typeof createLocalePreference> | null>(null)
  if (!preference.current) preference.current = createLocalePreference(saved)
  const [locale, updateLocale] = useState<Locale>(saved || browserLocale(navigator.language))
  const [ready, setReady] = useState(!!saved)
  useEffect(() => {
    if (saved) return
    let active = true
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 2000)
    void preference.current!.resolve(async () => {
      const response = await fetch('/api/locale', { cache: 'no-store', signal: controller.signal })
      if (!response.ok) throw new Error('Locale unavailable')
      return response.json()
    }, navigator.language).then(next => {
      if (active) { updateLocale(next); setReady(true) }
    }).finally(() => window.clearTimeout(timeout))
    return () => { active = false; controller.abort(); window.clearTimeout(timeout) }
  }, [saved])
  const setLocale = useCallback((next: Locale) => {
    preference.current!.select(next)
    updateLocale(next); setReady(true)
    try { window.localStorage.setItem(LOCALE_STORAGE_KEY, next) } catch { /* Still switch in privacy modes. */ }
  }, [])
  const t = useCallback<Translate>((message, values) => translate(locale, message, values), [locale])
  const message = useCallback((value: string | undefined) => runtimeMessage(locale, value), [locale])
  useEffect(() => {
    if (!ready) return
    document.documentElement.lang = locale
    document.title = locale === 'ko' ? 'Film Lab — 당신의 다음 색' : 'Film Lab — Find your next color'
    document.querySelector('meta[name="description"]')?.setAttribute('content', locale === 'ko'
      ? '필름과 인화지를 조합하고, 내 사진으로 비교하고, V-Log·Standard용 LUT를 다운로드하세요.'
      : 'Combine film looks and print materials, compare them on your photos, and download V-Log or Standard LUTs.')
  }, [locale, ready])
  return useMemo(() => ({ locale, ready, setLocale, t, message }), [locale, ready, setLocale, t, message])
}
