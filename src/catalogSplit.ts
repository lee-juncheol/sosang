// Split catalog: a small index (films, papers, samples and every look's recipe) plus one file per
// film with the heavy parts (file hashes, per-camera STD entries, QA, print-timing packs), loaded
// when the film is chosen. Shared by the public build (scripts/prepare-cloudflare.mjs) and the
// browser, which applies the same split to a full catalog.json when no index is published (dev).
//
// Only one look per film/paper print is baked: the recommended development (film-cast variant),
// or the neutral print for the blend reference film (Portra 400), whose recommended look equals it.
// The other print looks (neutral, manufacturer lab aim) stay in the index as recipes marked
// `synth` and are made in the browser from the pair's print-timing pack (src/printTiming.ts).
import type { Catalog, Combination } from './types'

export const CATALOG_INDEX_PATH = '/catalog/index.json'
export const CATALOG_LAYOUT = 'split-v1'
export const filmDetailPath = (filmId: string) => `/catalog/films/${filmId}.json`

// Published files and their checks: baked looks only.
const FILE_KEYS = ['files', 'stdByCamera', 'previews', 'qa'] as const
// Print recipes (preset shifts, cast direction): every variant, so the index stays small.
const RECIPE_KEYS = ['filmCast', 'labAim'] as const
const DETAIL_KEYS = [...FILE_KEYS, ...RECIPE_KEYS] as const
type DetailKey = typeof DETAIL_KEYS[number]
export type LookDetail = Pick<Combination, DetailKey>
type Packs = NonNullable<Catalog['printTiming']>['packs']
export interface FilmDetail { schemaVersion: 1; layout: typeof CATALOG_LAYOUT; film: string; looks: Record<string, LookDetail>; packs: Packs }
export interface SplitCatalog { index: Catalog; films: Record<string, FilmDetail> }

const printBaseId = (combo: Combination) => combo.castBaseId || combo.labAimBaseId || combo.id

/** IDs of the looks that keep baked files. Every other ready print look with a pack is made in the browser. */
export function bakedLookIds(catalog: Pick<Catalog, 'combinations' | 'filmCast' | 'printTiming'>): Set<string> {
  const baked = new Set<string>()
  const reference = catalog.filmCast?.referenceFilm
  const packs = catalog.printTiming?.packs ?? {}
  const casts = new Map(catalog.combinations.filter(c => c.castBaseId && c.status === 'ready').map(c => [c.castBaseId!, c]))
  for (const combo of catalog.combinations) {
    if (combo.processMode !== 'negative_print' || !packs[printBaseId(combo)]) { baked.add(combo.id); continue }
    if (combo.labAimBaseId) continue
    const cast = casts.get(printBaseId(combo))
    const keep = cast && combo.film !== reference ? cast.id : printBaseId(combo)
    if (combo.id === keep) baked.add(combo.id)
  }
  return baked
}

/**
 * slim: drop the QA and provenance JSON links (the public build without per-look loose files;
 * both are inside each look's LUTS ZIP).
 */
export function splitCatalog(catalog: Catalog, { slim = false }: { slim?: boolean } = {}): SplitCatalog {
  const baked = bakedLookIds(catalog)
  const films: Record<string, FilmDetail> = {}
  const film = (id: string) => films[id] ??= { schemaVersion: 1, layout: CATALOG_LAYOUT, film: id, looks: {}, packs: {} }
  const combinations = catalog.combinations.map(combo => {
    const light: Combination = { ...combo }
    for (const key of DETAIL_KEYS) delete light[key]
    if (!baked.has(combo.id)) light.synth = true
    const keys = light.synth ? RECIPE_KEYS : DETAIL_KEYS
    if (!keys.some(key => combo[key] !== undefined)) return light
    const detail: LookDetail = {}
    for (const key of keys) if (combo[key] !== undefined) (detail as Record<string, unknown>)[key] = structuredClone(combo[key])
    if (slim && detail.files) { const { qa: _qa, provenance: _provenance, ...files } = detail.files; detail.files = files }
    film(combo.film).looks[combo.id] = detail
    return light
  })
  const packs = catalog.printTiming?.packs ?? {}
  for (const combo of catalog.combinations) {
    if (combo.processMode === 'negative_print' && !combo.castBaseId && !combo.labAimBaseId && packs[combo.id]) film(combo.film).packs[combo.id] = packs[combo.id]
  }
  const index: Catalog = { ...catalog, layout: CATALOG_LAYOUT, combinations,
    ...(catalog.printTiming ? { printTiming: { ...catalog.printTiming, packs: {} } } : {}) }
  return { index, films }
}

/** The index with one film's details filled in (a new object; the input is not changed). */
export function mergeFilmDetail(catalog: Catalog, detail: FilmDetail): Catalog {
  if (detail.schemaVersion !== 1 || detail.layout !== CATALOG_LAYOUT) throw new Error('지원하지 않는 카탈로그입니다.')
  const combinations = catalog.combinations.map(combo => {
    const extra = detail.looks[combo.id]
    if (combo.film !== detail.film || !extra) return combo
    if (combo.synth && Object.keys(extra).some(key => !(RECIPE_KEYS as readonly string[]).includes(key))) throw new Error('카탈로그 형식을 읽지 못했습니다. 다시 불러와 주세요.')
    return { ...combo, ...structuredClone(extra) }
  })
  if (Object.keys(detail.looks).some(id => !catalog.combinations.some(combo => combo.id === id && combo.film === detail.film))) throw new Error('카탈로그 형식을 읽지 못했습니다. 다시 불러와 주세요.')
  const printTiming = catalog.printTiming ? { ...catalog.printTiming, packs: { ...catalog.printTiming.packs, ...detail.packs } } : undefined
  return { ...catalog, combinations, ...(printTiming ? { printTiming } : {}) }
}

/** True once a film's details are in (index-only looks have no recipe or files yet). */
export function filmLoaded(catalog: Catalog, filmId: string, loaded: ReadonlySet<string>) {
  return catalog.layout !== CATALOG_LAYOUT || loaded.has(filmId)
}

/** True when a look's files are published (false for browser-made looks and before its film is loaded). */
export function hasLookFiles(combo: Combination | undefined) {
  return !!combo && !combo.synth && !!combo.files
}
