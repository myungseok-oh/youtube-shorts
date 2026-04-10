"""채널 에이전트: ch-0004 (30초 뉴스)

단일 뉴스 30초 브리핑 — 하나의 경제 이슈를 빠르고 핵심만 전달.
짧고 임팩트 있는 문장, 뉴스 앵커 톤.
"""
from pipeline.agents.base_agent import BaseAgent


class Agent(BaseAgent):

    SCRIPT_RULES = """\
- news_date: 참조 기사의 게시 날짜 (YYYY-MM-DD), 정확히 기입
- 하나의 뉴스 브리핑. sentences를 이어 읽으면 완결된 내레이션이 되어야 함
- 슬라이드 간 자연스러운 연결 (접속 표현 활용)
- 슬라이드별 역할: ①훅 → ②핵심 → ③배경 → ④영향/전망

### 30초 브리핑 분량 규칙
- sentences: 8~12개, 각 15~25자, 총 160~200자 (=35~45초)
- slides: 4~6개
- 슬라이드 1개당 문장 2~3개 (5개 이상 금지)
- ★ 슬라이드당 나레이션은 약 5초 또는 약 10초
  - 5초 = 1~2문장(20~25자), 10초 = 3~4문장(40~50자)
  - 6~7초 어중간한 길이 금지

### 톤 & 스타일
- 존댓말 뉴스 앵커 스타일, 감정 배제
- 핵심만 전달, 군더더기 없이
- 문장 어미 다양: ~입니다 / ~인데요 / ~됩니다 / ~한 상황입니다
  - 같은 어미 2번 연속 금지
- sentences에 채널명 언급 금지, HTML 태그 금지 (순수 텍스트만)
- 강조 키워드는 main/sub에만: <span class="hl">...</span>
- 첫 슬라이드: category에 주제 태그, main 짧고 강렬
- youtube_title: 40자 이내, 핵심 수치/키워드 포함
- bg_type: photo | broll | graph | logo

### ★ 슬라이드 텍스트 임팩트 (음소거로도 내용 파악)
- **main**: 핵심 수치/팩트 필수. "환율 급등" → "원/달러 <span class=\\"hl\\">1,450원</span> 돌파"
- **sub**: 원인/맥락 한줄. "美 금리 인상 + 엔캐리 청산 여파"
- 30초 영상이므로 main만 훑어도 전체 스토리가 잡혀야 함"""

    IMAGE_PROMPT_STYLE = """\
너는 뉴스 영상의 비주얼 디렉터야. 30초 단일 뉴스이므로 4~6장으로 하나의 스토리를 전달.

ALL prompts in English, 30-60 words, 5요소: subject, setting, lighting, camera, style

## 30초 뉴스 비주얼 전략
- 슬라이드 적으므로 각 이미지의 임팩트 중요
- 훅(첫 장면): 가장 강렬한 비주얼로 시선 잡기
- wide → close-up → wide 스케일 변화
- 한 뉴스의 연속 장면이므로 색감/톤 일관성 유지

## bg_type별 스타일
- **photo**: 기사 현장. realistic, sharp focus, photojournalism, 8k
- **broll**: 시네마틱 B-roll. cinematic shot, news style
- **graph**: 인포그래픽 (실사 금지). flat illustration, vector art
- **logo**: 기업 건물 외관

## BANNED
- text, numbers in image
- 사람, 얼굴, 신체
- dark, moody themes
- 같은 장소 반복"""
