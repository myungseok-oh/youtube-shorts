"""에이전트 공통 유틸리티 — Claude/Gemini CLI 실행, JSON 파싱, 헬퍼 함수

모든 채널 에이전트가 공유하는 순수 유틸리티 함수와 기본 상수.
채널별 로직은 포함하지 않는다.
"""
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


# ── JSON 파싱 & 복구 ──────────────────────────────

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
        last_complete = max(
            raw.rfind('},'),
            raw.rfind('}'),
            raw.rfind('],'),
            raw.rfind(']'),
        )
        if last_complete > 0:
            truncated = raw[:last_complete + 1]
            truncated = re.sub(r',\s*$', '', truncated)
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
    try:
        wrapper = json.loads(raw)
        if isinstance(wrapper, dict) and "result" in wrapper:
            raw = wrapper["result"]
    except (json.JSONDecodeError, TypeError):
        pass

    m = re.search(r'```json\s*\n(.*?)\n\s*```', raw, re.DOTALL)
    if m:
        raw = m.group(1)

    m = re.search(r'\{.*\}', raw, re.DOTALL)
    if m:
        raw = m.group(0)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        repaired = _repair_json(raw)
        if repaired:
            try:
                data = json.loads(repaired)
                print(f"[agent] JSON 자동 복구 성공")
            except json.JSONDecodeError:
                raise RuntimeError(f"JSON 파싱 실패: {e}\n원본:\n{raw[:1000]}")
        else:
            raise RuntimeError(f"JSON 파싱 실패: {e}\n원본:\n{raw[:1000]}")

    if required_fields:
        missing = [f for f in required_fields if f not in data]
        if missing:
            raise RuntimeError(f"필수 필드 누락 {missing}: {list(data.keys())}")

    if not data.get("brand"):
        data["brand"] = brand

    return data


def _parse_topics(raw: str, fallback: str) -> list[str]:
    """Claude 출력에서 주제 리스트 추출"""
    try:
        wrapper = json.loads(raw)
        if isinstance(wrapper, dict) and "result" in wrapper:
            raw = wrapper["result"]
    except (json.JSONDecodeError, TypeError):
        pass

    m = re.search(r'```json\s*\n(.*?)\n\s*```', raw, re.DOTALL)
    if m:
        raw = m.group(1)

    m = re.search(r'\[.*?\]', raw, re.DOTALL)
    if m:
        try:
            topics = json.loads(m.group(0))
            if isinstance(topics, list) and len(topics) > 0:
                topics = [str(t).strip() for t in topics if str(t).strip()]
                requested = _extract_count(fallback)
                if requested and len(topics) > requested:
                    topics = topics[:requested]
                return topics
        except json.JSONDecodeError:
            pass

    return [fallback.strip()]


# ── 비주얼 플랜 동기화 & 보정 ──────────────────────────────

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
    """Gemini 응답 구조를 {synopsis, visual_plan, script} 형태로 보정."""
    if "script" in data and "visual_plan" in data:
        if not data["visual_plan"]:
            data["visual_plan"] = _build_visual_plan_from_slides(
                data["script"].get("slides", []))
        if "synopsis" not in data:
            data["synopsis"] = _build_synopsis_from_script(data["script"])
        return data

    if "sentences" in data and "slides" in data:
        script = {
            "news_date": data.pop("news_date", ""),
            "youtube_title": data.pop("youtube_title", ""),
            "sentences": data.pop("sentences", []),
            "slides": data.pop("slides", []),
            "hashtags": data.pop("hashtags", []),
        }
        vp = data.pop("visual_plan", [])
        syn = data.pop("synopsis", {})
        if not vp:
            vp = _build_visual_plan_from_slides(script["slides"])
        if not syn:
            syn = _build_synopsis_from_script(script)
        return {"synopsis": syn, "visual_plan": vp, "script": script,
                "style_guide": data.pop("style_guide", {})}

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


# ── 스키마 빌더 ──────────────────────────────

