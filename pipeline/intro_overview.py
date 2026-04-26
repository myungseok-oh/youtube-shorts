"""인트로 오버뷰 — 헤드라인 누적 등장 인트로 영상 생성기.

- script_json에서 콘텐츠 슬라이드 main 텍스트를 추출 → 짧은 헤드라인 N개로 압축
- generate_slides.js의 intro-overview 모드로 단계별 PNG N+1장 렌더 (헤드라인 0개~전체)
- ffmpeg concat으로 누적 등장 영상 생성 + 인트로 나레이션 합성
"""
from __future__ import annotations
import json
import os
import re
import shutil
import subprocess
import tempfile

from pipeline import config


_HEADLINE_MAX_CHARS = 18  # 카드 한 줄에 들어갈 글자 수
_PER_STAGE_SEC = 0.5      # 헤드라인 한 개 등장 간격
_FINAL_HOLD_MIN_SEC = 1.5  # 마지막 정지 최소 시간

# 키워드 추출 시 무시할 조사/숫자 시작 토큰
_NARR_STOP_TOKENS = {"오늘", "어제", "내일", "현재", "이번", "지난", "올해", "작년"}


def _strip_html(text: str) -> str:
    """<span class="hl">...</span> 등 HTML 태그 제거."""
    text = re.sub(r"<[^>]+>", "", text or "")
    return text.strip()


def _shorten_headline(text: str, max_chars: int = _HEADLINE_MAX_CHARS) -> str:
    """긴 main 텍스트를 카드용 헤드라인으로 압축.

    1) HTML 태그 제거
    2) max_chars 이하면 그대로 반환
    3) 초과 시 공백/구두점으로 자르기 → 마지막 토큰부터 제거
    """
    text = _strip_html(text)
    if len(text) <= max_chars:
        return text
    # 공백 기준 토큰 분리 → 마지막부터 제거
    tokens = re.split(r"(\s+)", text)
    while len("".join(tokens)) > max_chars and len(tokens) > 1:
        tokens.pop()
    short = "".join(tokens).rstrip(" ,.·…")
    if len(short) <= max_chars and short:
        return short
    # 그래도 길면 강제 자르기
    return text[: max_chars - 1].rstrip() + "…"


def build_fallback_narration(headlines: list[str]) -> str:
    """헤드라인 목록으로 인트로 멘트 자동 합성 (intro_narration 누락 시 폴백).

    채널 config의 intro_narration과 script_json의 intro_narration이 모두
    비어있을 때 호출. 2문장으로 분리하고 쉼표로 키워드 사이를 띄워서
    TTS가 자연스러운 호흡으로 읽도록 한다.
    """
    headlines = [h for h in (headlines or []) if h]
    if not headlines:
        return ""
    n = len(headlines)
    head = headlines[0]
    rest = headlines[1:4]
    if rest:
        return f"{head} 등 오늘의 핵심 뉴스 {n}건입니다. {', '.join(rest)}까지 차례로 정리했습니다."
    return f"{head} 핵심 정리했습니다."


def extract_headlines(script_json: dict, max_count: int | None = None) -> list[str]:
    """script_json에서 헤드라인 추출.

    - bg_type이 closing/overview/empty인 슬라이드 제외
    - main 텍스트에서 HTML 제거 + 카드 길이 압축
    - 빈 main 스킵
    - max_count=None 이면 콘텐츠 슬라이드 전체 사용 (closing 제외)
    """
    slides = (script_json or {}).get("slides", []) or []
    out: list[str] = []
    for i, s in enumerate(slides):
        bg_type = (s.get("bg_type") or "").strip().lower()
        if bg_type in ("closing", "overview", ""):
            if bg_type in ("closing", "overview"):
                continue
            if i == len(slides) - 1 and not bg_type:
                continue
        main = (s.get("main") or "").strip()
        if not main:
            continue
        out.append(_shorten_headline(main))
        if max_count is not None and len(out) >= max_count:
            break
    return out


