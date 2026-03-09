"""Claude Code 에이전트 — claude CLI를 subprocess로 호출하여 script_json 생성"""
import json
import os
import subprocess
import re
import tempfile
from datetime import datetime


def _clean_env():
    """중첩 세션 방지 환경변수 제거"""
    env = os.environ.copy()
    env.pop("CLAUDECODE", None)
    return env


def _run_claude(prompt: str, timeout: int = 120, use_web: bool = True,
                model: str | None = None) -> str:
    """claude CLI를 호출하고 결과 텍스트 반환"""
    cmd = "claude -p --output-format json"
    if model:
        cmd += f" --model {model}"
    if use_web:
        cmd += " --allowedTools WebSearch,WebFetch"
    result = subprocess.run(
        cmd,
        input=prompt,
        capture_output=True, text=True, timeout=timeout,
        encoding="utf-8", shell=True, env=_clean_env(),
        cwd=tempfile.gettempdir(),
    )

    if result.returncode != 0:
        raise RuntimeError(f"Claude agent failed: {result.stderr[:500]}")

    return result.stdout


_DURATION_PRESETS = {
    30: {"seconds": "35~45", "sentences": "8~12", "chars": "160~200",
         "slides": "4~6개(closing 포함)", "per_slide": "2~3개"},
    60: {"seconds": "50~60", "sentences": "14~20", "chars": "200~300",
         "slides": "6~8개(closing 포함)", "per_slide": "2~4개"},
}


def _build_script_schema(target_duration: int = 60, channel_format: str = "single") -> str:
    """target_duration(초)에 맞는 SCRIPT_JSON_SCHEMA 생성."""
    p = _DURATION_PRESETS.get(target_duration)
    if not p:
        closest = min(_DURATION_PRESETS.keys(), key=lambda k: abs(k - target_duration))
        p = _DURATION_PRESETS[closest]

    if channel_format == "roundup":
        return _build_roundup_schema(p)

    return f"""\
다음 JSON 형식으로만 출력해. 다른 텍스트 없이 JSON만 출력해.

{{
  "youtube_title": "YouTube 업로드용 제목 (100자 이내, 짧고 임팩트 있게)",
  "sentences": [
    {{"text": "TTS로 읽을 문장 (20자 이내)", "slide": 1}},
    {{"text": "두번째 문장", "slide": 1}},
    ...
  ],
  "slides": [
    {{
      "category": "속보",
      "main": "핵심 키워드 <span class=\\"hl\\">강조숫자</span>",
      "sub": "보조 설명",
      "accent": "#ff4444",
      "bg_type": "photo"
    }},
    ...
  ]
}}

규칙:
- 이것은 **하나의 뉴스 기사**에 대한 브리핑이다. 슬라이드는 같은 기사의 흐름을 시간순/논리순으로 나눈 것이다.
- sentences를 처음부터 끝까지 이어 읽으면 하나의 완결된 뉴스 내레이션이 되어야 한다.
- 슬라이드 간 자연스러운 연결: "이런 가운데", "그 배경에는", "앞으로는" 등 접속 표현을 활용해 흐름을 이어줘.
- 슬라이드별 역할: ①훅(충격 사실) → ②핵심 요약 → ③원인/배경 → ④영향/파장 → ⑤전망/마무리 → ⑥클로징
- sentences: {p['sentences']}개 문장, 각 15~25자, slide 번호로 슬라이드에 매핑
- **슬라이드 1개당 문장 {p['per_slide']}개** — 한 슬라이드에 5개 이상 문장을 넣지 마라. 시청자가 같은 화면을 10초 이상 보면 이탈한다.
- 전체 문장을 이어 읽으면 반드시 {p['seconds']}초가 되어야 함 (한국어 평균 읽기 속도: 초당 4~5음절)
- 즉, 총 글자 수 합계가 {p['chars']}자 이어야 함
- sentences에 채널명 언급 금지 (예: "이슈60초였습니다" 같은 마무리 문장 넣지 말 것)
- 문장 종결을 다양하게 하되, 채널 지침의 톤을 반드시 따를 것. 지침에 "뉴스 앵커 스타일"이면 격식체 위주("~습니다", "~입니다", "~였습니다")에 체언 종결("~한 상황", "~인 셈")을 섞어라. "~인데요", "~거든요" 같은 캐주얼 종결은 지침이 허용할 때만 사용.
- slides: {p['slides']}, accent 색상은 내용에 맞게 지정. 문장 수 ÷ 3 = 대략적 슬라이드 수.
- 첫 슬라이드(Opening): category에 "속보", "긴급", "단독" 등 임팩트 태그 사용. main은 짧고 강렬하게.
- 마지막 슬라이드(Closing): 자동 처리됨. main에 채널 지침에 맞는 짧은 마무리 문구. category 불필요.
- 강조할 숫자나 키워드는 <span class="hl">...</span>으로 감싸기
- youtube_title: YouTube에 업로드될 영상 제목. 100자 이내로 짧고 클릭을 유도하는 제목. 채널 지침에 제목 형식이 명시되어 있으면 반드시 따를 것.
- bg_type: 각 슬라이드의 배경 유형을 지정. AI 이미지 생성 프롬프트의 방향을 결정하므로 신중히 선택할 것.
  - "photo": 뉴스 현장 사진 스타일 (건물 외관, 간판, 거리 풍경 등) — 가장 많이 사용. 구체적 장소/사물이 있는 슬라이드에 적합.
  - "broll": 시네마틱 뉴스 B-roll (자연스러운 현실 장면) — 영상 전체에서 1~2개만
  - "graph": 데이터 시각화/인포그래픽 — 수치 비교, 쟁점 대립, 통계가 핵심인 슬라이드. AI가 저울/차트/좌우분할 등 비유적 시각화 이미지를 생성.
  - "logo": 기업/기관/브랜드 — 특정 기업이 주제일 때, 건물 외관+브랜드 사이니지
  - "closing": 마무리 화면 — 마지막 슬라이드 전용
  - 권장 배치 예시: photo → broll → photo → graph → photo → closing
  - 핵심: 각 슬라이드의 main/sub 텍스트 내용이 이미지 프롬프트로 변환되므로, 시각화 가능한 구체적 내용을 담을 것
"""