def _build_script_schema(channel_format: str = "single",
                         script_rules: str = "", roundup_rules: str = "",
                         has_outro: bool = False,
                         default_script_rules: str = "",
                         default_roundup_rules: str = "") -> str:
    """SCRIPT_JSON_SCHEMA 생성. 슬라이드/문장 수는 채널 지침(script_rules)에서 직접 지정."""
    if channel_format == "roundup":
        return _build_roundup_schema(roundup_rules, has_outro=has_outro,
                                     default_roundup_rules=default_roundup_rules)

    rules_text = script_rules.strip() if script_rules and script_rules.strip() else default_script_rules

    return f"""\
다음 JSON 형식으로만 출력해. 다른 텍스트 없이 JSON만.

{{
  "news_date": "2026-03-09",
  "youtube_title": "제목 (100자 이내)",
  "sentences": [{{"text": "문장 (15~25자)", "slide": 1}}, ...],
  "slides": [{{"category": "카테고리", "main": "핵심 <span class=\\"hl\\">강조</span>", "sub": "보조 설명", "bg_type": "photo"}}, ...],
  "hashtags": ["채널 기본 태그", "...", "내용 관련 태그", "..."]
}}

규칙:
{rules_text}

해시태그 규칙:
- 채널 지침의 `## 해시태그` 섹션에 명시된 기본 태그를 먼저 포함할 것
- 그 뒤에 주제 내용에 맞는 태그 5개를 추가
- 각 태그는 # 없이 단어만 (예: "건강정보", "다이어트")
- 전체 7~10개 이내
"""


def _build_roundup_schema(roundup_rules: str = "",
                          has_outro: bool = False,
                          default_roundup_rules: str = "") -> str:
    """라운드업(멀티뉴스) 형식 스키마."""
    rules_text = roundup_rules.strip() if roundup_rules and roundup_rules.strip() else default_roundup_rules

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
  ],
  "hashtags": ["채널 기본 태그", "...", "내용 관련 태그", "..."]
}}

규칙:
{rules_text}

