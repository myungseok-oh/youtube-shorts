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
                model: str | None = None, retries: int = 1,
                use_subagent: bool = False) -> str:
    """claude CLI를 호출하고 결과 텍스트 반환. 타임아웃 시 retries회 재시도."""
    global _claude_active
    claude_bin = _find_claude_bin()
    cmd = f'"{claude_bin}" -p --output-format json'
    if model:
        cmd += f" --model {model}"
    tools = []
    if use_web:
        tools.extend(["WebSearch", "WebFetch"])
    if use_subagent:
        tools.append("Agent")
    if tools:
        cmd += f" --allowedTools {','.join(tools)}"

    print(f"[claude] cmd: {cmd}")
    print(f"[claude] use_subagent={use_subagent}, tools={tools}, timeout={timeout}")

    last_err = None
    for attempt in range(1 + retries):
        if attempt > 0:
            print(f"[claude] 재시도 {attempt}/{retries} (이전: 타임아웃)")
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
        except subprocess.TimeoutExpired as e:
            last_err = e
            with _claude_lock:
                _claude_active = False
            continue
        finally:
            with _claude_lock:
                _claude_active = False

        if result.returncode != 0:
            raise RuntimeError(f"Claude agent failed: {result.stderr[:500]}")

        return result.stdout

    raise subprocess.TimeoutExpired(cmd, timeout) from last_err


# ── Gemini Flash 텍스트 생성 ──────────────────────────────

def _run_gemini(prompt: str, api_key: str, model: str = "gemini-2.5-flash",
                timeout: int = 60) -> str:
    """Gemini Flash로 텍스트 생성 (Phase A 대본 드래프트용).

    Returns:
        생성된 텍스트 (JSON 문자열 포함)
    """
    from google import genai
    from google.genai import types

    import time as _time
    client = genai.Client(api_key=api_key)
    print(f"[gemini] 요청 시작: model={model}, prompt_len={len(prompt)}")
    _t0 = _time.time()
    response = client.models.generate_content(
        model=model,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            temperature=0.7,
        ),
    )
    _elapsed = _time.time() - _t0
    _text = response.text or ""
    print(f"[gemini] 응답 완료: {_elapsed:.1f}초, response_len={len(_text)}")
    return _text


def _validate_with_claude(draft_json: dict, instructions: str, brand: str,
                          topic: str, target_duration: int = 60) -> dict:
    """Claude CLI로 Gemini 드래프트의 script 부분만 검증 및 보정.

    synopsis/visual_plan은 그대로 유지, script만 Claude에 전달하여 프롬프트 최소화.
    """
    script = draft_json.get("script", {})
    script_str = json.dumps(script, ensure_ascii=False)

    _max_slides = target_duration // 5 + 2
    prompt = f"""대본 검증. 목표={target_duration}초, closing 제외 최대 {_max_slides}개 슬라이드.
초과 시 병합/삭제. main 20자·sub 25자 넘으면 축약. 문제 없으면 그대로. JSON만 출력.

{script_str}"""
    raw = _run_claude(prompt, timeout=180, model="claude-sonnet-4-6",
                      retries=0, use_web=False)
    validated_script = _parse_response(raw, brand, required_fields=())

    # script만 교체, synopsis/visual_plan은 원본 유지
    result = dict(draft_json)
    result["script"] = validated_script

    # slides 수 변경 시 visual_plan도 동기화
    new_slides = validated_script.get("slides", [])
    old_vp = result.get("visual_plan", [])
    if len(new_slides) != len(old_vp):
        result["visual_plan"] = _sync_visual_plan(old_vp, new_slides)

    return result


def _sync_visual_plan(old_vp: list, new_slides: list) -> list:
    """slides 수에 맞게 visual_plan 동기화."""
    vp = []
    for i, s in enumerate(new_slides):
        if i < len(old_vp):
            entry = dict(old_vp[i])
        else:
            entry = {
                "media": "image", "duration": 5,
                "bg_type": s.get("bg_type", "photo"),
                "en": "", "ko": "", "motion": "",
            }
        entry["scene"] = i + 1
        entry["bg_type"] = s.get("bg_type", entry.get("bg_type", "photo"))
        if s.get("bg_type") == "closing":
            entry["duration"] = 0
            entry["en"] = ""
        vp.append(entry)
    return vp


def _normalize_gemini_result(data: dict) -> dict:
    """Gemini 응답 구조를 {synopsis, visual_plan, script} 형태로 보정.

    Gemini가 3단계 구조를 무시하고 script 내용을 최상위에 풀어놓는 경우 대응.
    visual_plan이 없으면 slides 기반으로 자동 생성.
    """
    # Case 1: 이미 올바른 구조
    if "script" in data and "visual_plan" in data:
        # visual_plan이 비어있으면 보정
        if not data["visual_plan"]:
            data["visual_plan"] = _build_visual_plan_from_slides(
                data["script"].get("slides", []))
        if "synopsis" not in data:
            data["synopsis"] = _build_synopsis_from_script(data["script"])
        return data

    # Case 2: script 내용이 최상위에 풀려있는 경우 (sentences, slides가 최상위)
    if "sentences" in data and "slides" in data:
        script = {
            "news_date": data.pop("news_date", ""),
            "youtube_title": data.pop("youtube_title", ""),
            "sentences": data.pop("sentences", []),
            "slides": data.pop("slides", []),
        }
        vp = data.pop("visual_plan", [])
        syn = data.pop("synopsis", {})
        if not vp:
            vp = _build_visual_plan_from_slides(script["slides"])
        if not syn:
            syn = _build_synopsis_from_script(script)
        return {"synopsis": syn, "visual_plan": vp, "script": script,
                "style_guide": data.pop("style_guide", {})}

    # Case 3: 알 수 없는 구조 → 에러
    raise RuntimeError(f"Gemini 응답 구조 인식 불가: {list(data.keys())}")


def _build_visual_plan_from_slides(slides: list) -> list:
    """slides 배열로부터 기본 visual_plan 생성."""
    vp = []
    for i, s in enumerate(slides):
        bg_type = s.get("bg_type", "photo")
        is_closing = bg_type == "closing"
        vp.append({
            "scene": i + 1,
            "media": "image",
            "duration": 0 if is_closing else 5,
            "bg_type": bg_type,
            "en": "",
            "ko": s.get("main", "").replace('<span class="hl">', "").replace("</span>", ""),
            "motion": "",
        })
    return vp


def _build_synopsis_from_script(script: dict) -> dict:
    """script에서 간이 synopsis 생성."""
    slides = script.get("slides", [])
    scenes = []
    for i, s in enumerate(slides):
        scenes.append({
            "scene": i + 1,
            "role": "content",
            "message": s.get("main", "").replace('<span class="hl">', "").replace("</span>", ""),
            "keywords": [],
        })
    return {
        "synopsis": script.get("youtube_title", ""),
        "scenes": scenes,
        "news_facts": [],
    }


# ── 외부화 가능한 기본값 상수 ──────────────────────────────
# 채널 config에 값이 있으면 해당 값으로 완전 대체. 비어있으면 기본값 사용.
# 동적 변수: {sentences}, {chars}, {seconds}, {slides}, {per_slide}, {year}, {date}, {prev_year}

