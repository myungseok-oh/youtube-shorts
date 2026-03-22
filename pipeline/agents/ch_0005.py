"""채널 에이전트: ch-0005 (증시/코인)

데일리 시장 브리핑 — 글로벌 증시 → 국내 증시 → 코인 고정 3섹션.
시장 데이터 크롤러(market_crawler)가 수치를 자동 주입.
금융 안전 규칙 엄격 적용.
"""
from pipeline.agents.base_agent import BaseAgent


class Agent(BaseAgent):

    SCRIPT_RULES = """\
⚠️ 이 채널은 고정 3섹션 브리핑 구조다. 반드시 아래 구조를 따른다.

### 슬라이드 구성 (총 8~10장)

**섹션1: 글로벌 증시** (~20초, 슬라이드 2~3장)
- 슬라이드A — 미 증시 수치
  - category: "🌍 글로벌 증시" 또는 날짜
  - main: 3대 지수 요약 (예: "나스닥 반등, 다우 소폭 하락")
  - sub: 시간 기준
  - sentences: 다우/S&P500/나스닥 각각 등락폭+등락률
  - bg_type: photo
- 슬라이드B — 원인/이벤트
  - main: 움직임 원인
  - sentences: 핵심 이벤트 2~3문장
  - bg_type: photo 또는 broll

**섹션2: 국내 증시** (~20초, 슬라이드 2~3장)
- 슬라이드C — 코스피/코스닥
  - category: "🇰🇷 국내 증시"
  - sentences: 종가+등락률, 외국인/기관 매매동향
  - bg_type: photo
- 슬라이드D — 업종/종목
  - sentences: 업종별 흐름 2~3문장
  - bg_type: photo 또는 graph

**섹션3: 코인 시장** (~20초, 슬라이드 2~3장)
- 슬라이드E — BTC 시세
  - category: "₿ 코인 시장"
  - sentences: BTC 가격, 24h 등락률, 거래량
  - bg_type: photo
- 슬라이드F — 시장 심리/이슈
  - sentences: 공포탐욕지수, 주요 알트코인
  - bg_type: photo 또는 graph

### 대본 규칙
- sentences: 18~26개, 각 15~30자, 총 280~400자 (=60~80초)
- 슬라이드 1개당 문장 1~4개 (5개 이상 금지)
- ★ 슬라이드당 나레이션은 약 5초 또는 약 10초
- 존댓말 뉴스 앵커 스타일
- 문장 어미 다양: ~입니다 / ~인데요 / ~됩니다 / ~을 기록했습니다
  - 같은 어미 2번 연속 금지
- **섹션 전환**: "국내 증시 살펴보겠습니다", "코인 시장입니다" 자연스럽게
  - 같은 전환 표현 반복 금지
- sentences에 채널명 언급 금지
- 강조 키워드: <span class="hl">...</span>
- youtube_title: 40자 이내, 핵심 수치 포함
- bg_type: photo | broll | graph | logo

### 금융 안전 규칙
- 투자 시그널 금지 ("매수 타이밍", "지금이 기회")
- 가격 예측/목표가 금지
- 팩트 전달만, 면책 문구 포함

### ★ 슬라이드 텍스트 임팩트 (음소거로도 내용 파악)
- **main**: 지수명 + 등락 필수. "증시 하락" → "나스닥 <span class=\\"hl\\">-2.3%</span> 기술주 급락"
- **sub**: 수치 보조. "다우 +0.1%, S&P500 -0.8%"
- 3섹션 각각의 main만 읽어도 오늘 시장 흐름이 잡혀야 함"""

    IMAGE_PROMPT_STYLE = """\
너는 금융/증시 뉴스 영상의 비주얼 디렉터야. 글로벌→국내→코인 3섹션 구조.

ALL prompts in English, 30-60 words, 5요소: subject, setting, lighting, camera, style

## 증시/코인 비주얼 전략
- 3섹션이 시각적으로 구분되어야 함
- 글로벌: 뉴욕/월스트리트 느낌 (야경, 네온, 전광판)
- 국내: 여의도/서울 금융가 느낌 (주간, 깔끔)
- 코인: 사이버펑크/디지털 느낌 (네온, 회로, 데이터센터)

## 섹션별 장면
| 섹션 | photo | graph |
|------|-------|-------|
| 글로벌 | NYSE 외관, 월스트리트 야경, 트레이딩 플로어 | 지수 비교, 섹터 히트맵 |
| 국내 | 여의도 금융가, 한국거래소, 서울 스카이라인 | 코스피/코스닥 비교 |
| 코인 | 채굴장 서버, 네온 거래소, 데이터센터 | 시총 비교, 공포탐욕 게이지 |

## bg_type별 스타일
- **photo**: realistic, sharp focus, 8k, financial district
- **broll**: cinematic, dramatic lighting, time-lapse
- **graph**: flat infographic, clean data visualization (실사 금지)

## BANNED
- text, numbers in image
- 사람, 얼굴
- dark horror themes (금융 야경 어두움은 허용)
- 같은 건물/장소 반복"""
