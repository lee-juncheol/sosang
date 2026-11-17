import assert from 'node:assert/strict';

export const BASE_LOOKS = 148;
// Base public looks on the eight upstream print profiles. Film Lab extension
// papers (experimental draft profiles) add 16 negative prints each, and
// experimental film-cast / lab-aim variants are counted on top, declared by
// catalog.filmCast.variants and catalog.labAim.variants.
export const PUBLIC_LOOKS = BASE_LOOKS;
export const UPSTREAM_PAPERS = 8;
export const EXTENSION_PAPERS = ['fujifilm_eterna_cp_3523xd'];
// Film Lab draft camera negatives from Fujifilm datasheets (artifacts/films).
export const EXTENSION_FILMS = ['fujifilm_eterna_250', 'fujifilm_eterna_250d', 'fujifilm_eterna_400', 'fujifilm_eterna_500',
  'fujifilm_eterna_vivid_160', 'fujifilm_eterna_vivid_250d', 'fujifilm_eterna_vivid_500', 'fujifilm_reala_500d', 'fujifilm_f64d'];
export const LAB_AIM_METHOD = 'film-lab-lab-aim-v1';
export const LAB_AIM_SUFFIX = '__labaim';
export const LAB_AIM_NUMBER_OFFSET = 2000;
export const FILM_CAST_METHOD = 'spektrafilm-print-reference-blend-v1';
export const FILM_CAST_SUFFIX = '__filmcast';
export const FILM_CAST_NUMBER_OFFSET = 1000;
// Amounts are solved per film/paper so 18% gray reaches a chroma target.
export const FILM_CAST_POLICY = 'chroma-target';
export const FILM_CAST_MIN_AMOUNT = 0.2;
// Films whose database direction contradicts their known look get an editorial hue.
export const FILM_CAST_HUE_POLICY = 'editorial-hue';

export function filmCastCount(catalog) {
  return catalog.filmCast?.variants ?? 0;
}

export function labAimCount(catalog) {
  return catalog.labAim?.variants ?? 0;
}

export function extensionPaperCount(catalog) {
  return (catalog.papers ?? []).filter(paper => EXTENSION_PAPERS.includes(paper.id)).length;
}

export function extensionFilmCount(catalog) {
  return (catalog.films ?? []).filter(film => EXTENSION_FILMS.includes(film.id)).length;
}

export function baseLookCount(catalog) {
  // Each extension film: every paper plus its digital scan.
  return BASE_LOOKS + 16 * extensionPaperCount(catalog) + extensionFilmCount(catalog) * (UPSTREAM_PAPERS + extensionPaperCount(catalog) + 1);
}

export function publicLookCount(catalog) {
  return baseLookCount(catalog) + filmCastCount(catalog) + labAimCount(catalog);
}

