# 슬라이드 직접 스캔 — 2026-11-02

요구사항은 ChatGPT 「프로젝트 확인 요약」의 최신 변경 설명에서 확인했다. 업데이트된 MD의 Library 링크는 로그인 화면으로 연결되어 첨부 원문 전체를 내려받지는 못했다. 기존 로컬 명세와 채팅에 명시된 아래 변경 내용을 구현했다.

- 네거티브: 필름 현상 → 인화지 인화 → 스캔.
- 슬라이드: 필름 현상 → 필름 직접 스캔. 인화지 선택 비활성화.
- 두 경로 모두 V-Log/STD LUT, 샘플 및 업로드 사진 미리보기 제공.

## 엔진

고정된 upstream 0.3.4, commit `3bb2c2d2801ff68b92019cf1dbcbb133d60832bc`의 GUI는 positive 필름 선택 시 `io.scan_film=True`를 설정한다. 런타임은 이 플래그에 따라 `printing.expose`, `printing.develop`를 건너뛰고 `CMY_FILM → RGB_OUT` 스캔을 실행한다. 원본 LUT builder와 QA factory는 이 플래그를 설정하지 않으므로 앱의 `pipeline/slide.py`가 두 경로를 보완한다. vendor 파일은 수정하지 않는다.

`SlideBundleBuilder`는 기존 1-LUT 격자 생성·색공간 처리·인코딩을 재사용하며, 런타임 초기화 전에 `scan_film=True`를 설정한다. 네거티브에는 기존 upstream builder를 그대로 사용한다. 슬라이드의 QA는 builder와 분리된 런타임 초기화에서 같은 직접 스캔 경로를 실행한다.

원본 런타임은 초기화 시 인화지 객체를 요구하므로 내부적으로 Portra Endura 프로파일을 로드한다. 인화 단계는 실행하지 않으며 슬라이드 결과의 `paper`는 `null`이다. 이 초기화 의존성은 provenance의 `runtimeInitPrintProfile`에 이름과 해시로 기록하고, 실제 선택된 인화지로 표시하지 않는다. Crystal Archive로 초기화해도 같은 픽셀 결과가 나오는 것을 4종 모두 검사한다.

## 카탈로그와 UI

- schemaVersion 2, `processMode`: `negative_print` / `positive_direct`.
- 네거티브 ID와 파일 번호 유지. 슬라이드는 `<film_id>__direct_scan`, `paper: null`.
- Provia `0017`, Velvia `0025`, Ektachrome `0041`, Kodachrome `0065`.
- 기존 32개 미지원 인화 조합 대신 4개 직접 스캔 룩만 노출.
- 총 132개 룩, 264개 LUT, 132개 ZIP, 792개 미리보기.
- 슬라이드에서는 인화지 선택 비활성화. 네거티브로 돌아오면 마지막 인화지 선택 유지.
- 다운로드·업로드 렌더링은 선택한 룩의 실제 STD/V-Log 파일을 사용한다.

## 검증 범위

4종의 오프그리드 직접 엔진 비교, 흑백 램프 방향, 인화지 초기화 의존성, 인화 노드 우회, 미리보기와 독립 LUT reader 일치, 메타데이터와 ZIP 내용을 검사한다. 기존 네거티브 LUT 256개의 SHA-256은 변경 전과 모두 같다. 최종 검사 결과는 `validation.md`에 기록한다. 카메라 실기 적용은 미검증이다.
