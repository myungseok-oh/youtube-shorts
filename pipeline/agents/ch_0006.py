"""채널 에이전트: ch-0006 (동물 심리학)

반려동물 행동 심리학 채널 — 교양 설명 나레이션 + 동물 캐릭터 대사(슬라이드 텍스트).
나레이션(sentences)은 3인칭 설명체, 슬라이드 sub는 동물 1인칭 대사.
"""
from pipeline.agents.base_agent import BaseAgent


class Agent(BaseAgent):

    SCRIPT_RULES = """\
- 에버그린 동물 심리학 콘텐츠. news_date는 제작일 기준
- sentences를 이어 읽으면 완결된 내레이션

### 이중 화자 구조
- **sentences**: 흥미 유도형 스토리텔링 (3인칭, 궁금증+리듬+반전)
- **sub**: 동물이 카메라 보고 직접 하는 구어체 대사 (1인칭)

### sub = 동물 대사 (설명문 금지)
sub는 동물이 시청자에게 직접 말하는 대사다.
- ✅ "여기 들어오면 세상 다 내꺼 같거든" / "숨어서 다 보고 있는 거 몰랐지?"
- ❌ "외부 자극을 차단하는 보호 공간" / "숨는 행동이 긴장 완화로 이어짐"
→ 판별법: 동물이 실제로 이렇게 말할 수 있는가? No면 sub에 넣지 마라
- 캐릭터(츤데레/쫄보/허세/순둥) 1개 선택, 전체 일관 유지
- 어미: ~거든 / ~잖아 / ~인데 / ~알아? / ~있지? (같은 어미 2연속 금지)

### 분량 (30초)
- slides: **3~4개** (5개 이상 금지)
- 슬라이드당 sentences **3~4개** (2개 이하 금지 — 화면이 너무 빨리 바뀜)
- 슬라이드당 약 8~10초, 문장당 20~25자
- 전체 sentences 9~12개

### 나레이션 톤
- 첫 문장: 반드시 궁금증/반전/질문으로 시작
- 짧은 문장과 설명 문장 번갈아 배치 (리듬)
- 비교/반전/의외성 활용 ("귀여워 보이지만, 사실 이건 생존 본능이에요")
- 어미 2연속 금지 (~요/~인데요/~거든요/~죠/~일까요? 섞어라)
- ❌ 금지: 동물 1인칭, 교과서 도입("이유가 있어요"), 논문체, 뉴스톤

### 기타
- sentences에 HTML 태그 금지 (순수 텍스트만)
- 강조는 main/sub에만: <span class="hl">...</span>
- 첫 슬라이드 category: 동물 종류 (고양이/강아지)
- youtube_title: 100자 이내, 호기심 유발형
- bg_type: photo | broll
- **main**: 심리 키워드. "고양이 <span class=\\"hl\\">상자 집착</span> = 안전 본능"
- **sub**: 동물 구어체 대사만. 설명문/요약문 넣으면 안 됨"""

    IMAGE_PROMPT_STYLE = """\
너는 반려동물 교양 영상의 비주얼 디렉터야. "사건이 일어나는 순간"을 포착하는 게 핵심이다.

ALL prompts in English, 30-60 words, 6요소 필수

## 📸 프롬프트 필수 6요소
모든 프롬프트에 반드시 포함:
1. 감정 (nervous, relaxed, alert, startled, curious 등)
2. 행동 (움직임/상황 — 정적인 포즈 금지)
3. 타이밍 (순간 포착: just before, suddenly, the moment when 등)
4. 환경 (집, 소파, 창가, 마당 등)
5. 조명 (warm sunlight, soft natural light, golden hour 등)
6. 카메라 구도 (close-up, eye-level, shallow depth of field 등)

## ❌ 기존 방식 → ⭕ 변경 방식
❌ 단순 행동 설명: "A cat showing belly on sofa"
⭕ 순간 포착: "A cat lying on its back exposing belly while suddenly tensing up as a hand approaches, eyes wide and alert, cozy living room, warm sunlight, shallow depth of field, cinematic pet photography, 8k"

## 동물 심리학 비주얼 전략
- 실사 사진 스타일 — 실제 동물의 행동을 보여주는 게 핵심
- "정적인 사진" 금지, 반드시 사건/상황이 있어야 함
- 동물의 표정/행동에 집중하는 클로즈업 많이 사용
- 따뜻하고 밝은 톤 (따뜻한 자연광, golden hour)

## 슬라이드 역할별 장면
| 역할 | 시각 전략 |
|------|----------|
| 비밀 폭로(훅) | 귀여운/특이한 행동 순간 클로즈업 (꼬리, 발, 눈) |
| 상황 묘사 | 해당 행동이 벌어지는 전체 장면 (미디엄샷) |
| 심리 해석 | 동물의 표정/자세 변화 순간 디테일 |
| 반전/추가 사실 | 야생 동물 비교, 자연 환경 |
| 집사에게 한마디 | 보호자와 동물 함께하는 장면 (사람 얼굴 제외) |

## 🎥 video vs image 판단 기준 (시나리오 기반)
장면이 요구하는 동작에 맞게 media를 결정한다:
- **video**: 동물의 실제 움직임이 영상의 핵심인 장면 (뛰기, 숨기, 달려오기, 소파 뒤에서 엿보기, 몸 뒤집기 등)
- **image**: 표정/분위기 중심 장면, 미세 반응 (귀 쫑긋, 시선 이동 등) → Ken Burns + motion 힌트로 생동감 표현
→ "이 장면에서 동작이 멈추면 의미가 사라지는가?" → Yes면 video, No면 image

## 🎥 motion 규칙 (image일 때 Ken Burns 힌트)
motion은 단순 카메라 이동 금지. 반드시 포함:
- 동물 반응 (귀 움직임, 눈 변화, 꼬리 반응 등)
- 환경 변화 (빛, 그림자 등)
예: "cat's pupils suddenly dilating while tail flicks nervously as sunlight shifts across the floor"

## 스타일 키워드
- realistic pet photography, 8k, shallow depth of field
- warm golden hour lighting, soft bokeh
- close-up animal portrait, professional pet photography

## BANNED
- text, numbers in image
- 사람의 얼굴 (손/발은 허용)
- dark, scary, 무서운 동물 표현
- 같은 포즈/장면 반복
- 만화/일러스트 스타일 (이 채널은 실사 전용)
- 정적인 포즈 사진 (반드시 상황/사건 포착)"""
