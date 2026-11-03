# Film Lab

FUJIFILM 공식 필름 시뮬레이션 LUT와 인화지 모델의 조합, 실제 필름 사진 참고색, 기존 필름·인화지 모델을 비교하는 React + TypeScript + Vite 웹앱입니다. LUMIX V-Log 및 Standard/sRGB 입력용 `.cube`와 미리보기를 정적 자산으로 제공합니다.

현재 **242개 룩 / 484개 LUT / 242개 ZIP**을 제공합니다. 기존 152개 룩은 네거티브 16종 × 인화지 8종의 128개 조합, 네거티브 디지털 스캔 16개, 슬라이드 직접 스캔 4개, 실사 참고색 4개입니다. 여기에 공식 FUJIFILM 시뮬레이션 10종 × (인화지 없는 출력 1개 + 프린트 재료 8개)의 **90개 합성 룩**을 추가했습니다. 각 ZIP은 두 LUT, 생성 설정, QA, 출처, 권리 안내를 포함합니다. GFX 및 S1M2 실기 검증은 아직 하지 않았습니다.

**BETA 0.6 / STD v3**는 기존 모델 148개와 후지 합성 90개, 총 **238개 STD LUT**에 JPG 톤 보호를 적용합니다. 이미 렌더링된 사진의 암부·밝은 부분이 과도하게 변하는 것을 줄이고, 네거티브 디지털 스캔의 갈색 블랙을 보정합니다. 실사 참고색 4종에는 이 보호를 추가하지 않습니다. 원본 사진과 V-Log LUT는 이 STD 보정의 대상이 아닙니다.

기본 모드는 **FUJI 공식 LUT + 인화지**, 기본 조합은 **CLASSIC CHROME + Fujifilm Crystal Archive Type II**입니다. GFX ETERNA 55 공식 패키지 v1.10의 F-Log2 / F-Gamut 시뮬레이션 LUT 10종을 사용하며, 공식 LUT를 색상 기준으로 삼은 직접 출력과 인화지 모델을 더한 출력을 전환할 수 있습니다. 두 STD 출력 모두 Film Lab의 JPG 톤 보호를 포함하므로 공식 LUT의 대비·색편향을 그대로 보존한 결과는 아닙니다. JPG/sRGB 입력 변환과 가상 인화 노출 연결은 Film Lab의 근사이며, 실제 GFX 촬영이나 FUJIFILM 공식 인화 레시피의 재현은 아닙니다. 사진 인화지 6종과 영화용 프린트 필름 2383·2393을 구분합니다. 기존 필름 20종과 실사 참고색 4종은 별도 모드에서 유지합니다. [공식 LUT 출처·변환·권리 안내](docs/fujifilm-official.md)를 참고하세요.

네거티브에서는 **인화지 인화 / 디지털 스캔**을 선택할 수 있습니다. 디지털 스캔은 인화 단계 대신 공통 가상 RGB 센서·회색 기준·톤 함수를 적용하고 STD에서는 JPG 톤 보호를 거치는 Film Lab 확장 모델입니다. 원작자의 공식 룩 또는 실측 상용 스캐너의 재현이 아닙니다. [디지털 스캔 수식과 검증](docs/digital-scan.md)에 고정 계수와 한계를 기록했습니다.

슬라이드 **Fujifilm Provia 100F · Velvia 100 · Kodak Ektachrome 100 · Kodachrome 64**를 선택하면 인화지 선택이 비활성화되고 `인화지 없음 · 필름 직접 스캔`으로 표시됩니다. 네거티브로 돌아오면 이전 인화지 선택이 복원됩니다. 샘플과 내 사진 미리보기, V-Log/STD/ZIP 다운로드를 모두 지원합니다. [슬라이드 구현 기록](docs/slide-support.md)을 참고하세요.

별도 모드 **실제 필름 사진 참고**는 Portra 400 · Gold 200 · Pro 400H · 구형 C200의 실제 필름 촬영·스캔 자료를 검토해 조정한 Film Lab 해석입니다. 참고 대상과 디지털 생성 결과를 구분하며, 출처별 노출·현상·스캐너·후보정과 미상 항목을 표시합니다. 기존 148개 모델 룩은 그대로 선택할 수 있습니다. 새 모드는 필름·인화지 계산을 거치지 않고 별도의 색·톤 변환을 적용합니다. [조사 기준과 변환 계약](docs/reference-looks.md)을 참고하세요.

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

