"""Film Lab stock extensions: profiles that are not part of the pinned spektrafilm.

The vendor checkout stays byte-for-byte unchanged. Extra profiles live in
pipeline/profiles/<stock>.json and their neutral print filters in
pipeline/profiles/neutral_print_filters.json (same layout as upstream's
database: paper -> illuminant -> film -> [C, M, Y] Kodak CC). install() makes
spektrafilm's loaders see both, so every builder and reference path works
unchanged. It is called from pipeline.common, so worker processes get it too.

Current extensions
- fujifilm_eterna_cp_3523xd: experimental print film draft built from Fujifilm datasheet
  KB-1004E; see artifacts/eterna-cp-3523xd/README.md for how and its limits.
- Fujifilm Eterna 250/250D/400/500, Eterna Vivid 160/250D/500, Reala 500D, F-64D: experimental
  camera negative drafts from Fujifilm datasheets; see artifacts/films/README.md.
"""
from __future__ import annotations

import json
from pathlib import Path

DIRECTORY = Path(__file__).resolve().parent / 'profiles'
FILTERS_PATH = DIRECTORY / 'neutral_print_filters.json'
FILM_NOTE = ('Film Lab draft from the Fujifilm datasheet (see artifacts/films/README.md); the method was checked on '
             'Kodak Vision3 500T/50D datasheets against upstream profiles. Not compared with real film.')
EXPERIMENTAL = {
    'fujifilm_eterna_cp_3523xd': 'Film Lab draft from the Fujifilm ETERNA-CP 3523XD datasheet (KB-1004E); '
                                 'not an upstream spektrafilm profile and not compared with a real print.',
    'fujifilm_eterna_250': FILM_NOTE,
    'fujifilm_eterna_250d': FILM_NOTE,
    'fujifilm_eterna_400': FILM_NOTE,
    'fujifilm_eterna_500': FILM_NOTE,
    'fujifilm_eterna_vivid_160': FILM_NOTE,
    'fujifilm_eterna_vivid_250d': FILM_NOTE,
    'fujifilm_eterna_vivid_500': FILM_NOTE,
    'fujifilm_reala_500d': FILM_NOTE,
    'fujifilm_f64d': FILM_NOTE,
}
_installed = False
_upstream_filters = None


def extra_stocks():
    return sorted(p.stem for p in DIRECTORY.glob('*.json') if p != FILTERS_PATH)


def extra_filters():
    return json.loads(FILTERS_PATH.read_text()) if FILTERS_PATH.exists() else {}


def install():
    global _installed
    if _installed: return
    import spektrafilm.profiles.io as profiles_io
    import spektrafilm.utils.io as utils_io
    import spektrafilm.runtime.params_builder as params_builder

    global _upstream_filters
    upstream_load, upstream_filters = profiles_io.load_profile, utils_io.read_neutral_print_filters
    _upstream_filters = upstream_filters
    extras = set(extra_stocks())

    def load_profile(stock):
        if stock not in extras: return upstream_load(stock)
        profile = profiles_io.profile_from_dict(json.loads((DIRECTORY / f'{stock}.json').read_text()))
        profiles_io._validate_profile(profile, stock)
        return profile

    def read_neutral_print_filters():
        database = upstream_filters()
        # Extension entries only add pairs: new papers, or new films on upstream papers.
        for paper, by_illuminant in extra_filters().items():
            for illuminant, table in by_illuminant.items():
                target = database.setdefault(paper, {}).setdefault(illuminant, {})
                for film, cmy in table.items():
                    if film in target: raise ValueError(f'Extension filters would override upstream {paper}/{film}')
                    target[film] = cmy
        return database

    profiles_io.load_profile = profiles_io.load_processed_profile = load_profile
    params_builder.load_profile = load_profile
    utils_io.read_neutral_print_filters = read_neutral_print_filters
    params_builder.read_neutral_print_filters = read_neutral_print_filters
    params_builder._get_neutral_print_filters.cache_clear()
    import spektrafilm.runtime as runtime, spektrafilm
    for module in (runtime, spektrafilm):
        if getattr(module, 'load_profile', None) is upstream_load: module.load_profile = load_profile
    _installed = True