def render_intro_with_overview(
    intro_bg: str,
    headlines: list[str],
    audio_path: str | None,
    output_mp4: str,
    vcfg: dict,
    *,
    audio_delay: float = 0.0,
    date_label: str = "",
    title: str = "오늘의 헤드라인",
    accent_color: str = "#ff6b35",
    hl_color: str = "#ffd700",
) -> float:
    """인트로 오버뷰 영상 생성.

    Returns:
        총 영상 길이(초). 실패 시 0 반환 (호출처에서 폴백 처리).
    """
    if not intro_bg or not os.path.exists(intro_bg):
        return 0.0
    headlines = [h for h in (headlines or []) if h]
    if len(headlines) < 2:
        return 0.0

    tmp_dir = tempfile.mkdtemp(prefix="intro_ov_")
    try:
        # 1) generate_slides.js intro-overview 모드 호출 → stage_0~N PNG 생성
        input_data = {
            "mode": "intro-overview",
            "introBg": os.path.abspath(intro_bg).replace("\\", "/"),
            "headlines": headlines,
            "dateLabel": date_label,
            "title": title,
            "accentColor": accent_color,
            "hlColor": hl_color,
        }
        input_json = os.path.join(tmp_dir, "input.json")
        with open(input_json, "w", encoding="utf-8") as f:
            json.dump(input_data, f, ensure_ascii=False)

        script_path = os.path.join(os.path.dirname(__file__), "generate_slides.js")
        result = subprocess.run(
            ["node", script_path, input_json, tmp_dir],
            capture_output=True, text=True, encoding="utf-8",
            cwd=config.root_dir(),
        )
        if result.returncode != 0:
            print(f"[intro_overview] Puppeteer 실패: {result.stderr[:400]}")
            return 0.0

        n = len(headlines)
        stage_paths = []
        for i in range(n + 1):
            p = os.path.join(tmp_dir, f"stage_{i}.png")
            if not os.path.exists(p):
                print(f"[intro_overview] stage_{i}.png 미생성 — 폴백")
                return 0.0
            stage_paths.append(p)

        # 2) 오디오 길이 → 마지막 정지 시간 동적 산출
        audio_dur = 0.0
        if audio_path and os.path.exists(audio_path):
            try:
                from pipeline.tts_generator import get_audio_duration
                audio_dur = get_audio_duration(audio_path)
            except Exception:
                audio_dur = 0.0

        n_stages = n + 1  # stage_0(빈 카드) ~ stage_N(전체)
        animation_dur = (n_stages - 1) * _PER_STAGE_SEC
        target_total = max(animation_dur + _FINAL_HOLD_MIN_SEC,
                            audio_dur + audio_delay)
        final_hold = target_total - animation_dur
        if final_hold < _FINAL_HOLD_MIN_SEC:
            final_hold = _FINAL_HOLD_MIN_SEC
        total_dur = animation_dur + final_hold

        # 3) ffmpeg concat 리스트 작성 (image2 demuxer)
        list_path = os.path.join(tmp_dir, "concat.txt")
        with open(list_path, "w", encoding="utf-8") as f:
            for i, sp in enumerate(stage_paths):
                abs_p = os.path.abspath(sp).replace("\\", "/")
                dur = _PER_STAGE_SEC if i < len(stage_paths) - 1 else final_hold
                f.write(f"file '{abs_p}'\n")
                f.write(f"duration {dur:.3f}\n")
            # concat demuxer 요구사항: 마지막 file 한 번 더
            last_p = os.path.abspath(stage_paths[-1]).replace("\\", "/")
            f.write(f"file '{last_p}'\n")

        # 4) ffmpeg 영상 + 오디오 합성
        os.makedirs(os.path.dirname(output_mp4), exist_ok=True)
        if audio_path and os.path.exists(audio_path) and audio_dur > 0:
            delay_ms = int(audio_delay * 1000)
            if delay_ms > 0:
                audio_filter = (
                    f"[1:a]adelay={delay_ms}|{delay_ms},"
                    f"aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,"
                    f"apad=whole_dur={total_dur:.3f}[aout]"
                )
            else:
                audio_filter = (
                    f"[1:a]aformat=sample_fmts=fltp:sample_rates=44100:"
                    f"channel_layouts=stereo,apad=whole_dur={total_dur:.3f}[aout]"
                )
            cmd = [
                config.ffmpeg(), "-y",
                "-f", "concat", "-safe", "0", "-i", list_path,
                "-i", audio_path,
                "-filter_complex",
                f"[0:v]scale=1080:1920,format=yuv420p,fps=24[vout];{audio_filter}",
                "-map", "[vout]", "-map", "[aout]",
                "-c:v", "libx264", "-preset", "fast",
                "-c:a", "aac", "-b:a", vcfg["audio_bitrate"],
                "-pix_fmt", "yuv420p",
                "-t", f"{total_dur:.3f}",
                "-movflags", "+faststart",
                output_mp4,
            ]
        else:
            cmd = [
                config.ffmpeg(), "-y",
                "-f", "concat", "-safe", "0", "-i", list_path,
                "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                "-filter_complex",
                "[0:v]scale=1080:1920,format=yuv420p,fps=24[vout]",
                "-map", "[vout]", "-map", "1:a",
                "-c:v", "libx264", "-preset", "fast",
                "-c:a", "aac", "-b:a", vcfg["audio_bitrate"],
                "-pix_fmt", "yuv420p",
                "-shortest",
                "-t", f"{total_dur:.3f}",
                "-movflags", "+faststart",
                output_mp4,
            ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"[intro_overview] ffmpeg 실패: {result.stderr[:400]}")
            return 0.0
        if not os.path.exists(output_mp4):
            return 0.0
        return total_dur
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