FUJI 공식 모드의 배포용 샘플 미리보기는 다운로드용 STD LUT로 브라우저에서 직접 계산합니다. 생성·QA용 WebP는 로컬 `public/`에 보존하고, 배포에서는 중복 이미지 540개를 생략합니다. 이미지 해상도나 LUT 수치는 줄이지 않으며, 업로드 사진과 같은 처리 경로를 사용합니다.

개발용 preview server는 127.0.0.1에만 바인딩됩니다. LUT를 JS 번들에 포함하지 않고 선택한 파일을 요청할 때 가져옵니다. 프로덕션 빌드는 기존 조합별 ZIP 한 벌을 LUT 전송에도 사용해, 개별 `.cube`의 별도 전송 사본을 배포하지 않습니다. manifest의 `encoding: "zip-entry"`에 따라 브라우저가 ZIP의 크기/SHA-256을 확인한 뒤 선택한 `.cube`를 무손실 압축 해제하고, 원본 LUT의 크기/SHA-256을 다시 확인합니다. 이 파일을 미리보기와 개별 LUT 다운로드에 사용하며 ZIP 다운로드도 지원합니다. 로컬 `public/`의 원본 `.cube`·ZIP은 그대로 유지하고, 전송 방식 변경으로 LUT 바이트나 이미지 품질은 달라지지 않습니다. HTTPS 또는 localhost의 Web Crypto와 현대 브라우저의 DecompressionStream을 사용합니다.

## 내 사진으로 미리보기

미리보기 아래 **사진 업로드**를 누르거나 업로드 영역에 파일을 끌어놓습니다. JPG/JPEG·PNG·WebP 한 장(최대 30 MiB, 8,000만 화소)을 읽습니다. HEIC·RAW는 먼저 JPG로 변환해야 합니다. 사진 바꾸기, 제거, 기본 샘플과 내 사진 사이의 전환을 지원합니다.

사진은 서버로 보내지 않고 브라우저 메모리에서만 처리합니다. 새로고침하면 사라지고 원본 파일은 변경하지 않습니다. 브라우저 디코더가 EXIF 방향을 반영한 후 sRGB canvas로 변환하며 미리보기의 긴 변은 최대 2,048px입니다. 업로드 사진의 Standard/LUT OFF 여부는 자동 판독하지 않습니다. STD·LUT OFF 촬영본을 권장합니다.

선택한 다운로드용 STD LUT를 SHA-256/크기로 확인하고 Web Worker에서 사면체 보간을 적용합니다. 필름·인화지 변경 시 진행 중인 작업을 취소하고 마지막 선택을 렌더링합니다. 원본·비교·적용 보기와 키보드 비교 슬라이더를 동일하게 사용할 수 있습니다. 결과는 PNG로 표시해 추가 손실 압축을 하지 않습니다. 이미지 파일 자체의 다운로드 기능은 제공하지 않습니다.

## Cloudflare 공개 배포

Cloudflare Workers Static Assets용 설정은 `wrangler.jsonc`에 있습니다. 기존 Sites용 `dist/`와 별도로 `dist-cloudflare/`를 생성하며, 공개 배포 허가를 확인하지 못한 FUJIFILM 공식 LUT 기반 90개 합성 룩은 공개 산출물에서 제외합니다. 기존 모델과 실사 참고색 152개 룩, 내 사진 미리보기와 LUT 다운로드를 제공합니다. 개인용 원본과 LUT는 변경하지 않습니다.

```bash
npm run build:cloudflare
npm run preview:cloudflare
npm run cloudflare:login
npm run deploy:cloudflare
```

