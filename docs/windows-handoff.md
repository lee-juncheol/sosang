# Windows 작업 인계 (6단계)

작성: 2026-11-15, macOS 세션에서. Windows PC의 새 Claude 세션은 이 문서를 먼저 읽고 시작합니다.

**답변은 항상 한국어로 합니다.** 코드, 명령어, 식별자는 그대로 둡니다.

## 지금까지 된 것 (브랜치 `feat/camera-lut-core`)

sosang 웹앱에 붙는 데스크톱 앱(Tauri v2)입니다. USB로 연결한 LUMIX의 LUT 라이브러리에 SD 카드 없이 LUT를 넣고 지웁니다.

| 영역 | 위치 | 상태 |
|---|---|---|
| 설정 파일 해석·수정 | `crates/lumix-lut` | 순수 Rust, 운영체제 무관. 체크섬, 범위 검사, 칸 상태 확인 포함 |
| 카메라 통신 공통부 | `crates/lumix-ptp/src/lib.rs` | 등록·삭제·백업·되돌리기 절차. 운영체제 무관 |
| 카메라 통신 macOS | `crates/lumix-ptp/src/mac.rs` | ImageCaptureCore. **Windows판이 없음 (이번 작업)** |
| 앱 | `src-tauri/` | 명령, 권한, 업데이터 |
| 화면 | `src/` | 웹과 같은 React 코드. 차이는 `src/platform.ts`에 모음 |
| 서버 | `server/worker.mjs`, `public/_headers` | CORS와 `/app/latest.json` 배포 완료 |

자세한 근거는 아래 문서에 있습니다.
- `docs/camera-lut-library.md`: 설정 파일 구조, PTP 명령, 안전 장치, 실기 확인 기록
- `docs/cloudflare.md`: 서버, 데스크톱 앱 CORS, 앱 릴리스 절차

## 지켜야 할 규칙

- **카메라에 쓰는 작업(등록, 삭제, 되돌리기, 원본 그대로 쓰기)은 매번 사용자에게 허락을 받은 뒤에 합니다.** 읽기는 허락 없이 해도 됩니다.
- **카메라 시리얼 번호를 출력하거나 로그에 남기지 않습니다.** `DeviceInfo.serial`은 Rust 안에서 백업 확인에만 씁니다.
- **카메라 설정 캡처와 백업은 커밋하지 않습니다.** 개인 설정과 시리얼이 들어 있습니다. 해당 위치는 `crates/**/fixtures/local/`, `camera-backups/`, 앱 데이터 폴더의 `camera-backups`입니다. `.gitignore`에 들어 있습니다.
- `reddit-post/`는 건드리지 않고 커밋하지 않습니다.
- 커밋 메시지 끝에는 `Co-Authored-By` 줄을 넣습니다. 푸시와 배포는 사용자가 말할 때만 합니다.
- 업데이트 서명 키(`~/.tauri/sosang-updater.key`)는 macOS에만 있습니다. 저장소에 넣거나 채팅에 붙여 넣지 않습니다.

## Windows PC 준비

- Git, Node.js 22.12 이상
- Rust(rustup, MSVC 툴체인)
- Visual Studio Build Tools의 "C++를 사용한 데스크톱 개발"
- WebView2: Windows 10/11 기본 포함

```bash
git clone -b feat/camera-lut-core https://github.com/lee-juncheol/sosang.git
cd sosang
npm ci
node scripts/run-web.mjs test
cargo test -p lumix-lut -p lumix-ptp
```

`lumix-lut`의 실기 캡처 테스트는 `tests/fixtures/local/`이 없으면 건너뜁니다. 정상입니다.

## 할 일

### 1. 앱이 Windows에서 뜨는지

- `node scripts/run-web.mjs app:dev`(개발 서버 5174 + 앱)
- 확인할 것:
  - 스튜디오와 갤러리가 서버(`https://sosang.film-lab-jc.workers.dev`) 데이터로 그려지는지. 앱 출처 `http://tauri.localhost`는 서버에서 이미 허용했습니다.
  - LUT 관리 탭이 보이는지. 카메라 명령은 지금 `unsupported_platform`을 돌려줘야 합니다.
  - LUT 다운로드가 저장 창으로 저장되는지.
- 빌드 오류가 나면 `#[cfg(target_os = "macos")]`로 막힌 곳을 Windows에서도 컴파일되게 정리합니다.

### 2. Windows 카메라 통신 (`crates/lumix-ptp/src/windows.rs`)

`mac.rs`와 같은 모양의 `Session`을 만들면 공통부가 그대로 동작합니다.

