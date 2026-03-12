"""Claude Code 에이전트 — claude CLI를 subprocess로 호출하여 script_json 생성"""
from __future__ import annotations
import json
import os
import subprocess
import re
import tempfile
import threading
import platform
import shutil
import glob as _glob
from datetime import datetime


# ── claude CLI 자동 탐색 (Windows / macOS 양 플랫폼) ──────────

_claude_bin_cache: str | None = None


def _find_claude_bin() -> str:
    """claude CLI 바이너리 전체 경로를 자동 탐색하여 반환.

    탐색 순서:
      1. PATH에서 직접 찾기
      2. Node.js 설치 위치와 같은 디렉토리에서 찾기
      3. npm global bin 디렉토리에서 찾기
      4. 플랫폼별 일반 설치 경로에서 찾기
    """
    global _claude_bin_cache
    if _claude_bin_cache:
        return _claude_bin_cache

    is_win = platform.system() == "Windows"
    names = ["claude.cmd", "claude"] if is_win else ["claude"]

    # 1. PATH에서 직접 찾기
    for name in names:
        found = shutil.which(name)
        if found:
            _claude_bin_cache = found
            return found

    # 2. Node.js 위치 기반 (nvm/n 등 버전 매니저 환경 대응)
    for node_name in (["node.exe", "node"] if is_win else ["node"]):
        node = shutil.which(node_name)
        if node:
            node_dir = os.path.dirname(os.path.realpath(node))
            for name in names:
                candidate = os.path.join(node_dir, name)
                if os.path.isfile(candidate):
                    _claude_bin_cache = candidate
                    return candidate

    # 3. npm global bin 디렉토리
    try:
        npm_names = ["npm.cmd", "npm"] if is_win else ["npm"]
        for npm_name in npm_names:
            npm = shutil.which(npm_name)
            if npm:
                r = subprocess.run(
                    [npm, "bin", "-g"],
                    capture_output=True, text=True, timeout=10,
                )
                if r.returncode == 0:
                    npm_bin = r.stdout.strip()
                    for name in names:
                        candidate = os.path.join(npm_bin, name)
                        if os.path.isfile(candidate):
                            _claude_bin_cache = candidate
                            return candidate
                break
    except Exception:
        pass

    # 4. 플랫폼별 일반 설치 경로
    home = os.path.expanduser("~")
    candidates: list[str] = []
    if is_win:
        appdata = os.environ.get("APPDATA", "")
        candidates += [
            os.path.join(appdata, "npm", "claude.cmd"),
            r"C:\Program Files\nodejs\claude.cmd",
        ]
        nvm_home = os.environ.get("NVM_HOME", "")
        if nvm_home:
            candidates += sorted(
                _glob.glob(os.path.join(nvm_home, "v*", "claude.cmd")),
                reverse=True,
            )
    else:
        candidates += [
            "/usr/local/bin/claude",
            "/opt/homebrew/bin/claude",
            os.path.join(home, "n", "bin", "claude"),
        ]
        candidates += sorted(
            _glob.glob(os.path.join(home, ".nvm", "versions", "node", "v*", "bin", "claude")),
            reverse=True,
        )

    for c in candidates:
        if os.path.isfile(c):
            _claude_bin_cache = c
            return c

    raise RuntimeError(
        "Claude CLI를 찾을 수 없습니다.\n"
        "설치: npm install -g @anthropic-ai/claude-code"
    )


def _clean_env():
    """중첩 세션 방지 환경변수 제거 + claude/node 디렉토리를 PATH에 추가"""
    env = os.environ.copy()
    env.pop("CLAUDECODE", None)
    try:
        bin_dir = os.path.dirname(_find_claude_bin())
        env["PATH"] = bin_dir + os.pathsep + env.get("PATH", "")
    except RuntimeError:
        pass
    return env


# Claude 실행 상태 (프론트엔드 표시용)
_claude_active = False
_claude_lock = threading.Lock()


def is_claude_active() -> bool:
    return _claude_active


