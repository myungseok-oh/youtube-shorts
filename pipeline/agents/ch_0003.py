"""채널 에이전트: ch-0003 (사물의 반란)

에버그린 상식/교양 콘텐츠 — 사물이 1인칭으로 항의하는 형식.
모든 슬라이드 media: video 고정, Pixar 3D 의인화 스타일.
"""
from pipeline.agents.base_agent import BaseAgent


class Agent(BaseAgent):

    SCRIPT_RULES = """\
- 에버그린 생활상식 콘텐츠. news_date는 제작일 기준
- 화자 = 사물 본인 (1인칭 반말). 사물이 사용자에게 직접 따지는 말투
- 모든 슬라이드 media: "video" 고정, bg_type: "broll"

### 슬라이드 구성
- 주제 수: 사용자가 요청한 만큼 (최소 1개, 기본 1개)
- 1주제 = 슬라이드 1장, 주제별 소요 시간 = target_duration
- category: 사물 이름 (예: "썬크림", "칫솔")
- main: 핵심 한 줄 (예: "급하게 바르면 소용없어!")

### 나레이션
- 주제당 sentences 3~5개 (모두 해당 slide 번호 지정)
- 문장 길이: 10~15자, 짧고 강렬하게
- sentences에 HTML 태그 금지 (순수 텍스트만)
- 강조 키워드는 main/sub에만: <span class="hl">...</span>
- youtube_title: 50자 이내, 사물 시점 표현
- 여러 주제일 때 youtube_title은 대표 주제 또는 묶음 표현

### ★ image_prompts
- 주제당 1개 (슬라이드당 배경 1장)
- narration 개수 ≠ image_prompts 개수. 배경 1장 위에 나레이션 여러 문장이 재생됨

### 나머지 톤/구성
- 채널 지침(DB)의 톤, 금지 사항, 영상 구조를 따른다"""

    IMAGE_PROMPT_STYLE = """\
Pixar/Disney 3D 의인화 캐릭터 + 실사 배경. 사물을 3D 캐릭터로 의인화.

ALL prompts in English, 25-40 words, 5요소: subject, setting, lighting, camera, style

## ★ 미디어 타입: 반드시 video

## 캐릭터 의인화 규칙
- 사물에 큰 눈, 표정 있는 입, 작은 팔다리 부여
- 배경은 사물이 실제로 존재하는 생활 공간 (실사풍)
- 감정 키워드는 1개만 (angry frown OR smug grin, 여러 개 금지)
- 캐릭터 설명은 프롬프트 시작에 1번만. 끝에 반복 금지

## en 프롬프트 구조
[캐릭터 외형] + [배경 장소] + [핵심 감정/행동 1개] + [조명]

### 좋은 예
"Pixar-style 3D anthropomorphized sunscreen tube with angry frown on wooden vanity, yellow stain spreading on white shirt beside it, soft morning light"

### 나쁜 예 (금지)
"Pixar-style tube, big shiny eyes, tiny arms and legs, smug grin, then recoils in horror, wide shocked eyes..." ← 반복+과잉

## motion 규칙
- 영어, 15-20 words, en 프롬프트와 내용 겹치지 않게
- [시작 동작] → [변화/반응]
- 예: "stands proudly then shrinks back as stain spreads on nearby shirt"
- 캐릭터 외형 재설명 금지, 감정 키워드 3개 이상 나열 금지

## 비주얼 방향
- 주제 핵심 메시지에 맞는 감정 1개만 선택
- 항의→angry / 공포→terrified / 자신만만→smug
- 밝은 조명 (soft lighting, warm light)

## BANNED
- 사람/손/신체
- dark/moody
- text in image
- 감정 키워드 여러 개 나열"""
