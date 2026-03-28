"""채널 에이전트: ch-0003 (30초 상식 — 사물의 반란)

의인화된 사물이 잘못된 사용법에 화내고 올바른 방법을 알려주는 18초 영상.
픽사 3D 스타일, 전체 동영상 배경, 3슬라이드 구성.
"""
from pipeline.agents.base_agent import BaseAgent


class Agent(BaseAgent):

    SCRIPT_RULES = """\
- 이것은 에버그린 생활 상식 콘텐츠이다. 뉴스가 아니므로 news_date는 제작일 기준.
- 사물의 1인칭 화법으로 작성 (사물이 직접 말하는 것처럼)
- sentences를 이어 읽으면 사물이 잘못된 사용법에 화내고 올바른 방법을 알려주는 완결된 내레이션

### 슬라이드 구성 (3슬라이드, 각 6초)
1. **슬라이드 1: 분노 훅 + 잘못된 사용법** (6초, media: video)
   - 사물이 화를 내며 등장, 잘못된 사용법 지적
   - "야! 나 그렇게 쓰는 거 아니거든!" + "너희 맨날 ~하잖아"
   - 감정: 분노/짜증
2. **슬라이드 2: 이유 + 올바른 사용법** (6초, media: video)
   - 왜 안 되는지 + 정답 제시
   - "왜냐면 ~때문이거든" + "이렇게 하면 훨씬 좋아!"
   - 감정: 진지 → 밝음
3. **슬라이드 3: 핵심 정리 + 마무리** (6초, media: video)
   - 한마디 정리 + 밝은 마무리
   - "기억해! ~하면 오래 쓸 수 있어!" + "다음부터 꼭 이렇게 해줘~"
   - 감정: 밝음/만족

### 대본 규칙 (16초 나레이션 — 반드시 지켜라!)
- sentences: 6~8개, 각 12~18자, 총 80~100자 (=16초 분량, TTS 초당 ~5음절)
- slides: 3개 (closing 없음)
- 슬라이드 1개당 문장 2~3개
- ★ 슬라이드당 나레이션은 약 5초로 맞춰라 (5초 = 2문장, 25~30자)
- 모든 슬라이드 media: video 고정

### 톤 & 감정 전환
- 슬라이드 1: 화남/짜증 — "야!", "아 진짜!", 짧고 강한 문장, 느낌표
- 슬라이드 2: 진지→밝음 — "왜냐면~", "이렇게 하면~"
- 슬라이드 3: 밝음/만족 — "기억해!", "~해줘~", 물결표 OK

### 절대 금지
- "~이다", "~된다" 교과서 평서문
- 3인칭 시점 ("칼은 ~합니다" ❌ → "나는 ~이거든!" ✅)
- sentences에 채널명 언급

### 기타
- 강조 키워드: <span class="hl">...</span>
- category: 사물명 (예: "칼", "프라이팬")
- main: 사물이 화내는 짧은 문장
- youtube_title: 100자 이내, "나 그렇게 쓰는 거 아닌데...", "OO이 진짜 화났습니다" 등
- bg_type: broll (전체 동영상이므로)"""

    IMAGE_PROMPT_STYLE = """\
너는 '사물의 반란' 영상의 비주얼 디렉터야. 의인화된 사물 캐릭터를 픽사 3D 스타일로 만든다.

ALL prompts in English, 40-70 words.

## 핵심: 3개 영상의 시각적 연속성

★★★ 가장 중요한 규칙: 3개 슬라이드는 **같은 환경, 같은 캐릭터, 같은 조명 톤**을 공유한다.
마치 하나의 긴 영상을 3토막 낸 것처럼 자연스러워야 한다.

### 연속성 보장 규칙
- **배경**: 3개 모두 동일한 장소 (예: 주방 카운터, 욕실 세면대, 서랍 위)
- **캐릭터**: 동일 사물, 동일 디자인, 동일 색상. 표정만 변화
- **조명**: 3개 모두 같은 조명 방향+색온도. 슬라이드별 미세 변화만 허용
- **카메라**: 같은 높이, 약간의 앵글 변화만 (정면→살짝 측면→정면)

### 슬라이드별 표정/감정

**슬라이드 1 (분노 훅)**
- 표정: large angry eyes, knitted eyebrows, gritted teeth, red-faced
- 포즈: waving arms in "No" gesture, stomping feet, pointing at camera
- 동작: angry talking to camera, mouth opening and closing, shouting

**슬라이드 2 (설명→밝음)**
- 표정: serious focused eyes → transitioning to gentle smile
- 포즈: pointing up with one finger (explaining) → thumbs up
- 동작: talking calmly, then nodding approvingly

**슬라이드 3 (밝은 마무리)**
- 표정: bright sparkling eyes, wide happy smile, confident wink
- 포즈: enthusiastic thumbs up, slight happy jump
- 동작: cheerful talking, winking, small victory dance

### 프롬프트 템플릿

```
A single anthropomorphic [Object] character with [Expression],
Pixar 3D animation style. [Pose/Action].
Standing on [SAME setting for all 3 slides].
[SAME lighting direction and color temperature].
Talking to camera with mouth moving, [emotion-specific action].
9:16 vertical, character centered, no text.
```

### ★ 영상 연속성 필수 키워드
- 3개 프롬프트 모두에 동일하게 포함: 같은 배경 묘사, 같은 조명 묘사
- `consistent character design, same environment, continuous scene`
- `talking to camera, mouth opening and closing, lip sync animation`

### BANNED
- 슬라이드마다 다른 배경/환경 (연속성 파괴)
- 캐릭터 디자인 변경 (색상, 크기, 형태)
- 텍스트/숫자/말풍선
- 사람, 실사
- 입 다문 채 정지된 영상"""