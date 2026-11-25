import test from 'node:test'
import assert from 'node:assert/strict'
import { bakedLookIds, mergeFilmDetail, splitCatalog } from '../src/catalogSplit.ts'
import { buildLutZip } from '../src/lutZip.ts'
import { extractZipEntry } from '../src/assets.ts'
import type { Asset, Catalog, Combination } from '../src/types.ts'

const asset = (path: string): Asset => ({ path, name: path.split('/').pop()!, bytes: 1, sha256: 'a'.repeat(64) })
const files = (id: string) => ({ std: asset(`/luts/${id}/STD.cube`), vlog: asset(`/luts/${id}/VLOG.cube`), zip: asset(`/luts/${id}/LUTS.zip`), qa: asset(`/luts/${id}/qa.json`), provenance: asset(`/luts/${id}/provenance.json`) })
const look = (id: string, film: string, paper: string | null, extra: Partial<Combination> = {}): Combination => ({ id, film, paper, number: 1, status: 'ready',
  processMode: paper ? 'negative_print' : 'negative_digital', files: files(id), stdByCamera: { S1II: { std: files(id).std, zip: files(id).zip, qa: {} as never, warnings: [] } }, ...extra })
const pack = (id: string) => ({ asset: asset(`/print-timing/${id}.bin`), wire: { min: 0, max: 1 }, qa: {} })
const catalog = {
  schemaVersion: 2, films: [], papers: [], samples: [], counts: {}, cameraAdapters: { defaultCamera: 'S1II', models: [] },
  filmCast: { referenceFilm: 'portra400' },
  printTiming: { packs: { gold__ca: pack('gold__ca'), portra400__ca: pack('portra400__ca') } },
  combinations: [
    look('gold__ca', 'gold', 'ca'),
    look('gold__ca__filmcast', 'gold', 'ca', { castBaseId: 'gold__ca', filmCast: { appliedCC: [0, 3, 4], filmCC: [0, 1, 1] } as never }),
    look('gold__ca__labaim', 'gold', 'ca', { labAimBaseId: 'gold__ca', labAim: { shiftCC: [0, 1, 2], printExposureStops: 0.3 } as never }),
    look('gold__digital_scan', 'gold', null),
    look('portra400__ca', 'portra400', 'ca'),
    look('portra400__ca__filmcast', 'portra400', 'ca', { castBaseId: 'portra400__ca', filmCast: { appliedCC: [0, 0, 0], filmCC: [0, 0, 0] } as never }),
    look('slide__xx', 'slide', 'xx'), // A print without a pack stays baked.
  ],
} as unknown as Catalog

test('only the recommended look (neutral for the reference film) and paperless looks keep files', () => {
  assert.deepEqual([...bakedLookIds(catalog)].sort(), ['gold__ca__filmcast', 'gold__digital_scan', 'portra400__ca', 'slide__xx'])
})

test('the index holds recipes-free light looks; merging a film restores its looks and packs', () => {
  const { index, films } = splitCatalog(catalog)
  assert.equal(index.layout, 'split-v1')
  assert.deepEqual(index.printTiming!.packs, {})
  for (const combo of index.combinations) assert(!combo.files && !combo.stdByCamera && !combo.filmCast && !combo.labAim, combo.id)
  assert.deepEqual(index.combinations.filter(c => c.synth).map(c => c.id).sort(), ['gold__ca', 'gold__ca__labaim', 'portra400__ca__filmcast'])
  const merged = mergeFilmDetail(index, films.gold)
  const byId = new Map(merged.combinations.map(c => [c.id, c]))
  assert.deepEqual(byId.get('gold__ca__filmcast')!.files, catalog.combinations[1].files)
  assert.deepEqual(byId.get('gold__ca__labaim')!.labAim, catalog.combinations[2].labAim)
  assert.equal(byId.get('gold__ca')!.files, undefined)
  assert.ok(merged.printTiming!.packs.gold__ca)
  assert.equal(merged.printTiming!.packs.portra400__ca, undefined)
  assert.equal(byId.get('portra400__ca')!.files, undefined, 'other films stay unloaded')
  assert.equal(index.combinations.find(c => c.id === 'gold__ca__filmcast')!.files, undefined, 'the index is not changed')
})

test('slim details drop the loose QA and provenance links', () => {
  const { films } = splitCatalog(catalog, { slim: true })
  assert.deepEqual(Object.keys(films.gold.looks.gold__ca__filmcast.files!).sort(), ['std', 'vlog', 'zip'])
})

test('a film file cannot add files to a browser-made look', () => {
  const { index, films } = splitCatalog(catalog)
  const bad = structuredClone(films.gold)
  bad.looks.gold__ca = { files: files('gold__ca') }
  assert.throws(() => mergeFilmDetail(index, bad))
})

test('browser LUT ZIP holds both cubes, the README and the licences', async () => {
  const std = 'STD cube\n'.repeat(200), vlog = 'VLOG cube\n'.repeat(200)
  const zip = await buildLutZip([{ name: 'Gold200CA.cube', text: std }, { name: 'Gold200CAVLOG.cube', text: vlog }], 'readme', [{ name: 'LICENSE.txt', bytes: new TextEncoder().encode('licence') }])
  const text = async (name: string, size: number) => new TextDecoder().decode(await extractZipEntry(zip, name, size))
  assert.equal(await text('Gold200CA.cube', std.length), std)
  assert.equal(await text('Gold200CAVLOG.cube', vlog.length), vlog)
  assert.equal(await text('README.txt', 6), 'readme')
  assert.equal(await text('LICENSE.txt', 7), 'licence')
})
