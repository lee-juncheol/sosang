import type { Combination, NegativeProcessMode, ProcessMode, Stock } from './types'

export function processModeFor(film: Pick<Stock, 'type'>, negativeMode: NegativeProcessMode): ProcessMode {
  return film.type === 'positive' ? 'positive_direct' : negativeMode
}

export function findLook(combinations: Combination[], film: Pick<Stock, 'id' | 'type'>, paperId: string, negativeMode: NegativeProcessMode): Combination | undefined {
  const processMode = processModeFor(film, negativeMode)
  const paper = processMode === 'negative_print' ? paperId : null
  return combinations.find(combo => combo.film === film.id && combo.processMode === processMode && combo.paper === paper)
}
