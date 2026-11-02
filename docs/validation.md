# 검증 기록 — 2026-11-02

## 생성 결과

- spektrafilm 0.3.4, commit `3bb2c2d2801ff68b92019cf1dbcbb133d60832bc`.
- 실제 프로파일 20개(negative 16, positive 4), printing 8개를 JSON 메타데이터와 런타임 CLI에서 확인.
- 네거티브 16 × 인화지 8 = **128개 성공**, 0개 실패. 각 조합 VLOG/STD `.cube`와 ZIP 포함.
- positive 4 × printing 8 = **32개 미지원**. 동일한 negative printing 경로에서 흑백 끝점의 명도 순서가 반전되는 것을 네 필름 모두 실제 엔진으로 확인하는 회귀 테스트를 작성했다. 별도 direct scan 경로는 후속 작업이다.
- LUT 파일 **256개**, 묶음 ZIP 128개, 이미지 512개. 전체 정적 자산 약 355 MiB.
- 프로덕션 배포는 원본 LUT 236.9 MiB를 무손실 gzip 90.1 MiB로 전송하여 `dist/` 전체를 약 213 MiB로 줄인다. 브라우저에서 원래 `.cube`로 복원하며, 256개 파일 전부 압축 해제한 SHA-256이 원본과 일치했다. ZIP은 변경하지 않는다.
- 이미 컴파일된 엔진/Numba 캐시 기준 3개 작업 프로세스로 39.03초. 조합별 소요 시간 합 112.398초. 가장 큰 작업 프로세스의 최고 RSS 563,101,696 bytes. 초기 설치·import·컴파일 시간은 포함하지 않는다.

## 수치 검사

각 조합에서 고정 시드 random RGB 4,096개, gray ramp 129개, 5³ grid 125개(총 4,350개)를 검사한다. 오차는 encoded sRGB 0–1에서 RGB 채널 절댓값 오차의 최댓값이며 perceptual ΔE가 아니다. 삼선형/사면체 보간을 모두 측정한다. 카메라의 실제 보간법은 확인되지 않았다.

아래는 **128개 조합 중 해당 통계의 최댓값**이다.

| 비교 (사면체 보간) | 평균 | 99백분위 | 최대 |
|---|---:|---:|---:|
| V-Log LUT ↔ 직접 엔진 | 0.003994 | 0.028817 | 0.261145 |
| STD LUT ↔ 연속 합성 | 0.001201 | 0.006981 | 0.015236 |

전체 V-Log 단위 도메인에는 극단 노출·색역 밖에 가까운 입력도 포함된다. 평균이 작아도 극단 입력에서 최대 오차가 크므로, 이를 모든 색에서의 정확한 일치로 해석하면 안 된다. UI에서 각 조합의 평균/99백분위/최대와 전체 QA JSON을 제공한다.

초기 엔지니어링 검토 플래그는 V-Log p99 > 0.05 또는 STD p99 > 0.02이다. 이는 보편적 지각 품질 합격선이 아닌 명시적인 검토 기준이다. 이번 빌드에서 이 플래그를 넘는 조합은 없다. 파일 검사와 카메라 검증 상태는 분리한다.

파일마다 35,937행, RGB 3채널, 유한한 값, 0–1 범위, 33 격자, Full range 도메인, TITLE 바로 다음의 사진 스타일 태그를 검사했다. writer의 소수점 여섯 자리 저장 후 최대 오차는 0.0000005 이하이다. 프로파일 해시, 엔진 commit, 설정, 코드 해시와 의존성 잠금 파일이 캐시 키에 포함된다.

## 자동 검사

`python -m pytest pipeline/tests -q`: **9 passed** (upstream GUI 의존성의 Pydantic deprecated 경고 1개).

