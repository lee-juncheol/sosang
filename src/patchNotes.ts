// User-facing update history shown in the topbar's "업데이트 내역" layer, newest first.
// Add a new entry at the top for each release; its id marks it as unread until the visitor opens the layer.
import type { Locale } from './i18n'

export type PatchNote = {
  id: string
  date: string
  app?: string
  items: Record<Locale, readonly string[]>
}

export const PATCH_NOTES: readonly PatchNote[] = [
  { id: '2026-11-25', date: '2026-11-25', app: '0.1.8', items: {
    ko: ['현상 방법에서 중립을 뺐어요. 인화 미세 조정의 "중립 (0)" 버튼을 누르면 같은 결과가 나와요.',
      '인화 미세 조정 슬라이더 옆 칸에 숫자를 직접 입력할 수 있어요.'],
    en: ['Neutral is no longer a development option. The "Neutral (0)" button in Print fine-tuning gives the same result.',
      'Type values directly in the boxes beside the Print fine-tuning sliders.'] } },
  { id: '2026-11-24', date: '2026-11-24', app: '0.1.7', items: {
    ko: ['언어 버튼 옆에서 지금까지의 업데이트 내역을 볼 수 있어요.',
      '새로 추가된 필름과 인화지에 NEW 표시가 붙어요.',
      '현상 방법은 처음부터 추천 현상으로 선택돼요.'],
    en: ['See the update history from the button beside the language switch.',
      'Newly added films and print films carry a NEW badge.',
      'The recommended development is now selected by default.'] } },
  { id: '2026-11-23', date: '2026-11-23', app: '0.1.6', items: {
    ko: ['S1II가 아닌 카메라용 LUT를 브라우저와 앱이 직접 만들어요. 받는 파일의 내용은 이전과 똑같아요.',
      '데스크톱 앱은 0.1.6으로 업데이트해야 다른 카메라의 다운로드와 카메라 등록이 다시 돼요.'],
    en: ['LUTs for cameras other than the S1II are now built in your browser or the app. The files you get are identical to before.',
      'Update the desktop app to 0.1.6 to download and register LUTs for other cameras again.'] } },
  { id: '2026-11-22', date: '2026-11-22', app: '0.1.4 · 0.1.5', items: {
    ko: ['앱과 사이트에 문의 창을 넣었어요.',
      '카메라 메뉴에서 순서를 바꾼 LUT 칸은 앱이 건드리지 않아요.',
      '카메라 작업 중에 앱을 닫으면 작업을 마친 뒤 닫혀요.',
      '설정 쓰기가 실패하면 카메라를 다시 읽어 맞추고, 화면 오류 몇 가지를 고쳤어요.'],
    en: ['Added a contact form to the app and the site.',
      'The app leaves alone LUT slots you reordered in the camera menu.',
      'Closing the app during a camera operation now waits for it to finish.',
      'After a failed settings write the app reads the camera again, and a few screen bugs are fixed.'] } },
  { id: '2026-11-17', date: '2026-11-17', app: '0.1.2 · 0.1.3', items: {
    ko: ['카메라 안 LUT의 순서를 앱에서 바꿀 수 있어요.',
      '카메라가 지금 쓰는 사진·영상 LUT를 표시해요.',
      'LUT 관리와 사진 보내기에 사용방법 영상을 넣었어요.',
      '제조사 기준 인화와 데이터시트 기반 필름·인화지 프로필을 더했어요.'],
    en: ['Rearrange the LUTs in your camera from the app.',
      'Shows which LUT the camera uses for photos and for video.',
      'How-to videos in the LUT manager and photo sending.',
      'Added manufacturer lab-aim prints and datasheet-based film and paper profiles.'] } },
  { id: '2026-11-16', date: '2026-11-16', items: {
    ko: ['앱에서 카메라로 사진(JPG)을 보낼 수 있어요.', '사이트 주소가 sosang.app이 됐어요.'],
    en: ['Send photos (JPG) from the app to your camera.', 'The site now lives at sosang.app.'] } },
  { id: '2026-11-15', date: '2026-11-15', app: '0.1.1', items: {
    ko: ['sosang 데스크톱 앱(macOS·Windows)이 나왔어요. USB로 LUMIX 카메라에 LUT를 바로 등록해요.',
      'LUT 여러 개를 한 번에 넣고 지우고, 끌어다 놓을 수 있어요.',
      '쓰기 전에 카메라를 백업하고 복원할 수 있어요.',
      '새 버전이 나오면 앱이 알려 주고 스스로 업데이트해요.'],
    en: ['The sosang desktop app (macOS and Windows) is here. Register LUTs on your LUMIX camera over USB.',
      'Add and delete several LUTs at once, with drag and drop.',
      'Back up and restore the camera before writing.',
      'The app tells you about new versions and updates itself.'] } },
  { id: '2026-11-14', date: '2026-11-14', items: {
    ko: ['맑은 하늘에 생기던 청록 띠를 없앴어요. 모든 카메라의 STD LUT를 새로 만들었으니 다시 받아 주세요.',
      '인화 미세 조정에 E(인화 노출)와 F(페이드)가 생겼어요.'],
    en: ['Removed the cyan band in clear skies. Every camera STD LUT was rebuilt, so please download them again.',
      'Print fine-tuning gains E (print exposure) and F (fade).'] } },
  { id: '2026-11-05', date: '2026-11-05 ~ 11-07', items: {
    ko: ['필름마다 추천 현상과 추천 인화지를 골라 줘요.', '인화 필터 슬라이더를 넣었어요.', '추천 조합 갤러리를 열었어요.', '조정하는 동안 미리보기가 화면에 계속 보여요.'],
    en: ['Recommended development and paper for each film.', 'Added print filter sliders.', 'Opened the recommended-combination gallery.', 'The preview stays in view while you adjust.'] } },
  { id: '2026-11-03', date: '2026-11-03', items: {
    ko: ['후지 필름 시뮬레이션을 넣었어요.', '공개 사이트를 열었어요. 한국어와 영어를 지원해요.'],
    en: ['Added Fujifilm film simulations.', 'The public site opened, in Korean and English.'] } },
  { id: '2026-11-02', date: '2026-11-02', items: {
    ko: ['첫 버전: 필름 룩을 LUMIX STD·V-Log LUT로 만들어요.', '슬라이드 필름 룩을 넣었어요.'],
    en: ['First version: film looks as LUMIX STD and V-Log LUTs.', 'Added slide film looks.'] } },
]

export const PATCH_NOTES_STORAGE_KEY = 'sosang-patch-notes-seen'
export const latestPatchNote = () => PATCH_NOTES[0].id
