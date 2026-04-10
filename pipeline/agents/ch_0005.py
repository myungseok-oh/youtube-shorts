"""채널 에이전트: ch-0005 (증시/코인)

데일리 시장 브리핑 — 글로벌 증시 → 국내 증시 → 코인 고정 3섹션.
시장 데이터 크롤러(market_crawler)가 수치를 자동 주입.
금융 안전 규칙 엄격 적용.
"""
from pipeline.agents.base_agent import BaseAgent


class Agent(BaseAgent):

    ROUNDUP_RULES = """\
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
- sentences에 채널명 언급 금지, HTML 태그 금지 (순수 텍스트만)
- 강조 키워드는 main/sub에만: <span class="hl">...</span>
- 단순 수치 나열 금지 → 각 슬라이드에 "왜" 1줄 이상
- 섹션 간 연결: "미 증시 상승 영향으로 국내도..." 식 흐름
- 확인 불가 수치는 "소폭 상승/약보합/하락세" 사용, 임의 숫자 금지
- youtube_title: 40자 이내, 핵심 수치 + 날짜 포함
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

## ★ 핵심 원칙: 피사체 다양성
- 모든 슬라이드가 건물 외관/스카이라인이면 안 됨. 반드시 다양한 피사체를 사용
- 8~10장 중 건물/스카이라인은 최대 2장까지만 허용
- 나머지는 아래 피사체 풀에서 뉴스 내용에 맞게 선택

## 피사체 풀 (섹션별)

### 글로벌 증시
- 트레이딩 모니터: multiple trading monitors displaying candlestick charts, green/red glow
- 전광판 클로즈업: LED stock ticker board scrolling numbers, warm amber glow
- 증권가 상징물: bronze Wall Street bull statue, dramatic low angle
- 금/원자재: stack of gold bars in bank vault, metallic reflections
- 신문/미디어: financial newspaper front page with stock charts, shallow depth of field
- 회의실: glass boardroom table with financial documents, soft overhead lighting

### 국내 증시
- 트레이딩 데스크: row of trading desk monitors with Korean stock data, blue ambient
- 반도체/산업: semiconductor wafer closeup, cleanroom blue lighting, macro shot
- 자동차/제조: automotive assembly line robotic arms, factory lighting
- 배터리/에너지: lithium battery cells stacked in factory, industrial blue-white
- 조선/중공업: massive ship hull in dry dock, scale perspective
- 화폐/경제: Korean won coins and bills, shallow depth of field macro

### 코인 시장
- 채굴 장비: GPU mining rig closeup with glowing fans, neon ambient
- 서버 회로: circuit board macro with glowing traces, cyberpunk blue-purple
- 하드웨어 월렛: hardware crypto wallet on desk, moody desk lamp lighting
- 블록체인 상징: fiber optic cables hub, blue data stream lighting
- 거래 환경: laptop screen in dark room with crypto interface glow

## bg_type별 스타일
- **photo**: realistic, sharp focus, professional photography, 8k resolution
- **broll**: cinematic shot, dramatic composition, depth of field
- **graph**: 실사 오브젝트 클로즈업 (차트/인포그래픽 아님). 주제를 상징하는 사물 매크로 촬영

## ★ 연속 슬라이드 규칙
- 인접한 2장이 같은 카테고리 피사체(예: 건물+건물, 모니터+모니터) 금지
- 원경(wide/aerial) → 근경(closeup/macro) 교대 배치 권장
- 조명 톤도 다양하게: 야경 → 주간 → 네온 → 자연광 번갈아

## BANNED
- text, numbers rendered in image
- 사람, 얼굴, 신체
- dark horror themes (금융 야경 어두움은 허용)
- 같은 피사체/구도 2번 이상 반복"""