def _build_roundup_schema(p: dict) -> str:
    """라운드업(멀티뉴스) 형식 스키마."""
    return f"""\
다음 JSON 형식으로만 출력해. 다른 텍스트 없이 JSON만 출력해.

{{
  "youtube_title": "YouTube 업로드용 제목 (100자 이내, 짧고 임팩트 있게)",
  "sentences": [
    {{"text": "TTS로 읽을 문장 (20자 이내)", "slide": 1}},
    {{"text": "두번째 문장", "slide": 1}},
    ...
  ],
  "slides": [
    {{
      "category": "오늘의 뉴스",
      "main": "오늘의 핵심 뉴스 <span class=\\"hl\\">5선</span>",
      "sub": "① 주제1 ② 주제2 ③ 주제3 ④ 주제4 ⑤ 주제5",
      "accent": "#2563eb",
      "bg_type": "overview"
    }},
    {{
      "category": "1️⃣ 카테고리",
      "main": "핵심 키워드 <span class=\\"hl\\">강조</span>",
      "sub": "보조 설명",
      "accent": "#ff4444",
      "bg_type": "photo"
    }},
    ...
  ]
}}

규칙:
- 이것은 **여러 뉴스를 묶은 라운드업 브리핑**이다. 주제별로 짧게 전달한다.
- sentences를 처음부터 끝까지 이어 읽으면 하나의 완결된 뉴스 라운드업 내레이션이 되어야 한다.

### 슬라이드 구성 (필수)
1. **첫 슬라이드 (Overview — 헤드라인)**: 5개 뉴스 헤드라인을 빠르게 나열하며 시작
   - category: "오늘의 뉴스" 또는 날짜 포함
   - main: "오늘의 핵심 뉴스 <span class="hl">N선</span>"
   - sub: "① 주제1 헤드라인 ② 주제2 헤드라인 ③ ..." (주제별 5~10자 핵심 키워드)
   - sentences: 5개 뉴스 헤드라인을 빠르게 나열 + "전해드리겠습니다" (2~3문장)
     예: "반도체 수출 역대 최고, 환율 급등, AI 규제안까지. 오늘의 핵심 뉴스 전해드리겠습니다"
   - **bg_type: "overview"** (전용 레이아웃: 진한 오버레이 + 번호 리스트)

2. **주제별 슬라이드 (각 1개씩)**: 각 뉴스를 1슬라이드로 요약
   - category: "1️⃣ 경제" / "2️⃣ 국제" 등 번호 + 분야
   - main: 핵심 내용 (키워드 강조)
   - sub: 보조 설명 1줄
   - sentences: 각 주제당 2~3문장 (핵심 팩트만)
   - bg_type: 주제에 맞게 photo/graph/logo 선택

3. **마지막 슬라이드 (Closing)**: 자동 처리됨
   - main: 짧은 마무리 문구
   - bg_type: "closing"

### 대본 규칙
- 전체 문장 {p['sentences']}개, 각 15~25자
- 전체 {p['seconds']}초 (한국어 읽기 속도 초당 4~5음절), 총 {p['chars']}자
- **슬라이드 1개당 문장 {p['per_slide']}개** — 한 슬라이드에 5개 이상 넣지 마라
- 주제 전환 시 자연스러운 연결: "다음 소식입니다", "이어서", "한편" 등
- sentences에 채널명 언급 금지
- 문장 종결을 다양하게, 채널 지침 톤 준수
- 강조할 숫자나 키워드는 <span class="hl">...</span>으로 감싸기
- youtube_title: 100자 이내, 클릭 유도. 채널 지침의 제목 형식 따를 것.
- bg_type: overview(첫 슬라이드 전용), photo(장소/사물), broll(시네마틱), graph(데이터), logo(기업), closing(마지막)
- ★ 첫 슬라이드는 반드시 bg_type: "overview"로 지정할 것
"""