해시태그 규칙:
- 채널 지침의 `## 해시태그` 섹션에 명시된 기본 태그를 먼저 포함할 것
- 그 뒤에 주제 내용에 맞는 태그 5개를 추가
- 각 태그는 # 없이 단어만
- 전체 7~10개 이내
"""


# ── 주제 처리 헬퍼 ──────────────────────────────

def _is_specific_topic(request: str) -> bool:
    """요청이 구체적 뉴스 헤드라인인지 판별."""
    general_patterns = [
        r'\d+\s*개', r'만들어', r'찾아', r'검색', r'알려',
        r'뉴스\s*줘', r'소식\s*줘', r'브리핑', r'최신',
    ]
    for pat in general_patterns:
        if re.search(pat, request):
            return False
    return len(request.strip()) >= 15


def _extract_count(request: str) -> int | None:
    """요청에서 개수 추출. '3개' → 3, 없으면 None"""
    m = re.search(r'(\d+)\s*개', request)
    return int(m.group(1)) if m else None


# ── 이미지 프롬프트 헬퍼 ──────────────────────────────

def _estimate_slide_durations(slides: list[dict], sentences: list[dict]) -> dict[int, float]:
    """슬라이드별 나레이션 예상 시간(초) 계산. 한국어 TTS 기준 초당 ~4.5음절."""
    durations: dict[int, float] = {}
    for sent in sentences:
        slide_idx = sent.get("slide", 1) - 1
        text = sent.get("text", "")
        dur = len(text) / 4.5
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


def _image_style_instruction(image_style: str) -> str:
    """이미지 스타일별 프롬프트 지시문."""
    if image_style == "photo":
        return (
            "★ ALL slides must use PHOTOREALISTIC style.\n"
            "- Use keywords: realistic, sharp focus, professional photography, 8k resolution, photojournalism\n"
            "- Depict real-world scenes: objects, equipment, devices, materials, interiors, exteriors\n"
            "- ★ VARIETY: Do NOT repeat the same subject category (e.g. building+building). Mix closeups, wide shots, macro, aerial\n"
            "- Do NOT use illustration, vector art, infographic, or cartoon styles\n"
            "- Even for data/comparison slides, depict a real-world object/scene that symbolizes the concept\n"
            "\n★★ OVERRIDE: 이 Image Style은 위 '프롬프트 지침'의 bg_type별 스타일 키워드보다 우선합니다.\n"
            "graph bg_type이더라도 반드시 photorealistic 키워드를 사용하세요.\n"
            "flat illustration, vector art, infographic 등 일러스트 키워드 사용 금지."
        )
    elif image_style == "infographic":
        return (
            "★ ALL slides must use INFOGRAPHIC/ILLUSTRATION style.\n"
            "- Use keywords: flat illustration, vector art, infographic, clean lines, soft pastels, diagram\n"
            "- Visualize data with charts, graphs, icons, comparison layouts\n"
            "- Do NOT use realistic photography style\n"
            "- Use split screens for comparisons, bar charts for statistics, icons for concepts\n"
            "\n★★ OVERRIDE: 이 Image Style은 위 '프롬프트 지침'의 bg_type별 스타일 키워드보다 우선합니다.\n"
            "photo/broll bg_type이더라도 반드시 infographic/illustration 키워드를 사용하세요.\n"
            "realistic, sharp focus, professional photography 등 실사 키워드 사용 금지."
        )
    elif image_style == "anime":
        return (
            "★ ALL slides must use ANIME/ILLUSTRATION style.\n"
            "- Use keywords: anime-style illustration, digital art, cel-shaded, vibrant colors, clean lines\n"
            "- People/characters: anime-style faces, expressive features, stylized proportions\n"
            "- Backgrounds: semi-realistic or painted style environments\n"
            "- Do NOT use realistic photography or photojournalism style\n"
            "- Reference styles: studio ghibli, modern anime, digital illustration\n"
            "- Keep scenes bright, warm, and visually appealing\n"
            "\n★★ OVERRIDE: 이 Image Style은 위 '프롬프트 지침'의 bg_type별 스타일 키워드보다 우선합니다.\n"
            "photo/broll bg_type이더라도 반드시 anime-style illustration 키워드를 사용하세요.\n"
            "realistic, sharp focus, professional photography, 8k resolution, photojournalism 등 실사 키워드 사용 금지."
        )
    return (
        "Use the style that best matches each slide's bg_type:\n"
        "- photo/broll/logo → photorealistic style (realistic, sharp focus, 8k, photojournalism)\n"
        "- graph → infographic/illustration style (flat illustration, vector art, clean lines, diagrams)"
    )


def _calc_zone_image_size(layout: str, zone_ratio: str = "3:4:3") -> tuple[int, int, str]:
    """zone 레이아웃의 이미지 영역 크기 및 비율 계산.

    Returns:
        (width, height, aspect_ratio_str)  예: (1080, 1536, "3:4")
    """
    parts = [float(x) for x in zone_ratio.split(":") if x]
    if len(parts) != 3:
        return 1080, 1080, "1:1"
    total = sum(parts) or 1

    if layout == "center":
        img_pct = parts[1] / total
    elif layout == "top":
        img_pct = (parts[0] + parts[1]) / total
    elif layout == "bottom":
        img_pct = (parts[1] + parts[2]) / total
    else:
        return 1080, 1920, "9:16"

    img_h = int(1920 * img_pct)
    if img_h >= 1600:
        ar = "9:16"
    elif img_h >= 1080:
        ar = "3:4"
    elif img_h >= 810:
        ar = "1:1"
    else:
        ar = "16:9"

    return 1080, img_h, ar


def _image_size_instruction(layout: str, bg_display_mode: str = "zone",
                            zone_ratio: str = "3:4:3") -> str:
    """레이아웃별 이미지 사이즈/비율 프롬프트 지시문."""
    if bg_display_mode != "zone" or layout == "full":
        return (
            "- Target: 1080x1920px (9:16 vertical/portrait orientation for YouTube Shorts)\n"
            "- Compose for VERTICAL framing — subject should fill the tall frame, avoid wide landscape compositions.\n"
            "- Include keywords: 'vertical composition, portrait orientation, 9:16 aspect ratio' in each prompt."
        )

    w, h, ar = _calc_zone_image_size(layout, zone_ratio)

    if ar == "9:16":
        framing = "VERTICAL framing — subject should fill the tall frame"
        keywords = "vertical composition, portrait orientation, 9:16 aspect ratio"
    elif ar == "3:4":
        framing = "PORTRAIT framing — slightly taller than wide, subject centered"
        keywords = f"portrait composition, centered subject, 3:4 aspect ratio"
    elif ar == "1:1":
        framing = "SQUARE framing — subject centered, avoid tall vertical compositions"
        keywords = "square composition, centered subject, 1:1 aspect ratio"
    else:
        framing = "LANDSCAPE framing — wide horizontal composition"
        keywords = "landscape composition, wide angle, 16:9 aspect ratio"

    zone_label = {"center": "CENTER", "top": "TOP+MID", "bottom": "MID+BOTTOM"}.get(layout, "")
    return (
        f"- Target: {w}x{h}px ({ar} ratio)\n"
        f"- The image will be displayed in the {zone_label} zone of a vertical 1080x1920 slide.\n"
        f"- Compose for {framing}.\n"
        f"- Include keywords: '{keywords}' in each prompt."
    )