계정 가입·이메일 인증 후 공식 Wrangler 연결을 승인해야 배포할 수 있습니다. 기본 주소는 Cloudflare가 반환하는 `workers.dev` 주소이며, 현재 설정은 서버 실행 코드 없이 정적 자산만 제공합니다. 배포 절차·권리 구분·캐시 정책은 [Cloudflare 배포 문서](docs/cloudflare.md)를 참고하세요.

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
.venv/bin/python -m pipeline.generate_research
.venv/bin/python -m pipeline.generate_fuji --download --jobs 2
```

Windows의 Python 실행 경로는 `.venv\Scripts\python.exe`입니다. 웹앱은 OS와 무관한 정적 앱이며, Windows에서 Python wheel 설치/생성은 별도 검증하지 않았습니다. 잠금 파일은 macOS 실행 환경 기준입니다.

현재 작업 폴더에서는 Python 환경과 upstream이 이미 준비되어 있습니다.

```bash
.venv/bin/python -m pipeline.generate --only kodak_portra_400__kodak_portra_endura --jobs 1
.venv/bin/python -m pipeline.generate --only fujifilm_velvia_100__direct_scan --jobs 1
# 기존 인화/슬라이드 파일을 보존하고 네거티브 디지털 룩만 추가/갱신
.venv/bin/python -m pipeline.generate --digital-only --jobs 3
.venv/bin/python -m pipeline.generate --jobs 3
# 캐시를 건너뛰고 선택한 조합 재생성
.venv/bin/python -m pipeline.generate --only kodak_portra_400__kodak_portra_endura --force
```

전체 카탈로그의 재생성 순서는 `pipeline.generate` → `pipeline.generate_research` → `pipeline.generate_fuji --download --jobs 2`입니다. 기존 모델 생성 후 실사 참고색 4종과 공식 FUJIFILM 합성 룩 90개를 순서대로 추가합니다. 후지 생성기는 기존 152개 룩의 레코드와 연결 자산을 검증하고 보존합니다. 공식 패키지와 원본 LUT의 SHA-256이 기록된 값과 다르면 생성을 중단합니다. 원본 패키지는 로컬 캐시에 보관하며 공개 자산에는 중복 배포하지 않습니다.

캐시는 엔진 commit, 설정, 프로파일 내용, 파이프라인 소스, 의존성 잠금 파일, 샘플 manifest와 이미지의 해시를 사용합니다. 기존 파일의 해시도 확인하며 실패/손상/설정 변경 결과는 재생성합니다. 실패한 조합은 `failed`로 표시하고 다른 조합 생성은 계속합니다. 최종 catalog는 원자적으로 교체됩니다. 생성 중 사이트는 점진적으로 준비된 결과를 표시할 수 있으므로 완성된 배치를 검증한 뒤 배포하세요.

## 파일 위치

| 경로 | 내용 |
|---|---|
| `src/` | 한국어 선택·비교·다운로드 UI |
| `pipeline/config/default.json` | 명시적인 생성 설정 |
| `pipeline/generate.py` | 실제 엔진·STD 직접 계산·QA·ZIP·카탈로그 |
| `pipeline/slide.py` | 슬라이드 직접 스캔용 builder 및 독립 런타임 QA |
| `pipeline/research.py`, `pipeline/generate_research.py` | 실제 필름 사진 참고색의 독립 변환·생성 |
| `pipeline/config/reference-looks.json` | 실제 촬영 출처, 조건, 제외 기준, 편집 계수 |
| `pipeline/fuji.py`, `pipeline/generate_fuji.py` | 공식 FUJIFILM LUT의 입력·출력 변환, 인화 연결, 합성 자산 생성 |
| `pipeline/config/fujifilm-official.json` | 공식 배포처, 원본 파일·해시, 변환 계약 |
| `pipeline/digital.py` | 공통 RGB 스캐너·네거티브 양화 모델 및 LUT builder |
| `pipeline/jpg.py` | STD 전용 중성 응답 보상·밝기 보호·중성 색편향 제거 |
| `public/catalog.json` | 실제 상태/자산/해시 |
| `public/luts/<film>__<paper>/` | `.cube`, ZIP, QA, provenance, 샘플 |
| `public/luts/kodak_portra_400__kodak_portra_endura/` | 기존 모델의 Portra 400 / Endura 조합 (`0086VLOG.cube`, `0086STD.cube`, `0086LUTS.zip`) |
| `docs/fujifilm-official.md` | 공식 FUJIFILM LUT와 인화지 연결의 계약·한계·검증 |
| `docs/validation.md` | 실행한 검사와 수치·제한 |
| `docs/camera-checklist.md` | S1M2 실기 확인 절차 |
| `licenses/`, `public/licenses/` | 원문 라이선스 |

## 색 변환 계약

### JPG 톤 보호 v3

현재 STD v3는 각 색상 모델의 연속 계산 뒤에 `pipeline/jpg.py`의 **`film-lab-jpg-tone-protection-v1`**을 적용하고 최종 33³ LUT를 만듭니다. 기존 모델의 STD v2 직접 계산과 후지 v2의 입력·인화 연결은 기반 단계로 유지합니다. 중간 V-Log LUT를 다시 보간하지 않으며, 다운로드용 STD 파일을 사용할 때 최종 격자 보간 한 번이 필요합니다. V-Log는 기존 생성 경로를 유지하고 JPG 톤 보호를 적용하지 않습니다. 두 형식 모두 최종 **sRGB 출력**입니다.

보호 기준은 사진마다 맞추지 않습니다. 각 룩에서 encoded sRGB 회색 4,097개의 고정 응답을 계산하고, 각 입력 픽셀과 같은 선형 휘도의 중성 응답을 참조합니다. 인화·슬라이드·후지 합성은 중성 톤 변화의 **20%**, 네거티브 디지털은 **0%**를 남기도록 보상합니다. 그 뒤 원본의 지각 밝기(OKLab L)에서 벗어나는 폭을 부드럽게 제한합니다. 이 계수는 LUT 강도가 아니며, 미리보기는 완성된 STD LUT를 100% 적용합니다.

```text
Lraw = Lmodel + (1 - retention) × (cuberoot(inputY) - Lneutral)
limit = min(0.028 + 0.012 × exp(-((Lsource - 0.6) / 0.2)^2),
            0.5 × min(Lsource, 1 - Lsource))