def _run_claude(prompt: str, timeout: int = 120, use_web: bool = True,
                model: str | None = None) -> str:
    """claude CLI를 호출하고 결과 텍스트 반환"""
    global _claude_active
    claude_bin = _find_claude_bin()
    cmd = f'"{claude_bin}" -p --output-format json'
    if model:
        cmd += f" --model {model}"
    if use_web:
        cmd += " --allowedTools WebSearch,WebFetch"

    with _claude_lock:
        _claude_active = True
    try:
        result = subprocess.run(
            cmd,
            input=prompt,
            capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", shell=True, env=_clean_env(),
            cwd=tempfile.gettempdir(),
        )
    finally:
        with _claude_lock:
            _claude_active = False

    if result.returncode != 0:
        raise RuntimeError(f"Claude agent failed: {result.stderr[:500]}")

    return result.stdout


_DURATION_PRESETS = {
    30: {
        "normal": {"seconds": "35~45", "sentences": "8~12", "chars": "160~200",
                   "slides": "4~6개(closing 포함)", "per_slide": "2~3개"},
        "dense":  {"seconds": "35~45", "sentences": "8~10", "chars": "160~200",
                   "slides": "8~10개(closing 포함)", "per_slide": "1개"},
    },
    60: {
        "normal": {"seconds": "50~60", "sentences": "14~20", "chars": "200~300",
                   "slides": "6~8개(closing 포함)", "per_slide": "2~4개"},
        "dense":  {"seconds": "50~60", "sentences": "14~18", "chars": "200~300",
                   "slides": "14~18개(closing 포함)", "per_slide": "1개"},
    },
}

# ── 외부화 가능한 기본값 상수 ──────────────────────────────
# 채널 config에 값이 있으면 해당 값으로 완전 대체. 비어있으면 기본값 사용.
# 동적 변수: {sentences}, {chars}, {seconds}, {slides}, {per_slide}, {year}, {date}, {prev_year}

DEFAULT_SCRIPT_RULES = """\
- news_date: 참조 기사의 게시 날짜 (YYYY-MM-DD), 정확히 기입
- 하나의 뉴스 브리핑. sentences를 이어 읽으면 완결된 내레이션이 되어야 함
- 슬라이드 간 자연스러운 연결 (접속 표현 활용)
- 슬라이드별 역할: ①훅 → ②핵심 → ③배경 → ④영향 → ⑤전망 → ⑥클로징
- sentences: {sentences}개, 각 15~25자, 총 {chars}자 (={seconds}초 분량)
- 슬라이드 1개당 문장 {per_slide}개
- ★ 슬라이드당 나레이션은 약 5초 또는 약 10초로 맞춰라 (한국어 TTS 초당 ~4.5음절 기준).
  - 5초 ≈ 문장 1~2개(20~25자), 10초 ≈ 문장 3~4개(40~50자)
  - 6~7초처럼 어중간한 길이는 피하라. 배경 영상이 5초 단위로 교체된다.
- sentences에 채널명 언급 금지
- 문장 종결 다양하게, 채널 지침 톤 준수
- slides: {slides}개, 강조 키워드는 <span class="hl">...</span>
- 첫 슬라이드: category에 주제에 맞는 태그(예: "경제","정치","코인","테크","사회" 등), main 짧고 강렬. "속보"는 실제 속보일 때만 사용
- 마지막 슬라이드: 자동 처리. main에 짧은 마무리. bg_type: "closing". 나레이션(sentences) 배정 금지
- youtube_title: 100자 이내, 클릭 유도. 채널 지침 제목 형식 따를 것
- bg_type: photo(장소/사물) | broll(시네마틱, 1~2개만) | graph(인포그래픽) | logo(기업 건물) | closing(마지막)
  - main/sub 텍스트가 이미지 프롬프트로 변환되므로 시각화 가능한 구체적 내용 필수"""