DEFAULT_SCRIPT_RULES = """\
- news_date: 참조 기사의 게시 날짜 (YYYY-MM-DD), 정확히 기입
- 하나의 뉴스 브리핑. sentences를 이어 읽으면 완결된 내레이션이 되어야 함
- 슬라이드 간 자연스러운 연결 (접속 표현 활용)
- 슬라이드별 역할: ①훅 → ②핵심 → ③배경 → ④영향 → ⑤전망 → ⑥클로징
- sentences: 14~20개, 각 15~25자, 총 200~300자 (=50~60초 분량)
- 슬라이드 1개당 문장 2~4개
- ★ 슬라이드당 나레이션은 약 5초 또는 약 10초로 맞춰라 (한국어 TTS 초당 ~4.5음절 기준).
  - 5초 ≈ 문장 1~2개(20~25자), 10초 ≈ 문장 3~4개(40~50자)
  - 6~7초처럼 어중간한 길이는 피하라. 배경 영상이 5초 단위로 교체된다.
- sentences에 채널명 언급 금지
- 문장 종결 다양하게, 채널 지침 톤 준수
- slides: 6~8개, 강조 키워드는 <span class="hl">...</span>
- 첫 슬라이드: category에 주제에 맞는 태그(예: "경제","정치","코인","테크","사회" 등), main 짧고 강렬. "속보"는 실제 속보일 때만 사용
- youtube_title: 100자 이내, 클릭 유도. 채널 지침 제목 형식 따를 것
- bg_type: photo(장소/사물) | broll(시네마틱, 1~2개만) | graph(인포그래픽) | logo(기업 건물)
  - main/sub 텍스트가 이미지 프롬프트로 변환되므로 시각화 가능한 구체적 내용 필수"""

DEFAULT_ROUNDUP_RULES = """\
- news_date: 참조한 뉴스 기사들의 게시 날짜 (YYYY-MM-DD). 가장 최근 기사의 날짜. 반드시 정확한 날짜를 기입할 것.
- 이것은 **여러 뉴스를 묶은 라운드업 브리핑**이다. 주제별로 짧게 전달한다.
- sentences를 처음부터 끝까지 이어 읽으면 하나의 완결된 뉴스 라운드업 내레이션이 되어야 한다.

### 슬라이드 구성 (필수)
1. **첫 슬라이드 (Overview — 헤드라인)**: 5개 뉴스 헤드라인을 빠르게 나열하며 시작
   - category: "오늘의 뉴스" 또는 날짜 포함
   - main: 채널 지침에 맞는 짧은 타이틀 (15자 이내)
   - sub: "① 주제1 ② 주제2 ③ ..." (주제별 5~10자 핵심 키워드)
   - sentences: 뉴스 헤드라인을 빠르게 나열하며 시작 (2~3문장)
   - **bg_type: "overview"** (전용 레이아웃: 진한 오버레이 + 번호 리스트)

2. **주제별 슬라이드 (각 1개씩)**: 각 뉴스를 1슬라이드로 요약
   - category: "1️⃣ 경제" / "2️⃣ 국제" 등 번호 + 분야
   - main: 핵심 내용 (키워드 강조)
   - sub: 보조 설명 1줄
   - sentences: 각 주제당 2~3문장 (핵심 팩트만)
   - bg_type: 주제에 맞게 photo/graph/logo 선택

### 대본 규칙
- 전체 문장 14~20개, 각 15~25자
- 전체 50~60초 (한국어 읽기 속도 초당 4~5음절), 총 200~300자
- **슬라이드 1개당 문장 2~4개**
- ★ 슬라이드당 나레이션은 약 5초 또는 약 10초로 맞춰라 (한국어 TTS 초당 ~4.5음절 기준).
  - 5초 ≈ 문장 1~2개(20~25자), 10초 ≈ 문장 3~4개(40~50자)
  - 6~7초처럼 어중간한 길이는 피하라. 배경 영상이 5초 단위로 교체된다
- 주제 전환 시 자연스러운 연결: "다음 소식입니다", "이어서", "한편" 등
- sentences에 채널명 언급 금지
- 문장 종결을 다양하게, 채널 지침 톤 준수
- 강조할 숫자나 키워드는 슬라이드(main/sub)에서 <span class="hl">...</span>으로 감싸기
- sentences(나레이션)는 TTS가 읽는 텍스트이므로 HTML 태그 금지, 순수 텍스트만
- youtube_title: 100자 이내, 클릭 유도. 채널 지침의 제목 형식 따를 것.
- bg_type: overview(첫 슬라이드 전용), photo(장소/사물), broll(시네마틱), graph(데이터), logo(기업)
- ★ 첫 슬라이드는 반드시 bg_type: "overview"로 지정할 것"""



def _build_script_schema(channel_format: str = "single",
                         script_rules: str = "", roundup_rules: str = "",
                         has_outro: bool = False) -> str:
    """SCRIPT_JSON_SCHEMA 생성. 슬라이드/문장 수는 채널 지침(script_rules)에서 직접 지정."""
    if channel_format == "roundup":
        return _build_roundup_schema(roundup_rules, has_outro=has_outro)

    rules_text = script_rules.strip() if script_rules and script_rules.strip() else DEFAULT_SCRIPT_RULES

    # has_outro는 별도 아웃트로 세그먼트 — closing 슬라이드와 무관 (closing 자체 미생성)

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


def _build_roundup_schema(roundup_rules: str = "",
                          has_outro: bool = False) -> str:
    """라운드업(멀티뉴스) 형식 스키마."""
    rules_text = roundup_rules.strip() if roundup_rules and roundup_rules.strip() else DEFAULT_ROUNDUP_RULES
    # has_outro는 별도 아웃트로 세그먼트 — closing 슬라이드와 무관 (closing 자체 미생성)

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
      "main": "1분 <span class=\\"hl\\">경제</span> 뉴스",
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
SCRIPT_JSON_SCHEMA = _build_script_schema()


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
                   recent_topics: list[str] | None = None,
                   skip_web_search: bool = False) -> list[str]:
    """자유 형식 요청을 개별 뉴스 주제 리스트로 변환.

    skip_web_search=True: 교양/상식 채널용 — 웹검색 없이 가이드라인에서 주제 선정.
    skip_web_search=False(기본): 뉴스 채널용 — 웹검색으로 오늘 뉴스 주제 추출.

    예: "오늘 경제 뉴스 3개 만들어줘" → ["원/달러 환율 급등", "코스피 하락", "금리 동결"]
    예: "'반도체 호황' 삼성전자 연봉 역대 최대" → ["'반도체 호황' 삼성전자 연봉 역대 최대"]
    """
    # 구체적 헤드라인이면 Claude 호출 스킵 → 즉시 반환
    if _is_specific_topic(request):
        return [request.strip()]

    recent_section = ""
    if recent_topics:
        dedup_label = "이미 다룬 주제" if skip_web_search else "최근 24시간 이내에 이미 만든 주제"
        recent_section = f"""
아래는 {dedup_label} 목록이야. 이 주제들과 겹치지 않는 완전히 다른 주제를 선정해.
같은 개념을 다른 각도로 다루는 것도 안 됨. 완전히 다른 주제여야 함:
{chr(10).join(f"- {t}" for t in recent_topics[:30])}

"""

    now = datetime.now()
    now_str = now.strftime("%Y년 %m월 %d일 %H시")
    date_str = now.strftime("%Y-%m-%d")

    if skip_web_search:
        # ── 교양/상식 채널: 웹검색 없이 가이드라인 기반 주제 생성 ──
        prompt = f"""유튜브 쇼츠 교양 영상 주제를 선정해.

요청:
{request}

{f"채널 지침 요약: {instructions[:300]}" if instructions else ""}
{recent_section}규칙:
- 요청의 주제 카테고리와 예시를 참고해서 구체적인 주제 1개를 골라라
- 주제는 구체적인 현상/효과/개념 이름 (예: "더닝크루거 효과", "입면경련", "꿀이 안 상하는 이유")
- 웹 검색 하지 마라. 일반 지식으로 선정만 하면 됨
- 기존 주제와 중복 금지
- "N개" 명시 시 정확히 N개, 없으면 1개

JSON 배열만 출력: ["주제"]"""
    else:
        # ── 뉴스 채널: 웹검색으로 오늘 뉴스 주제 추출 ──
        trend_section = ""
        if trend_context:
            trend_section = f"""
{trend_context}

"""
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

    _use_web = not skip_web_search
    raw = _run_claude(prompt, timeout=300, model="claude-haiku-4-5-20251001",
                      use_web=_use_web)
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
                    channel_format: str = "single",
                    script_rules: str = "", roundup_rules: str = "",
                    has_outro: bool = False,
                    use_subagent: bool = False) -> dict:
    """Claude CLI로 뉴스 검색 + script_json 생성."""
    schema = _build_script_schema(channel_format=channel_format,
                                  script_rules=script_rules, roundup_rules=roundup_rules,
                                  has_outro=has_outro)
    now = datetime.now()
    now_str = now.strftime("%Y년 %m월 %d일 %H시")
    date_str = now.strftime("%Y-%m-%d")

    # 라운드업: topic은 "주제1 / 주제2 / ..." 형태
    if channel_format == "roundup":
        topic_list = [t.strip() for t in topic.split(" / ") if t.strip()]
        topic_display = "\n".join(f"  {i+1}. {t}" for i, t in enumerate(topic_list))
        topic_section = f"""아래 {len(topic_list)}개 주제에 대해 각각 최신 뉴스를 웹에서 검색하고,
라운드업(멀티뉴스) 형식의 쇼츠 영상용 script_json을 생성해줘.

주제 목록:
{topic_display}

★ 각 주제를 개별적으로 검색해서 오늘 뉴스의 핵심 팩트를 확인할 것."""
    else:
        topic_section = f"""주제: {topic}

위 지침에 따라 이 주제에 대한 최신 뉴스를 웹에서 검색하고,
쇼츠 영상용 script_json을 생성해줘."""

    prompt = f"""{instructions}

---

## 오늘의 작업

**현재 시각: {now_str} (한국시간)**

{topic_section}

### ★ 웹 검색 효율 규칙
- WebSearch 결과의 제목+요약(snippet)만으로 팩트를 파악할 수 있으면 WebFetch 생략
- WebFetch는 정확한 수치/통계 확인이 필요할 때만, 최대 1~2회
- 검색은 2~3회 이내로 완료할 것

### ★ 날짜 엄격 규칙 (필수)
- 오늘 날짜는 {date_str}이다. 반드시 오늘({date_str}) 또는 어제 게시된 기사만 사용하라.
- 2일 이상 지난 기사는 절대 사용 금지. 검색 결과에 오래된 기사만 나오면 해당 주제를 스킵하라.
- news_date 필드에는 실제 참조한 기사의 게시 날짜를 정확히 기입하라 (거짓 날짜 금지).
- 대본(sentences)에 날짜를 언급할 때도 실제 기사 날짜와 일치해야 한다.

{schema}

brand 값은 "{brand}"로 설정해.
"""

    # 서브에이전트 사용 시 병렬 검색 지시 추가
    if use_subagent:
        prompt += """

### ★ 서브에이전트 병렬 처리 규칙
- Agent 도구를 사용하여 각 주제의 뉴스 검색을 병렬로 수행하라.
- 각 서브에이전트에게 하나의 주제에 대한 웹 검색과 핵심 팩트 수집을 맡겨라.
- 모든 서브에이전트 결과를 수집한 후 최종 script_json을 생성하라.
- 서브에이전트에게는 WebSearch, WebFetch 도구만 사용하도록 지시하라.
"""

    raw = _run_claude(prompt, timeout=900, model="claude-sonnet-4-6",
                      retries=1, use_subagent=use_subagent)
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
        print("[날짜 검증] news_date 필드 없음 — 경고")

    return script


