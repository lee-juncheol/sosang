import test from 'node:test'
import assert from 'node:assert/strict'
import { findLook, processModeFor } from '../src/lookSelection.ts'
import type { Combination } from '../src/types.ts'

const negative = { id: 'portra', type: 'negative' }
const slide = { id: 'velvia', type: 'positive' }
const official = { id: 'gfx_classic_chrome', type: 'official' }
const combinations: Combination[] = [
  { id: 'portra__endura', film: 'portra', paper: 'endura', processMode: 'negative_print', number: 1, status: 'ready' },
  { id: 'portra__crystal', film: 'portra', paper: 'crystal', processMode: 'negative_print', number: 2, status: 'ready' },
  { id: 'portra__digital_scan', film: 'portra', paper: null, processMode: 'negative_digital', number: 161, status: 'ready' },
  { id: 'portra__reference', film: 'portra', paper: null, processMode: 'reference_interpretation', number: 177, status: 'ready' },
  { id: 'velvia__direct_scan', film: 'velvia', paper: null, processMode: 'positive_direct', number: 41, status: 'ready' },
  { id: 'gfx_classic_chrome__direct', film: 'gfx_classic_chrome', paper: null, processMode: 'official_direct', number: 181, status: 'ready' },
  { id: 'gfx_classic_chrome__endura', film: 'gfx_classic_chrome', paper: 'endura', processMode: 'official_print', number: 182, status: 'ready' },
  { id: 'gfx_classic_chrome__crystal', film: 'gfx_classic_chrome', paper: 'crystal', processMode: 'official_print', number: 183, status: 'ready' },
]

test('print and digital select their exact combination while retaining the requested paper', () => {
  assert.equal(findLook(combinations, negative, 'crystal', 'negative_print')?.id, 'portra__crystal')
  assert.equal(findLook(combinations, negative, 'crystal', 'negative_digital')?.id, 'portra__digital_scan')
  assert.equal(findLook(combinations, negative, 'crystal', 'negative_print')?.id, 'portra__crystal')
})

test('slide always selects positive direct scan regardless of negative-mode preference', () => {
  for (const preference of ['negative_print', 'negative_digital'] as const) {
    assert.equal(processModeFor(slide, preference), 'positive_direct')
    assert.equal(findLook(combinations, slide, 'endura', preference)?.id, 'velvia__direct_scan')
  }
})

test('visiting a slide preserves the remembered negative process and selected paper', () => {
  const selectedPaper = 'crystal'
  for (const preference of ['negative_print', 'negative_digital'] as const) {
    const original = findLook(combinations, negative, selectedPaper, preference)
    assert.equal(findLook(combinations, slide, selectedPaper, preference)?.id, 'velvia__direct_scan')
    assert.equal(findLook(combinations, negative, selectedPaper, preference), original)
    assert.equal(findLook(combinations, negative, selectedPaper, 'negative_print')?.paper, selectedPaper)
  }
})

test('a missing digital asset never falls back to print or the wrong paperless process', () => {
  const unavailable = combinations.filter(c => c.processMode !== 'negative_digital')
  unavailable.push({ id: 'wrong_mode', film: 'portra', paper: null, processMode: 'positive_direct', number: 99, status: 'ready' })
  assert.equal(findLook(unavailable, negative, 'endura', 'negative_digital'), undefined)
  assert.equal(findLook(combinations, negative, 'missing_paper', 'negative_print'), undefined)
})

test('real-film reference look is independent from paper and experimental digital scan', () => {
  assert.equal(findLook(combinations, negative, 'crystal', 'reference_interpretation')?.id, 'portra__reference')
  assert.equal(findLook(combinations, negative, 'endura', 'reference_interpretation')?.id, 'portra__reference')
  assert.equal(findLook(combinations, { id: 'unsupported', type: 'negative' }, 'endura', 'reference_interpretation'), undefined)
  assert.equal(findLook(combinations.filter(c => c.processMode !== 'reference_interpretation'), negative, 'endura', 'reference_interpretation'), undefined)
  assert.equal(findLook(combinations, slide, 'endura', 'reference_interpretation')?.id, 'velvia__direct_scan')
})

test('official LUT can switch paper off and on without losing the selected paper', () => {
  assert.equal(findLook(combinations, official, 'crystal', 'official_print')?.id, 'gfx_classic_chrome__crystal')
  assert.equal(findLook(combinations, official, 'crystal', 'official_direct')?.id, 'gfx_classic_chrome__direct')
  assert.equal(findLook(combinations, official, 'endura', 'official_direct')?.id, 'gfx_classic_chrome__direct')
  assert.equal(findLook(combinations, official, 'crystal', 'official_print')?.paper, 'crystal')
  assert.equal(findLook(combinations, official, 'endura', 'official_print')?.id, 'gfx_classic_chrome__endura')
})

test('official LUT routes cannot resolve to real-film reference or negative digital assets', () => {
  assert.equal(processModeFor(official, 'reference_interpretation'), 'official_print')
  assert.equal(processModeFor(negative, 'official_direct'), 'negative_print')
  assert.equal(processModeFor(slide, 'official_print'), 'positive_direct')
  const withoutDirect = combinations.filter(c => c.processMode !== 'official_direct')
  withoutDirect.push({ id: 'wrong_official_scan', film: official.id, paper: null, processMode: 'negative_digital', number: 999, status: 'ready' })
  assert.equal(findLook(withoutDirect, official, 'crystal', 'official_direct'), undefined)
  assert.equal(findLook(combinations, official, 'missing', 'official_print'), undefined)
})
