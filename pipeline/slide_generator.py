"""Node.js Puppeteer 슬라이드 생성기 래퍼"""
from __future__ import annotations
import json
import os
import re
import subprocess
import tempfile
from pipeline import config


def _compress_to_jpeg(png_path: str, max_bytes: int = 2 * 1024 * 1024):
    """PNG를 JPEG로 변환하여 max_bytes 이하로 압축. 원본 PNG를 교체."""
    if not os.path.exists(png_path):
        return
    if os.path.getsize(png_path) <= max_bytes:
        return  # 이미 작으면 그대로

    from PIL import Image
    img = Image.open(png_path).convert("RGB")
    jpg_path = png_path  # 같은 경로에 덮어쓰기 (확장자 유지)

    quality = 92
    while quality >= 40:
        img.save(jpg_path, "JPEG", quality=quality, optimize=True)
        if os.path.getsize(jpg_path) <= max_bytes:
            break
        quality -= 8
    print(f"[thumbnail] 압축: {os.path.getsize(jpg_path) // 1024}KB (q={quality})")


def generate_slides(slides_data: list[dict], output_dir: str,
                    date: str = "", brand: str = "이슈60초",
                    backgrounds: list[dict] | None = None,
                    layout: str = "full",
                    bg_display_mode: str = "zone",
                    skip_overlay: bool = False,
                    zone_ratio: str = "",
                    text_bg: int = 4,
                    slide_overrides: dict | None = None,
                    sub_text_size: int = 0,
                    accent_color: str = "",
                    hl_color: str = "",
                    bg_gradient: str = "",
                    main_text_size: int = 0,
                    badge_size: int = 0,
                    show_badge: bool = True,
                    channel_format: str = "single",
                    main_zone: str = "top",
                    sub_zone: str = "bottom") -> list[str]:
    """슬라이드 데이터를 받아 PNG 이미지 생성.

    Args:
        slides_data: [{"category": "속보", "main": "...", "sub": "...", "accent": "#ff4444"}, ...]
        output_dir: PNG 저장 디렉토리
        date: 날짜 문자열
        brand: 브랜드 이름
        backgrounds: [{"path": "bg_1.jpg", "source": "MBC"}, ...] (빈 path면 기본 그라디언트)

    Returns:
        생성된 PNG 파일 경로 리스트
    """
    os.makedirs(output_dir, exist_ok=True)

    # 배경 경로를 절대경로로 변환 (Node.js에서 상대경로/백슬래시 문제 방지)
    norm_bgs = []
    for bg in (backgrounds or []):
        if bg.get("path"):
            norm_bgs.append({**bg, "path": os.path.abspath(bg["path"]).replace("\\", "/")})
        else:
            norm_bgs.append(bg)

    input_data = {
        "slides": slides_data,
        "date": date,
        "brand": brand,
        "backgrounds": norm_bgs,
        "layout": layout,
        "bgDisplayMode": bg_display_mode,
        "skipOverlay": skip_overlay,
        "zoneRatio": zone_ratio,
        "textBg": text_bg,
        "subTextSize": sub_text_size,
        "accentColor": accent_color,
        "hlColor": hl_color,
        "bgGradient": bg_gradient,
        "mainTextSize": main_text_size,
        "badgeSize": badge_size,
        "showBadge": show_badge if show_badge is not True else (channel_format == "roundup"),
        "showSlideNum": channel_format == "roundup",
        "slideOverrides": slide_overrides or {},
        "mainZone": main_zone,
        "subZone": sub_zone,
    }

    # 임시 JSON 파일에 입력 데이터 저장
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json",
                                     delete=False, encoding="utf-8") as f:
        json.dump(input_data, f, ensure_ascii=False)
        tmp_path = f.name

    try:
        script_path = os.path.join(os.path.dirname(__file__), "generate_slides.js")
        result = subprocess.run(
            ["node", script_path, tmp_path, output_dir],
            capture_output=True, text=True, encoding="utf-8",
            cwd=config.root_dir()
        )

        if result.returncode != 0:
            raise RuntimeError(f"Slide generation failed: {result.stderr}")

        # __RESULT__ 마커로 결과 파싱
        for line in result.stdout.split("\n"):
            if line.startswith("__RESULT__"):
                return json.loads(line[len("__RESULT__"):])

        # 폴백: 디렉토리에서 파일 목록 반환
        files = sorted(
            [os.path.join(output_dir, f) for f in os.listdir(output_dir)
             if f.endswith(".png")],
        )
        return files
    finally:
        os.unlink(tmp_path)


