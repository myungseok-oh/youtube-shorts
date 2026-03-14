# 이슈60초 YouTube Shorts 자동 제작 시스템

## ⚠️ 코드 수정 필수 규칙 (반드시 준수)

1. **영향 범위 확인**: 함수/로직 수정 전, 해당 함수를 호출하는 모든 곳을 Grep으로 검색한다. 호출처가 있으면 그 함수를 사용하는 다른 프로세스(Phase A, Phase B, API, 스케줄러 등)까지 전부 검토한다.
2. **이상 없음 확인 후 완료**: 모든 호출처에서 수정된 동작이 문제없는지 확인한 후에만 수정을 완료한다.
3. **영향이 큰 경우 함수 분리**: 수정된 내용으로 인해 다른 프로세스에 영향이 클 경우, 기존 함수를 건드리지 말고 새 함수를 분리하여 필요한 곳에서만 사용한다.
4. **에러 전파 변경 금지**: 기존에 `try-except`로 무시하던 에러를 `raise`로 바꾸면 다른 채널/프로세스가 깨질 수 있다. 에러 처리 방식 변경 시 반드시 전체 호출 흐름을 검토한다.
5. **Windows 인코딩 주의**: `print()` 문에 한국어 + 특수문자(em dash 등)가 포함되면 cp949 에러 발생 가능. runner.py 상단의 UTF-8 강제 설정을 유지한다.

---

## 프로젝트 구조
- `app.py` — FastAPI 백엔드 (포트 9999)
- `config.json` — ffmpeg 경로, DB 경로, 서버 설정
- `db/database.py` — SQLite WAL 래퍼
- `db/models.py` — Channel, Job, JobStep 모델
- `pipeline/` — 파이프라인 모듈
  - `runner.py` — Phase A/B 파이프라인 실행기 + JobQueue (Phase B 순차 실행)
  - `agent.py` — Claude CLI 호출 (뉴스검색+대본, 24시간 중복 필터, 밝은 이미지 프롬프트)
  - `trend_collector.py` — 뉴스 RSS 수집 (Google/YouTube 트렌드 제거됨)
  - `tts_generator.py` — gTTS/edge-tts 음성 생성
  - `slide_generator.py` — 슬라이드 이미지 생성
  - `generate_slides.js` — Puppeteer 슬라이드 렌더러 (오버레이 밝게, accent 그라디언트 제거)
  - `sync_engine.py` — 오디오-슬라이드 타임라인 동기화
  - `video_renderer.py` — ffmpeg 영상 합성
  - `metadata.py` — 제목/설명/태그 생성
  - `image_generator.py` — Openverse CC 배경 이미지 검색
  - `image_library.py` — 이미지 라이브러리 매칭
  - `sd_generator.py` — ComfyUI API 클라이언트 (SD 이미지/영상 생성)
  - `market_crawler.py` — 시장 데이터 크롤러 (네이버 증시, CoinGecko, 공포탐욕지수)
  - `youtube_uploader.py` — YouTube 업로드
- `templates/dashboard.html` — Jinja2 + Tailwind 대시보드
- `static/app.js` — 폴링 기반 프론트엔드 (큐 상태, 완료/활성 분리, OAuth 토큰 발급)
- `static/style.css` — 대시보드 스타일
- `templates/composer.html` — 프리프로덕션 편집기 페이지
- `static/composer.js` — 편집기 프론트엔드 (타임라인, 오버레이, TTS, SFX/BGM)
- `static/composer.css` — 편집기 스타일
- `pipeline/composer.py` — 편집기 백엔드 (데이터 수집/저장)

## 기술 스택
- FastAPI + Uvicorn, SQLite WAL, Vanilla JS + Tailwind, gTTS/edge-tts, Puppeteer, ffmpeg
- 배경 이미지: Gemini 이미지 (자동) / Gemini Veo 영상 (자동, 6초) / Genspark (수동) / Openverse CC API (자동 폴백) / SD (ComfyUI)
- 뉴스 수집: Google News RSS (Google/YouTube 트렌드 제거됨)
- TTS: gTTS/edge-tts (기본), GPT-SoVITS (설치 완료, 통합 예정)