// Keep the complete supported film/paper inventory. A film-cast variant is a
// separate creative LUT paired with exactly one negative print base look.
export function assertLookInventory(catalog) {
  const { combinations, films, papers } = catalog;
  const extensions = extensionPaperCount(catalog), extraFilms = extensionFilmCount(catalog), baseLooks = baseLookCount(catalog);
  const prints = (16 + extraFilms) * (UPSTREAM_PAPERS + extensions);
  const declared = filmCastCount(catalog), declaredLab = labAimCount(catalog), expected = baseLooks + declared + declaredLab;
  assert(Number.isInteger(declared) && declared >= 0 && declared <= prints, 'Invalid declared film-cast count');
  if (declared) {
    assert.equal(declared, prints, 'Every negative film/paper pair must offer the film-cast variant');
    assert.equal(catalog.filmCast.method, FILM_CAST_METHOD, 'Unknown film-cast method');
    assert.equal(catalog.filmCast.amountPolicy, FILM_CAST_POLICY, 'Film-cast recipe must solve its amount per pair');
    assert.equal(catalog.filmCast.minAmount, FILM_CAST_MIN_AMOUNT, 'Film-cast minimum amount differs');
    assert(Number.isFinite(catalog.filmCast.targetChroma?.default) && catalog.filmCast.targetChroma.default > 0, 'Missing film-cast chroma target');
    const hues = catalog.filmCast.targetHue ?? {};
    assert(Object.values(hues).every(h => Number.isFinite(h) && h >= 0 && h < 360), 'Invalid film-cast hue target');
    assert(!('amount' in catalog.filmCast) && !('percent' in catalog.filmCast), 'Catalog must not declare one shared percentage');
    assert.equal(catalog.filmCast.skipped?.length ?? 0, 0, 'Negative print variants must not be excluded');
  }
  assert.equal(combinations.length, expected, `Expected ${expected} public engine combinations`);
  assert.equal(new Set(combinations.map(combo => combo.id)).size, expected, 'Duplicate look ID');
  assert.equal(new Set(combinations.map(combo => combo.number)).size, expected, 'Duplicate look number');
  assert.equal(films.length, 20 + extraFilms, 'Expected 20 engine films plus known extensions');
  for (const film of films.filter(film => EXTENSION_FILMS.includes(film.id)))
    assert(film.experimental === true && film.source === 'film-lab-extension' && film.type === 'negative', `Extension film must be an experimental negative: ${film.id}`);
  assert.equal(new Set(films.map(film => film.id)).size, films.length, 'Duplicate film ID');
  assert.equal(papers.length, UPSTREAM_PAPERS + extensions, 'Expected eight upstream print profiles plus known extensions');
  for (const paper of papers.filter(paper => EXTENSION_PAPERS.includes(paper.id)))
    assert(paper.experimental === true && paper.source === 'film-lab-extension', `Extension paper must be marked experimental: ${paper.id}`);
  const labPapers = Object.keys(catalog.labAim?.papers ?? {});
  if (declaredLab) {
    assert.equal(catalog.labAim.method, LAB_AIM_METHOD, 'Unknown lab-aim method');
    assert(labPapers.length && labPapers.every(id => papers.some(paper => paper.id === id)), 'Lab-aim paper must be a print profile');
    assert.equal(declaredLab, (16 + extraFilms) * labPapers.length, 'Every negative film must offer the lab-aim variant on each lab-aim paper');
  }
  assert.equal(new Set(papers.map(paper => paper.id)).size, papers.length, 'Duplicate print profile');
  const negatives = films.filter(film => film.type === 'negative');
  const positives = films.filter(film => film.type === 'positive');
  assert.equal(negatives.length, 16 + extraFilms, 'Expected 16 negative films plus extensions');
  assert.equal(positives.length, 4, 'Expected four positive films');
  const filmById = new Map(films.map(film => [film.id, film]));
  const paperIds = new Set(papers.map(paper => paper.id));
  const base = new Map(), variants = [], labVariants = [];
  for (const combo of combinations) {
    assert(!('printNeutralAmount' in combo) && !('neutralBaseId' in combo) && !combo.id.endsWith('__neutral30'), `Retired neutral variant metadata: ${combo.id}`);
    if ('labAimBaseId' in combo || 'labAim' in combo || combo.id.endsWith(LAB_AIM_SUFFIX)) { labVariants.push(combo); continue; }
    if ('castBaseId' in combo || 'filmCast' in combo || combo.id.endsWith(FILM_CAST_SUFFIX)) { variants.push(combo); continue; }
    assert(Number.isInteger(combo.number) && combo.number > 0 && combo.number < 1000, `Invalid base look number: ${combo.id}`);
    const film = filmById.get(combo.film);
    assert(film, `Unknown film in look: ${combo.id}`);
    let baseId;
    if (combo.processMode === 'negative_print') {
      assert.equal(film.type, 'negative', `Print requires a negative film: ${combo.id}`);
      assert(paperIds.has(combo.paper), `Unknown print profile: ${combo.id}`);
      baseId = `${combo.film}__${combo.paper}`;
    } else {
      assert.equal(combo.paper, null, `Paperless look has a print profile: ${combo.id}`);
      assert.equal(combo.processMode, film.type === 'positive' ? 'positive_direct' : 'negative_digital', `Unexpected paperless mode: ${combo.id}`);
      baseId = `${combo.film}__${film.type === 'positive' ? 'direct_scan' : 'digital_scan'}`;
    }
    assert.equal(combo.id, baseId, 'Base look ID must identify its film and output');
    assert(!base.has(baseId), `Duplicate base look: ${baseId}`);
    base.set(baseId, combo);
  }
  assert.equal(base.size, baseLooks, `Expected ${baseLooks} preserved base looks`);
  for (const film of negatives) {
    assert(base.has(`${film.id}__digital_scan`), `Missing digital scan: ${film.id}`);
    for (const paper of papers) {
      const id = `${film.id}__${paper.id}`;
      assert(base.has(id), `Missing negative print: ${id}`);
    }
  }
  for (const film of positives) assert(base.has(`${film.id}__direct_scan`), `Missing positive scan: ${film.id}`);
  const paired = new Set();
  for (const combo of variants) {
    const original = base.get(combo.castBaseId);
    assert(original, `Film-cast variant without a base look: ${combo.id}`);
    assert.equal(original.processMode, 'negative_print', `Film-cast variant requires a print stage: ${combo.id}`);
    assert.equal(combo.processMode, 'negative_print', `Film-cast variant requires a print stage: ${combo.id}`);
    assert.equal(combo.id, `${original.id}${FILM_CAST_SUFFIX}`, 'Film-cast ID must identify its base print');
    assert.equal(combo.film, original.film, `Film-cast film differs from base: ${combo.id}`);
    assert.equal(combo.paper, original.paper, `Film-cast paper differs from base: ${combo.id}`);
    assert.equal(combo.number, original.number + FILM_CAST_NUMBER_OFFSET, `Film-cast number must be base + ${FILM_CAST_NUMBER_OFFSET}: ${combo.id}`);
    assert(!paired.has(original.id), `Duplicate film-cast variant: ${original.id}`);
    paired.add(original.id);
    const cast = combo.filmCast;
    assert(cast && cast.method === FILM_CAST_METHOD, `Missing film-cast recipe: ${combo.id}`);
    assert.equal(cast.amountPolicy, FILM_CAST_POLICY, `Film-cast amount must be solved per pair: ${combo.id}`);
    const editorialHue = catalog.filmCast?.targetHue?.[combo.film];
    if (editorialHue !== undefined) {
      // Editorial-hue films keep their own filters (amount 1) plus a solved M/Y shift.
      assert.equal(cast.directionPolicy, FILM_CAST_HUE_POLICY, `Editorial-hue film must declare its direction policy: ${combo.id}`);
      assert.equal(cast.targetHue, editorialHue, `Film-cast hue differs from the catalog: ${combo.id}`);
      assert.equal(cast.amount, 1, `Editorial-hue variant must use the film's own filters: ${combo.id}`);
      const shift = cast.hueShiftCC;
      assert(Array.isArray(shift) && shift.length === 3 && shift[0] === 0 && shift.slice(1).every(v => Number.isFinite(v) && Math.abs(v) <= 30)
        && shift.some(v => v !== 0), `Invalid editorial hue shift: ${combo.id}`);
      assert(cast.appliedCC.every((v, i) => Math.abs(v - (cast.filmCC[i] + shift[i])) < 1e-9), `Applied filters differ from film + hue shift: ${combo.id}`);
    } else {
      assert(!('directionPolicy' in cast) && !('hueShiftCC' in cast) && !('targetHue' in cast), `Unexpected editorial hue: ${combo.id}`);
      assert(Number.isFinite(cast.amount) && cast.amount >= FILM_CAST_MIN_AMOUNT && cast.amount < 1, `Film-cast amount out of range: ${combo.id}`);
    }
    assert.equal(cast.percent, Math.round(cast.amount * 100), `Film-cast displayed percent differs from its amount: ${combo.id}`);
    assert(Number.isFinite(cast.targetChroma) && cast.targetChroma > 0, `Missing film-cast chroma target: ${combo.id}`);
  }
  assert.equal(variants.length, declared, 'Film-cast variants differ from the declared count');
  const labPaired = new Set();
  for (const combo of labVariants) {
    const original = base.get(combo.labAimBaseId);
    assert(original && original.processMode === 'negative_print', `Lab-aim variant without a base print: ${combo.id}`);
    assert(labPapers.includes(original.paper), `Lab-aim variant on a paper without an aim: ${combo.id}`);
    assert.equal(combo.id, `${original.id}${LAB_AIM_SUFFIX}`, 'Lab-aim ID must identify its base print');
    assert.equal(combo.film, original.film, `Lab-aim film differs from base: ${combo.id}`);
    assert.equal(combo.paper, original.paper, `Lab-aim paper differs from base: ${combo.id}`);
    assert.equal(combo.processMode, 'negative_print', `Lab-aim variant requires a print stage: ${combo.id}`);
    assert.equal(combo.number, original.number + LAB_AIM_NUMBER_OFFSET, `Lab-aim number must be base + ${LAB_AIM_NUMBER_OFFSET}: ${combo.id}`);
    assert(!labPaired.has(original.id), `Duplicate lab-aim variant: ${original.id}`);
    labPaired.add(original.id);
    const aim = combo.labAim;
    assert(aim && aim.method === LAB_AIM_METHOD, `Missing lab-aim recipe: ${combo.id}`);
    assert(Number.isFinite(aim.printExposure) && aim.printExposure > 0 && Math.abs(aim.printExposureStops) <= 1, `Lab-aim exposure out of range: ${combo.id}`);
    assert(aim.shiftCC.length === 3 && aim.shiftCC[0] === 0 && aim.shiftCC.slice(1).every(v => Number.isFinite(v) && Math.abs(v) <= 30), `Invalid lab-aim shift: ${combo.id}`);
    assert(aim.appliedCC.every((v, i) => Math.abs(v - (aim.filmCC[i] + aim.shiftCC[i])) < 1e-9), `Applied filters differ from film + shift: ${combo.id}`);
  }
  assert.equal(labVariants.length, declaredLab, 'Lab-aim variants differ from the declared count');
  return { baseLooks: base.size, filmCastLooks: variants.length, ...(declaredLab ? { labAimLooks: labVariants.length } : {}), combinations: combinations.length };
}
