# Film Lab

필름·인화지 조합을 비교하고 LUMIX V-Log/Standard 입력용 `.cube`를 받는 React + TypeScript + Vite 웹앱입니다. 실제 spektrafilm 엔진으로 사전 생성한 결과를 정적 자산으로 제공합니다.

현재 **128개 조합 / 256개 LUT / 128개 ZIP**을 제공합니다. 각 ZIP은 두 LUT, 생성 설정, QA, 출처, 라이선스를 포함합니다. 필름 20종을 표시하며 네거티브 16종 × 인화지 8종이 준비되어 있습니다. 슬라이드 4종의 32개 조합은 현재 인화 경로에서 톤이 반전되어 제외했습니다. S1M2 실기 검증은 아직 하지 않았습니다.

## 웹앱 실행

Node.js 22.12 이상(이 개발 환경은 24.19.0), npm을 사용합니다. 이 Mac의 기본 Node가 오래된 경우 실행 스크립트가 설치된 Codex Node 런타임을 자동으로 사용합니다. 다른 환경에서는 Node.js 22.12 이상을 준비하세요. 이미 생성된 자산이 있으므로 웹앱 실행에 Python은 필요하지 않습니다.

```bash
cd film-lab
npm ci
npm run dev
```

브라우저에서 출력되는 로컬 주소를 엽니다. 정적 배포는 아래 명령으로 생성한 `dist/` 전체를 호스팅하면 됩니다. 기본 배포 경로는 `/`입니다.

```bash
npm run build
npm run preview
```

개발용 preview server는 127.0.0.1에만 바인딩됩니다. LUT를 JS 번들에 포함하지 않고 선택한 파일을 요청할 때 가져옵니다. 프로덕션 빌드는 LUT 전송용 파일에 무손실 gzip 압축을 적용하고 브라우저에서 원래 `.cube`로 복원합니다. 원본/ZIP의 LUT 내용은 바뀌지 않습니다. 다운로드 전 원본 파일 크기/SHA-256을 검사합니다. HTTPS 또는 localhost의 Web Crypto와 현대 브라우저의 DecompressionStream을 사용합니다.

## Python 환경과 재생성

upstream: https://github.com/andreavolpato/spektrafilm

- 버전 0.3.4, commit `3bb2c2d2801ff68b92019cf1dbcbb133d60832bc`
- Python 3.13.18, macOS arm64에서 실제 실행
- GUI 포함 원본 정식 의존성을 설치하되 생성 시 GUI를 열지 않음
- `pipeline/requirements.lock`에 검증한 전체 패키지 버전 고정

`uv`와 Git을 설치한 후 프로젝트 루트에서:

```bash
python3 scripts/bootstrap.py
.venv/bin/python -m pipeline.generate --jobs 3
```

Windows의 Python 실행 경로는 `.venv\Scripts\python.exe`입니다. 웹앱은 OS와 무관한 정적 앱이며, Windows에서 Python wheel 설치/생성은 별도 검증하지 않았습니다. 잠금 파일은 macOS 실행 환경 기준입니다.

현재 작업 폴더에서는 Python 환경과 upstream이 이미 준비되어 있습니다.

```bash
.venv/bin/python -m pipeline.generate --only kodak_portra_400__kodak_portra_endura --jobs 1
.venv/bin/python -m pipeline.generate --jobs 3
# 캐시를 건너뛰고 선택한 조합 재생성
.venv/bin/python -m pipeline.generate --only kodak_portra_400__kodak_portra_endura --force
```

캐시는 엔진 commit, 설정, 프로파일 내용, 파이프라인 소스와 의존성 잠금 파일의 해시를 사용합니다. 기존 파일의 해시도 확인하며 실패/손상/설정 변경 결과는 재생성합니다. 실패한 조합은 `failed`로 표시하고 다른 조합 생성은 계속합니다. 최종 catalog는 원자적으로 교체됩니다. 생성 중 사이트는 점진적으로 준비된 결과를 표시할 수 있으므로 완성된 배치를 검증한 뒤 배포하세요.

