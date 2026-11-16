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

## 지금까지 된 것 (`main`에 합침, 2026-11-16)

- macOS와 Windows 카메라 통신이 모두 끝났습니다. DC-S1M2 펌웨어 1.5, USB로 두 운영체제에서 확인했습니다.
  - 읽기를 확인했습니다.
  - 원본 그대로 다시 쓰고 읽어 보니 바이트가 같았습니다.
  - 테스트 LUT를 등록했고, 카메라에서 적용되는 것까지 봤습니다.
  - 앱 화면에서 등록, 삭제, 백업 되돌리기를 확인했습니다.
- 배포: macOS는 `.app` 업데이트, Windows는 NSIS 설치 파일입니다. 둘 다 업데이트 서명을 붙입니다.
  - `scripts/release-app.mjs`가 실행한 컴퓨터의 플랫폼(`darwin-aarch64` 또는 `windows-x86_64`)을 만듭니다.
  - 같은 버전의 다른 플랫폼 항목은 그대로 둡니다.
- 사진 보내기(`#send`, `docs/photo-sending.md`). Windows에서도 빌드와 테스트가 통과했고, 실제 사진으로는 아직 시험하지 않았습니다.
- 카메라에서 고른 LUT는 사진 모드와 영상 모드를 모두 읽고, 어느 쪽에서든 고른 칸은 지우지 않습니다. 사진 모드에 LUT가 없을 때 지우기가 모두 막히던 문제를 고쳤습니다.
- LUT 위치 바꾸기: 화면에서 순서를 다 바꾼 뒤 한 번에 씁니다(`docs/camera-lut-library.md`의 "위치 바꾸기"). Windows 실기로 확인했습니다.
- 여러 개 지우기 확인 창은 체크하면 표 아래에 붙어 화면 하단을 따라옵니다.
- 배포 현황(2026-11-17): **Windows 0.1.2**까지 배포했습니다(위 세 가지와 사진 보내기 포함). **macOS는 0.1.0**에 머물러 있고, 서버 `/app/latest.json`에는 `windows-x86_64`만 있습니다.
- GitHub 릴리스는 버전 없는 대표 페이지 하나(태그 `app`)로 바꿨습니다. 배포할 때 `--github`를 붙이면 그 페이지의 설치 파일과 버전 줄이 갱신됩니다(`docs/cloudflare.md`의 "앱 릴리스").

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
git clone -c core.autocrlf=false https://github.com/lee-juncheol/sosang.git
cd sosang
npm ci
node scripts/run-web.mjs test
cargo test -p lumix-lut -p lumix-ptp
```

`lumix-lut`의 실기 캡처 테스트는 `tests/fixtures/local/`이 없으면 건너뜁니다. 정상입니다.

## macOS에서 할 일 (Windows 0.1.2까지 반영)

Mac 세션은 이 절부터 처리하고, 끝난 항목은 지웁니다.

1. `git pull`(브랜치 `feat/camera-lut-core`). `gh`가 없으면 설치하고 `gh auth login`으로 저장소 주인 계정에 로그인합니다.
2. 테스트: `node scripts/run-web.mjs test`, `cargo test -p lumix-lut -p lumix-ptp -p photo-courier`.
   - 새 실기 테스트(사진·영상 선택, 위치 바꾸기)는 Windows에서 만든 캡처(`s1m2_fw15_photo37_video_none.bin` 등)를 쓰므로 Mac에서는 건너뜁니다. Mac의 기존 캡처로 도는 테스트는 `selected_entries()`(목록)로 바뀐 검사를 통과해야 합니다.
3. 실기 확인(쓰기는 사용자 허락 후). Windows에서 확인한 것을 macOS 전송(`mac.rs`)으로 다시 봅니다.
   - 사진 모드를 스탠더드(LUT 없음)로 두고 목록을 읽으면 지우기가 열리는지, 영상 모드에서 고른 칸에 "카메라에서 선택됨"이 붙는지(읽기만).
   - 위치 바꾸기로 두 칸을 맞바꾸고 카메라에서 적용되는지.
   - 사진 보내기는 macOS 디버그 앱에서 이미 확인했습니다.
4. 배포: `npm run release:app -- --version 0.1.2 --notes "<바뀐 점>" --deploy --github`
   - 버전이 이미 0.1.2라 `--version`은 빼도 됩니다. 서버의 Windows 0.1.2 항목을 받아 함께 싣기 때문에 두 플랫폼이 모두 들어갑니다.
   - `--github`가 DMG를 만들어 릴리스 페이지의 `sosang-mac-apple-silicon.dmg`를 바꾸고, Mac 버전 줄을 0.1.2로 고칩니다. 지금 그 파일은 0.1.0 DMG입니다.
   - 배포 뒤 `/app/latest.json`에 `darwin-aarch64`와 `windows-x86_64`가 모두 있는지 확인합니다.
5. Mac 0.1.1은 배포하지 않고 건너뜁니다. 설치된 Mac 0.1.0은 0.1.2로 바로 업데이트됩니다.

## 남은 일

- 위 "macOS에서 할 일".
- Windows 코드 서명이 없어서 처음 설치할 때 SmartScreen 경고가 뜹니다. 서명할지는 사용자와 정합니다.
- macOS 공증은 아직 하지 않았습니다.
- 저장소에 CI가 없어서 테스트는 손으로 돌립니다.
- 사진 보내기를 Windows에서 실제 JPG로 시험합니다.
- 사용자 피드백: 파일 검증(쓰기 뒤 다시 읽기)이 가끔 1분쯤 걸린다고 합니다. Windows에서 같은 내용을 3번 다시 쓸 때는 매번 5.5초였고 재현되지 않았습니다. 내용이 바뀌는 쓰기에서 늦어지는지, macOS 카메라 찾기가 늦은지 데이터를 더 모은 뒤 다시 봅니다.
- 스튜디오의 "카메라에 바로 등록"은 한 번에 LUT 하나라, 여러 개를 넣으면 매번 25초와 백업 하나가 생깁니다. 백업은 지워지지 않고 쌓입니다(8.8MB씩). 묶어 넣기와 백업 개수 제한은 아직 하지 않았습니다.

## 작업 기록

세션마다 무엇을 했고 무엇이 걸렸는지 짧게 남깁니다. 결과(지금 상태)는 위 절에, 경위와 다음 세션이 알아야 할 점은 여기에 둡니다.

### 2026-11-15 ~ 16, Windows 11 (첫 Windows 세션)

**준비**
- Rust(MSVC)와 VS Build Tools(C++ 데스크톱 개발)를 winget으로 설치했습니다. Git, Node, WebView2는 이미 있었습니다.
- 저장소가 7.8GB라 받는 데 5분 넘게 걸립니다.
- 이 PC의 git 전역 설정이 `core.autocrlf=true`여서, 받은 텍스트 파일이 CRLF로 바뀌고 바이트를 비교하는 테스트가 실패했습니다. 저장소에 `core.autocrlf=false`를 설정하고 다시 받았습니다. 새로 받을 때는 `git clone -c core.autocrlf=false`를 씁니다.
- 커밋 작성자는 macOS와 같은 `dlwnscjf11`입니다(저장소 설정).

**코드**
- Windows 경로 문제를 고쳤습니다(`5f6b8417`, `d31dddcd`).
  - `URL.pathname`을 파일 경로로 쓰면 `C:\C:\...`가 됩니다. `fileURLToPath`를 씁니다.
  - `/public` 같은 가짜 루트는 `path.resolve`에서 `C:\public`이 됩니다.
  - Windows `tar` 목록은 줄 끝이 CRLF입니다.
- `windows.rs`를 WPD로 만들었습니다(`5f6b8417`). 저장소 안의 `windows` 모듈과 `windows` 크레이트 이름이 겹치므로, 모듈 안에서는 `::windows::`로 크레이트를 부릅니다.
- `release-app.mjs`에 Windows(NSIS)를 추가했고, 같은 버전의 다른 플랫폼을 서버에서 받아 함께 싣게 했습니다(`e1529974`). `--version`은 `package-lock.json`도 고칩니다(`3bd47b45`).

**실기 확인**
- 결과는 `docs/camera-lut-library.md`의 실기 확인 기록에 있습니다.
- 사용자가 확인 중에 37~39번 칸의 FUJI LUT를 앱에서 지웠습니다. 그 전 백업은 앱 데이터 폴더에 있습니다.
- 카메라가 PC에 안 잡힐 때는 Windows USB 장치 목록에 Panasonic(VID `04DA`)이 없었습니다. 포트나 케이블을 바꾸니 휴대용 장치 "DC-S1M2"로 잡혔습니다. 앱 문제와 구분할 때 이 목록을 먼저 봅니다.

**배포**
- 서명 키를 macOS에서 옮겨 `%USERPROFILE%\.tauri\sosang-updater.key`에 두었습니다. 비밀번호는 터미널에서 사용자가 직접 입력합니다. Claude의 셸은 대화형이 아니라서 비밀번호 입력, GitHub 로그인, Cloudflare 로그인은 앱의 터미널 탭에서 실행합니다.
- 0.1.0 Windows를 macOS 0.1.0과 같은 업데이트 정보로 배포했고, 이어서 아이콘을 바꾼 0.1.1(Windows만)을 배포했습니다.
- 설치된 0.1.0이 배너에서 0.1.1로 업데이트되는 것을 확인했습니다. 업데이트 뒤 바탕화면 아이콘이 한동안 예전 그림으로 보였는데, 탐색기 아이콘 캐시 탓이었고 시간이 지나 바뀌었습니다.
- Cloudflare(`wrangler login`)와 GitHub(`gh auth login`, 계정 `lee-juncheol`)에 이 PC에서 로그인해 두었습니다.

**GitHub**
- 릴리스 v0.1.0을 "sosang for Mac & Windows"로 고쳤습니다.
  - Windows 0.1.1 설치 파일(`sosang_0.1.1_x64-setup.exe`)을 첨부했습니다.
  - 그래서 지금 한 릴리스에 Mac 0.1.0 DMG와 Windows 0.1.1이 섞여 있습니다. macOS 0.1.1이 나오면 v0.1.1 릴리스를 새로 만들어 맞춥니다.
- PR #1(https://github.com/lee-juncheol/sosang/pull/1, `feat/camera-lut-core` → `main`)을 만들고 2026-11-16에 머지 커밋으로 합쳤습니다. `feat/camera-lut-core` 브랜치는 지우지 않았고, 합친 뒤의 `main`과 같게 맞춰 두었습니다.

### 2026-11-16, Windows 11 (두 번째 Windows 세션)

- GitHub 기록을 다시 쓴 뒤의 재동기화를 안내대로 했습니다. 이 PC에만 있던 변경은 없었고, 옛 기록과의 차이는 Mac에서 지운 문서 5줄뿐이었습니다. 이 문서에 적힌 커밋 번호도 새 번호로 바꿨습니다.
- 사진 보내기: `photo-courier`(libwebp 포함)가 MSVC로 빌드되고 `cargo test -p photo-courier` 10개, 웹 테스트 105개가 통과했습니다. 앱의 사진 보내기 화면도 뜹니다(단축키 안내가 Ctrl+Enter).
- 사용자 제보: S1M2를 쓰는 사용자의 LUT 관리에서 체크박스와 삭제가 모두 꺼져 있었습니다("선택된 LUT를 읽지 못해 지우기를 막아 두었습니다").
  - 원인: 사진 모드에서 LUT를 쓰지 않으면 선택 항목 값이 42("LUT 없음")인데, 앱이 이것을 "못 읽음"으로 처리했습니다. 영상 모드 선택은 별도 항목(`0x530`)에 있습니다.
  - 카메라 모드를 바꿔 가며 읽기만으로 확인했고, 자세한 구조는 `docs/camera-lut-library.md`의 "삭제와 선택 상태"에 적었습니다.
  - `SettingsBlob::selected_entries`가 두 항목을 읽어 고른 칸 목록을 돌려줍니다. 앱(`Library.selected`)도 숫자 하나에서 목록으로 바뀌었습니다.
  - 확인에 쓴 캡처는 `crates/lumix-lut/tests/fixtures/local/`(git 제외)에 `s1m2_fw15_photo37_video_none.bin`, `s1m2_fw15_photo37_video1.bin`, `s1m2_fw15_photo_none_video1.bin`로 두었습니다. macOS에는 없으니 그쪽에서는 이 테스트가 건너뜁니다.
- 확인 뒤 카메라는 사진 모드 스탠더드, 영상 모드 ARRI 709인 상태입니다(사용자가 직접 바꿈).

### 2026-11-17, Windows 11 (세 번째 Windows 세션)

- 여러 개 지우기 확인 창을 표 아래로 옮기고 화면 하단에 붙도록 했습니다(`position: sticky`).
- LUT 위치 바꾸기를 넣었습니다: `SettingsBlob::rearranged`, `lumix_ptp::rearrange_luts`, 앱 명령 `camera_rearrange_luts`, LUT 관리의 "위치 바꾸기"(끌어다 놓기와 ↑↓로 두 칸 맞바꾸기, 다 옮긴 뒤 한 번에 적용).
  - 실기: 29↔30번을 맞바꿔 바이트 단위로 확인했고, 카메라에서도 맞게 적용됐습니다. 사용자 뜻으로 되돌리지 않았습니다.
- 검증 시간 피드백은 재현되지 않아 보류했습니다(위 "남은 일").
- Windows 0.1.2를 배포했고, GitHub 릴리스를 대표 페이지(태그 `app`)로 바꿨습니다.
  - 기존 v0.1.0 릴리스를 태그 `app`으로 옮겼습니다. 주소가 `/releases/tag/v0.1.0`에서 `/releases/tag/app`으로 바뀌었고, 저장소 안에는 옛 주소를 쓰는 곳이 없었습니다. git 태그 `v0.1.0`은 그대로 둡니다.
  - Mac DMG는 이름만 `sosang-mac-apple-silicon.dmg`로 바꿨고, 내용은 여전히 0.1.0입니다.

## 보류한 것

- **Wi-Fi 연결은 보류했습니다.**
  - S1II의 Wi-Fi 테더링은 Capture One용입니다. LUMIX Tether는 S1II를 유선 LAN으로만 지원합니다.
  - 실제로 LUMIX Tether도 Wi-Fi로는 S1II를 찾지 못했습니다.
  - 그래서 LUT는 USB로만 넣습니다.
- 다른 LUMIX 기종은 읽기만 열려 있습니다. 쓰기는 사용자가 실험적 쓰기에 동의할 때만 합니다(`VERIFIED_FOR_WRITE`에 없는 기종).