DEFAULT_ROUNDUP_RULES = """\
- news_date: 참조한 뉴스 기사들의 게시 날짜 (YYYY-MM-DD). 가장 최근 기사의 날짜. 반드시 정확한 날짜를 기입할 것.
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
   - 나레이션(sentences) 배정 금지 — 구독/좋아요 텍스트가 자동 표시됨

### 대본 규칙
- 전체 문장 {sentences}개, 각 15~25자
- 전체 {seconds}초 (한국어 읽기 속도 초당 4~5음절), 총 {chars}자
- **슬라이드 1개당 문장 {per_slide}개**
- ★ 슬라이드당 나레이션은 약 5초 또는 약 10초로 맞춰라 (한국어 TTS 초당 ~4.5음절 기준).
  - 5초 ≈ 문장 1~2개(20~25자), 10초 ≈ 문장 3~4개(40~50자)
  - 6~7초처럼 어중간한 길이는 피하라. 배경 영상이 5초 단위로 교체된다
- 주제 전환 시 자연스러운 연결: "다음 소식입니다", "이어서", "한편" 등
- sentences에 채널명 언급 금지
- 문장 종결을 다양하게, 채널 지침 톤 준수
- 강조할 숫자나 키워드는 슬라이드(main/sub)에서 <span class="hl">...</span>으로 감싸기
- sentences(나레이션)는 TTS가 읽는 텍스트이므로 HTML 태그 금지, 순수 텍스트만
- youtube_title: 100자 이내, 클릭 유도. 채널 지침의 제목 형식 따를 것.
- bg_type: overview(첫 슬라이드 전용), photo(장소/사물), broll(시네마틱), graph(데이터), logo(기업), closing(마지막)
- ★ 첫 슬라이드는 반드시 bg_type: "overview"로 지정할 것"""


def _apply_duration_vars(template: str, p: dict) -> str:
    """템플릿 내 동적 변수를 duration preset으로 치환."""
    return (template
            .replace("{sentences}", str(p["sentences"]))
            .replace("{chars}", str(p["chars"]))
            .replace("{seconds}", str(p["seconds"]))
            .replace("{slides}", str(p["slides"]))
            .replace("{per_slide}", str(p["per_slide"])))


def _build_script_schema(target_duration: int = 60, channel_format: str = "single",
                         script_rules: str = "", roundup_rules: str = "",
                         slide_density: str = "normal",
                         has_outro: bool = False) -> str:
    """target_duration(초)에 맞는 SCRIPT_JSON_SCHEMA 생성."""
    presets = _DURATION_PRESETS.get(target_duration)
    if not presets:
        closest = min(_DURATION_PRESETS.keys(), key=lambda k: abs(k - target_duration))
        presets = _DURATION_PRESETS[closest]
    p = presets.get(slide_density, presets.get("normal"))

    if channel_format == "roundup":
        return _build_roundup_schema(p, roundup_rules, has_outro=has_outro)

    rules_text = script_rules.strip() if script_rules and script_rules.strip() else DEFAULT_SCRIPT_RULES
    rules_text = _apply_duration_vars(rules_text, p)

    if has_outro:
        rules_text += "\n- ★ 이 채널은 별도 아웃트로가 있으므로 closing 슬라이드를 생성하지 마라. 마지막 콘텐츠 슬라이드로 끝내라."

    return f"""\
다음 JSON 형식으로만 출력해. 다른 텍스트 없이 JSON만.

{{
  "news_date": "2026-03-09",
  "youtube_title": "제목 (100자 이내)",
  "sentences": [{{"text": "문장 (15~25자)", "slide": 1}}, ...],
  "slides": [{{"category": "카테고리", "main": "핵심 <span class=\\"hl\\">강조</span>", "sub": "보조 설명", "bg_type": "photo"}}, ...]
}}

규칙:
{rules_text}
"""


