# 인계 메모 (Claude 원격 세션 → Claude Code)

작성: 2026-11-05. 이 파일을 읽은 뒤 아래 "남은 일"부터 진행하면 됩니다. 답변은 한국어로.

## 이번에 바뀐 것 (모두 로컬 저장소에 반영됨, 아직 배포 전)

1. **추천 현상 방법(film cast)**: 조합별 혼합 비율을 18% 회색 CIELAB C* 목표(기본 6, Vision3 200T/500T 10, 하한 0.2)로 계산. `pipeline/print_blend.py`, `pipeline/generate_film_cast.py`, 변형 128개 `public/luts/<id>__filmcast/`. 자세한 내용 `docs/film-cast.md`.
2. **인화 필터 M·Y 슬라이더(실험)**: spektrafilm Print M/Y filter shift를 브라우저에서 실시간 반영.
   - 생성: `pipeline/print_timing.py`, `pipeline/generate_print_timing.py` → `public/print-timing/*.bin` 128개(약 264MB), `catalog.json`의 `printTiming`.
   - 웹: `src/printTiming.ts`, `src/usePrintTiming.ts`, `src/usePhoto.ts`, `src/lut.worker.ts`. 자세한 내용 `docs/print-timing.md`.
   - 슬라이더 값은 룩(필름+인화지)·현상 방법별로 새로고침 전까지 기억. 추천 현상을 고르면 그 조합의 추천값에서 시작.
3. **UI 문구/레이아웃 (src/main.tsx, src/style.css, src/translations/en.ts)**
   - "인화 필터" → "현상 방법", 옵션은 "중립 현상 방법" / "추천 현상 방법". 초기화 버튼 문구 통일.
   - "현상 방법" 옆 ⓘ 버튼 → 레이어에 중립/추천 현상/슬라이더 원리 설명 (×, Esc, 바깥 클릭으로 닫힘).
   - Portra 400(기준 필름)은 추천 현상 버튼 비활성화(`castLocked`).
   - 전체 font-size +2px (style.css, filmGallery.css, lutUsageGuide.css, whiteBalanceGuide.css), 좌우 패널 폭 확대, `.film-option{flex-shrink:0}`.

검증: `node scripts/run-web.mjs test` 88개 통과, `tsc --noEmit` 통과, `npm run verify:assets` 통과(수정 전 시점).

## 남은 일

1. **배포**: `npm run deploy:cloudflare` (빌드·검증·Wrangler 배포). Cloudflare 로그인이 풀려 있으면 `npm run cloudflare:login`. 배포 후 https://sosang.film-lab-jc.workers.dev 에서 현상 방법 ⓘ 레이어, 슬라이더, 추천 현상 다운로드 확인.
   - 원격 세션에서는 Mac용 node_modules(rollup 네이티브)가 리눅스 셸에서 안 돌고 npm 접속도 막혀서 배포하지 못했음.
2. **ⓘ 레이어의 Esc·바깥 클릭 닫힘**은 화면에서 직접 확인하지 못했음 — 한 번 눌러 보기.
3. **정리(사용자 확인 후 삭제)**: `artifacts/print-timing/head.00`~`head.11`, `packs.part6` (전송용 임시 조각, 약 264MB). 백업 `artifacts/font-bump/`(CSS·main.tsx 수정 전 사본)는 확인 끝나면 삭제 가능.

## 참고

- 사용자 카메라: LUMIX S1II(S1M2). 다운로드 기본은 S1II STD.
- 다운로드 폴더 `sosang 추천 현상 LUT (S1II STD)`에 네거티브 16종 × 권장 인화지 × 추천 현상 LUT를 모아 둠(Portra 400만 중립).