# 하위 호환: 기존 코드에서 직접 참조하는 경우
SCRIPT_JSON_SCHEMA = _build_script_schema(60)


def parse_request(request: str, instructions: str = "", trend_context: str = "",
                   recent_topics: list[str] | None = None) -> list[str]:
    """자유 형식 요청을 개별 뉴스 주제 리스트로 변환.

    예: "오늘 경제 뉴스 3개 만들어줘" → ["원/달러 환율 급등", "코스피 하락", "금리 동결"]
    예: "이란 전쟁 뉴스" → ["이란 전쟁 뉴스"]
    """
    trend_section = ""
    if trend_context:
        trend_section = f"""
{trend_context}

"""

    recent_section = ""
    if recent_topics:
        recent_section = f"""
아래는 최근 24시간 이내에 이미 만든 주제 목록이야. 이 주제들과 겹치지 않는 완전히 다른 뉴스를 선정해.
같은 사건을 다른 각도로 다루는 것도 안 됨. 완전히 다른 이슈여야 함:
{chr(10).join(f"- {t}" for t in recent_topics[:15])}

"""

    now = datetime.now()
    now_str = now.strftime("%Y년 %m월 %d일 %H시")
    date_str = now.strftime("%Y-%m-%d")

    prompt = f"""아래 요청을 분석해서, 유튜브 쇼츠 뉴스 영상으로 만들 개별 주제를 추출해줘.

## 현재 시각: {now_str} (한국시간)

요청: {request}

{f"참고 채널 지침:{chr(10)}{instructions[:500]}" if instructions else ""}
{trend_section}{recent_section}규칙:
- 각 주제는 구체적인 뉴스 토픽이어야 해 (예: "원/달러 환율 1500원 돌파")
- 요청에 "N개"라고 명시되어 있으면 반드시 정확히 N개만 출력해. 절대 더 많거나 적게 만들지 마.
- 요청에 개수가 없으면 1개만
{("- ★ 아래 트렌딩 데이터는 실시간 인기 키워드이므로 주제 선정 시 최우선으로 활용해. 요청 카테고리에 맞는 트렌딩 주제를 우선 선택하고, 트렌딩에 없는 경우에만 웹 검색으로 보완해." + chr(10)) if trend_context else ""}- ★★★ 반드시 {date_str} 오늘 날짜 기사만 사용할 것. 웹 검색 시 "{date_str}" 또는 "오늘" 키워드를 포함해서 검색해.
- 검색 결과에서 기사 발행일을 반드시 확인해. 오늘({date_str}) 발행된 기사가 아니면 해당 주제를 선정하지 마.
- 어제 이전 기사, 날짜 불명확한 기사는 절대 사용 금지.
- 이미 만든 주제와 비슷하거나 겹치는 내용은 절대 선정하지 마. 같은 사건/이슈를 다른 각도로 다루는 것도 중복이다
- 한 번에 여러 주제를 만들 때, 주제끼리도 서로 완전히 다른 분야/이슈여야 함
- 다른 텍스트 없이 JSON 배열만 출력해

출력 형식 (JSON 배열만, 요청된 개수와 정확히 일치):
["주제1", "주제2"]"""

    raw = _run_claude(prompt, timeout=120)
    return _parse_topics(raw, request)