```rust
pub(crate) fn start_discovery();
pub(crate) fn open(hint: &str, timeout: Duration) -> Result<Session, PtpError>;
pub(crate) fn transaction(&self, op: u16, params: &[u32], out: Option<Vec<u8>>, timeout: Duration)
    -> Result<(u16 /* 응답 코드 */, Vec<u8> /* 받은 데이터 */), PtpError>;
// Drop에서 세션을 닫음
```

- 보내는 명령은 세 가지뿐입니다.
  - `0x1001` GetDeviceInfo
  - `0x9421` 설정 읽기: 파라미터 `0x080000A2`, 카메라→PC 약 9.2MB
  - `0x9422` 설정 쓰기: 같은 파라미터, PC→카메라
- 권장 방향은 **WPD(Windows Portable Devices)**입니다. 카메라는 Windows 기본 MTP 드라이버에 잡혀 있으므로, 드라이버를 바꿔야 하는 libusb/WinUSB는 쓰지 않습니다.
  - `IPortableDeviceManager`로 장치 목록을 받고, 제조사 "Panasonic"인 장치를 고릅니다. `IPortableDevice::Open`으로 엽니다.
  - 제조사 명령은 `WPD_CATEGORY_MTP_EXT_VENDOR_OPERATIONS`를 씁니다.
    - 데이터 없음: `WPD_COMMAND_MTP_EXT_EXECUTE_COMMAND_WITHOUT_DATA_PHASE`
    - 읽기: `..._EXECUTE_COMMAND_WITH_DATA_TO_READ` → `..._READ_DATA` 반복 → `..._END_DATA_TRANSFER`
    - 쓰기: `..._EXECUTE_COMMAND_WITH_DATA_TO_WRITE` → `..._WRITE_DATA` 반복 → `..._END_DATA_TRANSFER`
  - Rust에서는 `windows` 크레이트(`Win32_Devices_PortableDevices`, `Win32_System_Com` 등)를 씁니다. COM은 작업 스레드에서 초기화합니다.
  - `Cargo.toml`에는 `[target.'cfg(windows)'.dependencies]`로 넣습니다.
- 받은 데이터 길이, 응답 코드 `0x2001`, 시간 제한(읽기 60초, 쓰기 120초)을 macOS와 같게 맞춥니다.

### 3. 실기 확인 순서 (macOS 때와 같게)

카메라 USB 모드는 **PC(Tether)**로 둡니다. LUMIX Tether 앱은 끕니다.

1. `cargo run -p lumix-ptp --example probe`: 장치 정보와 LUT 목록 **읽기만**. 시리얼은 출력하지 않습니다.
2. 읽은 설정 파일을 `--dump`로 저장해 형식을 확인합니다(git 제외 위치에만 저장). 같은 카메라를 macOS에서 읽은 결과와 비교할 수 있으면 비교합니다.
3. **허락받고** `--rewrite`: 원본 그대로 쓰고, 다시 읽어 바이트가 같은지 확인합니다.
4. **허락받고** 빈 칸에 LUT 하나를 등록합니다. 카메라 화면에서 적용되는지 확인합니다.
5. 앱 화면에서 목록 읽기 → 등록 → 삭제 → 백업 되돌리기.

### 4. Windows 배포

- Windows 설치 파일(NSIS)과 업데이트 서명을 붙이고, `scripts/release-app.mjs`에 `windows-x86_64` 플랫폼을 추가합니다. 지금은 macOS만 처리합니다.
- 업데이트 정보(`app-release/latest.json`)에는 플랫폼이 여러 개 들어갈 수 있습니다. 같은 서명 키로 서명해야 합니다. 키를 옮길지, GitHub Actions 비밀값으로 둘지는 사용자와 정합니다.
- 코드 서명이 없으면 SmartScreen 경고가 뜹니다. 사용자에게 알리고 넘어갑니다.

## 보류한 것

- **Wi-Fi 연결은 보류했습니다.** S1II의 Wi-Fi 테더는 LUMIX Tether가 아니라 Capture One용으로 보입니다. 파나소닉 지원 표에서 LUMIX Tether는 S1II를 유선 LAN으로만 지원합니다.
  - Wi-Fi 대기 중 카메라에 열린 포트는 80, 443(TLS), 554였고, `/cam.cgi`는 404, PTP 포트 15740은 닫혀 있었습니다.
  - 포트를 한꺼번에 훑으면 카메라가 Wi-Fi에서 떨어집니다.
- 다른 LUMIX 기종은 읽기와 동의 후 실험적 쓰기만 열려 있습니다(`VERIFIED_FOR_WRITE`).
