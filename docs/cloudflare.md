# Cloudflare 공개 배포본

현행 sosang 빌드는 148개 엔진 룩, 10개 카메라의 합성 STD 1,480개, 공통 V-Log 148개와 사용자가 제공한 후지 STD LUT 9개를 제공합니다. 여기에 네거티브 인화 128개 조합마다 추천 현상 방법 변형이 하나씩 붙고([필름 색 남김 문서](film-cast.md)), 인화 필터 M·Y 슬라이더용 데이터 128개(`/print-timing/`, [인화 필터 문서](print-timing.md))가 함께 배포됩니다. 제공된 후지 LUT는 인화지·카메라 변환 없이 그대로 제공하며 별도 `suppliedFuji` 카탈로그로 관리합니다. 선택한 기종의 ZIP을 미리보기·다운로드 전송에 사용합니다. 모델별 변환·검증 상태·권리는 [카메라 STD 문서](camera-std.md)를 참고하세요. 빌드 갱신과 실제 공개 사이트 배포는 별도입니다.

`scripts/prepare-cloudflare.mjs`는 완성된 `dist/`를 읽어 별도 `dist-cloudflare/`를 생성한다. 공개 카탈로그에서 `reference_interpretation` 조합과 `referenceStudy`를 제거하고 상태별 개수를 재계산한다. 제외 조합의 디렉토리 전체와 `research/reference-looks.json`도 복사하지 않는다. 기존 FUJI 공식 필름·`fujiStudy`·`research/fujifilm-official.json`과 90개 합성 룩은 제거한다. 제공 후지 LUT 9개와 provenance·NOTICE는 `/supplied-fuji/`에서 원본 수치 그대로 제공한다. 공개되는 148개 조합의 카메라별 STD·VLOG·QA·출처 자산은 입력 `dist/`의 바이트를 유지한다. 미리보기는 선택한 카메라의 STD로 브라우저에서 계산하고, 과거 버전의 미리보기 사본은 포함하지 않는다. 외부 리뷰 사진을 모은 `sample-study/`는 배포 입력에 포함하지 않는다.

```sh
node scripts/prepare-cloudflare.mjs
node scripts/verify-cloudflare.mjs
node --experimental-strip-types scripts/verify-assets.mjs dist-cloudflare
node --test tests/cloudflare.test.mjs tests/geo.test.mjs
```

Node.js 22.12 이상을 사용한다. 첫 명령은 전용 출력 폴더 `dist-cloudflare/`를 다시 만든다. 개인용 `dist/`는 변경하지 않는다. `verify-cloudflare`는 148개 조합·1,480개 STD와 148개 V-Log LUT, 별도 후지 STD 9개, 제외된 데이터의 부재, 원본 카탈로그의 허용된 부분과의 일치, 자산 해시·크기, JSON의 웹 자산 참조, 샘플 원본 해시, 공개 텍스트의 개인 로컬 경로, 20,000개 파일·단일 25 MiB 제한을 검사한다. 기존 `verify-assets` 검사는 ZIP 안 LUT의 해시·형식·수치까지 검증한다. `verify-supplied-fuji`는 별도 후지 파일의 해시와 원본 데이터 보존, STD 태그, 중복·누락 및 불필요한 인화지/V-Log/카메라 합성 경로의 부재를 검사한다.

필름 라이선스와 사진 권리는 구분한다. 공개 샘플은 사용자 촬영본과 기술 테스트 패턴만 포함하며, 이용자가 선택한 사진은 브라우저 안에서 처리한다.

## 실행과 계정 연결

먼저 현행 카메라 STD 생성·검증을 완료한 뒤 배포 빌드를 만든다. 이전 B 정리 도구는 과거 아카이브용이며 현행 생성 경로에 사용하지 않는다.

`npm run build:cloudflare`는 타입 검사·Vite 빌드·무손실 ZIP 패키징·공개판 선별·소스 코드 패키징·공개판 검사를 순서대로 실행한다. `npm run preview:cloudflare -- --port 4418`로 Cloudflare의 로컬 런타임을 실행한다. `npm run deploy:cloudflare`는 같은 빌드·검증 후 공식 Wrangler로 배포한다. 모든 명령은 `scripts/run-web.mjs`의 지원 Node 런타임 선택을 거친다.

