export interface Asset { path: string; name: string; bytes: number; sha256: string }
export interface Stock { id: string; name: string; type: string; stage: string; brand: string; use: string; recommendedPrint: string | null; sha256: string }
export interface Sample { id: string; name: string; category: string; credit: string; source: string | null; path: string; width: number; height: number }
export interface Metric { mean: number; p95: number; p99: number; max: number; samples: number }
export interface Combination {
  id: string; film: string; paper: string; number: number;
  status: 'ready' | 'failed' | 'unsupported' | 'not-generated'; reason?: string;
  seconds?: number; files?: Record<'vlog' | 'std' | 'zip' | 'qa' | 'provenance', Asset>;
  previews?: Record<string, Asset>;
  qa?: { fileChecks: string; cameraVerified: boolean; warnings: string[]; vlogVsDirectEngine: { tetrahedral: Metric }; stdVsContinuousComposition: { tetrahedral: Metric } }
}
export interface Catalog {
  schemaVersion: number; engineCommit: string; engineVersion: string; adapter: string;
  films: Stock[]; papers: Stock[]; samples: Sample[]; combinations: Combination[];
  counts: Record<string, number>; output: string; resolution: number
}