def _extract_count(request: str) -> int | None:
    """요청에서 개수 추출. '3개' → 3, 없으면 None"""
    m = re.search(r'(\d+)\s*개', request)
    return int(m.group(1)) if m else None


def _parse_topics(raw: str, fallback: str) -> list[str]:
    """Claude 출력에서 주제 리스트 추출"""
    try:
        wrapper = json.loads(raw)
        if isinstance(wrapper, dict) and "result" in wrapper:
            raw = wrapper["result"]
    except (json.JSONDecodeError, TypeError):
        pass

    # ```json ... ``` 블록에서 추출 시도
    m = re.search(r'```json\s*\n(.*?)\n\s*```', raw, re.DOTALL)
    if m:
        raw = m.group(1)

    # [...] 배열 추출 (non-greedy로 첫 번째 매칭)
    m = re.search(r'\[.*?\]', raw, re.DOTALL)
    if m:
        try:
            topics = json.loads(m.group(0))
            if isinstance(topics, list) and len(topics) > 0:
                topics = [str(t).strip() for t in topics if str(t).strip()]
                # 요청에서 개수를 파싱해서 초과분 자르기
                requested = _extract_count(fallback)
                if requested and len(topics) > requested:
                    topics = topics[:requested]
                return topics
        except json.JSONDecodeError:
            pass

    # 파싱 실패 시 원본 요청을 하나의 주제로
    return [fallback.strip()]


def generate_script(topic: str, instructions: str, brand: str = "이슈60초",
                    target_duration: int = 60, channel_format: str = "single") -> dict:
    """Claude CLI로 뉴스 검색 + script_json 생성."""
    schema = _build_script_schema(target_duration, channel_format=channel_format)
    duration_label = f"{target_duration}초" if target_duration <= 60 else f"{target_duration // 60}분"
    now = datetime.now()
    now_str = now.strftime("%Y년 %m월 %d일 %H시")
    date_str = now.strftime("%Y-%m-%d")

    # 라운드업: topic은 "주제1 / 주제2 / ..." 형태
    if channel_format == "roundup":
        topic_list = [t.strip() for t in topic.split(" / ") if t.strip()]
        topic_display = "\n".join(f"  {i+1}. {t}" for i, t in enumerate(topic_list))
        topic_section = f"""아래 {len(topic_list)}개 주제에 대해 각각 최신 뉴스를 웹에서 검색하고,
라운드업(멀티뉴스) 형식의 {duration_label} 쇼츠 영상용 script_json을 생성해줘.

주제 목록:
{topic_display}

★ 각 주제를 개별적으로 검색해서 오늘 뉴스의 핵심 팩트를 확인할 것."""
    else:
        topic_section = f"""주제: {topic}

위 지침에 따라 이 주제에 대한 최신 뉴스를 웹에서 검색하고,
{duration_label} 쇼츠 뉴스 브리핑 영상용 script_json을 생성해줘."""

    prompt = f"""{instructions}

---

## 오늘의 작업

**현재 시각: {now_str} (한국시간)**

{topic_section}

### ★ 뉴스 선별 기준 (필수)
1. 웹 검색 시 반드시 "{date_str}" 또는 "오늘" 키워드를 함께 검색할 것
2. 검색된 기사의 **발행일**을 확인하고, 오늘({date_str}) 발행된 기사만 사용
3. 어제 이전 기사, 날짜가 불명확한 기사, 과거 분석 기사는 사용 금지
4. 여러 기사를 참고할 경우 모든 기사가 오늘 날짜인지 각각 확인
5. 오늘 기사를 찾지 못하면 "최신 뉴스를 찾을 수 없습니다"라고 youtube_title에 명시

{schema}

### ★★★ 금융/투자 콘텐츠 안전 규칙 (모든 채널 필수)
아래 규칙은 채널 지침보다 우선하며 절대 위반 불가:

1. **투자 권유/매수·매도 시그널 금지**
   - "신호 포착", "시그널", "매수 타이밍", "지금이 기회" 등 투자 판단을 유도하는 표현 금지
   - "역대급 신호", "강력한 매수 시그널" 같은 자극적 표현 절대 금지

2. **기술적 분석 지표 기반 전망 금지**
   - RSI, MACD, 볼린저밴드 등 기술 지표를 근거로 가격 방향성을 암시하지 말 것
   - "과매도 → 반등", "골든크로스 → 상승" 같은 패턴 기반 예측 금지

3. **과거 수익률로 미래 암시 금지**
   - "당시 90% 반등", "이전에 2배 올랐다" 등 과거 실적으로 미래 수익을 암시하지 말 것
   - 과거 데이터 언급 시 반드시 "과거 사례이며 반복을 보장하지 않음" 명시

4. **가격 예측/목표가 금지**
   - 구체적 가격 예측, 목표가, 상승/하락 퍼센트 전망 금지
   - "~까지 오를 수 있다", "~% 상승 가능" 등 방향성 예측 금지

5. **허용되는 표현**
   - 팩트 전달: "스테이킹 비율이 30%를 넘었다" (사실)
   - 시장 상황 설명: "거래소 보유량이 감소하고 있다" (사실)
   - 전문가/기관 의견 인용: "~에 따르면" (출처 명시)
   - 면책: "투자 판단은 본인 책임입니다" (권장)

6. **대본 마지막에 면책 문구 권장**
   - "이 영상은 정보 제공 목적이며 투자 조언이 아닙니다"

brand 값은 "{brand}"로 설정해.
"""

    raw = _run_claude(prompt, timeout=300)
    return _parse_response(raw, brand)