def _repair_json(raw: str) -> str | None:
    """잘리거나 깨진 JSON 자동 복구 시도."""
    # 1. trailing comma 제거: ,] → ] , ,} → }
    fixed = re.sub(r',\s*([}\]])', r'\1', raw)
    if fixed != raw:
        try:
            json.loads(fixed)
            return fixed
        except json.JSONDecodeError:
            pass
        raw = fixed  # trailing comma 수정은 유지하고 계속

    # 2. 잘린 JSON → 괄호 자동 닫기
    opens = 0
    open_sq = 0
    in_str = False
    escape = False
    for ch in raw:
        if escape:
            escape = False
            continue
        if ch == '\\':
            escape = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == '{':
            opens += 1
        elif ch == '}':
            opens -= 1
        elif ch == '[':
            open_sq += 1
        elif ch == ']':
            open_sq -= 1

    if opens > 0 or open_sq > 0:
        # 마지막 불완전한 요소 제거 후 닫기
        # 마지막 완전한 }, ] 또는 , 뒤를 자르고 닫기
        # 마지막 완전한 오브젝트/배열 요소 찾기
        last_complete = max(
            raw.rfind('},'),
            raw.rfind('}'),
            raw.rfind('],'),
            raw.rfind(']'),
        )
        if last_complete > 0:
            truncated = raw[:last_complete + 1]
            # trailing comma 제거
            truncated = re.sub(r',\s*$', '', truncated)
            # 남은 괄호 닫기
            closing = ']' * open_sq + '}' * opens
            # 좀 더 정교하게: 다시 카운트
            o2 = o_sq2 = 0
            in_s2 = esc2 = False
            for ch in truncated:
                if esc2: esc2 = False; continue
                if ch == '\\': esc2 = True; continue
                if ch == '"': in_s2 = not in_s2; continue
                if in_s2: continue
                if ch == '{': o2 += 1
                elif ch == '}': o2 -= 1
                elif ch == '[': o_sq2 += 1
                elif ch == ']': o_sq2 -= 1
            closing = ']' * o_sq2 + '}' * o2
            candidate = truncated + closing
            try:
                json.loads(candidate)
                return candidate
            except json.JSONDecodeError:
                pass

    return None


def _parse_response(raw: str, brand: str,
                    required_fields: tuple = ("sentences", "slides")) -> dict:
    """Claude 출력에서 JSON dict 추출.

    required_fields: 필수 필드 목록. 비어있으면 검증 스킵.
    """
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
        # JSON 자동 복구 시도
        repaired = _repair_json(raw)
        if repaired:
            try:
                data = json.loads(repaired)
                print(f"[agent] JSON 자동 복구 성공")
            except json.JSONDecodeError:
                raise RuntimeError(f"JSON 파싱 실패: {e}\n원본:\n{raw[:1000]}")
        else:
            raise RuntimeError(f"JSON 파싱 실패: {e}\n원본:\n{raw[:1000]}")

    # 필수 필드 검증
    if required_fields:
        missing = [f for f in required_fields if f not in data]
        if missing:
            raise RuntimeError(f"필수 필드 누락 {missing}: {list(data.keys())}")

    # brand/date 보정
    if not data.get("brand"):
        data["brand"] = brand

    return data


# ── Phase A v2: 시놉시스 → 비주얼 플랜 → 대본 ──────────────────

