# FUJIFILM 공식 GFX LUT와 인화지 조합

GFX ETERNA 55의 공식 LUT 패키지 v1.10(2026-04-16)을 FUJIFILM 배포처에서 내려받았다. 그 안의 **F-Log2 / F-Gamut, 65³, 시뮬레이션 LUT v1.00 10종**을 사용한다. 패키지 버전과 개별 LUT 버전은 다르다. F-Log2C/F-GamutC 파일, WDR 및 Log-to-709 기술 변환은 이 10종에 포함하지 않는다.

- 공식 배포: https://www.fujifilm-x.com/global/support/download/lut/
- 원본 ZIP: https://dl.fujifilm-x.com/support/lut/gfx-eterna-55-3d-lut-v110.zip
- F-Log2 변환식/색역: https://dl.fujifilm-x.com/technical-data/F-Log2_DataSheet_E_Ver.1.1.pdf
- 출력 모니터 기준(13쪽): https://dl.fujifilm-x.com/support/lut/GFX_ETERNA_WhitePaper_260206_v101.pdf
- 패키지 SHA-256: `febfc7050999620651ca0cf162bf8b499970ef270b4da632765b61b958cf7940`

출처와 원본 파일별 SHA-256은 `pipeline/config/fujifilm-official.json`, 공개 미러 `public/research/fujifilm-official.json`에 기록한다. 원본 패키지는 `.cache/fujifilm-gfx/`에 보존하고 Git이나 공개 다운로드에 원본 사본을 중복 포함하지 않는다.

## 범위

CLASSIC CHROME, CLASSIC Neg., REALA ACE, PROVIA, Velvia, ASTIA, PRO Neg. Std, ETERNA, ETERNA BLEACH BYPASS, ACROS.

각 시뮬레이션마다 인화지 없는 출력 1개와 프린트 재료 8개를 제공한다. **90개 조합, STD/V-Log LUT 180개**다. 기존 152개 룩을 유지해 전체 **242개 룩, 484개 LUT, 242개 ZIP**이 된다. 프린트 재료는 사진 인화지 6종과 영화용 프린트 필름(Kodak 2383/2393) 2종이며 화면에서도 구분한다. 새 조합 번호는 201–290이다.

## 입력과 출력의 계약

공식 LUT 값에 별도 필름별 색보정은 하지 않는다. 65³ 원본의 사면체 보간을 순차 계산한 후, 최종 33³ 합성 LUT를 만든다.

- **STD:** sRGB decode → 선형 sRGB를 F-Gamut(BT.2020과 같은 원색)으로 행렬 변환 → 공식 F-Log2 인코딩 → 원본 65³ LUT. 선형 배율 1.0이며, display-linear 값을 scene reflection처럼 사용하는 근사다. Panasonic Standard나 GFX JPEG 렌더링을 역변환하지 않는다.
- **V-Log:** Panasonic V-Log decode → V-Gamut에서 F-Gamut으로 선형 행렬 변환 → F-Log2 encode → 같은 원본 LUT. 별도 톤 곡선을 추가하지 않는다. 0–1 LUT 영역 밖의 F-Log2 코드는 경계로 제한한다. 센서·화이트밸런스 차이는 교정하지 않았다.
- **공식 LUT 출력:** 공식 백서가 권장하는 BT.709 원색/D65/감마 2.2 모니터 기준으로 해석한다. `linear = encoded^2.2`로 되돌리고 최종 출력은 sRGB로 인코딩한다. BT.709 OETF나 sRGB 디코딩을 원본 출력에 대신 적용하지 않는다.

공식 LUT만 모드에도 위 입력·출력 변환은 포함된다. 배포 LUT는 원본 FUJIFILM 파일이 아니라 Film Lab 합성 파일이며, GFX 카메라에 넣을 원본 F-Log2 LUT로 표시하지 않는다. 원본은 공식 사이트에서 받는다. 사진 미리보기는 항상 STD 기준이다.

## 인화지 연결

완성된 양화 RGB를 다시 네거티브 필름 모델에 입력하면 필름이 이중으로 적용된다. 따라서 가상 디지털 프린터의 입력을 만든 후 upstream `LOG_E_PRINT`에 주입해 **printing.develop → scanning.scan_print**만 실행한다. 필름 노광·필름 현상·확대기 노광은 실행하지 않는다.