## 파일 위치

| 경로 | 내용 |
|---|---|
| `src/` | 한국어 선택·비교·다운로드 UI |
| `pipeline/config/default.json` | 명시적인 생성 설정 |
| `pipeline/generate.py` | 실제 엔진·STD 합성·QA·ZIP·카탈로그 |
| `public/catalog.json` | 실제 상태/자산/해시 |
| `public/luts/<film>__<paper>/` | `.cube`, ZIP, QA, provenance, 샘플 |
| `public/luts/kodak_portra_400__kodak_portra_endura/` | 기본 조합 (`0086VLOG.cube`, `0086STD.cube`, `0086LUTS.zip`) |
| `docs/validation.md` | 실행한 검사와 수치·제한 |
| `docs/camera-checklist.md` | S1M2 실기 확인 절차 |
| `licenses/`, `public/licenses/` | 원문 라이선스 |

## 색 변환 계약

V-Log/V-Gamut → 실제 필름·인화 시뮬레이션 → sRGB. 그레인, 할레이션, 블러, 자동 노출은 비활성화했습니다. upstream 입력 gamut compression과 CAM16-UCS 출력 gamut compression, 최종 bounded 출력 규칙을 사용합니다.

STD는 `L_std(x) = L_vlog(A_std(x))`를 33³ 격자에서 다시 샘플링합니다. `A_std`는 sRGB 디코딩 → 공개 행렬의 V-Gamut 변환 → Panasonic V-Log 인코딩입니다. `.cube` 태그만 바꾸지 않습니다. 두 파일 모두 최종 **sRGB 출력**이며 Rec.709와 구분합니다.

Standard의 비공개 톤 처리·노출/게인까지 역변환하는 모델이 아닙니다. S1II 기종별 후보와의 차이를 측정했지만 실측 정답이 없어 정확도 우열을 주장하지 않습니다. 선택 근거와 비교 결과는 `docs/validation.md`에 있습니다.

미리보기는 CC0/퍼블릭 도메인 sRGB 사진을 분석적으로 V-Log 재인코딩한 후 배포된 LUT를 적용한 공통 룩 예시입니다. 카메라 실측 STD 비교나 RAW 복원 결과가 아닙니다.

## 검증

```bash
.venv/bin/python -m pytest pipeline/tests -q
npm run verify:assets
npm run build
# 프로덕션 압축 전송 파일도 원본 해시와 대조
node scripts/verify-assets.mjs dist
```

9개 Python 테스트, 256개 LUT의 형식·수치, 1,152개 자산 해시, ZIP 내부 파일, 대표 조합의 바이트 단위 재현성을 확인했습니다. In-app browser에서 실제 세 종류 다운로드와 모바일 흐름을 검증했습니다. 별도 Chrome/Edge/Safari 앱, Windows, 카메라는 미검증입니다. 자세한 수치와 측정 한계는 [검증 기록](docs/validation.md)을 참고하세요.

## 출처

Derived from spektrafilm by Andrea Volpato. https://github.com/andreavolpato/spektrafilm

원본 소프트웨어와 이 프로젝트 코드는 GPLv3로 제공합니다. 프로파일 및 파생 LUT는 CC BY-SA 4.0이며 원본 라이선스를 각 ZIP에 그대로 포함했습니다. Film Lab에서 생성과 STD 합성을 수행한 변경 기록도 포함합니다. 제품명은 임시 이름이며 spektrafilm 또는 Panasonic의 공식 제휴를 뜻하지 않습니다.

사진: Rachel Michetti(coffee, CC0), Stefan van der Walt(chelsea, CC0), NASA(astronaut, public domain), 기술 테스트 패턴(Film Lab, CC0). 사진별 출처는 `public/samples/manifest.json`에 기록했습니다.