무료 Cloudflare 계정을 만들고 이메일을 인증한 후 `npm run cloudflare:login`의 공식 OAuth 승인을 완료한다. 인증 값은 Wrangler가 로컬에서 관리하며 저장소·배포 자산에 포함하지 않는다. 여러 계정에 속해 있으면 배포 대상 계정을 명시적으로 선택해야 한다. 기본 `wrangler.jsonc`의 `name`은 `sosang`이며, `npm run deploy:cloudflare`는 이 Worker에 배포한다. 기존 동명 Worker가 있다면 덮어쓰기 전에 소유·용도를 확인한다.

휴대폰 등 다른 기기에서 승인하거나 원격 작업 중이면 다음 기기 인증 방식을 사용한다. 터미널에 표시된 공식 주소에서 일회용 코드를 입력하고 승인하면 되며, 브라우저가 이 컴퓨터의 localhost에 접근할 필요가 없다. 앱 배포에 필요한 계정·사용자 조회와 Worker 배포 권한으로 범위를 제한한다.

```sh
npm run cloudflare:login -- --device --browser=false --scopes account:read user:read workers_scripts:write
```

`server/worker.mjs`는 언어 자동 선택을 위한 `GET /api/locale`과 데스크톱 앱 업데이트 정보 `GET /app/latest.json`만 처리한다. `wrangler.jsonc`의 `run_worker_first: ["/api/locale", "/app/latest.json"]`로 두 경로만 Worker를 먼저 실행하고, 그 외 요청은 기존 정적 자산 제공을 유지한다. Worker에 전달된 다른 경로도 `env.ASSETS.fetch(request)`로 넘긴다. 바인딩은 정적 파일용 `ASSETS` 하나이며 데이터베이스·KV·유료 서비스 바인딩은 추가하지 않는다. 기존 `workers_scripts:write` 배포 권한을 그대로 사용한다. 이 구성은 Cloudflare의 [선택 경로 Worker 실행 및 자산 바인딩](https://developers.cloudflare.com/workers/static-assets/binding/)을 따른다.

기본 공개 주소는 **https://sosang.app/**이다. 이 도메인은 Cloudflare 대시보드에서 sosang Worker에 연결되어 있다(`wrangler.jsonc`에는 적지 않았다). 같은 Worker의 `https://sosang.film-lab-jc.workers.dev/`(`workers_dev: true`)도 그대로 둔다. 도메인은 만료 등으로 끊길 수 있으므로, 코드(데스크톱 앱의 화면 데이터와 업데이트 주소, 릴리스 스크립트, 구주소 리디렉션)는 일부러 workers.dev 주소를 쓴다. 문서와 공유 링크에만 sosang.app을 쓴다. 새 Cloudflare 배포는 기존 Sites의 접근 권한이나 배포를 변경하지 않는다.

## 데스크톱 앱

데스크톱 앱(`src-tauri`)은 화면 코드만 담고, 카탈로그·LUT·사진은 이 서버에서 읽는다. 앱 화면의 출처는 `tauri://localhost`(Windows는 `http://tauri.localhost`)라서 서버가 다른 출처의 읽기를 허용해야 한다.

- 정적 파일: `public/_headers`의 `/*` 규칙에 `Access-Control-Allow-Origin: *`를 둔다. 모두 공개 파일이고 쿠키나 인증을 쓰지 않으므로 출처를 가리지 않는다. 인증 정보를 함께 보내는 요청(`Allow-Credentials`)은 허용하지 않는다.
- `/api/locale`: Worker가 앱 출처(`tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`)에만 `Access-Control-Allow-Origin`을 붙이고 `Vary: Origin`을 둔다.
- `/app/latest.json`: Tauri 업데이터가 읽는 업데이트 정보다. 릴리스 단계가 `app-release/latest.json`을 만들면 `build:cloudflare`가 형식(버전, 플랫폼별 https 주소와 서명)을 검사한 뒤 `app/latest.json`으로 싣는다. 파일이 없으면 Worker가 `204 No Content`를 돌려주고, 업데이터는 이를 업데이트 없음으로 처리한다. `Cache-Control: no-cache`라서 새 릴리스가 바로 보인다.
- 설치 파일(`sosang.app.tar.gz`, 약 6MB)은 같은 Worker의 `/app/releases/<버전>/`에 둔다. 빌드 검증은 `app/` 아래에 `latest.json`과 그것이 가리키는 파일만 있는지 확인한다.
- `server/worker.mjs`는 함수와 기본 처리기만 내보낸다. 상수를 내보내면 Cloudflare 런타임이 진입점으로 잘못 읽어 Worker가 시작되지 않는다(`tests/app-update.test.mjs`에서 확인).

## 주소 이전과 구주소 유지

기존 `https://film-lab.film-lab-jc.workers.dev/`는 `wrangler.legacy.jsonc`의 `film-lab` Worker로 유지한다. 진입점은 `server/legacy-worker.mjs`이다. 구주소의 `/`와 `/index.html`에 대한 GET·HEAD 요청만 같은 경로의 `sosang.film-lab-jc.workers.dev`로 308 리디렉션하며 쿼리 문자열을 보존한다. `#studio` 같은 fragment는 서버에 전달되지 않으며 브라우저가 새 주소로 이어간다.

이미 열린 구주소 탭이 카탈로그·사진·LUT 파일을 계속 읽을 수 있도록 정적 자산과 `/api/locale`은 구주소에서도 제공한다. 구주소의 정적 자산 우선 처리는 의도된 구성이다. 공유한 파일 직접 링크도 유지하며, 새로 공유하는 사이트 주소에는 `sosang.app`을 사용한다.

먼저 `npm run deploy:cloudflare`로 새 주소를 배포하고 홈페이지·언어 API·사진·LUT 다운로드를 확인한다. 확인이 끝난 뒤에만 같은 검증된 배포 자산으로 구주소 Worker를 별도로 배포한다. 다음 명령은 Node.js 22.12 이상에서 실행한다.

```sh
node node_modules/wrangler/bin/wrangler.js deploy --config wrangler.legacy.jsonc
```

일반 업데이트는 기본 sosang 배포 명령을 사용한다. 구주소 배포는 위 명령으로 명시적으로 수행한다. 호스트가 달라지므로 브라우저에 저장된 언어·카메라 선택은 새 주소에서 다시 설정된다.

## 접속 국가와 언어

Worker는 Cloudflare가 제공하는 [`request.cf.country`](https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties)만 읽는다. `KR`이면 `{"locale":"ko"}`, 다른 국가 코드이면 `{"locale":"en"}`을 반환한다. 국가 정보가 없거나 미확인 코드인 경우에는 `{"locale":null}`을 반환해 클라이언트가 브라우저 언어를 대체 기준으로 사용할 수 있게 한다. 요청자가 넣은 국가 헤더·쿼리 매개변수는 판단에 사용하지 않는다.

응답에는 언어 코드만 포함하며 IP·국가 정보의 저장이나 로그 출력을 하지 않는다. `Cache-Control: no-store`를 Worker 응답에 직접 적용해 서로 다른 방문자의 언어 결과를 재사용하지 않는다. `HEAD`도 지원하고 다른 메서드는 `405`와 `Allow: GET, HEAD`로 거절한다. 로컬 환경에서는 국가 정보가 없을 수 있으며, 국가별 분기·헤더 무시·캐시·정적 자산 전달은 `tests/geo.test.mjs`로 확인한다.

## 캐시와 소스 제공

`public/_headers`는 내용 해시가 파일명에 들어간 `/assets/*`에만 1년 immutable 캐시를 설정한다. 고정 이름인 카탈로그·LUT ZIP·사진·소스 패키지는 Cloudflare 기본 ETag 재검증을 유지한다. 새 LUT와 오래된 ZIP의 혼합을 막기 위해 고정 경로에는 immutable을 사용하지 않는다. 압축과 캐시 응답 헤더는 실제 배포 후 확인한다.

`scripts/package-source.mjs`는 허용한 소스와 라이선스만 묶어 `/source/film-lab-source.tar.gz`로 제공한다. 브라우저 코드와 함께 `server/worker.mjs`도 포함하고 필수 파일로 확인한다. 사진·LUT 데이터·인증 정보·개인용 배포 설정을 넣지 않는다. 사이트의 제작 정보에서 소스를 내려받을 수 있으며, 카탈로그에 패키지 크기와 SHA-256을 기록한다.

## 앱 릴리스

```
npm run release:app -- --version 0.2.0 --notes "바뀐 점" --deploy --github
```

1. `--version`을 주면 `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`의 버전을 함께 바꾼다. 세 값이 다르면 멈춘다.
2. 실행한 컴퓨터의 앱을 만들고 업데이트 서명 키로 서명한다. macOS는 `tauri build --bundles app`(`sosang.app.tar.gz`), 64비트 Windows는 `tauri build --bundles nsis`(설치 파일 `sosang_<버전>_x64-setup.exe`, 업데이트에도 같은 파일을 쓴다)다. 키는 저장소 밖 `~/.tauri/sosang-updater.key`(또는 `TAURI_SIGNING_PRIVATE_KEY_PATH`)이고, 비밀번호는 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`가 없으면 실행 중에 묻는다. 공개 키는 `tauri.conf.json`의 `plugins.updater.pubkey`에 있다. macOS와 Windows는 같은 키로 서명한다.
3. 서명된 파일을 `app-release/releases/<버전>/`에, 업데이트 정보를 `app-release/latest.json`에 쓴다(`app-release/`는 git에서 제외). 같은 버전의 다른 플랫폼 항목이 로컬 `app-release/latest.json`이나 서버의 `/app/latest.json`에 이미 있으면 그대로 두고, 그 파일을 서버에서 받아 `app-release/releases/<버전>/`에 함께 둔다. 그래서 macOS에서 먼저 배포한 뒤 Windows에서 같은 버전을 배포해도(또는 그 반대) 한쪽이 빠지지 않는다. 버전이 다르면 이번에 만든 플랫폼만 들어가므로, 두 컴퓨터에서 같은 버전을 차례로 배포한다.
4. `--deploy`면 사이트를 다시 빌드해 함께 배포한다.
5. `--github`면 GitHub의 앱 릴리스 페이지를 갱신한다(`scripts/github-release.mjs`, `gh` 로그인 필요).
   - 릴리스 페이지는 태그 `app` 하나뿐이다(https://github.com/lee-juncheol/sosang/releases/tag/app). 버전마다 새 릴리스를 만들지 않는다.
   - 설치 파일은 버전 없는 고정 이름으로 덮어 올린다: macOS `sosang-mac-apple-silicon.dmg`(이때 `--bundles app,dmg`로 DMG도 만든다), Windows `sosang-windows-x64-setup.exe`. 그래서 `…/releases/download/app/<이름>` 링크가 바뀌지 않는다.
   - 본문에서는 그 플랫폼의 `<!--windows-x86_64-->…<!--/windows-x86_64-->`(버전·크기·날짜)와 `<!--windows-x86_64:sha-->…`(SHA-256) 표시만 바꾼다. 영어·한국어 두 곳 모두 바뀌고 다른 플랫폼 줄은 그대로다. 표시를 지우면 갱신이 멈추므로 본문을 손으로 고칠 때 남겨 둔다.
   - 바뀐 점 설명은 손으로 고친다.

- 서명에는 버전이 기록되고(`version:0.1.0`), 앱은 `requireSignedVersion`으로 업데이트 정보의 버전과 서명의 버전이 같은지 확인한다. 예전 서명 파일을 더 높은 버전으로 속여 내려보내는 것을 막는다.
- 개인 키나 비밀번호를 잃으면 이미 설치된 앱에 업데이트를 보낼 수 없다. 따로 백업한다.
- 앱은 시작 3초 뒤 한 번 확인하고, 카메라 작업 중에는 설치하지 않는다. 설치가 시작되면 다시 시작할 때까지 카메라 작업을 막는다.
- macOS 공증은 아직 하지 않는다. 처음 설치할 때 경고가 뜨지만 설치된 앱의 자동 업데이트에는 영향이 없다.
- Windows 코드 서명도 아직 하지 않는다. 처음 설치할 때 SmartScreen이 "알 수 없는 게시자" 경고를 띄운다("추가 정보 → 실행"으로 설치). 업데이트 서명(위 키)과는 별개다.
- 2026-11-15 확인: 0.0.9 시험 앱이 로컬 서버의 0.1.0을 알리고, 내려받아 서명을 확인한 뒤 설치하고 다시 시작했다.

