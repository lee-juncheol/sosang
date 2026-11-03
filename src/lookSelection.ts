import type { Combination, ProcessPreference, ProcessMode, Stock } from './types'

export function processModeFor(film: Pick<Stock, 'type'>, preference: ProcessPreference): ProcessMode {
  if (film.type === 'official') return preference === 'official_direct' ? 'official_direct' : 'official_print'
  if (film.type === 'positive') return 'positive_direct'
  return preference === 'official_direct' || preference === 'official_print' ? 'negative_print' : preference
}

export function findLook(combinations: Combination[], film: Pick<Stock, 'id' | 'type'>, paperId: string, preference: ProcessPreference): Combination | undefined {
  const processMode = processModeFor(film, preference)
  const paper = processMode === 'negative_print' || processMode === 'official_print' ? paperId : null
  return combinations.find(combo => combo.film === film.id && combo.processMode === processMode && combo.paper === paper)
}