def _build_roundup_schema(p: dict, roundup_rules: str = "",
                          has_outro: bool = False) -> str:
    """라운드업(멀티뉴스) 형식 스키마."""
    rules_text = roundup_rules.strip() if roundup_rules and roundup_rules.strip() else DEFAULT_ROUNDUP_RULES
    rules_text = _apply_duration_vars(rules_text, p)
    if has_outro:
        rules_text += "\n- ★ 이 채널은 별도 아웃트로가 있으므로 closing 슬라이드를 생성하지 마라. 마지막 콘텐츠 슬라이드로 끝내라."

    return f"""\
다음 JSON 형식으로만 출력해. 다른 텍스트 없이 JSON만 출력해.

{{
  "news_date": "2026-03-09",
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

      "bg_type": "overview"
    }},
    {{
      "category": "1️⃣ 카테고리",
      "main": "핵심 키워드 <span class=\\"hl\\">강조</span>",
      "sub": "보조 설명",

      "bg_type": "photo"
    }},
    ...
  ]
}}

규칙:
{rules_text}
"""


# 하위 호환: 기존 코드에서 직접 참조하는 경우
SCRIPT_JSON_SCHEMA = _build_script_schema(60)


def _is_specific_topic(request: str) -> bool:
    """요청이 구체적 뉴스 헤드라인인지 판별.

    '만들어줘', 'N개', '뉴스 찾아줘' 등 일반 요청 패턴이 없고
    충분히 길면(15자+) 구체적 주제로 판단.
    """
    general_patterns = [
        r'\d+\s*개', r'만들어', r'찾아', r'검색', r'알려',
        r'뉴스\s*줘', r'소식\s*줘', r'브리핑', r'최신',
    ]
    for pat in general_patterns:
        if re.search(pat, request):
            return False
    # 충분히 구체적인 길이 (15자 이상)
    return len(request.strip()) >= 15


def parse_request(request: str, instructions: str = "", trend_context: str = "",
                   recent_topics: list[str] | None = None) -> list[str]:
    """자유 형식 요청을 개별 뉴스 주제 리스트로 변환.

    예: "오늘 경제 뉴스 3개 만들어줘" → ["원/달러 환율 급등", "코스피 하락", "금리 동결"]
    예: "'반도체 호황' 삼성전자 연봉 역대 최대" → ["'반도체 호황' 삼성전자 연봉 역대 최대"]
    """
    # 구체적 헤드라인이면 Claude 호출 스킵 → 즉시 반환
    if _is_specific_topic(request):
        return [request.strip()]

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

    prompt = f"""유튜브 쇼츠 뉴스 영상 주제를 추출해.

현재: {now_str} (한국시간)
요청: {request}
{f"채널 지침: {instructions[:300]}" if instructions else ""}
{trend_section}{recent_section}규칙:
- ★ 요청이 이미 구체적인 뉴스 헤드라인/주제이면 그대로 반환. 절대 다른 주제로 바꾸지 마라.
- "N개 만들어줘", "뉴스 N개" 등 일반적 요청일 때만 웹 검색으로 주제를 찾아라
- 구체적 뉴스 토픽 (예: "원/달러 환율 1500원 돌파")
- "N개" 명시 시 정확히 N개, 없으면 1개
- 요청에 특정 분야가 명시되면(예: "연예 뉴스", "코인 뉴스") 해당 분야 내에서만 주제 선정
{("- 트렌딩 데이터를 최우선 활용, 없으면 웹 검색 보완" + chr(10)) if trend_context else ""}- 오늘({date_str}) 발행 기사만 사용. 어제 이전/날짜 불명 금지
- 기존 주제와 중복 금지 (다른 각도도 불가)

JSON 배열만 출력: ["주제1", "주제2"]"""

    raw = _run_claude(prompt, timeout=300, model="claude-haiku-4-5-20251001")
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
                    target_duration: int = 60, channel_format: str = "single",
                    script_rules: str = "", roundup_rules: str = "",
                    slide_density: str = "normal",
                    has_outro: bool = False) -> dict:
    """Claude CLI로 뉴스 검색 + script_json 생성."""
    schema = _build_script_schema(target_duration, channel_format=channel_format,
                                  script_rules=script_rules, roundup_rules=roundup_rules,
                                  slide_density=slide_density, has_outro=has_outro)
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
{duration_label} 쇼츠 영상용 script_json을 생성해줘."""

    prompt = f"""{instructions}