def generate_synopsis(topic: str, instructions: str, brand: str = "이슈60초",
                      channel_format: str = "single",
                      has_outro: bool = False,
                      use_subagent: bool = False,
                      target_duration: int = 60) -> dict:
    """Step 1: 웹 검색 + 시놉시스(전체 스토리 구조) 생성. [Sonnet, 웹검색O]

    Returns:
        {
          "news_date": "2026-03-15",
          "youtube_title": "...",
          "synopsis": "전체 스토리 1~2줄 요약",
          "scenes": [
            {"scene": 1, "role": "hook", "message": "핵심 한줄", "keywords": ["키워드"],
             "source_fact": "팩트 출처/내용"},
            ...
          ],
          "news_facts": ["수집된 팩트1", "팩트2", ...]
        }
    """
    now = datetime.now()
    now_str = now.strftime("%Y년 %m월 %d일 %H시")
    date_str = now.strftime("%Y-%m-%d")

    if channel_format == "roundup":
        topic_list = [t.strip() for t in topic.split(" / ") if t.strip()]
        topic_display = "\n".join(f"  {i+1}. {t}" for i, t in enumerate(topic_list))
        topic_section = f"""아래 {len(topic_list)}개 주제에 대해 각각 최신 뉴스를 웹에서 검색하고,
라운드업(멀티뉴스) 형식의 시놉시스를 생성해줘.

주제 목록:
{topic_display}

★ 각 주제를 개별적으로 검색해서 오늘 뉴스의 핵심 팩트를 확인할 것."""
    else:
        topic_section = f"""주제: {topic}

위 지침에 따라 이 주제에 대한 최신 뉴스를 웹에서 검색하고,
쇼츠 영상용 시놉시스를 생성해줘."""

    outro_note = ""
    if has_outro:
        outro_note = "\n- ★ 별도 아웃트로가 있으므로 마지막 씬에 마무리/구독 요청 넣지 마라. 콘텐츠 전달로 끝내라."

    prompt = f"""{instructions}

---

## 오늘의 작업: 시놉시스 생성

**현재 시각: {now_str} (한국시간)**

{topic_section}

### ★ 웹 검색 효율 규칙
- WebSearch 결과의 제목+요약(snippet)만으로 팩트를 파악할 수 있으면 WebFetch 생략
- WebFetch는 정확한 수치/통계 확인이 필요할 때만, 최대 1~2회
- 검색은 2~3회 이내로 완료할 것

### ★ 날짜 엄격 규칙 (필수)
- 오늘 날짜는 {date_str}이다. 반드시 오늘({date_str}) 또는 어제 게시된 기사만 사용하라.
- 2일 이상 지난 기사는 절대 사용 금지.
- news_date에는 실제 참조한 기사의 게시 날짜를 정확히 기입하라.

### 시놉시스 작성 규칙
- 이 단계에서는 대본(sentences)이나 슬라이드 텍스트를 작성하지 않는다.
- 영상의 전체 스토리 구조만 설계한다.
- 씬(scene) 단위로 분할: 각 씬이 영상에서 어떤 역할을 하는지 정의한다.
- ★ 목표 영상 길이: **{target_duration}초** — 씬당 평균 5~6초 기준으로 씬 수를 결정
  - {target_duration}초 영상 → {target_duration // 5}~{target_duration // 5 + 2}개 씬 (closing 제외)
- 각 씬의 역할(role): hook(시작 훅) / context(배경) / detail(구체 내용) / impact(영향) / outlook(전망)
- 라운드업이면: overview(헤드라인) / topic_1 / topic_2 / ... 형태
- 수집한 뉴스 팩트(수치, 인용, 날짜)를 news_facts에 빠짐없이 기록
- 각 씬의 source_fact에 해당 씬에서 다룰 팩트를 명시
- ★ 씬 간 인과 관계를 명확히: 각 씬의 message에 앞 씬과의 연결("~때문에", "그 결과", "이에 따라")을 포함{outro_note}

다음 JSON 형식으로만 출력해. 다른 텍스트 없이 JSON만.

{{
  "news_date": "{date_str}",
  "youtube_title": "YouTube 제목 (100자 이내, 클릭 유도)",
  "synopsis": "전체 스토리 1~2줄 요약",
  "scenes": [
    {{"scene": 1, "role": "hook", "message": "이 씬의 핵심 메시지", "keywords": ["키워드1", "키워드2"], "source_fact": "이 씬에서 다룰 팩트"}},
    {{"scene": 2, "role": "detail", "message": "...", "keywords": ["..."], "source_fact": "..."}},
    ...
  ],
  "news_facts": ["수집된 팩트 전체 목록 (수치/인용/날짜 포함)"]
}}"""

    if use_subagent:
        prompt += """

### ★ 서브에이전트 병렬 처리 규칙
- Agent 도구를 사용하여 각 주제의 뉴스 검색을 병렬로 수행하라.
- 각 서브에이전트에게 하나의 주제에 대한 웹 검색과 핵심 팩트 수집을 맡겨라.
- 모든 서브에이전트 결과를 수집한 후 최종 시놉시스를 생성하라.
"""

    raw = _run_claude(prompt, timeout=900, model="claude-sonnet-4-6",
                      retries=1, use_subagent=use_subagent)
    result = _parse_response(raw, brand, required_fields=("scenes",))

    # 날짜 검증
    news_date_str = result.get("news_date", "")
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

    # 필수 필드 보정
    if "scenes" not in result:
        raise RuntimeError(f"synopsis에 scenes 필드 누락: {list(result.keys())}")
    if "news_facts" not in result:
        result["news_facts"] = []
    if "synopsis" not in result:
        result["synopsis"] = ""

    return result