def _parse_response(raw: str, brand: str) -> dict:
    """Claude 출력에서 script_json 추출"""
    # --output-format json인 경우, result 필드에서 텍스트 추출
    try:
        wrapper = json.loads(raw)
        if isinstance(wrapper, dict) and "result" in wrapper:
            raw = wrapper["result"]
    except (json.JSONDecodeError, TypeError):
        pass

    # JSON 블록 추출 시도
    # ```json ... ``` 패턴
    m = re.search(r'```json\s*\n(.*?)\n\s*```', raw, re.DOTALL)
    if m:
        raw = m.group(1)

    # { ... } 패턴 (가장 바깥쪽)
    m = re.search(r'\{.*\}', raw, re.DOTALL)
    if m:
        raw = m.group(0)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"script_json 파싱 실패: {e}\n원본:\n{raw[:1000]}")

    # 필수 필드 검증
    if "sentences" not in data or "slides" not in data:
        raise RuntimeError(f"script_json에 필수 필드 누락: {list(data.keys())}")

    # brand/date 보정
    if not data.get("brand"):
        data["brand"] = brand

    return data


DEFAULT_IMAGE_PROMPT_STYLE = """\
## CRITICAL: Read the slide text, then create a detailed AI image generation prompt.

- ALL prompts in English, 30-60 words each
- Include: subject, setting, lighting, camera/composition, style keywords
- closing 타입 → 빈 문자열 "" 출력

## bg_type별 스타일 (반드시 준수)

### overview (라운드업 헤드라인 슬라이드)
- 뉴스 스튜디오, 방송국 세트, 뉴스룸 배경
- 텍스트가 위에 올라가므로 배경은 어두운 톤 허용 (유일한 예외)
- 키워드: "modern news studio set, broadcast newsroom, monitors and screens, cinematic lighting, professional broadcast studio, 8k resolution, 9:16 vertical"
- 예: "Modern broadcast news studio with large LED screens and anchor desk, blue accent lighting, professional broadcast equipment, cinematic wide shot, 8k resolution, vertical 9:16"

### photo (실사 — 뉴스 현장 사진)
- 구체적 장소/건물/사물 중심
- 키워드: "realistic, sharp focus, professional photography, 8k resolution, photojournalism style"
- 예: "Empty voting booth with blue curtain, wooden ballot box on table, bright fluorescent lighting, photojournalism style, sharp focus, 8k resolution"
- 예: "Cinematic wide shot of a modern semiconductor fabrication plant, logo on white building facade, industrial security gate, morning sunlight, news B-roll style"

### broll (실사 — 시네마틱)
- photo와 유사하나 영상적 구도
- 키워드: "cinematic shot, news B-roll style, dramatic composition"
- 예: "Aerial view of modern apartment complex in South Korea, tall residential towers, golden hour lighting, cinematic drone shot"

### graph (인포그래픽/일러스트 — 실사 금지)
- **반드시 인포그래픽/일러스트 스타일**로 생성. 실사(realistic) 절대 금지.
- 수치 비교 → 비유적 시각화 (저울, 좌우 분할, 막대 그래프, 화살표)
- 쟁점 대립 → split screen, left vs right, comparison layout
- 통계/데이터 → diagram, charts, iconography
- 필수 키워드: "flat illustration, vector art, infographic, clean lines, soft pastels"
- 예: "Comparison infographic: Left side showing 'Salary Cap' icon with down arrows, right side showing '6.2% Raise' icon with up arrows, clean flat illustration, vs layout, soft pastel colors"
- 예: "Flat illustration of semiconductor wafer production diagram, isometric view, conveyor belts with chips, digital overlay icons, soft pastel colors, infographic style"
- 예: "Vector art diagram of financial data flow, bar charts and pie charts, iconography elements, clean lines, studio lighting, 2D stylized"

### logo (실사 — 기업/기관)
- 해당 기업 건물 외관 + 브랜드 사이니지
- 키워드: "cinematic wide shot, building exterior, brand signage visible, morning sunlight"

### closing
- 빈 문자열 "" 출력

## 뉴스 주제 → 장면 매핑 (참조)
| 주제 | photo/broll 실사 장면 | graph 인포그래픽 장면 |
|---|---|---|
| 투표/선거 | 투표소, 투표함, 파란 커튼 | 투표율 비교 차트, 찬반 비율 다이어그램 |
| 국회/정치 | 국회의사당 외관, 돔 지붕 | 정당별 의석수 비교, 법안 찬반 아이콘 |
| 반도체/삼성 | 팹 공장 외관/클린룸 내부 | 생산량 그래프, 공정 다이어그램 |
| 주식/증시 | 거래소 모니터, 캔들스틱 차트 | 지수 변동 그래프, 업종별 비교 차트 |
| 부동산 | 아파트 단지 항공뷰 | 가격 추이 그래프, 지역별 비교 |
| 코인/가상화폐 | 거래소 모니터, 네온 조명 | 코인 가격 차트, 시총 비교 다이어그램 |
| 무역/수출 | 컨테이너 항구, 크레인 | 수출입 비교 막대 그래프 |
| 쟁점/대립 | (graph 사용 권장) | 좌우 분할, 저울, VS 레이아웃 |

## BANNED
- people, humans, faces, body parts, hands
- text, letters, numbers, words rendered in the image
- dark, moody, horror themes → always bright/professional tone
- low quality, blurry, watermark"""