- 공개 Panasonic 중간 회색/검정 앵커와 독립 colour-science 변환 비교.
- 비대칭 색 변환을 이용한 RGB/격자 순서, SciPy 보간, colour-science 파일 reader 교차 검사.
- 최종 STD 파일과 연속 합성 오차 검사, 단순 태그 변경 아님 확인.
- Portra 400/Portra Endura의 VLOG/STD 재생성 **바이트 단위 일치**.
- 슬라이드 필름 4종의 인화 경로 반전 확인.
- 128 ZIP의 실제 두 LUT·QA·설정 파일 해시 및 출처/라이선스 포함 검사.

`npm run verify:assets`: **160개 조합 상태, 256개 LUT, 1,152개 연결 자산 해시/크기** 확인.

`npm run build`: TypeScript 검사와 Vite 정적 빌드 통과. `npm audit`: 알려진 취약점 0개(실행 시점).

## 브라우저 검사

macOS Codex in-app browser에서 수행했다.

- Portra → Fujifilm C200, 인화지 → Crystal Archive, 사진 → astronaut 변경 후 올바른 자산 경로 확인.
- 비교 경계를 키보드로 50 → 51 조작.
- `0001STD.cube`, `0086VLOG.cube`, `0086LUTS.zip`을 UI에서 실제 다운로드하고 카탈로그 SHA-256과 일치 확인.
- 미지원 Provia의 다운로드 차단, 검색 결과 없음, 상세 정보 dialog 및 Escape 닫기 확인.
- 390×844 viewport에서 선택·미리보기·다운로드 점검. 페이지 가로 넘침/깨진 이미지 없음.
- 브라우저 console error/warning 없음.
- 프로덕션 preview에서도 gzip 전송 → `.cube` 복원 → 원본 해시 검증 → `0086STD.cube` 다운로드 흐름을 별도로 확인했다.

별도 Chrome, Edge, Safari 앱과 Windows 실기, S1M2/LUMIX Lab 카메라 가져오기는 **미검증**이다.

## STD 방식 선택

공개 수식을 직접 구현한 `analytic-srgb-vgamut-vlog-v1`을 제공한다. 공식 [Panasonic V-Log/V-Gamut reference](https://pro-av.panasonic.net/en/cinema_camera_varicam_eva/support/pdf/VARICAM_V-Log_V-Gamut.pdf)의 행렬과 인코딩식을 사용한다. [lumix-lut-converter](https://github.com/t0saki/lumix-lut-converter)에서 설명하는 수식 방식과 동일한 변환 순서이며 해당 프로젝트의 코드는 복사하지 않았다.

후보 B `V-Log-Alchemy`의 S1II 어댑터도 commit `e51ba9a23458ff5c316f630b860eb0201139d126`에서 확인했다. 20,000개 동일 입력에 두 어댑터와 동일 Portra 룩을 평가한 차이는 [adapter-comparison.json](adapter-comparison.json)에 있다. **두 방법 사이의 차이이며 정확도 순위가 아니다.** 실제 S1II 대조 촬영이 없어 명시적인 공개 수식 모델을 초기 기본값으로 골랐다. 모델 맞춤 어댑터는 비교에만 사용하고 배포 자산에는 넣지 않았다.

## 라이선스 기록

upstream 코드 `LICENSE`는 GPLv3, 별도 `SPEKTRAFILM_LICENSE.txt`는 프로파일/파생 LUT에 CC BY-SA 4.0을 명시한다. 고정 버전 README에는 CC BY-SA 표기와 과거 custom/no-resale 문구가 같이 남아 있다. 이를 임의로 합치지 않았으며 실제 라이선스 파일을 원문 그대로 포함했다. 변경 사항은 각 ZIP의 `CHANGELOG.txt`에 있다.

## 미리보기

scikit-image의 coffee(Rachel Michetti, CC0), astronaut(NASA, public domain), chelsea(Stefan van der Walt, CC0) 및 직접 만든 기술 패턴을 사용했다. 입력은 이미 표시용인 sRGB로 취급하고 디코딩 → V-Gamut → V-Log → 배포 VLOG LUT → sRGB로 평가했다. 웹 이미지는 sRGB ICC를 포함한다. 이는 룩 설명용 샘플이며 장면 선형/RAW 복원이나 카메라 Standard 실측 비교가 아니다.