---

## 오늘의 작업

**현재 시각: {now_str} (한국시간)**

{topic_section}

### ★ 웹 검색 효율 규칙
- WebSearch 결과의 제목+요약(snippet)만으로 팩트를 파악할 수 있으면 WebFetch 생략
- WebFetch는 정확한 수치/통계 확인이 필요할 때만, 최대 1~2회
- 검색은 2~3회 이내로 완료할 것

{schema}

brand 값은 "{brand}"로 설정해.
"""

    raw = _run_claude(prompt, timeout=600, model="claude-sonnet-4-6")
    script = _parse_response(raw, brand)

    # 날짜 검증: 오래된 뉴스 차단
    news_date_str = script.get("news_date", "")
    if news_date_str:
        try:
            news_date = datetime.strptime(news_date_str, "%Y-%m-%d").date()
            today = datetime.now().date()
            diff = (today - news_date).days
            if diff > 1:
                raise RuntimeError(
                    f"24시간 이전 뉴스입니다 (기사일: {news_date_str}, 오늘: {today}). "
                    "오늘 날짜 뉴스로 다시 시도해주세요."
                )
        except ValueError:
            print(f"[날짜 검증] news_date 파싱 실패, 스킵: {news_date_str}")
    else:
        print("[날짜 검증] news_date 필드 없음, 스킵")

    return script


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
너는 뉴스 영상의 비주얼 디렉터야. 슬라이드 전체를 먼저 읽고, 기사의 흐름을 이해한 후 각 장면에 맞는 이미지를 구성해.

ALL prompts in English, 30-60 words, 5요소: subject, setting, lighting, camera, style

## 프롬프트 작성법

### 1단계: 기사 흐름 파악
모든 슬라이드를 통째로 읽고 전체 스토리를 파악해:
- 이 기사의 핵심 사건은 무엇인가?
- 각 슬라이드가 기사에서 어떤 역할인가? (도입/원인/구체내용/영향/전망)

### 2단계: 슬라이드별 현장 특정
각 슬라이드의 핵심 행위/변화를 읽고, 그것이 실제로 일어나는 현장을 특정해.
추상적 개념이 아니라 카메라맨이 실제로 촬영할 수 있는 구체적 장소/사물을 선택.

### 3단계: 카메라 구도 결정
그 현장에서 카메라맨이 실제로 찍을 수 있는 구체적 구도:
- 건물 외관 → 어느 각도에서, 어떤 시간대에
- 내부 공간 → 어떤 장비/사물이 보이는지
- 풍경 → 날씨, 시간대, 계절감

## 슬라이드 역할별 시각 전략

| 역할 | 시각 전략 | 카메라 움직임 |
|-----|----------|-------------|
| 도입 (무슨 일?) | 사건 현장 전경, 와이드샷 | slow zoom in (전경→핵심부) |
| 원인 (왜?) | 원인이 되는 장소/사물 | gentle pan left/right |
| 구체 내용 (어떻게?) | 핵심 피사체 디테일, 미디엄샷 | slow zoom in (디테일 강조) |
| 영향 (그래서?) | 결과가 나타나는 현장 | pan across (현장 훑기) |
| 전망 (앞으로?) | 미래를 암시하는 장면 | slow zoom out (전체 조망) |

## 시각적 흐름 (슬라이드 연결)
영상으로 이어질 때 자연스러운 흐름이 되도록 구도를 배치:
- wide shot → medium → close-up → wide 순서로 스케일 변화
- 장소가 바뀔 때 앵글도 같이 바꿔서 시각적 단조로움 방지
- 각 슬라이드의 구도가 이전/다음과 다른 스케일이어야 함 (연속 와이드 금지)

## bg_type별 스타일

- **overview**: 뉴스 스튜디오/뉴스룸 배경. 어두운 톤 허용. 키워드: modern news studio, broadcast newsroom, cinematic lighting, 8k
- **photo**: 기사 맥락에 맞는 실제 장소. 키워드: realistic, sharp focus, photojournalism, 8k
- **broll**: photo와 유사하되 시네마틱. 키워드: cinematic shot, news B-roll, dramatic composition
- **graph**: 인포그래픽/일러스트 (실사 금지). 키워드: flat illustration, vector art, infographic, clean lines, soft pastels
- **logo**: 기업 건물 외관 + 브랜드 사이니지. 키워드: cinematic wide shot, brand signage visible
- **closing**: 빈 문자열 "" 출력

## BANNED
- text, letters, numbers rendered in the image
- 모니터/스크린에 차트/그래프가 표시된 장면 (graph 타입 제외)
- 같은 장소/건물을 여러 슬라이드에서 반복
- dark, moody, horror themes → always bright/professional
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


def _image_size_instruction(layout: str, bg_display_mode: str = "zone") -> str:
    """레이아웃별 이미지 사이즈/비율 프롬프트 지시문.
    bg_display_mode가 fullscreen이면 레이아웃과 무관하게 9:16 풀사이즈."""
    if bg_display_mode == "fullscreen" or layout == "full":
        return (
            "- Target: 1080x1920px (9:16 vertical/portrait orientation for YouTube Shorts)\n"
            "- Compose for VERTICAL framing — subject should fill the tall frame, avoid wide landscape compositions.\n"
            "- Include keywords: 'vertical composition, portrait orientation, 9:16 aspect ratio' in each prompt."
        )
    return (
        "- Target: 1080x960px (approximately 1:1 square ratio)\n"
        "- The image will be displayed in the CENTER zone (50% height) of a vertical 1080x1920 slide.\n"
        "- Compose for SQUARE/HORIZONTAL framing — subject centered, avoid tall vertical compositions.\n"
        "- Include keywords: 'square composition, centered subject, 1:1 aspect ratio' in each prompt."
    )


def _estimate_slide_durations(slides: list[dict], sentences: list[dict]) -> dict[int, float]:
    """슬라이드별 나레이션 예상 시간(초) 계산. 한국어 TTS 기준 초당 ~4.5음절."""
    durations: dict[int, float] = {}
    for sent in sentences:
        slide_idx = sent.get("slide", 1) - 1  # 0-based
        text = sent.get("text", "")
        dur = len(text) / 4.5  # 한국어 초당 ~4.5음절
        durations[slide_idx] = durations.get(slide_idx, 0) + dur
    return durations


def generate_image_prompts(topic: str, slides: list[dict],
                           prompt_style: str = "",
                           layout: str = "full",
                           image_style: str = "mixed",
                           scene_references: str = "",
                           bg_display_mode: str = "zone",
                           sentences: list[dict] | None = None) -> list[str]:
    """대본의 슬라이드 정보로 이미지 생성 프롬프트(영어) 생성.

    SD 모델은 영어 프롬프트만 이해하므로 반드시 영어로 출력.
    prompt_style: 채널별 커스텀 프롬프트 지침. 비어있으면 기본 뉴스 B-roll 스타일 사용.
    layout: 슬라이드 레이아웃 (full/center/top/bottom) — 이미지 사이즈/비율 결정
    scene_references: 채널별 주제→현장 매핑 레퍼런스 (비어있으면 생략)
    sentences: 문장 리스트. 슬라이드별 나레이션 길이 추정에 사용.
    웹 검색 불필요 — 빠르게 완료됨.
    """
    # 슬라이드별 나레이션 길이 추정
    slide_durations = _estimate_slide_durations(slides, sentences or [])

    slide_descs = []
    prompt_count = 0
    for i, s in enumerate(slides):
        if s.get("bg_type") == "closing":
            continue
        clean_main = (s.get("main", "")).replace("<span class=\"hl\">", "").replace("</span>", "")
        bg_type = s.get("bg_type", "photo")
        est_dur = slide_durations.get(i, 5.0)
        need_two = est_dur > 6.0
        count_label = " [×2 prompts — 나레이션 길어서 배경 2개 필요]" if need_two else ""
        slide_descs.append(f"Slide {i+1}: [bg_type={bg_type}] [{s.get('category', '')}] {clean_main} — {s.get('sub', '')} (~{est_dur:.0f}s){count_label}")
        prompt_count += 2 if need_two else 1

    style_rules = prompt_style.strip() if prompt_style and prompt_style.strip() else DEFAULT_IMAGE_PROMPT_STYLE

    prompt = f"""너는 뉴스 영상의 비주얼 디렉터야.
