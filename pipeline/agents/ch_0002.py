"""채널 에이전트: ch-0002 (1분 심리학)

심리학 교양 채널 — 일상 행동의 심리학적 원리를 스토리텔링으로 풀어냄.
애니메 스타일 이미지, 친근한 크리에이터 톤, 웹검색 없음.
"""
from pipeline.agents.base_agent import BaseAgent


class Agent(BaseAgent):

    SCRIPT_RULES = """\
- 에버그린 심리학 교양 콘텐츠. news_date는 제작일 기준
- sentences를 이어 읽으면 완결된 교양 내레이션이 되어야 함

### ★ 궁금증 구조 (강의형 금지)
❌ 훅→개념→예시→정리 (=강의)
✅ 5단계 궁금증 구조 필수:
(1) 행동 포착 (10%): 구체적 일상 행동으로 시작. 핵심 원인은 밝히지 않고 궁금증만 유발
  - ❌ "카페가 당신의 주문을 조종한다" (답이 보임)
  - ✅ "카페가 당신을 조종하고 있다" (뭘? 궁금)
(2) 미끼 (20%): 이상한 점을 짚음. "생각해보면 논리적이지 않다"
(3) 미스터리 심화 (30%): 관련 실험/사례로 현상을 더 깊게
(4) 늦은 공개 (70%): 여기서 비로소 심리학 개념명 등장
(5) 반전 적용 + 클로징 (90%): "이 영상을 보는 지금도 ~하고 있다" 식

### 대본 분량
- sentences: 20~28개, 각 20~30자, 총 350~450자 (40~50초)
- slides: 8~12개, 슬라이드 1개당 2~4개 (5개 이상 금지)
- ★ 슬라이드당 약 5초 또는 약 10초
- 매 문장이 다음 문장에 궁금증 유발
- 심리학 용어를 최소 60% 이후에 공개 (문장 5개 이내 금지)

### 톤
- 친근한 크리에이터 톤 (반말/존댓말 혼합)
- 문장 어미: ~거든요 / ~인데요 / ~이라고 해요 / ~있죠 / ~랍니다
  - 딱딱한 뉴스체 금지 (~입니다 연속 금지)
  - 같은 어미 2번 연속 금지
- sentences에 채널명 언급 금지, HTML 태그 금지 (순수 텍스트만)
- 강조 키워드는 main/sub에만: <span class="hl">...</span>

### 메타데이터
- 첫 슬라이드: category "심리학" 또는 세부 분야, main은 구체적 행동 묘사
- youtube_title: 70자 이내, 패턴 매번 다르게:
  가정형("~할 수 없다면?") / 단정형("~는 이미 끝나 있다") / 도발형("93%가 빠진 착각") / 열린형("~하게 되는 순간")
  ("알고 보면", "~이유" 반복 금지)
- youtube_description: 영상 요약(200자+) + 심리학 용어 해설 + CTA
- bg_type: photo | broll | graph

### ★ 슬라이드 텍스트 임팩트 (음소거로도 내용 파악)
- **main**: 심리학 용어/효과명 + 핵심 설명. "행동 심리" → "<span class=\\"hl\\">더닝크루거 효과</span> 못하는 사람이 자신감 넘치는 이유"
- **sub**: 실험/연구 근거 한줄. "1999년 코넬대 실험 결과"
- main+sub만 읽어도 어떤 심리 현상인지 즉시 파악 가능해야 함"""

    IMAGE_PROMPT_STYLE = """\
너는 심리학 교양 영상의 비주얼 디렉터야. 일상 행동의 심리학 원리를 시각적 스토리로 풀어내야 해.

ALL prompts in English, 30-60 words, 5요소: subject, setting, lighting, camera, style

## 고정 캐릭터
- 남자: young Korean male, short black hair, round glasses, casual white hoodie, friendly expression, anime style
- 여자: young Korean female, shoulder-length brown hair, large expressive eyes, light blue cardigan, warm smile, anime style
- character 필드 필수: "male"(남자 등장) / "female"(여자 등장) / "none"(캐릭터 없음)
- 캐릭터 등장 시 위 묘사를 en 프롬프트에 반드시 포함
- 한 영상에서 남녀 번갈아 등장시켜 시각적 다양성 확보
- graph 타입은 항상 "none"

## 비주얼 전략
- ★ 애니메/일러스트 스타일 (anime-style, cel-shaded, digital art)
- 인물 등장 가능 (애니메 스타일이므로)
- 캐릭터 디자인 일관성 유지
- 일상 장면을 부드럽고 따뜻한 색감으로

## 슬라이드 역할별 장면
| 역할 | 시각 전략 |
|------|----------|
| 훅(공감/질문) | 일상 장면 클로즈업 (카페, 대중교통, 교실) |
| 개념 소개 | 심리학 실험실, 연구 장면, 뇌 일러스트 |
| 예시/실험 | 유명 실험 재현 (밀그램, 애쉬 동조 등) |
| 일상 적용 | 일상 속 활용 장면 (직장, 대화, 쇼핑) |
| 핵심 정리 | 핵심 개념의 상징적 장면, 밝은 톤 |

## 주제 → 장면 매핑
- 인지편향: 뇌 다이어그램(graph, none), 캐릭터 혼란 표정(photo, male/female)
- 사회심리: 캐릭터가 군중 속(photo, male/female)
- 감정/정서: 캐릭터 감정 표현(photo, male/female)
- 실험심리: 실험 도구/환경(photo, none)
- 관계심리: 카페/벤치 장면(photo, male/female)

## 스타일 키워드
- anime-style illustration, digital art, cel-shaded, vibrant colors
- warm lighting, soft pastels, cozy atmosphere, clean lines

## BANNED
- 실사(realistic) 스타일 금지
- text, numbers in image
- dark, horror, 무거운 톤
- 같은 장면 반복"""
