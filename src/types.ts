export interface Asset { path: string; name: string; bytes: number; sha256: string; encoding?: 'gzip' | 'zip-entry'; transferBytes?: number; transferSha256?: string }
export interface Stock { id: string; name: string; type: string; stage: string; brand: string; use: string; recommendedPrint: string | null; sha256: string }
export interface Sample { id: string; name: string; category: string; credit: string; source: string | null; path: string; width: number; height: number; inputKind: 'camera-std' | 'synthetic-srgb' | 'uploaded-srgb'; sourceFilename?: string; previewLut: 'std' }
export interface Metric { mean: number; p95: number; p99: number; max: number; samples: number }
export type NegativeProcessMode = 'negative_print' | 'negative_digital' | 'reference_interpretation'
export type OfficialProcessMode = 'official_direct' | 'official_print'
export type ProcessPreference = NegativeProcessMode | OfficialProcessMode
export type ProcessMode = ProcessPreference | 'positive_direct'
export interface FilmReference { title: string; url: string; author?: string; evidence?: string; camera?: string; exposure?: string; development?: string; scanner?: string; post?: string; role?: string; observation?: string }
export interface ReferenceLook { film: string; name: string; description: string; adjustments?: string[]; references: FilmReference[] }
export interface ReferenceStudy { methodId: string; looks: ReferenceLook[]; limitation?: string }
export interface FujiLook { film: string; name: string; sourceFile: string; sourceSha256: string }
export interface FujiStudy { methodId: string; model: string; packageVersion: string; sourceUrl: string; downloadUrl: string; sourceSha256: string; looks: FujiLook[]; limitation?: string }
export interface Combination {
  id: string; film: string; paper: string | null; number: number;
  processMode: ProcessMode;
  status: 'ready' | 'failed' | 'unsupported' | 'not-generated'; reason?: string;
  seconds?: number; files?: Record<'vlog' | 'std' | 'zip' | 'qa' | 'provenance', Asset>;
  previews?: Record<string, Asset>;
  qa?: { fileChecks: string; cameraVerified: boolean; warnings: string[]; vlogVsDirectEngine: { tetrahedral: Metric }; stdVsDirectEngine?: { tetrahedral: Metric }; stdVsContinuousComposition?: { tetrahedral: Metric } }
}
export interface Catalog {
  schemaVersion: number; engineCommit: string; engineVersion: string; adapter: string;
  films: Stock[]; papers: Stock[]; samples: Sample[]; combinations: Combination[];
  counts: Record<string, number>; output: string; resolution: number
  referenceStudy?: ReferenceStudy
  fujiStudy?: FujiStudy
}