## Phase 현황
- Phase 1 (코어 파이프라인 + 웹 대시보드): **완료**
- Phase 2 (Claude 에이전트 연동 — 뉴스검색+대본): **완료**
- Phase 3 (슬라이드 품질 개선 — 배경 이미지): **완료** (Genspark 수동 + 벌크 업로드)
- Phase 4 (YouTube 업로드): **완료**
- Phase 5 (트렌드 수집 연동): **제거됨** (Google/YouTube 트렌드 삭제, 뉴스 RSS만 유지)
- Phase 6 (나레이션 업로드): **완료**
- Phase 7 (JobQueue 순차 실행): **완료**
- Phase 8 (GPT-SoVITS 다양한 음성): **진행 중** (설치 완료, 파이프라인 통합 남음)

## 파이프라인 단계
1. news_search → 2. script → 3. slides (배경+슬라이드) → 4. tts (또는 나레이션 업로드) → 5. render → 6. upload
- QA 단계 제거됨

## 파이프라인 흐름 (2단계 실행)

### Phase A: 대본 생성 (병렬)
```
채널 실행 → parse_request() → 주제 리스트
         → 주제별 Job 생성 → generate_script() → script_json → waiting_slides
```
- 24시간 내 동일 주제 중복 필터링
- 주제 간 다른 분야 강제 (프롬프트 강화)

### Phase B: 영상 제작 — JobQueue 순차 실행 (GPU 리소스 보호)
```
waiting_slides → [queued] → 슬라이드 렌더링 → TTS 또는 나레이션 → 영상 합성 → 업로드
```
- `JobQueue`: deque 기반 FIFO, 한 번에 1개 Job만 Phase B 실행
- 상태 흐름: waiting_slides → queued → running → completed/failed

## DB/경로
- 채널 DB: `data/channels.db` (channels 테이블 — 이식 가능, Win↔Mac 동기화)
- 작업 DB: `data/shorts.db` (jobs, job_steps 테이블 — 머신별)
- 서버 첫 시작 시 `channels.db` 없으면 `shorts.db`에서 channels 자동 마이그레이션
- `app.py`에서 `db_ch` (channels), `db` (jobs) 두 인스턴스 사용
- `db/models.py` 채널 함수는 `db_ch`, 작업 함수는 `db` 파라미터
- `pipeline/runner.py` 함수 시그니처: `start_pipeline(db_ch, db, ...)`, `resume_pipeline(db_ch, db, ...)`
- ffmpeg: `C:\Users\msoh\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.0.1-full_build\bin\`

---

## 뉴스 탐색

- Google News RSS로 뉴스 수집 (탐색 탭)
- Google Trends / YouTube Trending 수집 기능 **제거됨** (UI + 채널 설정에서 삭제)
- `youtube_api_key` 채널 config 필드 미사용 (삭제 가능)

---

## 나레이션 업로드 (Phase 6)

### 흐름
- 작업 상세 팝업에서 **TTS 생성** / **음성 업로드** 택1
- 업로드: `POST /api/jobs/{id}/narration` → `{job_dir}/narration.mp3`
- Phase B에서 `_find_narration()` → 파일 있으면 TTS 스킵
- `_render_with_narration()`: 나레이션 길이 ÷ 슬라이드 수 = 균등 배분 → 슬라이드쇼 영상 + 나레이션 합성

---

## 배경 이미지 히스토리

### 시도 1: Pollinations.ai (AI 이미지 생성)
- **탈락**: 무료 티어에서 사용 불가

### 시도 2: Bing 이미지 크롤링
- **탈락**: 저작권 문제

### 시도 3: Openverse CC API (원스탑 파이프라인용)
- CC 라이선스 이미지, 한국 뉴스 주제에 약함
- 원스탑 파이프라인(`start_pipeline_full`)에서 자동 배경으로 사용

### 현재: Genspark (수동)
- 대본 생성 후 Genspark 프롬프트(영어) 자동 생성 → 사용자가 복사해서 이미지 생성
- 벌크 업로드 (전체 업로드 버튼) 또는 개별 슬롯 업로드
- 이미지 라이브러리 자동매칭 지원

### Stable Diffusion (ComfyUI — 구현 완료)
- 사용자 PC: RTX 2070 SUPER 8GB / Ryzen 7 3700X / 32GB RAM
- ComfyUI v0.16.3: `C:\git\ComfyUI` (venv, PyTorch 2.6.0+cu124)
- 모델: SD 1.5 (`v1-5-pruned-emaonly.safetensors`)
- 시작: `C:\git\ComfyUI\start_comfyui.bat` (--disable-cuda-malloc 필수)
- `pipeline/sd_generator.py` — ComfyUI API 클라이언트
- 이미지 프롬프트: 밝은 톤 강제 (dark/moody/red 계열 금지)
- GPU 동시 사용 불가 → JobQueue로 순차 실행

---

## Puppeteer 배경 이미지 핵심 이슈

### 문제: `file:///` URL 차단
- `page.setContent(html)` → 오리진이 `about:blank`
- **해결**: `generate_slides.js`의 `bgInfo()`에서 이미지를 base64 data URL로 변환