def generate_visual_plan(topic: str, synopsis: dict,
                         prompt_style: str = "",
                         layout: str = "full",
                         image_style: str = "mixed",
                         scene_references: str = "",
                         bg_display_mode: str = "zone",
                         bg_media_type: str = "auto",
                         auto_bg_source: str = "",
                         first_slide_single_bg: bool = False,
                         target_duration: int = 60) -> list[dict]:
    """Step 2: 시놉시스 기반 비주얼 플랜 생성. [Opus, 웹검색X]

    Returns:
        [
          {"scene": 1, "media": "video", "duration": 6, "bg_type": "broll",
           "en": "English prompt...", "ko": "한국어 설명", "motion": "slow zoom in"},
          ...
        ]
    """
    scenes = synopsis.get("scenes", [])
    news_facts = synopsis.get("news_facts", [])
    synopsis_text = synopsis.get("synopsis", "")

    scene_descs = []
    for s in scenes:
        scene_descs.append(
            f"Scene {s['scene']}: [{s['role']}] {s['message']} "
            f"(keywords: {', '.join(s.get('keywords', []))})"
        )

    style_rules = prompt_style.strip() if prompt_style and prompt_style.strip() else DEFAULT_IMAGE_PROMPT_STYLE

    # media 타입 전략 결정
    if bg_media_type == "auto":
        media_instruction = (
            "- 이미지:영상 비율 약 6:4 (전체 프롬프트 중 ~40%를 'video'로 지정)\n"
            "- 나머지는 'image'\n"
            "- 동적 장면(행동/움직임/변화)은 video, 정적 장면(설명/도입/정리)은 image"
        )
    elif bg_media_type == "single":
        media_instruction = "- 모든 씬을 'image'로 지정 (영상 없음)"
    else:
        media_instruction = f"- bg_media_type: {bg_media_type} 설정에 따라 지정"

    prompt = f"""너는 뉴스 영상의 비주얼 디렉터야.
시놉시스를 기반으로 각 씬(scene)의 비주얼을 설계해.

## 기사 정보
Topic: {topic}
Synopsis: {synopsis_text}

## 수집된 팩트
{chr(10).join(f"- {f}" for f in news_facts[:20])}

## 씬 구성
{chr(10).join(scene_descs)}

## STEP 0: 비주얼 스타일 가이드 (먼저 정의)
모든 씬에 걸쳐 **시각적 일관성**을 유지할 스타일을 먼저 정의하라.
- art_style: 전체 영상의 그림체/톤
- color_palette: 3~5개 주요 색상
- character_design: 주요 인물의 외형 상세 정의 — 헤어스타일, 눈, 체형, 의상, 소품 등. 모든 씬에서 동일 인물이 같은 외형으로 등장해야 함
- consistency_keywords: 모든 en 프롬프트에 반복 삽입할 키워드
- ★ character_design + consistency_keywords를 **모든 en 프롬프트에 반드시 포함**시켜라.
- ★ 일러스트/애니메 스타일에서는 인물 등장 가능 (실사 스타일에서만 인물 금지)

## 비주얼 플랜 지침 (반드시 따를 것)
{style_rules}

{f"## 주제별 현장 레퍼런스{chr(10)}{scene_references.strip()}" if scene_references and scene_references.strip() else ""}

## Image Style
{_image_style_instruction(image_style)}

## Image Size & Composition
{_image_size_instruction(layout, bg_display_mode)}

## ★★★ 핵심: 비주얼이 영상을 주도한다 ★★★

★ 목표 영상 길이: **{target_duration}초** (closing 제외 duration 합계가 이 범위에 맞아야 함)

이 비주얼 플랜에 따라 대본이 작성된다. 따라서:
1. **duration 결정이 핵심**: 모든 씬의 duration 합계가 ~{target_duration}초가 되도록 배분
   - image 씬: 5초 기본. 정보량이 많은 씬만 10초 (10초 씬은 전체의 1~2개 이하)
   - ★ video 씬: 반드시 6초 고정 (6초 초과 금지)
   - 어중간한 6~7초 image 금지
2. **시각적 리듬**: wide → medium → close-up → wide 순서로 스케일 변화
3. **연속 금지**: 같은 앵글/스케일 연속 사용 금지
4. **각 씬은 독립적 장면**: 같은 장소/피사체 반복 금지

## media 배치 규칙
{media_instruction}
- video 프롬프트의 en 필드에 움직임 키워드 추가 (gentle movement, swaying, flowing 등)
- graph/overview 타입은 항상 "image"
- 첫 씬은 시청자 주의를 끄는 강렬한 비주얼

## bg_type 선택
- overview: 뉴스 라운드업 첫 씬 전용
- photo: 실제 장소/사물 (가장 일반적)
- broll: 시네마틱 (1~2개만, video와 잘 어울림)
- graph: 인포그래픽/일러스트 (수치 비교, 데이터)
- logo: 기업 건물 외관
- closing: 빈 프롬프트 (마지막 씬 배경 재사용)

## motion 작성 규칙
- 단순 카메라 동작만 쓰지 마라 ("slow zoom in" 만 X)
- 카메라 + 피사체 + 환경을 조합:
  "slow zoom in on factory exterior as smoke rises from chimneys"
  "gentle pan across trading floor with flickering monitors"
- video 씬의 motion은 실제 영상 생성에 사용되므로 구체적으로

## 출력 형식
다음 JSON 배열만 출력해. 다른 텍스트 없이 JSON만.

[
  {{"scene": 1, "media": "image", "duration": 5, "bg_type": "photo",
    "en": "English prompt 30-60 words...", "ko": "한국어 현장 설명",
    "motion": "camera + subject + environment motion description"}},
  ...
]

★ closing 씬은 {{"scene": N, "media": "image", "duration": 0, "bg_type": "closing", "en": "", "ko": "", "motion": ""}}"""

    raw = _run_claude(prompt, timeout=180, use_web=False,
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
        plan = json.loads(m.group(0))
        if isinstance(plan, list):
            result = []
            for p in plan:
                if isinstance(p, dict):
                    result.append({
                        "scene": p.get("scene", len(result) + 1),
                        "media": str(p.get("media", "image")),
                        "duration": p.get("duration", 5),
                        "bg_type": str(p.get("bg_type", "photo")),
                        "en": str(p.get("en", "")),
                        "ko": str(p.get("ko", "")),
                        "motion": str(p.get("motion", "")),
                    })
            return result

    raise RuntimeError(f"visual_plan 파싱 실패:\n{raw[:1000]}")


def generate_script_from_plan(topic: str, synopsis: dict,
                              visual_plan: list[dict],
                              instructions: str,
                              brand: str = "이슈60초",
                              channel_format: str = "single",
                              script_rules: str = "",
                              roundup_rules: str = "",
                              has_outro: bool = False) -> dict:
    """Step 3: 비주얼 플랜 기반 대본 + 슬라이드 생성. [Sonnet, 웹검색X]

    비주얼 플랜의 duration에 맞춰 나레이션 분량을 조절.

    Returns:
        기존 script_json 포맷:
        {
          "news_date": "...", "youtube_title": "...",
          "sentences": [{"text": "...", "slide": 1}, ...],
          "slides": [{"category": "...", "main": "...", "sub": "...", "bg_type": "..."}, ...]
        }
    """
    scenes = synopsis.get("scenes", [])
    news_facts = synopsis.get("news_facts", [])
    synopsis_text = synopsis.get("synopsis", "")
    news_date = synopsis.get("news_date", "")
    youtube_title = synopsis.get("youtube_title", "")

    # 비주얼 플랜 요약 (대본 작성자에게 전달)
    plan_descs = []
    total_duration = 0
    for vp in visual_plan:
        if vp.get("bg_type") == "closing":
            continue
        dur = vp.get("duration", 5)
        total_duration += dur
        media_tag = "VIDEO 6s" if vp.get("media") == "video" else f"IMAGE {dur}s"
        plan_descs.append(
            f"씬 {vp['scene']} [{media_tag}] [{vp.get('bg_type', 'photo')}]: "
            f"{vp.get('ko', '')} — motion: {vp.get('motion', '')}"
        )

    # 씬 정보 (역할 + 메시지)
    scene_context = []
    for s in scenes:
        scene_context.append(
            f"씬 {s['scene']} [{s['role']}]: {s['message']} "
            f"(팩트: {s.get('source_fact', '')})"
        )

    # 대본 규칙
    rules_text = ""
    if channel_format == "roundup":
        rules_text = roundup_rules.strip() if roundup_rules and roundup_rules.strip() else DEFAULT_ROUNDUP_RULES
    else:
        rules_text = script_rules.strip() if script_rules and script_rules.strip() else DEFAULT_SCRIPT_RULES

    outro_note = ""
    if has_outro:
        outro_note = "\n- ★ 별도 아웃트로가 있으므로 마지막 씬에 마무리 인사/구독 요청 넣지 마라."

    prompt = f"""{instructions}

---

## 오늘의 작업: 비주얼 플랜에 맞춘 대본 작성

### 기사 정보
- 주제: {topic}
- 요약: {synopsis_text}
- 날짜: {news_date}
- 제목: {youtube_title}

### 수집된 팩트 (반드시 대본에 반영)
{chr(10).join(f"- {f}" for f in news_facts[:20])}

### 씬 구성 (시놉시스)
{chr(10).join(scene_context)}

### ★★★ 비주얼 플랜 (이 구조에 맞춰 대본 작성) ★★★
{chr(10).join(plan_descs)}

예상 총 길이: ~{total_duration}초

### ★ 핵심 규칙: 대본은 비주얼에 맞춘다
- 각 씬의 duration에 맞춰 나레이션 분량을 정확히 조절
- 한국어 TTS 기준: 초당 ~4.5음절
- IMAGE 5초 씬 → 문장 1~2개 (20~25자)
- IMAGE 10초 씬 → 문장 3~4개 (40~50자)
- VIDEO 6초 씬 → 문장 2개 (25~30자)
- ★ 각 씬의 duration을 초과/미달하면 안 된다. 배경과 나레이션이 어긋난다.
- 슬라이드 수 = 비주얼 플랜의 씬 수 (closing 포함)
- slides와 비주얼 플랜은 1:1 매핑 (순서 동일)

### ★★★ 나레이션 연결 규칙 (매우 중요) ★★★
sentences를 처음부터 끝까지 이어 읽으면 **하나의 연속된 내레이션**이 되어야 한다.
슬라이드가 바뀌어도 이야기의 흐름은 끊기지 않는다.

**슬라이드 간 인과/논리 연결 필수:**
- 앞 슬라이드가 현상(무슨 일?)을 말했으면 → 다음 슬라이드 첫 문장은 원인/이유로 연결
  - "~했기 때문입니다", "~한 영향인데요", "원인은 ~에 있습니다"
- 앞 슬라이드가 원인을 말했으면 → 다음은 결과/영향으로 연결
  - "그 결과 ~", "이 때문에 ~", "영향으로 ~"
- 앞 슬라이드가 데이터를 말했으면 → 다음은 의미/해석으로 연결
  - "이게 의미하는 건 ~", "다시 말해 ~", "문제는 ~인데요"

**금지:**
- 각 슬라이드가 독립된 뉴스처럼 시작하는 것 (매번 새 주어+서술어로 끊는 것)
- 같은 접속 표현 반복 ("~인데요"만 계속 쓰기)

**좋은 예 (연결):**
슬라이드1: "유가가 배럴당 100달러를 돌파했습니다. 하루 만에 9% 급등한 건데요."
슬라이드2: "이란의 호르무즈 해협 봉쇄가 원인입니다. 전 세계 원유의 20%가 막혔거든요."
슬라이드3: "공급 차질은 하루 800만 배럴에 달하는데요. 비축유로도 26일밖에 못 버팁니다."

**나쁜 예 (끊김):**
슬라이드1: "유가가 배럴당 100달러를 돌파했습니다."
슬라이드2: "이란이 호르무즈 해협 봉쇄를 선언했습니다." ← 앞 슬라이드와 연결 없이 새 문장 시작
{outro_note}

### 대본 규칙
{rules_text}

### 출력 형식
다음 JSON 형식으로만 출력해. 다른 텍스트 없이 JSON만.

{{
  "news_date": "{news_date}",
  "youtube_title": "{youtube_title}",
  "sentences": [{{"text": "문장 (15~25자)", "slide": 1}}, ...],
  "slides": [
    {{"category": "카테고리", "main": "핵심 <span class=\\"hl\\">강조</span>", "sub": "보조 설명", "bg_type": "photo"}},
    ...
  ]
}}

★ slides 배열 길이 = 비주얼 플랜 씬 수 (closing 포함)
★ 각 slide의 bg_type은 비주얼 플랜의 bg_type과 동일해야 한다.
★ sentences에 채널명 언급 금지, HTML 태그 금지 (순수 텍스트만)
★ slides의 main/sub에서 강조 키워드는 <span class="hl">...</span>

brand 값은 "{brand}"로 설정해.
"""

    raw = _run_claude(prompt, timeout=300, use_web=False,
                      model="claude-sonnet-4-6")
    script = _parse_response(raw, brand)

    # news_date 보정
    if not script.get("news_date") and news_date:
        script["news_date"] = news_date
    if not script.get("youtube_title") and youtube_title:
        script["youtube_title"] = youtube_title

    return script


def generate_all_in_one(topic: str, instructions: str, brand: str = "이슈60초",
                        channel_format: str = "single",
                        has_outro: bool = False,
                        use_subagent: bool = False,
                        target_duration: int = 60,
                        prompt_style: str = "",
                        layout: str = "full",
                        image_style: str = "mixed",
                        scene_references: str = "",
                        bg_display_mode: str = "zone",
                        bg_media_type: str = "auto",
                        script_rules: str = "",
                        roundup_rules: str = "",
                        skip_web_search: bool = False,
                        gemini_api_key: str = "") -> dict:
    """Phase A 통합: 시놉시스 + 비주얼 플랜 + 대본을 1회 Claude 호출로 생성. [Sonnet, 웹검색O]

    Returns:
        {
          "synopsis": {"synopsis": "...", "scenes": [...], "news_facts": [...]},
          "visual_plan": [{"scene":1, "media":"image", "duration":5, ...}, ...],
          "script": {"news_date":"...", "youtube_title":"...", "sentences":[...], "slides":[...]}
        }
    """
    now = datetime.now()
    now_str = now.strftime("%Y년 %m월 %d일 %H시")
    date_str = now.strftime("%Y-%m-%d")

    # 주제 섹션
    if channel_format == "roundup":
        topic_list = [t.strip() for t in topic.split(" / ") if t.strip()]
        topic_display = "\n".join(f"  {i+1}. {t}" for i, t in enumerate(topic_list))
        topic_section = f"""아래 {len(topic_list)}개 주제에 대해 각각 최신 정보를 검색하고,
라운드업 형식의 영상을 제작해줘.

주제 목록:
{topic_display}"""
    else:
        topic_section = f"주제: {topic}"

    outro_note = ""
    if has_outro:
        outro_note = "\n- ★ 별도 아웃트로가 있으므로 마지막 씬에 마무리 인사/구독 요청 넣지 마라."

    # 대본 규칙
    if channel_format == "roundup":
        rules_text = roundup_rules.strip() if roundup_rules and roundup_rules.strip() else DEFAULT_ROUNDUP_RULES
    else:
        rules_text = script_rules.strip() if script_rules and script_rules.strip() else DEFAULT_SCRIPT_RULES

    # 이미지 스타일 지침
    style_rules = prompt_style.strip() if prompt_style and prompt_style.strip() else DEFAULT_IMAGE_PROMPT_STYLE

    # media 타입 전략
    if bg_media_type == "auto":
        media_instruction = (
            "- 이미지:영상 비율 약 6:4 (전체 씬 중 ~40%를 'video'로 지정)\n"
            "- 동적 장면(행동/움직임/변화)은 video, 정적 장면(설명/도입/정리)은 image"
        )
    elif bg_media_type == "single":
        media_instruction = "- 모든 씬을 'image'로 지정"
    else:
        media_instruction = f"- bg_media_type: {bg_media_type}"

    # all-in-one용 비주얼 지침 (경량화)
    _compact_style = style_rules
    # 채널 커스텀이 없으면 축약 버전 사용 (DEFAULT_IMAGE_PROMPT_STYLE 대체)
    if not (prompt_style and prompt_style.strip()):
        _compact_style = (
            "ALL prompts in English, 30-60 words, 5요소: subject, setting, lighting, camera, style\n"
            "- 추상 개념 금지 → 카메라맨이 촬영할 수 있는 구체적 장소/사물\n"
            "- wide→medium→close-up→wide 스케일 변화, 같은 구도 연속 금지\n"
            "- photo/broll/logo: realistic, sharp focus, 8k, photojournalism\n"
            "- graph: flat illustration, vector art, infographic (실사 금지)\n"
            "- overview: modern news studio, broadcast newsroom\n"
            "- closing: 빈 문자열\n"
            "- BANNED: text/numbers in image, dark/moody themes, same scene repeated"
        )

    # 웹검색 스킵 여부에 따라 시놉시스 지침 분기
    if skip_web_search:
        _synopsis_instruction = "위 지침에 제공된 데이터만으로 스토리 구조를 설계해. 웹 검색 금지."
    else:
        _synopsis_instruction = (
            "웹 검색으로 최신 팩트를 수집하고 스토리 구조를 설계해.\n\n"
            "### ★ 웹 검색 규칙 (속도 최우선)\n"
            f"- WebSearch **1회**로 핵심 팩트 수집 (snippet만으로 충분하면 추가 검색 금지)\n"
            f"- WebFetch **금지** (snippet에 없는 정확한 수치가 반드시 필요할 때만 최대 1회)\n"
            f"- 오늘({date_str}) 또는 어제 기사만 사용"
        )

    prompt = f"""{instructions}

---

## 작업

**{now_str} (한국시간)** | {topic_section}

3단계를 순서대로 사고한 뒤 최종 JSON을 출력해.

## STEP 1: 시놉시스

{_synopsis_instruction}

### 시놉시스 규칙
- 목표: **{target_duration}초**, 씬당 5~6초 → {target_duration // 5}~{target_duration // 5 + 2}개 씬
- 씬별 한줄 키워드만, 씬 간 인과 관계 명확히{outro_note}

## STEP 1.5: 비주얼 스타일 가이드

모든 씬에 걸쳐 **시각적 일관성**을 유지할 스타일 가이드를 먼저 정의하라.
- art_style: 전체 영상의 그림체/톤 (예: "soft cel-shaded anime, pastel warm tones, clean linework")
- color_palette: 3~5개 주요 색상 (예: "soft pink, cream, sky blue, warm beige")
- character_design: 주요 인물의 외형 상세 정의 — 헤어스타일, 눈, 체형, 의상, 소품 등. 모든 씬에서 동일 인물이 같은 외형으로 등장해야 함 (예: "young woman, shoulder-length black hair, large round eyes, white blouse, navy skirt, cheerful expression")
- consistency_keywords: 모든 프롬프트에 반복 삽입할 키워드 (예: "consistent art style, same character design, same color palette")
- ★ character_design + consistency_keywords를 STEP 2의 **모든 en 프롬프트에 반드시 포함**시켜라.
- ★ 일러스트/애니메 스타일에서는 인물 등장 가능 (실사 스타일에서만 인물 금지)

## STEP 2: 비주얼 플랜

{_compact_style}
{f"{chr(10)}### 현장 레퍼런스{chr(10)}{scene_references.strip()}" if scene_references and scene_references.strip() else ""}

### Image Style
{_image_style_instruction(image_style)}

### Image Size
{_image_size_instruction(layout, bg_display_mode)}

### duration/media
- duration 합계 ≈ {target_duration}초. image: 5초(정보 많으면 10초, 최대 1~2개). ★ video: 반드시 6초 고정 (6초 초과 금지). 6~7초 image 금지
{media_instruction}
- graph/overview → 항상 image. video의 en에 움직임 키워드 포함
- motion: 카메라+피사체+환경 조합 (예: "slow zoom in on factory as smoke rises")
- bg_type: photo/broll/graph/logo/closing. overview는 라운드업 전용 (단일 형식 사용 금지)

## STEP 3: 대본

비주얼 플랜의 duration에 맞춰 나레이션 작성. TTS 초당 ~4.5음절 기준:
- 5초 → 1~2문장(20~25자), 10초 → 3~4문장(40~50자)
- ★ video(6초) → 반드시 2문장, 25~30자 이내. video는 6초 고정이므로 대본도 6초 분량만 작성
- ★ sentences를 이어 읽으면 연속된 내레이션이 되어야 함. 슬라이드 간 인과 연결 필수 (끊김 금지)

### 대본 규칙
{rules_text}

## 출력 (JSON만 출력, 다른 텍스트 금지)

{{
  "style_guide": {{
    "art_style": "그림체/톤 키워드",
    "color_palette": "주요 색상 3~5개",
    "character_design": "주요 인물 외형 상세 (헤어, 눈, 체형, 의상 등)",
    "consistency_keywords": "모든 en 프롬프트에 삽입할 스타일 키워드"
  }},
  "synopsis": {{
    "synopsis": "1~2줄 요약",
    "scenes": [{{"scene": 1, "role": "hook", "message": "키워드", "keywords": ["k1"]}}, ...],
    "news_facts": ["팩트 목록"]
  }},
  "visual_plan": [
    {{"scene": 1, "media": "image", "duration": 5, "bg_type": "photo",
      "en": "★ consistency_keywords 포함 English prompt 30-60 words", "ko": "한국어 설명", "motion": "motion desc"}}, ...
  ],
  "script": {{
    "news_date": "{date_str}",
    "youtube_title": "제목 (100자 이내)",
    "sentences": [{{"text": "나레이션", "slide": 1}}, ...],
    "slides": [{{"category": "카테고리", "main": "핵심 <span class=\\"hl\\">강조</span>", "sub": "보조", "bg_type": "photo"}}, ...]
  }}
}}

★ visual_plan↔slides 1:1 매핑. closing: {{"scene":N,"media":"image","duration":0,"bg_type":"closing","en":"","ko":"","motion":""}}
★ sentences: HTML 금지. slides main/sub: <span class="hl">...</span>만 허용. brand: "{brand}"
"""

    if use_subagent and not skip_web_search:
        prompt += """
### ★ 서브에이전트 병렬 처리
- Agent 도구로 각 주제의 검색을 병렬 수행하라.
"""

    # ── Gemini 1차 생성 + Claude 검증 or 기존 Claude 단독 ──
    if gemini_api_key:
        import time as _time
        print(f"[agent] Gemini+Claude mode 시작: topic={topic[:40]}")
        _t_total = _time.time()
        try:
            # Step 1: Gemini 드래프트
            raw_gemini = _run_gemini(prompt, api_key=gemini_api_key)
            draft = _parse_response(raw_gemini, brand, required_fields=())
            draft = _normalize_gemini_result(draft)
            _sc = draft.get("script", {})
            print(f"[gemini] 드래프트 완료: {_time.time()-_t_total:.1f}초, "
                  f"sentences={len(_sc.get('sentences',[]))}, slides={len(_sc.get('slides',[]))}")

            # Step 2: Claude 검증
            print("[agent] Claude 검증 시작...")
            _t_val = _time.time()
            result = _validate_with_claude(draft, instructions, brand, topic,
                                             target_duration=target_duration)
            result = _normalize_gemini_result(result)  # Claude 출력도 구조 보정
            _sc2 = result.get("script", {})
            print(f"[agent] Claude 검증 완료: {_time.time()-_t_val:.1f}초, "
                  f"sentences={len(_sc2.get('sentences',[]))}, slides={len(_sc2.get('slides',[]))}")
            print(f"[agent] Gemini+Claude 총 소요: {_time.time()-_t_total:.1f}초")
        except Exception as e:
            print(f"[agent] Gemini+Claude 실패 ({e}), Claude CLI 폴백")
            gemini_api_key = ""  # 아래 Claude 폴백으로

    if not gemini_api_key:
        _timeout = 300 if skip_web_search else 900
        raw = _run_claude(prompt, timeout=_timeout, model="claude-sonnet-4-6",
                          retries=1, use_subagent=use_subagent if not skip_web_search else False,
                          use_web=not skip_web_search)
        result = _parse_response(raw, brand, required_fields=("synopsis", "visual_plan", "script"))

    # script 필수 필드 검증
    script = result.get("script", {})
    if "sentences" not in script or "slides" not in script:
        raise RuntimeError(f"script에 필수 필드 누락: {list(script.keys())}")

    # 날짜 검증 (뉴스 채널용)
    news_date_str = script.get("news_date", "")
    if news_date_str:
        try:
            news_date = datetime.strptime(news_date_str, "%Y-%m-%d").date()
            today = datetime.now().date()
            if (today - news_date).days > 1:
                raise RuntimeError(
                    f"24시간 이전 뉴스입니다 (기사일: {news_date_str}). 다시 시도하세요."
                )
        except ValueError:
            pass

    return result


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
    elif image_style == "anime":
        return (
            "★ ALL slides must use ANIME/ILLUSTRATION style.\n"
            "- Use keywords: anime-style illustration, digital art, cel-shaded, vibrant colors, clean lines\n"
            "- People/characters: anime-style faces, expressive features, stylized proportions\n"
            "- Backgrounds: semi-realistic or painted style environments\n"
            "- Do NOT use realistic photography or photojournalism style\n"
            "- Reference styles: studio ghibli, modern anime, digital illustration\n"
            "- Keep scenes bright, warm, and visually appealing"
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


def _count_slide_sentences(slides: list[dict], sentences: list[dict]) -> dict[int, int]:
    """슬라이드별 문장 수 계산."""
    counts: dict[int, int] = {}
    for sent in sentences:
        slide_idx = sent.get("slide", 1) - 1
        if sent.get("text", "").strip():
            counts[slide_idx] = counts.get(slide_idx, 0) + 1
    return counts


def generate_image_prompts(topic: str, slides: list[dict],
                           prompt_style: str = "",
                           layout: str = "full",
                           image_style: str = "mixed",
                           scene_references: str = "",
                           bg_display_mode: str = "zone",
                           sentences: list[dict] | None = None,
                           bg_media_type: str = "auto",
                           auto_bg_source: str = "",
                           first_slide_single_bg: bool = False) -> list[str]:
    """대본의 슬라이드 정보로 이미지 생성 프롬프트(영어) 생성.

    SD 모델은 영어 프롬프트만 이해하므로 반드시 영어로 출력.
    prompt_style: 채널별 커스텀 프롬프트 지침. 비어있으면 기본 뉴스 B-roll 스타일 사용.
    layout: 슬라이드 레이아웃 (full/center/top/bottom) — 이미지 사이즈/비율 결정
    scene_references: 채널별 주제→현장 매핑 레퍼런스 (비어있으면 생략)
    sentences: 문장 리스트. 슬라이드별 나레이션 길이 추정에 사용.
    bg_media_type: 배경 교체 전략 (single/per-sentence/auto)
    auto_bg_source: 배경 소스 (gemini/sd_image/sd_video/openverse) — auto 모드에서 참조
    웹 검색 불필요 — 빠르게 완료됨.
    """
    # 배경 소스에 따라 전략 결정
    _first_slide_single = first_slide_single_bg
    _effective_type = bg_media_type
    if bg_media_type == "auto":
        if auto_bg_source in ("sd_video",):
            _effective_type = "timed"  # 영상 → 시간 기준 교체
        else:
            _effective_type = "per-sentence"  # 이미지 → 문장별 교체
    # mixed, single, per-sentence, timed → 채널 config에서 직접 선택

    # 슬라이드별 나레이션 길이 추정
    _sents = sentences or []
    slide_durations = _estimate_slide_durations(slides, _sents)
    slide_sentence_counts = _count_slide_sentences(slides, _sents)

    def _bg_count_for_slide(slide_idx: int) -> int:
        """슬라이드에 필요한 배경 수 계산."""
        if _first_slide_single and slide_idx == 0:
            return 1
        if _effective_type == "single":
            return 1
        elif _effective_type == "mixed":
            # Gemini 혼합 모드: 슬라이드당 2~3개 (이미지+영상 조합)
            dur = slide_durations.get(slide_idx, 8.0)
            if dur >= 8.0:
                return 3  # 이미지2 + 영상1 또는 이미지3
            else:
                return 2  # 이미지1 + 영상1 또는 이미지2
        elif _effective_type == "per-sentence":
            n = slide_sentence_counts.get(slide_idx, 1)
            return max(1, n)
        else:  # timed
            dur = slide_durations.get(slide_idx, 5.0)
            if dur > 6.0:
                return 2
            return 1

    slide_descs = []
    prompt_count = 0
    for i, s in enumerate(slides):
        if s.get("bg_type") == "closing":
            continue
        clean_main = (s.get("main", "")).replace("<span class=\"hl\">", "").replace("</span>", "")
        bg_type = s.get("bg_type", "photo")
        est_dur = slide_durations.get(i, 5.0)
        bg_n = _bg_count_for_slide(i)
        count_label = f" [x{bg_n} prompts -- 배경 {bg_n}개 필요]" if bg_n > 1 else ""
        slide_descs.append(f"Slide {i+1}: [bg_type={bg_type}] [{s.get('category', '')}] {clean_main} -- {s.get('sub', '')} (~{est_dur:.0f}s, {slide_sentence_counts.get(i, 1)}문장){count_label}")
        prompt_count += bg_n

    style_rules = prompt_style.strip() if prompt_style and prompt_style.strip() else DEFAULT_IMAGE_PROMPT_STYLE

    prompt = f"""너는 뉴스 영상의 비주얼 디렉터야.
아래 슬라이드 전체를 먼저 읽고, 기사의 전체 흐름을 파악한 후 각 슬라이드에 어울리는 이미지를 구성해.

Topic: {topic}

Slides:
{chr(10).join(slide_descs)}

## STEP 0: 비주얼 스타일 가이드 (먼저 정의)
모든 슬라이드에 걸쳐 **시각적 일관성**을 유지할 스타일을 먼저 정의하라.
- art_style: 전체 영상의 그림체/톤
- color_palette: 3~5개 주요 색상
- character_design: 주요 인물의 외형 상세 정의 — 헤어스타일, 눈, 체형, 의상, 소품 등. 모든 씬에서 동일 인물이 같은 외형으로 등장해야 함
- consistency_keywords: 모든 en 프롬프트에 반복 삽입할 키워드
- ★ character_design + consistency_keywords를 **모든 en 프롬프트에 반드시 포함**시켜라.
- ★ 일러스트/애니메 스타일에서는 인물 등장 가능 (실사 스타일에서만 인물 금지)

## 이미지 프롬프트 지침 (반드시 따를 것)
{style_rules}

{f"## 주제별 현장 레퍼런스{chr(10)}{scene_references.strip()}" if scene_references and scene_references.strip() else ""}

## Image Style
{_image_style_instruction(image_style)}

## Image Size & Composition
{_image_size_instruction(layout, bg_display_mode)}

## 출력 형식
각 슬라이드에 대해 ko, en, motion, media 4개 필드를 생성.
**[xN prompts]로 표시된 슬라이드는 서로 다른 장면의 프롬프트를 N개 연속 출력하라.**

- ko: 촬영 현장을 구체적으로 (예: "울산 정유소 증류탑 야경, 가스 플레어 불빛")
- en: 영어 이미지 프롬프트, 30-60 words, 5요소 필수 (Subject, Setting, Lighting, Camera, Style)
- motion: 이 장면을 영상으로 만들 때의 카메라 움직임 (예: "slow zoom in", "gentle pan left", "slow zoom out")
- media: "image" 또는 "video" — 이 배경을 정적 이미지로 쓸지, 6초 영상으로 변환할지 지정

## ★★★ media 배치 핵심 규칙 (반드시 따를 것) ★★★
한 슬라이드에 프롬프트가 2~3개일 때, **나레이션 흐름에 맞춰 image/video 순서를 결정**하라.
영상은 이미지에서 변환(image-to-video)되므로, 모든 프롬프트는 먼저 이미지로 생성된다.

### 나레이션 → 배경 순서 매핑
- 설명/도입부 → image (정적 장면으로 집중)
- 행동/움직임/변화 묘사 → video (동적 장면)
- 결론/정리 → image (안정감)

### 배치 예시 (3개 프롬프트 슬라이드)
| 나레이션 흐름 | 순서 |
|---|---|
| 설명 → 행동 → 결과 | image → video → image |
| 갑작스러운 행동 → 설명 → 마무리 | video → image → image |
| 도입 → 전개 → 클라이맥스 | image → image → video |

### 배치 예시 (2개 프롬프트 슬라이드)
| 나레이션 흐름 | 순서 |
|---|---|
| 설명 → 행동 | image → video |
| 행동 → 설명 | video → image |
| 정보 → 정보 | image → image |

### 비율 규칙
- 이미지:영상 비율 약 6:4 (전체 프롬프트 중 ~40%를 "video"로 지정)
- ★ video는 반드시 6초 고정 (6초 초과 금지). 대본도 6초 분량(25~30자)만 작성
- graph/overview 타입은 항상 "image"
- "video" 프롬프트의 en 필드에 움직임 키워드 추가 (gentle movement, swaying, flowing 등)
- 같은 슬라이드 안에서 video는 **최대 1개**
- closing 타입 → {{"ko":"", "en":"", "motion":"", "media":"image"}}

## 기타 규칙
- ★ 모든 프롬프트는 반드시 서로 다른 장소/피사체/앵글. 같은 장면 반복 금지.
- 같은 슬라이드 내에서도 앵글/스케일을 변경 (wide → close-up, 외부 → 내부)
- 이미지 사이즈에 맞는 composition 키워드 포함

Output ONLY a JSON array with exactly {prompt_count} items, no other text:
[{{"ko":"한국어 설명", "en":"English prompt", "motion":"camera movement", "media":"image"}}, ...]"""

    # 슬라이드→프롬프트 매핑 (slide 필드 추가용)
    slide_prompt_map = []  # [(slide_idx_0based, bg_count), ...]
    for i, s in enumerate(slides):
        if s.get("bg_type") == "closing":
            continue
        bg_n = _bg_count_for_slide(i)
        slide_prompt_map.append((i, bg_n))

    raw = _run_claude(prompt, timeout=120, use_web=False,
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
            for slide_idx, bg_count in slide_prompt_map:
                for _ in range(bg_count):
                    if prompt_idx < len(prompts):
                        p = prompts[prompt_idx]
                        if isinstance(p, dict) and "ko" in p and "en" in p:
                            result.append({
                                "ko": str(p["ko"]),
                                "en": str(p["en"]),
                                "motion": str(p.get("motion", "")),
                                "media": str(p.get("media", "image")),
                                "slide": slide_idx + 1,  # 1-based
                            })
                        else:
                            result.append({"ko": "", "en": str(p), "motion": "",
                                           "media": "image",
                                           "slide": slide_idx + 1})
                    prompt_idx += 1
            return result

    return []
