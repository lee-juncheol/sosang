import { hydrateCameraAssets } from './cameraStd'
import { CATALOG_INDEX_PATH, CATALOG_LAYOUT, filmDetailPath, mergeFilmDetail, splitCatalog, type FilmDetail } from './catalogSplit'
import { serverUrl } from './platform.ts'
import { selectStdAsset } from './lookSelection'
import type { Catalog } from './types'

export interface LoadedIndex {
  catalog: Catalog
  /** Film details already in memory: a full catalog.json was split here (local dev, no index published). */
  local?: Record<string, FilmDetail>
}

const formatError = () => new Error('지원하지 않는 카탈로그입니다.')

function checkIndex(data: Catalog) {
  if (data.schemaVersion !== 2 || !data.films?.length || !data.papers?.length || !data.combinations?.length || !data.cameraAdapters?.models.length) throw formatError()
}

/** The split index from the server, or a full catalog.json split in the browser. */
export async function loadCatalogIndex(signal?: AbortSignal): Promise<LoadedIndex> {
  const response = await fetch(serverUrl(CATALOG_INDEX_PATH), { signal })
  if (response.ok && (response.headers.get('content-type') || '').includes('json')) {
    const catalog = await response.json() as Catalog
    checkIndex(catalog)
    if (catalog.layout !== CATALOG_LAYOUT) throw formatError()
    return { catalog }
  }
  const full = await fetch(serverUrl('/catalog.json'), { signal })
  if (!full.ok) throw new Error(`카탈로그를 불러올 수 없습니다 (${full.status})`)
  const data = await full.json() as Catalog
  checkIndex(data)
  const { index, films } = splitCatalog(data)
  return { catalog: index, local: films }
}

export async function loadFilmDetail(filmId: string, local?: Record<string, FilmDetail>, signal?: AbortSignal): Promise<FilmDetail> {
  if (local) return local[filmId] ?? { schemaVersion: 1, layout: CATALOG_LAYOUT, film: filmId, looks: {}, packs: {} }
  if (!/^[a-z0-9_]+$/.test(filmId)) throw formatError()
  const response = await fetch(serverUrl(filmDetailPath(filmId)), { signal })
  if (!response.ok) throw new Error(`카탈로그를 불러올 수 없습니다 (${response.status})`)
  const detail = await response.json() as FilmDetail
  if (detail.film !== filmId) throw formatError()
  return detail
}

/** Merge one film and check that its baked looks name the default camera's STD file. */
export function withFilmDetail(catalog: Catalog, detail: FilmDetail): Catalog {
  const merged = hydrateCameraAssets(mergeFilmDetail(catalog, detail))
  const camera = merged.cameraAdapters!.defaultCamera
  if (merged.combinations.some(c => c.film === detail.film && c.status === 'ready' && !c.synth && !selectStdAsset(c, camera)))
    throw new Error('카메라별 STD LUT 파일 정보를 확인하지 못했습니다. 다시 불러와 주세요.')
  return merged
}