### 오버레이 불투명도
- 현재: **35-50%** (`rgba(5,8,20,0.45)` ~ `rgba(5,8,20,0.50)`) — 밝게 조정됨

### 경로 주의사항
- Python → Node.js(Puppeteer)로 경로 전달 시 **절대경로 + 포워드 슬래시** 필수
- `slide_generator.py`에서 `os.path.abspath().replace("\\", "/")` 처리
- Windows 백슬래시(`\`) 경로는 Node.js `fs.existsSync()`에서 실패할 수 있음

### 수정 후 체크리스트
- `generate_slides.js` 또는 `slide_generator.py` 수정 후 반드시 확인:
  1. 배경 이미지(PNG/JPG)가 슬라이드에 반영되는지
  2. MP4/GIF 배경일 때 `slide_X_overlay.png`가 생성되는지
  3. overlay가 있을 때 영상 합성에서 움직이는 배경이 적용되는지
- 경로 관련 수정 시: Node.js에서 `fs.existsSync(path)` 테스트

---

## 배경 이미지 데이터 흐름

```
[수동 업로드] → {job_dir}/backgrounds/bg_1.jpg, bg_2.jpg, ...
             → runner._load_uploaded_backgrounds() → list[dict]
             → slide_generator → generate_slides.js → base64 data URL
```

- Closing 슬라이드: 마지막 콘텐츠 슬라이드 배경 이미지 재사용
- 실패 시 기본 그라디언트 폴백

---

## GPT-SoVITS TTS (Phase 8 — 진행 중)

### 설치 상태: 완료
- 경로: `C:\git\GPT-SoVITS` (venv, Python 3.12, PyTorch 2.6.0+cu124)
- API 서버: `start_api.bat` → `python api_v2.py -a 127.0.0.1 -p 9880`
- 모델: GPT-SoVITS v2 weights, chinese-roberta-wwm-ext-large, chinese-hubert-base
- 의존성 패치 완료:
  - `jieba_fast` → `jieba` 폴백 (chinese.py, chinese2.py, tone_sandhi.py)
  - `eunjeon` → `python-mecab-ko` shim (`venv/Lib/site-packages/eunjeon/__init__.py`)
  - `pyopenjtalk` 제거 (일본어 전용, 빌드 불가)

### 남은 작업
1. **GPT-SoVITS API 서버 실행 확인** — `start_api.bat` 실행 후 한국어 TTS 정상 동작 테스트
2. **참조 음성 준비** — GPT-SoVITS는 참조 오디오(3~10초)로 음색 복제, 채널별 참조 음성 필요
3. **tts_generator.py 통합** — GPT-SoVITS API 호출 옵션 추가
   - 채널 config에 `tts_engine` 필드 추가 (`edge-tts` | `gpt-sovits`)
   - GPT-SoVITS 설정: `sovits_ref_audio`, `sovits_ref_text`, `sovits_model` 등
4. **대시보드 UI** — 채널 설정에서 TTS 엔진 선택, 참조 음성 업로드
5. **VRAM 관리** — SD(ComfyUI)와 GPT-SoVITS는 동시 GPU 사용 불가 (8GB)
   - JobQueue가 순차 실행하므로 충돌 방지됨
   - 단, ComfyUI와 GPT-SoVITS 서버 동시 실행 시 VRAM 부족 가능

### GPT-SoVITS API 사용법 (참고)
```
POST http://127.0.0.1:9880/tts
{
  "text": "안녕하세요",
  "text_lang": "ko",
  "ref_audio_path": "참조음성.wav",
  "prompt_text": "참조음성의 텍스트",
  "prompt_lang": "ko"
}
→ WAV 오디오 응답
```

---

## 채널 목록
- **이슈 TOP 5** (ch-0001) — 종합 뉴스, 기본 채널
- **코인시황** (ch-0002) — 코인 뉴스, 인포그래픽 스타일, 가운데 레이아웃
  - 업비트/빗썸 신규상장/상폐 + 핫 코인 뉴스
  - OAuth 토큰 발급 완료
- **코인시황 TOP5** (ch-0003) — 코인 라운드업
- **30초 뉴스** (ch-0004) — 짧은 뉴스
- **코인 브리핑** (ch-0005) — 데일리 시장 브리핑 (글로벌→국내→코인 고정 3섹션)
  - `fixed_topic: true` — parse_request 스킵, 고정 주제로 대본 생성
  - `market_data_sources` — 시장 데이터 자동 크롤링 → 프롬프트 주입
- **동물심리 60초** (ch-0006) — 반려동물 행동 심리학 교양 콘텐츠
  - 60~90초 목표, 친근한 크리에이터 톤
  - `slide_zone_ratio: "1.5:7:1.5"` — 이미지 중심 레이아웃
  - `slide_text_bg: 10` — 완전 검정 텍스트 배경
  - Gemini Veo 영상 추천 활용
  - 시즌제: 시즌1 고양이 → 시즌2 강아지 → 시즌3 비교 심리

---

## 최근 변경사항 (요약)
- **수동 대본**: category 상위 이동 (속보 체크박스), 슬라이드에 image_prompt_ko/en 추가
- **채널 설정 연동**: 수동 지침에 slide_layout, image_style, image_prompt_style 반영
- **image_prompt 자동 사용**: script_json에 image_prompt_en 있으면 Claude 프롬프트 생성 스킵 → 바로 이미지 생성
- **accent_color**: 고정값 제거, AI가 주제별 색상 추천
- **그라디언트 제거**: generate_slides.js에서 accent 기반 radial/linear gradient 제거
- **나레이션 규칙**: "1문장" → "1~3문장" + 영상 길이 맞춤
- **QA 단계 제거**: 파이프라인 아이콘에서 QA 삭제
- **UI**: "영상 미리보기" → "영상 제작"
- **트렌드 제거**: Google Trends / YouTube Trending UI + 채널 설정 삭제, 뉴스 RSS만 유지
- **JobQueue**: Phase B 순차 실행 (GPU 충돌 방지), 상태 `queued` 추가
- **중복 방지**: 24시간 내 동일 주제 필터 + 프롬프트 강화
- **Closing 텍스트**: 하드코딩 제거 → 채널 지침 기반
- **인트로/아웃트로 나레이션**: 채널 config에 `intro_narration`/`outro_narration` 텍스트 설정 → TTS로 음성 생성 → 이미지+나레이션 세그먼트 렌더링 (duration=오디오 길이). 텍스트 없으면 기존 무음+설정 duration 유지
- **SFX/BGM 타이밍 보정**: 인트로 세그먼트 추가 시 SFX/BGM 오프셋 자동 보정. concat(SFX 없이) → wrap → apply_audio_mix(offset) 분리 흐름
- **인트로 나레이션 딜레이**: `audio_delay` 파라미터로 SFX 오프닝 시간 확보 (채널 config `narration_delay`)
- **BGM 길이 보정**: 영상 전체 길이(ffprobe) 기반으로 BGM 종료 시점 계산 → 아웃트로까지 BGM 유지
- **슬라이드간 나래이션 갭**: 0.3초 무음 패딩 (`_pad_slide_audio`) → 자연스러운 쉼
- **클로징 나래이션 중복 방지**: 아웃트로 있을 때 마지막 슬라이드 클로징 멘트 제거 (`_strip_closing_audio`). AI 프롬프트에도 아웃트로 존재 시 엔딩 멘트 생성 금지 지시 추가
- **빈 문장 필터링**: 빈 text 문장 자동 제거 + 오디오 캐시 무효화 (인덱스 불일치 방지)
- **이미지 상태 표시 개선**: 이미지 업로드 완료 시 "영상 제작 대기" 표시 (기존: 항상 "이미지 업로드 필요")
- **영상 미리보기 개선**: video 태그에 poster/thumbnail 추가, 렌더 완료 시 UI 자동 전환
- **면책 문구 조건부 적용**: 투자/금융 관련 뉴스일 때만 면책 문구 포함 (일반 경제 뉴스 제외)
- **시장 데이터 크롤러** (`pipeline/market_crawler.py`): 채널 config에 `market_data_sources` 설정 시 자동 크롤링 → instructions에 주입
  - 소스: 네이버 해외지수(다우/S&P/나스닥), 네이버 국내지수(코스피/코스닥), 투자자별 매매동향(외국인/기관/개인), CoinGecko(BTC), 공포탐욕지수(전일 대비 변화)
  - 크롤링 수치 우선 사용 지시 (WebSearch 시세 검색 금지)
- **고정 주제 채널**: `fixed_topic: true` 설정 시 `parse_request` 스킵, `default_topics`를 그대로 topic으로 사용
- **인트로 나레이션 템플릿**: `{날짜}` → "3월 11일", `{요일}` → "수요일" 자동 치환
- **인트로 나레이션 대본 연결**: 인트로 나레이션이 있으면 첫 슬라이드 sentences가 인트로에 자연스럽게 이어지도록 지시
- **이미지 프롬프트 bg_display_mode 반영**: `bg_display_mode: fullscreen`이면 레이아웃과 무관하게 1080×1920(9:16) 이미지 생성
- **채널 내보내기/가져오기**: JSON 파일로 전체 채널 데이터 내보내기(`GET /api/channels/export`) / 가져오기(`POST /api/channels/import`, upsert). 사이드바 ↓↑ 버튼
- **슬라이드 오버레이 밝기 조정**: `.bg-overlay` 25/15/45%, `.text-bg` 72%, overview 45-60%
- **한국어 줄바꿈**: `word-break: keep-all` 적용 (단어 중간 줄바꿈 방지)
- **슬라이드 텍스트 크기 축소**: content main 100px, sub 52px / opening main 110px, sub 56px
- **Closing 슬라이드 오판 수정**: `bg_type`이 closing이 아닌 마지막 슬라이드는 content로 렌더링
- **Phase B 프롬프트 덮어쓰기 수정**: Phase A에서 생성한 image_prompts를 Phase B가 보존
- **Veo 영상 추천**: 이미지 프롬프트에 `media` 필드 추가 ("image"/"video"), AI가 30~40% 영상 추천. Gemini Veo API로 6초 영상 생성, 실패 시 이미지 폴백
- **슬라이드 영역 비율 커스텀**: `slide_zone_ratio` (예: "1.5:7:1.5") — center/top/bottom 레이아웃의 상:중:하 비율 조정. 기본 "3:4:3"
- **텍스트 배경 불투명도**: `slide_text_bg` (0~10) — 0=투명, 10=완전 검정. 기본 4
- **MP3 concat 재인코딩**: `sync_engine.py` — `-c copy` 대신 libmp3lame 재인코딩으로 문장 시작 음절 씹힘 수정
- **오디오 패딩 포맷 매칭**: `_pad_slide_audio()` — ffprobe로 원본 오디오 샘플레이트/채널 감지 → 무음 패딩 동일 포맷 생성
- **동물심리 60초 채널** (ch-0006): 반려동물 행동 심리학 교양 채널 추가
- **프리프로덕션 편집기(Composer)**: `/composer/{job_id}` — CapCut 스타일 영상 편집기
  - **UI**: 아이콘 탭 사이드바 (미디어/효과음/배경음/요소/텍스트/나레이션) + 미리보기(9:16) + 타임라인
  - **미디어 탭**: 배경 이미지 2열 그리드, 업로드, 슬라이드 삭제
  - **효과음 탭**: SFX 드래그 배치, 볼륨/페이드인/아웃, 타임라인 좌우 핸들로 시작/길이 조절
  - **배경음 탭**: BGM 적용, 볼륨/시작/종료/페이드인/아웃, 타임라인 드래그 이동+좌우 핸들
  - **요소 탭**: 말풍선 SVG 9종 + 이미지 요소, 드래그/회전/4코너 리사이즈
  - **텍스트 탭**: 오버레이 편집 (제목/부제/크기/색/폰트/위치/회전/불투명도), 텍스트 강조(부분 컬러), 자유 텍스트 추가
  - **나레이션 탭**: 문장 리스트, TTS 엔진 선택(Edge/Google/SoVITS), 슬라이드별/전체 TTS 생성, 음성 업로드
  - **미리보기**: ▶ 재생/정지 토글, 슬라이드 순서대로 배경+오버레이+나레이션+BGM+SFX 동시 재생
  - **타임라인**: 프레임 스트립, 플레이헤드(60fps), 클릭/드래그 탐색, SFX/BGM 트랙
  - 빈 closing 슬라이드 자동 제외, TTS 미생성 시 자동 생성 후 재생
  - 파일: `templates/composer.html`, `static/composer.js`, `static/composer.css`, `pipeline/composer.py`
  - API: `GET /api/jobs/{id}/composer`, `POST /api/jobs/{id}/composer/save`, `POST /api/jobs/{id}/composer/tts`, `POST /api/jobs/{id}/composer/audio/{n}`, `GET /api/jobs/{id}/audio/{filename}`
  - 편집 데이터: `compose_data.json` (slide_order, slide_overrides, freeTexts, elements, sfx_markers, bgm)
- **슬라이드 오버레이 오버라이드**: `generate_slides.js`에 `slideOverrides` 입력 지원
  - `buildCustomContent()`: 커스텀 위치/크기/색/폰트/회전/불투명도
  - `buildHiddenOverlay()`: 텍스트 없이 배경만 렌더링 (오버레이 제거)
  - `slide_generator.py` → `generate_slides()` 함수에 `slide_overrides` 파라미터 추가
  - `runner.py`: Phase B에서 `compose_data.json`의 `slide_overrides` 자동 로드
- **YouTube 썸네일 2MB 제한 대응**: `slide_generator.py`에서 썸네일 생성 직후 2MB 초과 시 JPEG 변환+압축
- **스크롤바 스타일**: 전역 `*` 셀렉터로 얇은 다크 스크롤바 적용

---

## 이미지/영상 프롬프트 작성 지침

`pipeline/agent.py`의 `generate_image_prompts()`가 참조하는 기준.
채널 config의 `image_prompt_style`로 채널별 커스텀 가능 (비어있으면 `DEFAULT_IMAGE_PROMPT_STYLE` 사용).

### 핵심 원칙
1. **구체적 장면 묘사** — 추상 개념 금지, 카메라맨이 실제로 촬영할 수 있는 장소/사물
2. **영어 프롬프트** — 모든 AI 이미지 모델(Gemini, SD 등)은 영어가 품질 최상
3. **30-60 words** — 너무 짧으면 디테일 부족, 너무 길면 혼란

### 프롬프트 필수 구성요소 (5요소)
| 요소 | 설명 | 예시 |
|------|------|------|
| **Subject** | 핵심 피사체 | semiconductor fabrication plant, voting booth |
| **Setting** | 배경/환경 | industrial campus, bright sterile cleanroom |
| **Lighting** | 조명/분위기 | morning sunlight, bright fluorescent lighting |
| **Camera** | 앵글/구도 | cinematic wide shot, aerial view, close-up |
| **Style** | 스타일 키워드 | photojournalism style, 8k resolution, sharp focus |

### bg_type별 전략 (2가지 스타일 체계)

#### 실사 스타일 (photo, broll, logo)
- **photo**: 실제 장소/건물/사물 + `realistic, sharp focus, professional photography, 8k resolution`
- **broll**: photo와 유사 + `cinematic shot, news B-roll style, dramatic composition`
  - 영상 모델(Veo)에서만 `gentle camera pan, slow zoom` 사용 가능
- **logo**: 해당 기업 건물 외관 + `brand signage visible, cinematic wide shot`

#### 인포그래픽/일러스트 스타일 (graph)
- **graph**: **실사(realistic) 절대 금지**. 반드시 인포그래픽/일러스트 스타일.
  - 필수 키워드: `flat illustration, vector art, infographic, clean lines, soft pastels`
  - 수치 비교: 저울, 막대 그래프, 화살표, 아이콘
  - 쟁점 대립: `split screen, left vs right, comparison layout, vs layout`
  - 통계/데이터: `diagram, charts and graphs, iconography, isometric view`
  - Gemini 사용 시: 프롬프트로 직접 인포그래픽 이미지 생성
  - SD 사용 시: Claude Haiku HTML 인포그래픽 → Puppeteer 렌더링

#### closing
- 항상 빈 문자열 → 마지막 콘텐츠 슬라이드 배경 재사용

### 뉴스 주제 → 장면 매핑 (참조)
| 주제 | photo/broll (실사) | graph (인포그래픽) |
|------|-------------------|-------------------|
| 투표/선거 | 투표소, 투표함, 파란 커튼 | 투표율 비교 차트, 찬반 비율 다이어그램 |
| 국회/정치 | 국회의사당 외관, 돔 지붕 | 의석수 비교, 법안 찬반 아이콘 |
| 반도체/삼성 | 팹 공장 외관/클린룸 내부 | 생산량 그래프, 공정 다이어그램 |
| 주식/증시 | 거래소 모니터, 캔들스틱 차트 | 지수 변동 그래프, 업종별 비교 |
| 부동산 | 아파트 단지 항공뷰, 드론샷 | 가격 추이 그래프, 지역별 비교 |
| 코인/가상화폐 | 거래소 모니터, 네온 조명 | 시총 비교 다이어그램, 가격 차트 |
| 무역/수출 | 컨테이너 항구, 크레인 | 수출입 비교 막대 그래프 |
| 쟁점/대립 | (graph 사용 권장) | 좌우 분할, 저울, VS 레이아웃 |

### BANNED (금지 요소)
- 사람, 얼굴, 신체 부위, 손
- 이미지 내 텍스트/숫자/글자 렌더링
- 어두운/공포/무거운 톤 → 항상 밝고 전문적
- 저화질, 흐림, 워터마크

### 모델별 참고
- **Gemini**: 상세 프롬프트에 강함, `8k/cinematic` 키워드 효과적, `TEXT+IMAGE` 혼합 모드
- **SD (SDXL)**: 프롬프트 토큰 77개 제한, 네거티브 프롬프트 별도 (`SAFE_NEGATIVE`)
- **Veo (영상)**: `camera pan, zoom, motion` 키워드 효과적 (이미지 모델에서는 무의미)

---

## 금융/투자 콘텐츠 안전 규칙

`pipeline/agent.py`의 `generate_script()` 프롬프트에 하드코딩된 안전장치.
채널 지침보다 우선 적용되며, 모든 채널의 대본 생성에 강제 적용됨.

### 금지 사항
| 카테고리 | 금지 표현 예시 |
|---------|-------------|
| 투자 시그널 | "신호 포착", "매수 타이밍", "지금이 기회", "역대급 시그널" |
| 기술 지표 전망 | "RSI 과매도 → 반등", "골든크로스 → 상승", "MACD 돌파" |
| 과거 수익률 암시 | "당시 90% 반등", "이전에 2배" (미래 반복 암시) |
| 가격 예측 | 목표가, "~까지 오를 수 있다", "~% 상승 가능" |

### 허용 사항
- 팩트 전달: "스테이킹 비율이 30%를 넘었다"
- 시장 상황 설명: "거래소 보유량이 감소하고 있다"
- 전문가/기관 의견 인용: "~에 따르면" (출처 명시)
- 면책 문구: "투자 판단은 본인 책임입니다" — **투자/금융 관련 뉴스일 때만** (일반 경제 뉴스 제외)

### 적용 위치
- 채널 지침(instructions)에 금융/투자 안전 규칙 포함
- 면책 문구는 투자/금융 뉴스(주식, 코인, 금리, 펀드 등)에만 조건부 적용
- 일반 경제 뉴스(물가, 유가, 환율 단순 보도)에는 면책 문구 불필요

---

## 시장 데이터 크롤러 (`pipeline/market_crawler.py`)

### 데이터 소스 (무료, 인증 불필요)
| 데이터 | 소스 | 함수 |
|--------|------|------|
| 다우/S&P/나스닥 | 네이버 해외지수 API | `fetch_global_indices()` |
| 코스피/코스닥 | 네이버 국내지수 API (m.stock) | `fetch_kr_indices()` |
| 외국인/기관/개인 순매수 | 네이버 투자자 동향 API | `fetch_investor_trends()` |
| BTC 시세 + 거래량 | CoinGecko API | `fetch_btc()` |
| 공포탐욕지수 (전일 대비) | alternative.me API | `fetch_fear_greed()` |

### 채널 config 설정
```json
"market_data_sources": ["global_stocks", "kr_stocks", "investor_trends", "crypto", "fear_greed"]
```

### 인트로 나레이션 템플릿 변수
- `{날짜}` → "3월 12일"
- `{요일}` → "목요일"
- 예: `"{날짜} {요일} 코인 브리핑 시작합니다."`

---

## 남은 과제

1. **GPT-SoVITS 파이프라인 통합** — tts_generator.py에 GPT-SoVITS 엔진 추가 (위 상세 참조)
2. **밝은 배경 대응** — 이미지 밝기에 따라 오버레이 동적 조절
3. **테스트 커버리지** — 단위 테스트 없음

---

# 피드백

- [2026-03-10] 서버 재시작: `kill $(lsof -ti :9999)` 로 포트만 종료할 것. 파이어폭스 등 다른 프로세스 kill 금지
- [2026-03-11] 변수명 충돌 주의: `_now()`는 runner.py 모듈 함수. 로컬 변수로 `_now = datetime.now()` 사용 금지 → `_dt` 등 다른 이름 사용