def generate_thumbnail(title: str, output_path: str,
                       category: str = "", accent: str = "#ff6b35",
                       brand: str = "이슈60초",
                       background: str = "") -> str:
    """YouTube 썸네일 이미지(1280x720) 생성.

    Args:
        title: 영상 제목
        output_path: 출력 PNG 경로
        category: 카테고리 뱃지 텍스트
        accent: 강조 색상
        brand: 브랜드 이름
        background: 배경 이미지 경로 (없으면 기본 그라디언트)

    Returns:
        생성된 PNG 파일 경로
    """
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    bg_abs = ""
    if background and os.path.isfile(background):
        bg_abs = os.path.abspath(background).replace("\\", "/")

    input_data = {
        "title": title,
        "category": category,
        "accent": accent,
        "brand": brand,
        "background": bg_abs,
    }

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json",
                                     delete=False, encoding="utf-8") as f:
        json.dump(input_data, f, ensure_ascii=False)
        tmp_path = f.name

    try:
        script_path = os.path.join(os.path.dirname(__file__), "generate_thumbnail.js")
        result = subprocess.run(
            ["node", script_path, tmp_path, output_path],
            capture_output=True, text=True, encoding="utf-8",
            cwd=config.root_dir()
        )

        if result.returncode != 0:
            raise RuntimeError(f"Thumbnail generation failed: {result.stderr}")

        # PNG → JPEG 변환 (YouTube 2MB 제한 대응)
        _compress_to_jpeg(output_path, max_bytes=2 * 1024 * 1024)

        return output_path
    finally:
        os.unlink(tmp_path)


def generate_chart(slide_data: dict, output_path: str,
                   width: int = 768, height: int = 768) -> str:
    """graph 타입 슬라이드용 HTML/CSS 차트 이미지 생성.

    SD 대신 Puppeteer로 깔끔한 인포그래픽을 직접 렌더링.

    Args:
        slide_data: {"main": "...", "sub": "...", "category": "...", "accent": "#ff4444"}
        output_path: 출력 PNG 경로
        width: 이미지 너비
        height: 이미지 높이

    Returns:
        생성된 PNG 파일 경로
    """
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    input_data = {
        "main": slide_data.get("main", ""),
        "sub": slide_data.get("sub", ""),
        "category": slide_data.get("category", ""),
        "accent": slide_data.get("accent", "#3b82f6"),
        "width": width,
        "height": height,
    }

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json",
                                     delete=False, encoding="utf-8") as f:
        json.dump(input_data, f, ensure_ascii=False)
        tmp_path = f.name

    try:
        script_path = os.path.join(os.path.dirname(__file__), "generate_chart.js")
        result = subprocess.run(
            ["node", script_path, tmp_path, output_path],
            capture_output=True, text=True, encoding="utf-8",
            cwd=config.root_dir()
        )

        if result.returncode != 0:
            raise RuntimeError(f"Chart generation failed: {result.stderr}")

        return output_path
    finally:
        os.unlink(tmp_path)