def _image_style_instruction(image_style: str) -> str:
    """이미지 스타일별 프롬프트 지시문."""
    if image_style == "photo":
        return (
            "★ ALL slides must use PHOTOREALISTIC style.\n"
            "- Use keywords: realistic, sharp focus, professional photography, 8k resolution, photojournalism\n"
            "- Depict real-world scenes: buildings, places, objects, landscapes\n"
            "- Do NOT use illustration, vector art, infographic, or cartoon styles\n"
            "- Even for data/comparison slides, depict a real-world scene that represents the concept"
        )
    elif image_style == "infographic":
        return (
            "★ ALL slides must use INFOGRAPHIC/ILLUSTRATION style.\n"
            "- Use keywords: flat illustration, vector art, infographic, clean lines, soft pastels, diagram\n"
            "- Visualize data with charts, graphs, icons, comparison layouts\n"
            "- Do NOT use realistic photography style\n"
            "- Use split screens for comparisons, bar charts for statistics, icons for concepts"
        )
    return (
        "Use the style that best matches each slide's bg_type:\n"
        "- photo/broll/logo → photorealistic style (realistic, sharp focus, 8k, photojournalism)\n"
        "- graph → infographic/illustration style (flat illustration, vector art, clean lines, diagrams)"
    )


def _image_size_instruction(layout: str) -> str:
    """레이아웃별 이미지 사이즈/비율 프롬프트 지시문."""
    if layout in ("center", "top", "bottom"):
        return (
            "- Target: 1080x960px (approximately 1:1 square ratio)\n"
            "- The image will be displayed in the CENTER zone (50% height) of a vertical 1080x1920 slide.\n"
            "- Compose for SQUARE/HORIZONTAL framing — subject centered, avoid tall vertical compositions.\n"
            "- Include keywords: 'square composition, centered subject, 1:1 aspect ratio' in each prompt."
        )
    return (
        "- Target: 1080x1920px (9:16 vertical/portrait orientation for YouTube Shorts)\n"
        "- Compose for VERTICAL framing — subject should fill the tall frame, avoid wide landscape compositions.\n"
        "- Include keywords: 'vertical composition, portrait orientation, 9:16 aspect ratio' in each prompt."
    )