아래 슬라이드 전체를 먼저 읽고, 기사의 전체 흐름을 파악한 후 각 슬라이드에 어울리는 이미지를 구성해.

Topic: {topic}

Slides:
{chr(10).join(slide_descs)}

## 이미지 프롬프트 지침 (반드시 따를 것)
{style_rules}

{f"## 주제별 현장 레퍼런스{chr(10)}{scene_references.strip()}" if scene_references and scene_references.strip() else ""}

## Image Style
{_image_style_instruction(image_style)}

## Image Size & Composition
{_image_size_instruction(layout, bg_display_mode)}

## 출력 형식
각 슬라이드에 대해 ko, en, motion 3개 필드를 생성.
**[×2 prompts]로 표시된 슬라이드는 서로 다른 장면의 프롬프트를 2개 연속 출력하라.**
(같은 주제를 다른 앵글/장소/스케일로. 예: wide shot → close-up, 외부 → 내부)

- ko: 촬영 현장을 구체적으로 (예: "울산 정유소 증류탑 야경, 가스 플레어 불빛")
- en: 영어 이미지 프롬프트, 30-60 words, 5요소 필수 (Subject, Setting, Lighting, Camera, Style)
- motion: 이 장면을 영상으로 만들 때의 카메라 움직임 (예: "slow zoom in", "gentle pan left", "slow zoom out")
- closing 타입 → {{"ko":"", "en":"", "motion":""}}
- ★ 모든 프롬프트는 반드시 서로 다른 장소/피사체/앵글을 사용하라. 같은 건물, 같은 장면, 같은 구도 반복 금지.
  - 예: 슬라이드1 "증권거래소 외관" → 슬라이드2 "공장 내부" → 슬라이드3 "항구 컨테이너" (모두 다른 장소)
  - 나쁜 예: 슬라이드1 "trading floor monitors" → 슬라이드2 "stock exchange screens" (같은 장면)
