# Claude 세션 인계

처음 작성: 2026-11-15(macOS → Windows 인계). 고침: 2026-11-16, Windows 작업이 끝난 뒤의 상태로 맞춤.
이 프로젝트를 이어 받는 Claude 세션(macOS, Windows 모두)은 이 문서를 먼저 읽고 시작합니다. 작업이 끝나면 이 문서를 지금 상태에 맞게 고칩니다.

**답변은 항상 한국어로 합니다.** 코드, 명령어, 식별자는 그대로 둡니다.

## 기술 개요

- sosang 웹앱을 바탕으로 만든 데스크톱 앱입니다.
  - 화면은 웹과 같은 React 코드(`src/`)를 씁니다.
  - 카메라 통신과 파일 처리는 Rust로 만들었습니다.
  - 앱 틀은 Tauri v2입니다.

### 카메라 통신

USB로 연결한 LUMIX와 PTP로 통신해서, SD 카드 없이 LUT 라이브러리를 읽고 씁니다. 명령의 세부는 코드(`crates/lumix-ptp`)에 있습니다.

- 설정 전체를 한 덩어리로 읽고, LUT 칸만 고친 뒤 체크섬을 다시 계산해서 통째로 씁니다.
- 쓰기 전에는 원본을 백업합니다. 쓴 뒤에는 다시 읽어 비교하고, 다르면 원본으로 되돌립니다.
- 운영체제별 전송 계층은 다음과 같습니다. 나머지(`crates/lumix-lut`, `crates/lumix-ptp/src/lib.rs`)는 공통입니다.
  - macOS `crates/lumix-ptp/src/mac.rs`
    - ImageCaptureCore를 씁니다.
  - Windows `crates/lumix-ptp/src/windows.rs`
    - WPD(Windows Portable Devices)를 씁니다.
    - 카메라는 Windows 기본 MTP 드라이버에 잡힌 그대로 둡니다. 드라이버를 바꾸지 않습니다.
    - MTP 제조사 확장 명령을 이 순서로 보냅니다: 실행 → 데이터 읽기/쓰기를 나눠 반복 → 전송 끝.
    - COM은 세션마다 하나씩 둔 작업 스레드에서만 다룹니다.
- 카메라 USB 모드는 **PC(Tether)**로 둡니다. LUMIX Tether 앱은 끕니다. 켜 두면 그 앱이 장치를 먼저 잡습니다.

자세한 근거는 아래 문서에 있습니다.
- `docs/camera-lut-library.md`: 설정 파일 구조, 안전 장치, 실기 확인 기록
- `docs/cloudflare.md`: 서버, 앱 릴리스 절차

## 지금까지 된 것 (브랜치 `feat/camera-lut-core`)

- macOS와 Windows 카메라 통신이 모두 끝났습니다. DC-S1M2 펌웨어 1.5, USB로 두 운영체제에서 확인했습니다.
  - 읽기를 확인했습니다.
  - 원본 그대로 다시 쓰고 읽어 보니 바이트가 같았습니다.
  - 테스트 LUT를 등록했고, 카메라에서 적용되는 것까지 봤습니다.
  - 앱 화면에서 등록, 삭제, 백업 되돌리기를 확인했습니다.
- 배포: macOS는 `.app` 업데이트, Windows는 NSIS 설치 파일입니다. 둘 다 업데이트 서명을 붙입니다.
  - `scripts/release-app.mjs`가 실행한 컴퓨터의 플랫폼(`darwin-aarch64` 또는 `windows-x86_64`)을 만듭니다.
  - 같은 버전의 다른 플랫폼 항목은 그대로 둡니다.
- 0.1.1(sosang 워드마크 아이콘)은 Windows판만 배포했습니다.
  - 2026-11-16에 서버 `/app/latest.json`을 확인했을 때 `windows-x86_64`만 있었습니다.

## 지켜야 할 규칙

- **카메라에 쓰는 작업(등록, 삭제, 되돌리기, 원본 그대로 쓰기)은 매번 사용자에게 허락을 받은 뒤에 합니다.** 읽기는 허락 없이 해도 됩니다.
- **카메라 시리얼 번호를 출력하거나 로그에 남기지 않습니다.**
  - Windows PnP 장치 ID에도 시리얼이 들어갈 수 있으므로 오류 메시지에 넣지 않습니다.
- **카메라 설정 캡처와 백업은 커밋하지 않습니다.** 해당 위치는 아래와 같고, 모두 `.gitignore`에 들어 있습니다.
  - `crates/**/fixtures/local/`
  - `camera-backups/`
  - 앱 데이터 폴더의 `camera-backups`
- `reddit-post/`는 건드리지 않고 커밋하지 않습니다.
- 커밋 메시지 끝에는 `Co-Authored-By` 줄을 넣습니다. 푸시와 배포는 사용자가 말할 때만 합니다.
- 업데이트 서명 키(`~/.tauri/sosang-updater.key`)를 저장소에 넣거나 채팅에 붙여 넣지 않습니다. macOS와 Windows는 같은 키로 서명합니다.

## 새 PC 준비

Windows에서 필요한 것:
- Git, Node.js 22.12 이상
- Rust(rustup, MSVC 툴체인)
- Visual Studio Build Tools의 "C++를 사용한 데스크톱 개발"
- WebView2: Windows 10/11 기본 포함

macOS에서는 Git, Node.js 22.12 이상, Rust, Xcode Command Line Tools가 필요합니다.

```bash
git clone -b feat/camera-lut-core https://github.com/lee-juncheol/sosang.git
cd sosang
npm ci
node scripts/run-web.mjs test
cargo test -p lumix-lut -p lumix-ptp
```

`lumix-lut`의 실기 캡처 테스트는 `tests/fixtures/local/`이 없으면 건너뜁니다. 정상입니다.

## 남은 일

- macOS판 0.1.1을 Mac에서 `release:app -- --version 0.1.1 --deploy`로 배포합니다. 그러면 업데이트 정보에 두 플랫폼이 모두 들어갑니다.
- Windows 코드 서명이 없어서 처음 설치할 때 SmartScreen 경고가 뜹니다. 서명할지는 사용자와 정합니다.
- macOS 공증과 웹사이트용 DMG는 아직 하지 않았습니다.
- `main`으로 보내는 PR은 아직 만들지 않았습니다.

## 보류한 것

- **Wi-Fi 연결은 보류했습니다.**
  - S1II의 Wi-Fi 테더링은 Capture One용입니다. LUMIX Tether는 S1II를 유선 LAN으로만 지원합니다.
  - 실제로 LUMIX Tether도 Wi-Fi로는 S1II를 찾지 못했습니다.
  - 그래서 LUT는 USB로만 넣습니다.
- 다른 LUMIX 기종은 읽기만 열려 있습니다. 쓰기는 사용자가 실험적 쓰기에 동의할 때만 합니다(`VERIFIED_FOR_WRITE`에 없는 기종).
