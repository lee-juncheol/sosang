# S1M2 / S1II 실기 확인

소프트웨어 수치 검사는 완료했지만 아래 실기 항목은 아직 수행하지 않았다.

공식 [S1M2 LUT Library](https://eww.pavc.panasonic.co.jp/dscoi/DC-S1M2/html/DC-S1M2_DVQP3227_eng/0079.html) 설명서는 2–33-point `.cube`, Full range 권장, FAT32에서 확장자 제외 8자 파일명, 카드 최상위 폴더 저장, TITLE 다음의 사진 스타일 태그를 안내한다. 앱은 이 파일 규칙을 따른다.

1. 기본 조합 ZIP을 풀고 `0086VLOG.cube`, `0086STD.cube`를 빈 카드 최상위 폴더에 복사한다. 기존 카드 파일을 덮어쓰지 않는다.
2. 카메라의 LUT Library에서 빈 등록 위치와 Load를 선택하고 해당 슬롯의 파일을 불러온다. 또는 LUMIX Lab의 LUT 전송 흐름을 사용한다.
3. 각각 V-Log와 Standard 베이스로 인식되는지 기록한다. 공식 [Photo Style](https://eww.pavc.panasonic.co.jp/dscoi/DC-S1M2/html/DC-S1M2_DVQP3227_eng/0076.html) 기준으로 LUT의 베이스가 입력 스타일을 결정한다.
4. JPEG 색공간은 sRGB, SDR로 두고, 화이트밸런스·조명·구도·초점을 고정한다. LUT opacity와 Photo Style 조절값도 기록한다.
5. 동일 장면의 피부·회색·하늘·녹색·빨강·하이라이트를 촬영한다. 같은 ISO 숫자가 동일 신호/게인을 뜻한다고 가정하지 않는다. 셔터·조리개·ISO·Dual Native ISO·노출 차이를 기록한다.
6. 밴딩, 급격한 색 변화, 하이라이트 클리핑, 역전, 전체 밝기 차이를 확인한다. 각 베이스의 LUT off 촬영도 함께 확보한다.

| 항목 | 기록 |
|---|---|
| 카메라/펌웨어 | 미확인 |
| LUMIX Lab 버전/OS | 미확인 |
| 두 파일 가져오기 성공 | 미확인 |
| VLOG/STD 베이스 인식 | 미확인 |
| 조명/WB/노출/Photo Style 설정 | 미확인 |
| 피부·색 패치/하이라이트 비교 | 미확인 |
| 테스트 파일 SHA-256 | 각 조합 provenance/manifest 참조 |

STD는 수식 기반 근사 모델이다. 실제 Standard 내부 톤 곡선·게인·하이라이트 손실을 역변환하지 않는다. 카메라가 없는 개발 환경에서 이 체크리스트를 완료한 것으로 표시하지 않는다.
