# 나눈 목록과 브라우저에서 만드는 인화 LUT (2026-11-25)

필름을 늘려도 Cloudflare 정적 파일 한도(무료 20,000개, 파일당 25 MiB)와 목록 크기가 버티도록 공개 빌드의 구조를 바꿨다.
`pipeline/`과 `public/catalog.json`(개인 빌드)은 그대로이고, 공개 빌드(`scripts/prepare-cloudflare.mjs`)에서만 바꾼다.

## 미리 굽는 룩
- 필름×인화지마다 하나만 굽는다. 기본은 추천 현상(`__filmcast`)이다. 기준 필름(Portra 400)은 추천 현상이 중립과 같으므로 중립을 굽는다.
- 중립, 제조사 기준(`__labaim`), 그 밖의 게이지 위치는 그 조합의 인화 데이터(`/print-timing/<id>.bin`)로 브라우저가 만든다(`bakeTimingCube`).
- 디지털 스캔, 슬라이드, 인화 데이터가 없는 조합은 지금처럼 굽는다.
- 규칙은 `src/catalogSplit.ts`의 `bakedLookIds`에 있다. 목록에는 `synth: true`로 표시된다.
- 차이 검증: `artifacts/lut-validation/2026-11-25-timing-synth/`. 미리 구운 STD와 비교해 실사진 ΔE p99는 0.95 이하이고, 눈으로는 구분되지 않는다.

## 목록
- `/catalog/index.json`: 필름, 인화지, 샘플과 모든 룩의 가벼운 정보(약 250 KB). `layout: "split-v1"`.
- `/catalog/films/<film>.json`: 파일 해시, 카메라별 STD, QA, 인화 레시피(`filmCast`, `labAim`), 인화 데이터 목록. 필름을 고를 때 받는다.
- `lutLicenses`: 브라우저가 만드는 ZIP에 넣는 라이선스 3개(`/licenses/…`, `/camera-adapters/V-Log-Alchemy-LICENSE.txt`)와 해시.
- 개발 서버처럼 index가 없으면 브라우저가 `/catalog.json`을 받아 같은 함수로 나눈다(`src/catalogLoader.ts`).

## 이전 앱 지원 (`LEGACY_LAYOUT`)
- 0.1.9 이하 데스크톱 앱은 `/catalog.json`과 모든 룩의 파일을 읽는다. 그래서 `LEGACY_LAYOUT = true`인 동안은 예전 파일을 모두 함께 배포한다.
- 앱 사용자가 업데이트를 마치면 `LEGACY_LAYOUT`을 `false`로 바꾼다. 그러면 `catalog.json`, 구울 필요가 없는 룩의 폴더, 룩마다 있던 README·라이선스·JSON이 빠진다.
  - 이때 룩마다 남는 파일은 `NNNNLUTS.zip`과 `NNNNCAMS.zip` 두 개다.
- 2026-11-25 기준 파일 수: 이전 앱 지원을 켜면 6,424개, 끄면 1,641개다(`luts/`는 5,290개에서 508개로 준다).
- 미리 확인하는 방법: `node scripts/prepare-cloudflare.mjs dist dist-cloudflare --no-legacy` → `scripts/package-source.mjs` → `scripts/verify-cloudflare.mjs`.

## 검사
`scripts/verify-split.mjs`에 있다.
- 이전 앱 지원을 켠 빌드: 나눈 목록이 `catalog.json`을 나눈 결과와 정확히 같아야 한다.
- 이전 앱 지원을 끈 빌드: 구운 룩의 파일만 남았는지, 해시가 맞는지, 브라우저가 만드는 룩마다 레시피와 인화 데이터가 있는지 본다.