Ltarget = Lsource + limit × tanh((Lraw - Lsource) / limit)
ab = (ab_model - ab_neutral) × clip(Ltarget / Lmodel, 0, 3)
```

끝점의 나눗셈은 별도로 처리하고 정확한 검정·흰색을 보존합니다. 같은 밝기의 중성 색편향을 제거하며, sRGB 밖의 색은 OKLab 밝기와 색상 방향을 고정한 채 채도를 줄여 범위에 넣습니다. 디지털 스캔의 갈색 블랙은 이 중성 보상으로 줄입니다. 원본에 없는 디테일을 생성하거나 사진 전체 노출을 올리는 처리는 아닙니다. 사진 통계, 사진별 자동 노출·화이트밸런스, 샤픈은 사용하지 않습니다.

기존 spektrafilm 모델의 기반 계산은 인화 모드에서 필름·인화 시뮬레이션, 슬라이드에서 필름 현상·직접 스캔을 실행합니다. 네거티브 디지털은 인화를 우회하고 D50·공통 Gaussian RGB 센서·감마 0.60·회색 0.184와 공통 톤 함수로 양화합니다. STD의 선형 입력 배율은 **1.0배**이며 upstream의 2.88배 입력을 추가하지 않습니다. 그레인·할레이션·블러·자동 노출도 비활성화합니다.

후지 기반 계산은 공통 PROVIA 중성 응답 역산으로 JPG 입력을 근사한 뒤 F-Gamut/F-Log2와 공식 65³ LUT를 사용합니다. 공식 출력을 BT.709 원색·감마 2.2로 해석하며, 선택한 경우 인화지 현상·분광 스캔을 연결합니다. **v3 STD는 이 기반 출력 뒤에 JPG 톤 보호를 추가합니다.** 따라서 공식 원본 파일은 보존하지만 최종 톤·중성 색조·재료의 검정·흰색 한계를 그대로 전달하지는 않습니다. [공식 LUT 문서](docs/fujifilm-official.md)에 v1·v2 이력과 현재 v3 계약을 구분했습니다.

이는 Film Lab의 JPG 표시 정책이며 실측 카메라 역변환, 원작자 기본 톤, FUJIFILM 공식 JPG·인화 레시피가 아닙니다. 모델의 색상 차이를 기준으로 사용하되 밝기·대비와 색역 경계의 채도는 달라집니다. 같은 인화지의 필름 룩이 비슷할 수 있는 기반 모델의 중성 인화 정규화와 공통 DIR coupler 근사도 남아 있습니다. 필름 이름별 채도를 따로 키우지는 않습니다. 실물 정확도에는 동일 장면의 통제된 필름·디지털 촬영과 현상·스캔 기준이 필요합니다.

Standard의 비공개 톤 처리·노출/게인까지 역변환하는 모델이 아닙니다. S1II 기종별 후보와의 차이를 측정했지만 실측 정답이 없어 정확도 우열을 주장하지 않습니다. 선택 근거와 비교 결과는 `docs/validation.md`에 있습니다.

미리보기는 사용자 촬영 S1M2 Standard 사진 5장(P1458403, P1458391, PANA8578, PANA8619, P1458338)과 sRGB 기술 패턴을 사용합니다. EXIF의 Standard / 두 LUT 강도 0을 확인한 촬영본만 선택했습니다. 축소·방향 정리한 원본에 **다운로드용 STD LUT를 직접 100% 적용**하며, 감마/V-Log 변환을 추가하지 않습니다. 원본·비교·적용 세 보기로 확인할 수 있습니다. 내보내기 형식 선택과 미리보기는 독립적이며 미리보기는 항상 STD 기준입니다. 첫 화면은 야외 놀이터 전경이며 노란 놀이 패널의 세로 사진도 선택할 수 있습니다. 카메라 내부에서 LUT를 적용한 결과와의 일치 검증이나 RAW 복원은 아닙니다.

`assets/samples/`에는 재현용 최대 960–1024px 무손실 WebP와 원본 해시·선별 EXIF 기록이 있습니다. 공개 이미지에는 sRGB ICC만 남기고 EXIF는 제거했습니다. 242개 룩의 출력은 WebP quality 90 미리보기이며 원본 전체 해상도 사진은 배포하지 않습니다.

## 검증

```bash
.venv/bin/python -m pytest pipeline/tests -q
npm test
npm run verify:assets
npm run build
# 프로덕션 ZIP 전송과 추출한 LUT도 원본 해시와 대조
npm run verify:assets -- dist
```

Python 테스트와 업로드 렌더러의 JavaScript 테스트로 색 변환, 슬라이드·디지털 모드의 인화지 독립성, 선택된 연속 모델과의 오차를 확인합니다. 디지털 모드는 독립 파장 적분 기준으로도 검증합니다. 자산 검증은 484개 LUT와 2,662개 연결 자산의 해시·크기, ZIP 내부 파일을 검사합니다. 디지털 모드 도입 당시 기존 인화/슬라이드 1,980개 파일의 바이트 보존을 확인했습니다. 이 수치는 과거 추가 작업의 기록이며, STD v3의 갱신 자산에 대한 해시 불변 주장으로 사용하지 않습니다. 최신 실행 결과는 검증 기록에 있습니다. 기존 In-app browser 검증과 새 디지털 모드 검증 범위는 [검증 기록](docs/validation.md)을 참고하세요. 별도 Chrome/Edge/Safari 앱, Windows, 카메라는 미검증입니다.

## 출처

Derived from spektrafilm by Andrea Volpato. https://github.com/andreavolpato/spektrafilm

원본 spektrafilm 소프트웨어와 이 프로젝트 코드는 GPLv3로 제공합니다. 기존 spektrafilm 프로파일 기반 148개 룩과 Film Lab 실사 참고색 4개, 총 152개 룩의 LUT는 CC BY-SA 4.0으로 제공하며 해당 라이선스를 ZIP에 포함합니다. Film Lab에서 수행한 LUT 생성과 STD 입력 직접 계산의 변경 기록도 포함합니다.

새로운 공식 FUJIFILM 기반 90개 합성 룩은 위 152개 룩과 권리 범위를 구분합니다. 원본 LUT 데이터의 권리는 FUJIFILM에 있으며, 이를 포함한 합성 LUT 전체에 CC BY-SA를 일괄 부여하지 않습니다. spektrafilm 인화지 모델과 공유 도구의 출처 및 구성요소별 라이선스는 유지합니다. 공식 원본의 다운로드 출처와 권리 안내는 [공식 LUT 문서](docs/fujifilm-official.md)에 있습니다. Film Lab은 FUJIFILM, spektrafilm 또는 Panasonic의 공식 제휴 제품이 아닙니다.

사진: 사용자 촬영, 모든 권리는 촬영자에게 있습니다. 사진은 코드 GPLv3 및 LUT CC BY-SA 라이선스의 적용 대상이 아닙니다. 기술 테스트 패턴은 Film Lab, CC0입니다. 사진별 원본 해시, 카메라 설정, 준비 과정은 `public/samples/manifest.json`에 기록했습니다. 사이트 접근 권한은 기존 소유자 비공개 상태를 유지합니다.