- 이미지 사이즈에 맞는 composition 키워드 포함

Output ONLY a JSON array with exactly {prompt_count} items, no other text:
[{{"ko":"한국어 설명", "en":"English prompt", "motion":"camera movement"}}, ...]"""

    # 슬라이드→프롬프트 매핑 (slide 필드 추가용)
    slide_prompt_map = []  # [(slide_idx_0based, need_two), ...]
    for i, s in enumerate(slides):
        if s.get("bg_type") == "closing":
            continue
        est_dur = slide_durations.get(i, 5.0)
        need_two = est_dur > 6.0
        slide_prompt_map.append((i, need_two))

    raw = _run_claude(prompt, timeout=60, use_web=False,
                      model="claude-opus-4-6")

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
            # slide 필드 매핑: 어떤 프롬프트가 어떤 슬라이드에 속하는지
            prompt_idx = 0
            for slide_idx, need_two in slide_prompt_map:
                count = 2 if need_two else 1
                for _ in range(count):
                    if prompt_idx < len(prompts):
                        p = prompts[prompt_idx]
                        if isinstance(p, dict) and "ko" in p and "en" in p:
                            result.append({
                                "ko": str(p["ko"]),
                                "en": str(p["en"]),
                                "motion": str(p.get("motion", "")),
                                "slide": slide_idx + 1,  # 1-based
                            })
                        else:
                            result.append({"ko": "", "en": str(p), "motion": "",
                                           "slide": slide_idx + 1})
                    prompt_idx += 1
            return result

    return []