def generate_infographic(slide_data: dict, script_context: str,
                         output_path: str, width: int = 1080,
                         height: int = 960) -> str:
    """Claude가 생성한 맞춤 HTML 인포그래픽을 Puppeteer로 렌더링.

    Args:
        slide_data: {"main": "...", "sub": "...", "category": "...", "accent": "#ff4444"}
        script_context: 대본 텍스트 (인포그래픽 내용 참고용)
        output_path: 출력 PNG 경로
        width: 이미지 너비
        height: 이미지 높이

    Returns:
        생성된 PNG 파일 경로
    """
    from pipeline.agent import _run_claude

    main_text = slide_data.get("main", "").replace('<span class="hl">', "").replace("</span>", "")
    sub_text = slide_data.get("sub", "")
    category = slide_data.get("category", "")
    accent = slide_data.get("accent", "#3b82f6")

    prompt = f"""너는 뉴스 인포그래픽 전문 웹 디자이너야.
아래 뉴스 슬라이드 내용을 시각화하는 HTML/CSS/SVG 코드를 생성해.

## 슬라이드 정보
- 카테고리: {category}
- 메인 텍스트: {main_text}
- 서브 텍스트: {sub_text}
- 강조 색상: {accent}

## 대본 컨텍스트
{script_context[:500]}

## 요구사항
1. 크기: 정확히 {width}x{height}px
2. **한국어 텍스트 포함** — 핵심 숫자와 키워드를 크게 표시
3. 완전한 HTML 문서 (<!DOCTYPE html> ~ </html>)
4. 외부 리소스 없이 인라인 CSS/SVG만 사용 (이미지, 외부 폰트 금지)
5. font-family: 'Segoe UI', 'Malgun Gothic', sans-serif
6. 배경색 포함 (밝은 그라디언트 또는 단색)
7. 뉴스 인포그래픽 스타일:
   - VS 비교: 좌우 분할, 각 측면에 아이콘/숫자/라벨
   - 수치 강조: 큰 숫자 + 보조 설명
   - 트렌드: 화살표, 바 차트, 방향 표시
   - SVG 아이콘 활용 (건물, 화살표, 코인, 차트 등)
8. 텍스트 없는 빈 공간 최소화, 정보 밀도 높게
9. 색상: 강조색({accent}) 기반, 깔끔하고 전문적

## 출력
HTML 코드만 출력해. 설명이나 마크다운 코드 블록 없이 <!DOCTYPE html>로 시작해."""

    raw = _run_claude(prompt, timeout=90, use_web=False, model="claude-haiku-4-5-20251001")

    # HTML 추출
    html = _extract_html(raw)
    if not html:
        print("[infographic] Claude HTML 생성 실패 — 기본 차트로 폴백")
        return generate_chart(slide_data, output_path, width, height)

    # Puppeteer로 렌더링
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    input_data = {
        "html": html,
        "width": width,
        "height": height,
    }

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json",
                                     delete=False, encoding="utf-8") as f:
        json.dump(input_data, f, ensure_ascii=False)
        tmp_path = f.name

    try:
        script_path = os.path.join(os.path.dirname(__file__), "generate_chart.js")
        result = subprocess.run(
            ["node", script_path, tmp_path, output_path],
            capture_output=True, text=True, encoding="utf-8",
            cwd=config.root_dir()
        )

        if result.returncode != 0:
            raise RuntimeError(f"Infographic render failed: {result.stderr}")

        print(f"[infographic] 인포그래픽 생성 완료: {os.path.basename(output_path)}")
        return output_path
    finally:
        os.unlink(tmp_path)


def _extract_html(raw: str) -> str:
    """Claude 출력에서 HTML 코드 추출."""
    # JSON wrapper 처리
    try:
        wrapper = json.loads(raw)
        if isinstance(wrapper, dict) and "result" in wrapper:
            raw = wrapper["result"]
    except (json.JSONDecodeError, TypeError):
        pass

    # 코드 블록 내 HTML
    m = re.search(r'```html?\s*\n(.*?)\n\s*```', raw, re.DOTALL)
    if m:
        return m.group(1).strip()

    # <!DOCTYPE html> 부터 </html> 까지
    m = re.search(r'(<!DOCTYPE html>.*?</html>)', raw, re.DOTALL | re.IGNORECASE)
    if m:
        return m.group(1).strip()

    # <html> 부터
    m = re.search(r'(<html.*?</html>)', raw, re.DOTALL | re.IGNORECASE)
    if m:
        return m.group(1).strip()

    return ""