def generate_image_prompts(topic: str, slides: list[dict],
                           prompt_style: str = "",
                           layout: str = "full",
                           image_style: str = "mixed") -> list[str]:
    """대본의 슬라이드 정보로 이미지 생성 프롬프트(영어) 생성.

    SD 모델은 영어 프롬프트만 이해하므로 반드시 영어로 출력.
    prompt_style: 채널별 커스텀 프롬프트 지침. 비어있으면 기본 뉴스 B-roll 스타일 사용.
    layout: 슬라이드 레이아웃 (full/center/top/bottom) — 이미지 사이즈/비율 결정
    웹 검색 불필요 — 빠르게 완료됨.
    """
    slide_descs = []
    for i, s in enumerate(slides):
        if i == len(slides) - 1:  # closing 스킵
            continue
        clean_main = (s.get("main", "")).replace("<span class=\"hl\">", "").replace("</span>", "")
        bg_type = s.get("bg_type", "photo")
        slide_descs.append(f"Slide {i+1}: [bg_type={bg_type}] [{s.get('category', '')}] {clean_main} — {s.get('sub', '')}")

    style_rules = prompt_style.strip() if prompt_style and prompt_style.strip() else DEFAULT_IMAGE_PROMPT_STYLE

    prompt = f"""You are an expert at creating AI image generation prompts from Korean news slides.

Topic: {topic}

Slides:
{chr(10).join(slide_descs)}

## Image Prompt Guidelines (MUST FOLLOW)
{style_rules}

## Image Style
{_image_style_instruction(image_style)}

## Image Size & Composition
{_image_size_instruction(layout)}

## Your task:
For each slide, read the Korean text and create BOTH a Korean description and an English image prompt.
Every English prompt MUST include all 5 elements: Subject, Setting, Lighting, Camera angle, Style keywords.

Rules:
- closing 타입 → {{"ko":"", "en":""}}
- For ALL other types (photo, broll, graph, logo): generate a detailed prompt (30-60 words)
- Each prompt must be DIFFERENT from others — no repeated scenes.
- Always specify the composition/orientation keywords matching the image size above in each English prompt.
- Korean description (ko): 슬라이드 장면을 한국어로 간결하게 설명 (예: "반도체 공장 클린룸 내부, 밝은 형광등 아래 장비들")
- English prompt (en): detailed AI image generation prompt in English

Output ONLY a JSON array with exactly {len(slide_descs)} items, no other text:
[{{"ko":"한국어 설명", "en":"English prompt"}}, ...]"""

    raw = _run_claude(prompt, timeout=60)

    try:
        wrapper = json.loads(raw)
        if isinstance(wrapper, dict) and "result" in wrapper:
            raw = wrapper["result"]
    except (json.JSONDecodeError, TypeError):
        pass

    m = re.search(r'```json\s*\n(.*?)\n\s*```', raw, re.DOTALL)
    if m:
        raw = m.group(1)

    m = re.search(r'\[.*\]', raw, re.DOTALL)
    if m:
        prompts = json.loads(m.group(0))
        if isinstance(prompts, list):
            result = []
            for p in prompts:
                if isinstance(p, dict) and "ko" in p and "en" in p:
                    result.append({"ko": str(p["ko"]), "en": str(p["en"])})
                else:
                    # 하위호환: 문자열이면 en으로 취급
                    result.append({"ko": "", "en": str(p)})
            return result

    return []