```text
logE = offset_paper − 0.60 × log10(max(linearRGB, 1e−6) / 0.184)
```

`offset_paper`는 인화지의 중간 회색 출력이 선형 sRGB (0.184, 0.184, 0.184)가 되도록 한 번 계산한 3채널 노출값이다. 동일한 인화지의 모든 시뮬레이션에 같은 값을 쓴다. 시뮬레이션마다 색을 중립화하거나 사진별 자동 노출을 적용하지 않는다. 기울기 0.60과 RGB → 인화 노출 연결은 **Film Lab의 가상 프린터 가정**이다. FUJIFILM이나 spektrafilm 제작자가 제시한 공식 계수 또는 실측 프린터 값이 아니다.

원본 인화지의 특성 곡선·염료 스펙트럼·관찰 광원과 CAM16UCS 출력을 유지한다. 분광 스캐너를 직접 계산하며 중간 스캐너 LUT는 쓰지 않는다. 중간 회색 이외의 흰색·검정·톤·색편향은 따로 강제로 맞추지 않는다. 이 설정의 흰색 출력은 선형 약 0.595–0.688로 압축된다. 따라서 공식 LUT만 적용한 결과와 인화지 결과의 밝기·하이라이트 차이는 모델의 일부다. ACROS도 컬러 프린트 재료를 통과하면 약한 색조가 생길 수 있다.

초기화에 필요한 Portra 400 프로파일은 어떤 필름 단계에도 사용하지 않는다. C200으로 초기화해도 결과가 같다는 테스트로 확인한다. 각 조합의 provenance에 실제 오프셋·흑백 끝점·회색 보정 잔차·실행 단계를 기록한다.

## 생성과 검증

```sh
.venv/bin/python -m pipeline.generate_fuji --download --jobs 2
.venv/bin/python -m pytest pipeline/tests
npm test
npm run build
npm run verify:assets -- dist
```

원본 패키지와 각 LUT의 해시가 기록된 값과 다르면 생성을 중단한다. 전체 모델의 재생성 순서는 `pipeline.generate` → `pipeline.generate_research` → `pipeline.generate_fuji --download --jobs 2`다. 새 후지 생성기는 기존 152개 레코드와 연결 자산의 무결성을 먼저 검증하고 보존한다.

테스트는 공식 F-Log2 회색 코드, 정확한 원색 행렬, 독립 colour-science LUT reader와의 일치, STD/V-Log의 동일 합성 좌표, 인화 노드 실행 범위, 회색의 단조성·보정, 픽셀 독립성을 확인한다. 조합별 4,350개 입력 및 사용자 사진별 1,024개 픽셀에서 최종 33³ LUT와 순차 계산을 비교한다. 이 수치는 LUT 보간 오차이며 실물 필름·GFX 실기·실제 인화의 재현 정확도가 아니다. V-Log 전체 영역의 극단적인 색과 노출에서 오차가 커질 수 있어 실험용으로 표시한다.

## 권리와 출처

FUJIFILM 원본 LUT 데이터의 권리는 FUJIFILM에 남는다. 새 합성 LUT 전체에 CC BY-SA 라이선스를 임의로 부여하지 않는다. spektrafilm 인화지·공유 도구의 Andrea Volpato 출처 및 해당 구성요소의 원래 라이선스는 유지한다. 사용자 사진은 촬영자 소유다. 실제 필름 사진을 참고해 만든 별도 4종과 이 공식 디지털 시뮬레이션 모드는 구분한다.

## 배포용 샘플 미리보기

생성기와 `public/`에는 모든 조합의 비교용 WebP를 보존한다. 정적 배포 시 새 후지 90개 조합은 `previewMode: runtime-std`로 표시하고, 중복된 미리보기 540개를 배포본에서 생략한다. 화면은 공통 샘플 원본을 sRGB 픽셀로 읽고, 다운로드용 STD LUT를 검증·압축 해제한 뒤 업로드 사진과 같은 Web Worker에서 사면체 보간으로 계산한다. 결과는 PNG이며 추가 손실 압축을 하지 않는다. LUT 값·해상도를 줄이지 않고 호스팅의 256 MiB 제한 안에 배포하기 위한 구성이다. 기존 152개 룩의 정적 미리보기와 모든 다운로드 LUT 바이트는 유지한다.
