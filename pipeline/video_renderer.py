"""ffmpeg 기반 영상 합성기"""
from __future__ import annotations
import glob
import json
import os
import random
import re
import subprocess
from pipeline import config


# ── 지원하는 xfade 전환 효과 목록 ──
XFADE_TRANSITIONS = [
    # ── 기본 ──
    {"id": "fade", "label": "페이드", "desc": "부드러운 밝기 전환", "cat": "기본"},
    {"id": "dissolve", "label": "디졸브", "desc": "녹아드는 전환", "cat": "기본"},
    {"id": "fadeblack", "label": "페이드 블랙", "desc": "검은색으로 전환", "cat": "기본"},
    {"id": "fadewhite", "label": "페이드 화이트", "desc": "흰색으로 전환", "cat": "기본"},
    {"id": "fadegrays", "label": "페이드 그레이", "desc": "회색으로 전환", "cat": "기본"},
    {"id": "fadefast", "label": "빠른 페이드", "desc": "빠르게 페이드", "cat": "기본"},
    {"id": "fadeslow", "label": "느린 페이드", "desc": "느리게 페이드", "cat": "기본"},
    # ── 와이프 ──
    {"id": "wipeleft", "label": "왼쪽 와이프", "desc": "왼쪽으로 밀기", "cat": "와이프"},
    {"id": "wiperight", "label": "오른쪽 와이프", "desc": "오른쪽으로 밀기", "cat": "와이프"},
    {"id": "wipeup", "label": "위로 와이프", "desc": "위로 밀기", "cat": "와이프"},
    {"id": "wipedown", "label": "아래로 와이프", "desc": "아래로 밀기", "cat": "와이프"},
    {"id": "wipetl", "label": "와이프 좌상", "desc": "좌상단에서 시작", "cat": "와이프"},
    {"id": "wipetr", "label": "와이프 우상", "desc": "우상단에서 시작", "cat": "와이프"},
    {"id": "wipebl", "label": "와이프 좌하", "desc": "좌하단에서 시작", "cat": "와이프"},
    {"id": "wipebr", "label": "와이프 우하", "desc": "우하단에서 시작", "cat": "와이프"},
    # ── 슬라이드 ──
    {"id": "slideup", "label": "위로 슬라이드", "desc": "위로 밀어올리기", "cat": "슬라이드"},
    {"id": "slidedown", "label": "아래로 슬라이드", "desc": "아래로 내리기", "cat": "슬라이드"},
    {"id": "slideleft", "label": "왼쪽 슬라이드", "desc": "왼쪽으로 밀기 (겹침)", "cat": "슬라이드"},
    {"id": "slideright", "label": "오른쪽 슬라이드", "desc": "오른쪽으로 밀기 (겹침)", "cat": "슬라이드"},
    # ── 부드러운 이동 ──
    {"id": "smoothleft", "label": "부드러운 좌측", "desc": "부드럽게 좌측 이동", "cat": "부드러운 이동"},
    {"id": "smoothright", "label": "부드러운 우측", "desc": "부드럽게 우측 이동", "cat": "부드러운 이동"},
    {"id": "smoothup", "label": "부드러운 상단", "desc": "부드럽게 위로 이동", "cat": "부드러운 이동"},
    {"id": "smoothdown", "label": "부드러운 하단", "desc": "부드럽게 아래로 이동", "cat": "부드러운 이동"},
    # ── 도형 ──
    {"id": "circlecrop", "label": "원형 확대", "desc": "원형으로 확대", "cat": "도형"},
    {"id": "circleclose", "label": "원형 축소", "desc": "원형으로 축소", "cat": "도형"},
    {"id": "circleopen", "label": "원형 열기", "desc": "원형으로 열림", "cat": "도형"},
    {"id": "radial", "label": "시계방향", "desc": "시계 방향 회전", "cat": "도형"},
    {"id": "rectcrop", "label": "사각형 확대", "desc": "사각형으로 확대", "cat": "도형"},
    {"id": "horzclose", "label": "수평 닫기", "desc": "좌우에서 닫힘", "cat": "도형"},
    {"id": "horzopen", "label": "수평 열기", "desc": "중앙에서 좌우로 열림", "cat": "도형"},
    {"id": "vertclose", "label": "수직 닫기", "desc": "상하에서 닫힘", "cat": "도형"},
    {"id": "vertopen", "label": "수직 열기", "desc": "중앙에서 상하로 열림", "cat": "도형"},
    # ── 커버/리빌 ──
    {"id": "coverleft", "label": "커버 좌측", "desc": "좌측으로 덮기", "cat": "커버/리빌"},
    {"id": "coverright", "label": "커버 우측", "desc": "우측으로 덮기", "cat": "커버/리빌"},
    {"id": "coverup", "label": "커버 상단", "desc": "위로 덮기", "cat": "커버/리빌"},
    {"id": "coverdown", "label": "커버 하단", "desc": "아래로 덮기", "cat": "커버/리빌"},
    {"id": "revealleft", "label": "리빌 좌측", "desc": "좌측으로 벗기기", "cat": "커버/리빌"},
    {"id": "revealright", "label": "리빌 우측", "desc": "우측으로 벗기기", "cat": "커버/리빌"},
    {"id": "revealup", "label": "리빌 상단", "desc": "위로 벗기기", "cat": "커버/리빌"},
    {"id": "revealdown", "label": "리빌 하단", "desc": "아래로 벗기기", "cat": "커버/리빌"},
    # ── 특수 ──
    {"id": "diagtl", "label": "대각선 좌상", "desc": "좌상단 대각선", "cat": "특수"},
    {"id": "diagtr", "label": "대각선 우상", "desc": "우상단 대각선", "cat": "특수"},
    {"id": "diagbl", "label": "대각선 좌하", "desc": "좌하단 대각선", "cat": "특수"},
    {"id": "diagbr", "label": "대각선 우하", "desc": "우하단 대각선", "cat": "특수"},
    {"id": "hlslice", "label": "수평 슬라이스", "desc": "수평 줄무늬 전환", "cat": "특수"},
    {"id": "hrslice", "label": "수평 슬라이스(역)", "desc": "수평 줄무늬 역전환", "cat": "특수"},
    {"id": "vuslice", "label": "수직 슬라이스", "desc": "수직 줄무늬 전환", "cat": "특수"},
    {"id": "vdslice", "label": "수직 슬라이스(역)", "desc": "수직 줄무늬 역전환", "cat": "특수"},
    {"id": "squeezeh", "label": "수평 압축", "desc": "수평으로 눌림", "cat": "특수"},
    {"id": "squeezev", "label": "수직 압축", "desc": "수직으로 눌림", "cat": "특수"},
    {"id": "pixelize", "label": "픽셀화", "desc": "픽셀로 변환", "cat": "특수"},
    {"id": "zoomin", "label": "줌 인", "desc": "확대하며 전환", "cat": "특수"},
    {"id": "distance", "label": "디스턴스", "desc": "색상 거리 기반 전환", "cat": "특수"},
]

XFADE_IDS = [t["id"] for t in XFADE_TRANSITIONS]


def generate_transition_preview(transition: str, output_dir: str,
                                duration: float = 0.5,
                                img_from: str = "", img_to: str = "") -> str:
    """전환 효과 샘플 영상 생성.

    img_from/img_to가 있으면 실제 이미지로, 없으면 컬러 블록으로 생성.
    캐시: output_dir/{hash}.mp4
    """
    import hashlib
    if transition not in XFADE_IDS:
        transition = "fade"
    os.makedirs(output_dir, exist_ok=True)

    # 캐시 키: 이미지 경로 포함
    cache_key = f"{transition}_{duration:.1f}_{img_from}_{img_to}"
    cache_hash = hashlib.md5(cache_key.encode()).hexdigest()[:12]
    out_path = os.path.join(output_dir, f"tr_{cache_hash}.mp4")
    if os.path.exists(out_path):
        return out_path

    seg_dur = 1.5
    xd = min(duration, seg_dur * 0.8)
    use_images = img_from and img_to and os.path.exists(img_from) and os.path.exists(img_to)

    if use_images:
        # 실제 이미지 → 360x640 리사이즈 → xfade
        filter_complex = (
            f"[0:v]scale=360:640:force_original_aspect_ratio=decrease,"
            f"pad=360:640:(ow-iw)/2:(oh-ih)/2,setsar=1,loop=loop={int(seg_dur*24)}:size=1,"
            f"fps=24,format=yuv420p,trim=duration={seg_dur}[v0];"
            f"[1:v]scale=360:640:force_original_aspect_ratio=decrease,"
            f"pad=360:640:(ow-iw)/2:(oh-ih)/2,setsar=1,loop=loop={int(seg_dur*24)}:size=1,"
            f"fps=24,format=yuv420p,trim=duration={seg_dur}[v1];"
            f"[v0][v1]xfade=transition={transition}:duration={xd:.3f}"
            f":offset={seg_dur - xd:.3f},format=yuv420p[vout]"
        )
        cmd = [
            config.ffmpeg(), "-y",
            "-i", img_from, "-i", img_to,
            "-filter_complex", filter_complex,
            "-map", "[vout]",
            "-c:v", "libx264", "-preset", "ultrafast",
            "-an", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            out_path
        ]
    else:
        # 컬러 블록 폴백
        filter_complex = (
            f"color=c=#1a2238:s=360x640:d={seg_dur}:r=24,format=yuv420p[v0];"
            f"color=c=#ff6b35:s=360x640:d={seg_dur}:r=24,format=yuv420p[v1];"
            f"[v0][v1]xfade=transition={transition}:duration={xd:.3f}"
            f":offset={seg_dur - xd:.3f},format=yuv420p[vout]"
        )
        cmd = [
            config.ffmpeg(), "-y",
            "-filter_complex", filter_complex,
            "-map", "[vout]",
            "-c:v", "libx264", "-preset", "ultrafast",
            "-an", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            out_path
        ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)

    if result.returncode != 0:
        raise RuntimeError(f"transition preview failed: {result.stderr[:300]}")

    return out_path


def generate_motion_preview(motion: str, output_dir: str,
                             bg_path: str = "", duration: float = 3.0) -> str:
    """모션 효과 미리보기 영상 생성 (3초).

    Args:
        motion: 모션 프리셋 ID (zoom_in, pan_right, none, random 등)
        output_dir: 출력 디렉토리
        bg_path: 배경 이미지 경로 (없으면 기본 그라디언트)
        duration: 미리보기 길이 (초)

    Returns:
        생성된 MP4 파일 경로
    """
    import hashlib
    os.makedirs(output_dir, exist_ok=True)

    _hash = hashlib.md5(f"{motion}_{duration}_{bg_path}".encode()).hexdigest()[:12]
    out_path = os.path.join(output_dir, f"mo_{_hash}.mp4")
    if os.path.exists(out_path):
        return out_path

    total_frames = int(duration * 24) + 5

    # 배경이 없으면 그라디언트 생성
    is_image = False
    if not bg_path or not os.path.exists(bg_path):
        bg_input = ["-f", "lavfi", "-i",
                    f"color=c=#1a2238:s=1080x1920:d={duration}:r=24"]
    else:
        is_image = True
        bg_input = ["-i", bg_path]  # 단일 이미지: -loop 1 없이 zoompan 직접 적용

    preset = _select_motion(motion)
    if preset is None:
        # 정적: 단순 스케일
        if is_image:
            bg_input = ["-loop", "1", "-i", bg_path]
        filter_v = (
            "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,"
            "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,fps=24[vout]"
        )
    elif isinstance(preset, str) and preset in _FILTER_PRESETS:
        # 필터 기반 효과 미리보기
        if is_image:
            bg_input = ["-loop", "1", "-i", bg_path]
        fps_out = "fps=24,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black"
        filter_v = _build_filter_expr(
            preset, total_frames, duration,
            1080, 1920, "", has_overlay=False
        ).replace("[out]", "[vout]")
    else:
        # zoompan 미리보기 전용 강화 프리셋 (3초 안에 효과 명확히 인지)
        _PREVIEW_PRESETS = {
            "zoom_in":  ("min(2.0,1+0.014*on)",  "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
            "zoom_out": ("if(eq(on,1),2.0,max(1,zoom-0.014))", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
            "pan_right": ("min(1.5,1+0.007*on)", "iw/2-(iw/zoom/2)+on*3", "ih/2-(ih/zoom/2)"),
            "pan_left":  ("min(1.5,1+0.007*on)", "iw/2-(iw/zoom/2)-on*3", "ih/2-(ih/zoom/2)"),
        }
        motion_key = motion.lower().strip()
        if motion_key in _PREVIEW_PRESETS:
            zoom_expr, x_expr, y_expr = _PREVIEW_PRESETS[motion_key]
        else:
            zoom_expr, x_expr, y_expr = preset
        filter_v = (
            f"[0:v]zoompan=z='{zoom_expr}':x='{x_expr}':y='{y_expr}'"
            f":d={total_frames}:s=1080x1920:fps=24[vout]"
        )

    result = subprocess.run([
        config.ffmpeg(), "-y",
        *bg_input,
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
        "-filter_complex", filter_v,
        "-map", "[vout]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "fast",
        "-c:a", "aac", "-b:a", "64k",
        "-pix_fmt", "yuv420p",
        "-t", str(duration),
        "-shortest",
        out_path
    ], capture_output=True, text=True)

    if result.returncode != 0:
        print(f"[video_renderer] motion preview error ({motion}): {result.stderr[:300]}")
        raise RuntimeError("Motion preview generation failed")

    return out_path


def generate_full_preview(job_id: str, output_dir: str,
                          slide_motions: list[dict],
                          slide_transitions: list[dict],
                          bg_dir: str, duration_per_slide: float = 2.0) -> str:
    """전체 미리보기 영상 생성 — 모든 슬라이드를 모션+전환으로 연결한 단일 MP4.

    Args:
        slide_motions: [{"slide":1, "motion":"zoom_in"}, ...]
        slide_transitions: [{"slide":1, "effect":"fade", "duration":0.5}, ...]
        bg_dir: backgrounds 폴더 경로
        duration_per_slide: 슬라이드당 길이 (초)

    Returns:
        생성된 MP4 파일 경로
    """
    import hashlib
    os.makedirs(output_dir, exist_ok=True)

    # 해시: 모션+전환 설정이 바뀌면 재생성
    _cfg_str = str(slide_motions) + str(slide_transitions) + str(duration_per_slide)
    _hash = hashlib.md5(_cfg_str.encode()).hexdigest()[:12]
    out_path = os.path.join(output_dir, f"full_preview_{_hash}.mp4")
    if os.path.exists(out_path):
        return out_path

    motions_dir = os.path.join(output_dir, "motions")
    os.makedirs(motions_dir, exist_ok=True)

    # 1) 각 슬라이드 모션 프리뷰 생성 (캐시 활용)
    segments = []
    for mo in slide_motions:
        slide_num = mo["slide"]
        motion = mo.get("motion", "random")

        # 배경 이미지 찾기
        bg_path = ""
        for ext in ("jpg", "jpeg", "png", "webp"):
            p = os.path.join(bg_dir, f"bg_{slide_num}.{ext}")
            if os.path.exists(p):
                bg_path = p
                break

        try:
            seg = generate_motion_preview(
                motion, motions_dir, bg_path=bg_path,
                duration=duration_per_slide)
            segments.append(seg)
        except Exception as e:
            print(f"[full_preview] slide {slide_num} motion failed: {e}")
            # 폴백: 정적 이미지로 생성
            try:
                seg = generate_motion_preview(
                    "none", motions_dir, bg_path=bg_path,
                    duration=duration_per_slide)
                segments.append(seg)
            except Exception:
                continue

    if len(segments) < 2:
        if segments:
            import shutil
            shutil.copy2(segments[0], out_path)
            return out_path
        raise RuntimeError("No segments generated")

    # 2) xfade로 합성
    n = len(segments)
    durations = [duration_per_slide] * n

    # 전환 설정
    tr_map = {}
    for t in slide_transitions:
        tr_map[int(t.get("slide", 0))] = t

    # filter_complex 구성
    inputs = []
    for seg in segments:
        inputs.extend(["-i", seg])

    norm_filters = []
    for i in range(n):
        norm_filters.append(
            f"[{i}:v]fps=24,scale=540:960:force_original_aspect_ratio=decrease,"
            f"pad=540:960:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[nv{i}]"
        )

    # xfade 체인
    xfade_filters = []
    offsets = []
    cumulative = durations[0]
    prev_label = "[nv0]"

    for i in range(1, n):
        t_cfg = tr_map.get(i, {})
        t_effect = t_cfg.get("effect", "fade")
        t_dur = float(t_cfg.get("duration", 0.5))
        t_dur = min(t_dur, min(durations[i - 1], durations[i]) * 0.4)

        offset = cumulative - t_dur
        out_label = f"[xf{i}]" if i < n - 1 else "[vout]"
        xfade_filters.append(
            f"{prev_label}[nv{i}]xfade=transition={t_effect}"
            f":duration={t_dur:.2f}:offset={offset:.2f}{out_label}"
        )
        cumulative += durations[i] - t_dur
        prev_label = out_label if i < n - 1 else ""

    filter_str = ";".join(norm_filters + xfade_filters)

    result = subprocess.run([
        config.ffmpeg(), "-y",
        *inputs,
        "-filter_complex", filter_str,
        "-map", "[vout]",
        "-c:v", "libx264", "-preset", "fast",
        "-pix_fmt", "yuv420p",
        "-an",  # 오디오 없음
        out_path
    ], capture_output=True, text=True)

    if result.returncode != 0:
        print(f"[full_preview] xfade error: {result.stderr[:500]}")
        raise RuntimeError("Full preview generation failed")

    return out_path


# Ken Burns 효과 프리셋 (zoompan 필터용)
# 각 프리셋: (zoom_expr, x_expr, y_expr)
# 출력 해상도 1080x1920, 입력은 여유 있게 스케일 (1.15배)
_KB_PRESETS = {
    # ── 기본 줌/패닝 ──
    "zoom_in": ("min(1.15,1+0.0015*on)", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
    "zoom_out": ("if(eq(on,1),1.15,max(1,zoom-0.0015))", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
    "pan_right": ("min(1.15,1+0.001*on)", "iw/2-(iw/zoom/2)+on*0.3", "ih/2-(ih/zoom/2)"),
    "pan_left": ("min(1.15,1+0.001*on)", "iw/2-(iw/zoom/2)-on*0.3", "ih/2-(ih/zoom/2)"),
    # ── 떨림 ──
    "shake": ("min(1.08,1+0.0008*on)", "iw/2-(iw/zoom/2)+sin(on*0.15)*8", "ih/2-(ih/zoom/2)+cos(on*0.12)*6"),
    # ── 펄스 (리듬감 있는 확대↔축소 반복) ──
    "pulse": ("1+0.06*sin(on*0.08)", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
}

# 필터 기반 모션 효과 (zoompan이 아닌 ffmpeg 필터 사용)
# 각 프리셋: filter_complex 생성 함수 (total_frames, duration 을 인자로 받음)
_FILTER_PRESETS = {
    "rotate",       # 느린 회전
    "blur_in",      # 흐릿 → 선명
    "bright_pulse", # 밝기 리듬 변화
    "vignette",     # 모서리 어둡게
    "glitch",       # RGB 채널 분리
}

# UI 표시용 모션 프리셋 목록
MOTION_PRESETS = [
    {"id": "none", "label": "정적", "desc": "모션 없음"},
    {"id": "random", "label": "랜덤", "desc": "랜덤 효과"},
    # ── 줌/패닝 ──
    {"id": "zoom_in", "label": "줌 인", "desc": "느린 확대"},
    {"id": "zoom_out", "label": "줌 아웃", "desc": "느린 축소"},
    {"id": "pan_right", "label": "우측 패닝", "desc": "좌→우 이동"},
    {"id": "pan_left", "label": "좌측 패닝", "desc": "우→좌 이동"},
    {"id": "shake", "label": "흩뿌리기", "desc": "가볍게 흔들리는 효과"},
    # ── 신규 효과 ──
    {"id": "pulse", "label": "펄스", "desc": "리듬감 있는 확대↔축소"},
    {"id": "rotate", "label": "회전", "desc": "느리게 회전"},
    {"id": "blur_in", "label": "블러 인", "desc": "흐릿→선명 전환"},
    {"id": "bright_pulse", "label": "밝기 펄스", "desc": "밝기 리듬 변화"},
    {"id": "vignette", "label": "비네팅", "desc": "모서리 어둡게"},
    {"id": "glitch", "label": "글리치", "desc": "RGB 채널 분리"},
]

# motion 힌트 → 프리셋 매핑 (AI 생성 motion 텍스트 → 프리셋 ID)
_MOTION_MAP = {
    "slow zoom in": "zoom_in",
    "zoom in": "zoom_in",
    "slow zoom out": "zoom_out",
    "zoom out": "zoom_out",
    "gentle pan left": "pan_left",
    "pan left": "pan_left",
    "gentle pan right": "pan_right",
    "pan right": "pan_right",
    "pan across": "pan_right",
    "pan up": "pan_right",
    "gentle pan up": "pan_right",
    "pan down": "pan_left",
    "gentle pan down": "pan_left",
    "tilt up": "pan_right",
    "tilt down": "pan_left",
}

# 전체 모션 ID 목록 (랜덤 선택용)
_ALL_MOTION_IDS = [k for k in _KB_PRESETS.keys()] + list(_FILTER_PRESETS)


def _select_motion(motion: str = ""):
    """motion 힌트로 모션 프리셋 선택.
    "none" → None 반환 (정적).
    zoompan 프리셋이면 (zoom, x, y) 튜플 반환.
    필터 프리셋이면 프리셋 ID 문자열 반환.
    매칭 안 되면 랜덤.
    """
    if motion:
        motion_lower = motion.lower().strip()
        if motion_lower == "none":
            return None
        # 프리셋 ID 직접 매칭 (UI에서 선택)
        if motion_lower in _KB_PRESETS:
            return _KB_PRESETS[motion_lower]
        if motion_lower in _FILTER_PRESETS:
            return motion_lower
        # 긴 구문부터 매칭
        for hint in sorted(_MOTION_MAP.keys(), key=len, reverse=True):
            if hint in motion_lower:
                mapped = _MOTION_MAP[hint]
                if mapped in _KB_PRESETS:
                    return _KB_PRESETS[mapped]
                return mapped
    # 랜덤: zoompan + 필터 전체에서 선택
    rid = random.choice(_ALL_MOTION_IDS)
    if rid in _KB_PRESETS:
        return _KB_PRESETS[rid]
    return rid


def _select_kb_preset(motion: str = ""):
    """하위 호환: zoompan 프리셋만 반환. 필터 프리셋이면 None."""
    result = _select_motion(motion)
    if isinstance(result, tuple):
        return result
    return None


def _build_filter_expr(motion_id: str, total_frames: int, duration: float,
                       scale_w: int, scale_h: int, crop: str,
                       has_overlay: bool) -> str:
    """필터 기반 모션 효과의 filter_complex 문자열 생성."""
    base_scale = f"scale={scale_w}:{scale_h},format=rgba{crop}"
    fps_out = f"fps=24,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black"

    if motion_id == "rotate":
        # 느린 시계방향 회전 (5초에 약 8도), fps 먼저 적용해서 t 변수 활성화
        filt = (
            f"[0:v]{base_scale},fps=24,"
            f"rotate='PI/180*t*1.6':c=black@0:ow=1080:oh=1920,"
            f"scale=1080:1920:force_original_aspect_ratio=decrease,"
            f"pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black[bg]"
        )
    elif motion_id == "blur_in":
        # 흐릿→선명 (boxblur가 시간에 따라 감소)
        max_blur = 15
        filt = (
            f"[0:v]{base_scale},fps=24,"
            f"boxblur=luma_radius='max(0,{max_blur}*(1-t/{duration}))':luma_power=2,"
            f"scale=1080:1920:force_original_aspect_ratio=decrease,"
            f"pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black[bg]"
        )
    elif motion_id == "bright_pulse":
        # 밝기 사인파 변화
        filt = (
            f"[0:v]{base_scale},fps=24,"
            f"eq=brightness='0.15*sin(t*2.5)':eval=frame,"
            f"scale=1080:1920:force_original_aspect_ratio=decrease,"
            f"pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black[bg]"
        )
    elif motion_id == "vignette":
        # 비네팅 (모서리 어둡게, 시간에 따라 강화)
        filt = (
            f"[0:v]{base_scale},fps=24,"
            f"vignette='PI/4+t*0.1':mode=forward,"
            f"scale=1080:1920:force_original_aspect_ratio=decrease,"
            f"pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black[bg]"
        )
    elif motion_id == "glitch":
        # RGB 채널 분리 (사인파 기반 시간 변화)
        filt = (
            f"[0:v]{base_scale},fps=24,"
            f"rgbashift=rh='sin(t*3)*8':bh='sin(t*3+1.5)*-8'"
            f":rv='cos(t*2.5)*5':bv='cos(t*2.5+1)*-5',"
            f"scale=1080:1920:force_original_aspect_ratio=decrease,"
            f"pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black[bg]"
        )
    else:
        # 폴백: 정적
        filt = f"[0:v]{base_scale},{fps_out}[bg]"

    if has_overlay:
        filt += ";[bg][1:v]overlay=0:0:shortest=1[out]"
    else:
        filt = filt.replace("[bg]", "[out]")

    return filt


def _find_video_bg(image_dir: str, slide_num: int) -> str | None:
    """슬라이드에 대응하는 영상 배경 파일 검색 (MP4 우선, GIF 폴백)"""
    bg_dir = os.path.join(os.path.dirname(image_dir), "backgrounds")
    for ext in (".mp4", ".gif"):
        path = os.path.join(bg_dir, f"bg_{slide_num}{ext}")
        if os.path.exists(path) and os.path.getsize(path) > 100:
            return path
    return None


def _find_image_bg(image_dir: str, slide_num: int) -> str | None:
    """슬라이드에 대응하는 정적 배경 이미지 검색"""
    bg_dir = os.path.join(os.path.dirname(image_dir), "backgrounds")
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        path = os.path.join(bg_dir, f"bg_{slide_num}{ext}")
        if os.path.exists(path) and os.path.getsize(path) > 100:
            return path
    return None


def render_static_silent(image_path: str, output_path: str,
                          duration: float, vcfg: dict):
    """정적 이미지 → 무음 오디오 포함 MP4 (Ken Burns 효과, 1080x1920, 24fps).

    인트로/아웃트로 세그먼트 생성용. concat demuxer 호환을 위해 무음 오디오 트랙 포함.
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    preset = random.choice(list(_KB_PRESETS.values()))
    zoom_expr, x_expr, y_expr = preset
    total_frames = int(duration * 24) + 5

    result = subprocess.run([
        config.ffmpeg(), "-y",
        "-i", image_path,
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
        "-filter_complex",
        f"[0:v]scale=1242:2208,format=rgba,"
        f"zoompan=z='{zoom_expr}':x='{x_expr}':y='{y_expr}'"
        f":d={total_frames}:s=1080x1920:fps=24[vout]",
        "-map", "[vout]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "fast",
        "-c:a", "aac", "-b:a", vcfg["audio_bitrate"],
        "-pix_fmt", "yuv420p",
        "-shortest",
        "-t", str(duration),
        output_path
    ], capture_output=True, text=True)

    if result.returncode != 0:
        print(f"[video_renderer] Ken Burns silent failed: {result.stderr[:300]}")
        subprocess.run([
            config.ffmpeg(), "-y",
            "-loop", "1", "-i", image_path,
            "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
            "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,"
                   "pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=24",
            "-c:v", "libx264", "-preset", "fast",
            "-c:a", "aac", "-b:a", vcfg["audio_bitrate"],
            "-pix_fmt", "yuv420p",
            "-shortest",
            "-t", str(duration),
            output_path
        ], capture_output=True)


def render_static_with_audio(image_path: str, audio_path: str,
                              output_path: str, vcfg: dict,
                              audio_delay: float = 0) -> float:
    """정적 이미지 + 오디오 → MP4 (Ken Burns 효과, 1080x1920, 24fps).

    인트로/아웃트로 나레이션 세그먼트 생성용.
    duration은 오디오 실제 길이 + audio_delay, AAC 재인코딩으로 concat 호환 보장.

    Args:
        audio_delay: 오디오 시작 전 무음 구간(초). SFX 오프닝 재생 여유 시간용.

    Returns:
        총 세그먼트 길이(초) = audio_delay + 오디오 길이
    """
    from pipeline.tts_generator import get_audio_duration
    duration = get_audio_duration(audio_path)
    total_duration = duration + audio_delay

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    preset = random.choice(list(_KB_PRESETS.values()))
    zoom_expr, x_expr, y_expr = preset
    total_frames = int(total_duration * 24) + 5

    delay_ms = int(audio_delay * 1000)
    if delay_ms > 0:
        audio_filter = (
            f"[1:a]adelay={delay_ms}|{delay_ms},"
            f"aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,"
            f"apad=whole_dur={total_duration:.3f}[aout]"
        )
    else:
        audio_filter = (
            f"[1:a]aformat=sample_fmts=fltp:sample_rates=44100:"
            f"channel_layouts=stereo[aout]"
        )

    result = subprocess.run([
        config.ffmpeg(), "-y",
        "-i", image_path,
        "-i", audio_path,
        "-filter_complex",
        f"[0:v]scale=1242:2208,format=rgba,"
        f"zoompan=z='{zoom_expr}':x='{x_expr}':y='{y_expr}'"
        f":d={total_frames}:s=1080x1920:fps=24[vout];"
        f"{audio_filter}",
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "fast",
        "-c:a", "aac", "-b:a", vcfg["audio_bitrate"],
        "-pix_fmt", "yuv420p",
        "-t", str(total_duration),
        output_path
    ], capture_output=True, text=True)

    if result.returncode != 0:
        print(f"[video_renderer] Ken Burns with audio failed: {result.stderr[:300]}")
        delay_af = f"adelay={delay_ms}|{delay_ms}," if delay_ms > 0 else ""
        subprocess.run([
            config.ffmpeg(), "-y",
            "-loop", "1", "-i", image_path,
            "-i", audio_path,
            "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,"
                   "pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=24",
            "-af", f"{delay_af}aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo",
            "-c:v", "libx264", "-preset", "fast",
            "-c:a", "aac", "-b:a", vcfg["audio_bitrate"],
            "-pix_fmt", "yuv420p",
            "-t", str(total_duration),
            output_path
        ], capture_output=True)

    return total_duration


def render_segments(slide_durations: dict, image_dir: str,
                    merged_audio: dict, segment_dir: str,
                    motion_hints: dict | None = None,
                    slide_bg_map: dict | None = None,
                    bg_display_mode: str = "zone",
                    slide_layout: str = "full",
                    disable_motion: bool = False) -> list[str]:
    """슬라이드별 세그먼트 영상 생성.

    배경 유형에 따라:
    - 영상 배경 (MP4/GIF) → 영상 루프 + 오버레이
    - 이미지 배경 (PNG/JPG) → Ken Burns 효과 + 오버레이
    - 배경 없음 → 정적 슬라이드

    Args:
        motion_hints: {bg_idx: "slow zoom in", ...} — Ken Burns 프리셋 선택용
        slide_bg_map: {slide_num: [bg_idx, ...]} — 슬라이드→배경 파일 매핑
                      bg_idx가 2개면 duration을 반분하여 세그먼트 2개 생성

    Returns:
        세그먼트 MP4 파일 경로 리스트 (순서대로)
    """
    os.makedirs(segment_dir, exist_ok=True)
    vcfg = config.video_cfg()
    segment_files = []
    hints = motion_hints or {}
    bg_map = slide_bg_map or {}

    # zone 모드 + zoned 레이아웃 → overlay 분리 합성 대신 composite slide PNG 직접 사용
    _is_zoned = (bg_display_mode == "zone" and slide_layout in ("center", "top", "bottom"))

    for s in sorted(slide_durations.keys()):
        img_path = os.path.join(image_dir, f"slide_{s}.png")
        overlay_path = os.path.join(image_dir, f"slide_{s}_overlay.png")
        audio_path = merged_audio[s]
        dur = slide_durations[s]
        has_overlay = os.path.exists(overlay_path)

        # zone 모드: overlay가 있으면 Ken Burns(bg) + overlay(텍스트) 합성
        # overlay가 없으면 composite slide PNG를 정적으로 사용

        # 슬라이드에 배경이 2개 매핑된 경우 → 분할 렌더링 후 슬라이드 내 concat
        bg_indices = bg_map.get(s, [s])  # 기본: 슬라이드 번호 = bg 번호
        if len(bg_indices) >= 2 and dur > 3.0:
            # 오디오를 반분하여 각 배경에 할당
            half_dur = dur / len(bg_indices)
            part_files = []
            for part_i, bg_idx in enumerate(bg_indices):
                part_seg = os.path.join(segment_dir, f"segment_{s}_{part_i}.mp4")
                motion = hints.get(bg_idx, "")
                video_bg = _find_video_bg(image_dir, bg_idx)
                image_bg = _find_image_bg(image_dir, bg_idx)

                # 오디오 분할: ffmpeg로 구간 추출
                part_audio = os.path.join(segment_dir, f"audio_{s}_{part_i}.aac")
                _split_audio(audio_path, part_audio, part_i * half_dur, half_dur)

                if video_bg and has_overlay:
                    print(f"[video_renderer] slide {s} part {part_i}: video_bg (bg_{bg_idx}) + overlay")
                    _render_video_segment(video_bg, overlay_path, part_audio, part_seg,
                                          half_dur, vcfg)
                elif image_bg and has_overlay:
                    print(f"[video_renderer] slide {s} part {part_i}: Ken Burns (bg_{bg_idx}, {motion or 'random'}) + overlay")
                    _render_kenburns_segment(image_bg, overlay_path, part_audio,
                                             part_seg, half_dur, vcfg, motion=motion)
                elif _is_zoned:
                    print(f"[video_renderer] slide {s} part {part_i}: zoned static composite")
                    _render_static_segment(img_path, part_audio, part_seg, half_dur, vcfg)
                else:
                    print(f"[video_renderer] slide {s} part {part_i}: static")
                    _render_static_segment(img_path, part_audio, part_seg, half_dur, vcfg)
                part_files.append(part_seg)
            # 서브세그먼트를 하나의 슬라이드 세그먼트로 concat (하드컷)
            merged_seg = os.path.join(segment_dir, f"segment_{s}.mp4")
            _concat_parts(part_files, merged_seg)
            segment_files.append(merged_seg)
        else:
            # 단일 배경 (기존 로직)
            seg_path = os.path.join(segment_dir, f"segment_{s}.mp4")
            bg_idx = bg_indices[0] if bg_indices else s
            motion = hints.get(bg_idx, "")
            video_bg = _find_video_bg(image_dir, bg_idx)
            image_bg = _find_image_bg(image_dir, bg_idx)

            if disable_motion:
                # 모션 비활성화: 모든 배경을 정적으로 렌더링
                print(f"[video_renderer] slide {s}: static (motion disabled)")
                _render_static_segment(img_path, audio_path, seg_path, dur, vcfg)
            elif video_bg and has_overlay:
                print(f"[video_renderer] slide {s}: video_bg + overlay")
                _render_video_segment(video_bg, overlay_path, audio_path, seg_path,
                                      dur, vcfg)
            elif image_bg and has_overlay:
                print(f"[video_renderer] slide {s}: Ken Burns ({motion or 'random'}) + overlay")
                _render_kenburns_segment(image_bg, overlay_path, audio_path,
                                         seg_path, dur, vcfg, motion=motion)
            elif _is_zoned:
                # zone 모드: composite slide PNG를 정적으로 사용 (Ken Burns 적용 시 텍스트도 움직여서 부적합)
                print(f"[video_renderer] slide {s}: zoned static composite")
                _render_static_segment(img_path, audio_path, seg_path, dur, vcfg)
            else:
                print(f"[video_renderer] slide {s}: static (bg={bool(image_bg)}, overlay={has_overlay})")
                _render_static_segment(img_path, audio_path, seg_path, dur, vcfg)
            segment_files.append(seg_path)

    return segment_files


def _concat_parts(part_files: list[str], output_path: str):
    """서브세그먼트를 하나의 세그먼트로 concat (슬라이드 내 배경 전환)."""
    concat_file = output_path + ".parts.txt"
    with open(concat_file, "w", encoding="utf-8") as f:
        for p in part_files:
            abs_p = os.path.abspath(p).replace("\\", "/")
            f.write(f"file '{abs_p}'\n")
    subprocess.run([
        config.ffmpeg(), "-y",
        "-f", "concat", "-safe", "0",
        "-i", concat_file,
        "-c", "copy",
        output_path
    ], capture_output=True)
    if os.path.exists(concat_file):
        os.remove(concat_file)


def _split_audio(input_path: str, output_path: str, start: float, duration: float):
    """오디오 파일에서 구간 추출."""
    subprocess.run([
        config.ffmpeg(), "-y",
        "-i", input_path,
        "-ss", str(start), "-t", str(duration),
        "-c:a", "aac", "-b:a", "192k",
        output_path,
    ], capture_output=True)


def _render_static_segment(img_path: str, audio_path: str,
                            output_path: str, duration: float, vcfg: dict):
    """정적 이미지 슬라이드 (xfade 호환: 1080x1920, 24fps)"""
    subprocess.run([
        config.ffmpeg(), "-y",
        "-loop", "1", "-i", img_path,
        "-i", audio_path,
        "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,"
               "pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=24",
        "-c:v", "libx264", "-preset", "fast",
        "-c:a", "aac", "-b:a", vcfg["audio_bitrate"],
        "-pix_fmt", "yuv420p",
        "-shortest",
        "-t", str(duration + 0.1),
        output_path
    ], capture_output=True)


def _render_static_bg_segment(bg_path: str, overlay_path: str, audio_path: str,
                               output_path: str, duration: float, vcfg: dict):
    """정적 배경 이미지 + PNG 오버레이 + 오디오 합성 (모션 없음)."""
    result = subprocess.run([
        config.ffmpeg(), "-y",
        "-loop", "1", "-i", bg_path,
        "-loop", "1", "-i", overlay_path,
        "-i", audio_path,
        "-filter_complex",
        "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,"
        "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,fps=24[bg];"
        "[bg][1:v]overlay=0:0:shortest=1[out]",
        "-map", "[out]", "-map", "2:a",
        "-c:v", "libx264", "-preset", "fast",
        "-c:a", "aac", "-b:a", vcfg["audio_bitrate"],
        "-pix_fmt", "yuv420p",
        "-t", str(duration + 0.1),
        output_path
    ], capture_output=True, text=True)

    if result.returncode != 0:
        print(f"[video_renderer] static_bg failed: {result.stderr[:300]}")
        _render_static_segment(
            overlay_path.replace("_overlay.png", ".png"),
            audio_path, output_path, duration, vcfg)


def _render_kenburns_segment(bg_path: str, overlay_path: str | None, audio_path: str,
                              output_path: str, duration: float, vcfg: dict,
                              motion: str = ""):
    """이미지 배경 + 모션 효과 + PNG 오버레이 + 오디오 합성.
    motion="none"이면 정적 배경.
    overlay_path=None이면 오버레이 없이 이미지만 사용 (zone 모드).
    zoompan 프리셋과 필터 프리셋 모두 지원.
    """
    preset = _select_motion(motion)
    if preset is None:
        if overlay_path:
            _render_static_bg_segment(bg_path, overlay_path, audio_path,
                                       output_path, duration, vcfg)
        else:
            _render_static_segment(bg_path, audio_path, output_path, duration, vcfg)
        return

    total_frames = int(duration * 24) + 5  # 24fps

    # 입력 이미지 비율 감지 → 1:1이면 중앙 배치, 9:16이면 전체 채움
    from PIL import Image as _PILImage
    try:
        _img = _PILImage.open(bg_path)
        _iw, _ih = _img.size
        _img.close()
    except Exception:
        _iw, _ih = 1080, 1920

    _aspect = _iw / _ih if _ih > 0 else 1.0
    if _aspect > 0.8:
        _scale_h = 2208
        _scale_w = max(1242, int(2208 * _aspect))
        _pad = f",crop=1242:2208:(iw-1242)/2:(ih-2208)/2"
    else:
        _scale_w, _scale_h = 1242, 2208
        _pad = ""

    # 필터 기반 효과 (rotate, blur_in, bright_pulse, vignette, glitch)
    is_filter = isinstance(preset, str) and preset in _FILTER_PRESETS
    if is_filter:
        filter_complex = _build_filter_expr(
            preset, total_frames, duration,
            _scale_w, _scale_h, _pad,
            has_overlay=bool(overlay_path)
        )
    else:
        # zoompan 기반 효과
        zoom_expr, x_expr, y_expr = preset
        if overlay_path:
            filter_complex = (
                f"[0:v]scale={_scale_w}:{_scale_h},format=rgba{_pad},"
                f"zoompan=z='{zoom_expr}':x='{x_expr}':y='{y_expr}'"
                f":d={total_frames}:s=1080x1920:fps=24[bg];"
                f"[bg][1:v]overlay=0:0:shortest=1[out]"
            )
        else:
            filter_complex = (
                f"[0:v]scale={_scale_w}:{_scale_h},format=rgba{_pad},"
                f"zoompan=z='{zoom_expr}':x='{x_expr}':y='{y_expr}'"
                f":d={total_frames}:s=1080x1920:fps=24[out]"
            )

    if overlay_path:
        cmd = [
            config.ffmpeg(), "-y",
            "-loop", "1", "-i", bg_path,
            "-loop", "1", "-i", overlay_path,
            "-i", audio_path,
            "-filter_complex", filter_complex,
            "-map", "[out]", "-map", "2:a",
            "-c:v", "libx264", "-preset", "fast",
            "-c:a", "aac", "-b:a", vcfg["audio_bitrate"],
            "-pix_fmt", "yuv420p",
            "-t", str(duration + 0.1),
            output_path
        ]
    else:
        cmd = [
            config.ffmpeg(), "-y",
            "-loop", "1", "-i", bg_path,
            "-i", audio_path,
            "-filter_complex", filter_complex,
            "-map", "[out]", "-map", "1:a",
            "-c:v", "libx264", "-preset", "fast",
            "-c:a", "aac", "-b:a", vcfg["audio_bitrate"],
            "-pix_fmt", "yuv420p",
            "-t", str(duration + 0.1),
            output_path
        ]

    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        print(f"[video_renderer] motion effect failed ({motion}): {result.stderr[:300]}")
        fallback_img = overlay_path.replace("_overlay.png", ".png") if overlay_path else bg_path
        _render_static_segment(fallback_img, audio_path, output_path, duration, vcfg)


def _render_video_segment(bg_path: str, overlay_path: str, audio_path: str,
                          output_path: str, duration: float, vcfg: dict):
    """영상 배경(MP4/GIF) + PNG 오버레이 + 오디오를 합성하여 세그먼트 생성"""
    is_gif = bg_path.lower().endswith(".gif")
    bg_input = (["-ignore_loop", "0"] if is_gif else ["-stream_loop", "-1"]) + ["-i", bg_path]

    result = subprocess.run([
        config.ffmpeg(), "-y",
        *bg_input,
        "-loop", "1", "-i", overlay_path,
        "-i", audio_path,
        "-filter_complex",
        "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,"
        "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,fps=24[bg];"
        "[bg][1:v]overlay=0:0:shortest=1[out]",
        "-map", "[out]", "-map", "2:a",
        "-c:v", "libx264", "-preset", "fast",
        "-c:a", "aac", "-b:a", vcfg["audio_bitrate"],
        "-pix_fmt", "yuv420p",
        "-t", str(duration + 0.1),
        output_path
    ], capture_output=True, text=True)

    if result.returncode != 0:
        print(f"[video_renderer] Video segment failed: {result.stderr[:300]}")
        _render_static_segment(
            overlay_path.replace("_overlay.png", ".png"),
            audio_path, output_path, duration, vcfg)


def concat_segments(segment_files: list[str], output_path: str,
                    sfx_cfg: dict | None = None,
                    slide_durations: dict | None = None,
                    per_slide_transitions: list[dict] | None = None) -> str:
    """세그먼트들을 하나의 최종 영상으로 합침 (크로스페이드) + BGM/효과음 믹싱.

    Args:
        sfx_cfg: 채널 config dict (sfx_*, bgm_*, crossfade_* 설정 포함)
        slide_durations: {슬라이드번호: 초} — 전환 시점 계산용
        per_slide_transitions: 슬라이드별 전환 효과 리스트 (없으면 글로벌 적용)

    Returns:
        최종 영상 파일 경로
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    # 오디오 믹싱 필요 여부 판단
    needs_sfx = sfx_cfg and sfx_cfg.get("sfx_enabled") and slide_durations
    needs_bgm = sfx_cfg and sfx_cfg.get("bgm_enabled") and sfx_cfg.get("bgm_file")
    needs_mix = needs_sfx or needs_bgm
    concat_out = output_path if not needs_mix else output_path.replace(".mp4", "_nomix.mp4")

    # 크로스페이드 적용 여부
    xfade_dur = 0.5  # 기본 0.5초
    xfade_transition = "fade"
    if sfx_cfg:
        xfade_dur = sfx_cfg.get("crossfade_duration", 0.5) or 0.5
        xfade_transition = sfx_cfg.get("crossfade_transition", "fade") or "fade"

    _has_per_slide = bool(per_slide_transitions)
    print(f"[video_renderer] concat_segments: {len(segment_files)} files, "
          f"xfade={xfade_dur}s/{xfade_transition}, per_slide={_has_per_slide}, sfx={bool(needs_sfx)}, bgm={bool(needs_bgm)}")

    actual_xfade = 0  # 실제 적용된 xfade 시간 (fallback 시 0)
    if len(segment_files) >= 2 and xfade_dur > 0:
        try:
            _concat_with_xfade(segment_files, concat_out, slide_durations, xfade_dur,
                               transition=xfade_transition,
                               per_slide_transitions=per_slide_transitions)
            actual_xfade = xfade_dur
        except Exception as e:
            print(f"[video_renderer] xfade failed, falling back to simple concat: {e}")
            _concat_simple(segment_files, concat_out)
    else:
        _concat_simple(segment_files, concat_out)

    if not os.path.exists(concat_out):
        raise RuntimeError("Video rendering failed")

    # 2차: BGM + 효과음 믹싱
    if needs_mix:
        try:
            _mix_audio(concat_out, output_path, sfx_cfg, slide_durations,
                       mix_sfx=needs_sfx, mix_bgm=needs_bgm,
                       xfade_dur=actual_xfade)
        except Exception as e:
            print(f"[video_renderer] Audio mixing failed, using original: {e}")
            if not os.path.exists(output_path):
                os.replace(concat_out, output_path)
        finally:
            if os.path.exists(concat_out) and concat_out != output_path:
                os.remove(concat_out)

    if not os.path.exists(output_path):
        raise RuntimeError("Video rendering failed")

    return output_path


def _concat_simple(segment_files: list[str], output_path: str):
    """단순 concat (하드컷)"""
    concat_file = os.path.join(os.path.dirname(segment_files[0]), "concat_final.txt")
    with open(concat_file, "w", encoding="utf-8") as f:
        for seg in segment_files:
            abs_seg = os.path.abspath(seg).replace("\\", "/")
            f.write(f"file '{abs_seg}'\n")

    subprocess.run([
        config.ffmpeg(), "-y",
        "-f", "concat", "-safe", "0",
        "-i", concat_file,
        "-c:v", "libx264",
        "-c:a", "aac",
        "-movflags", "+faststart",
        output_path
    ], capture_output=True)


def _get_segment_duration(seg_path: str) -> float:
    """ffprobe로 세그먼트 길이 조회"""
    result = subprocess.run([
        config.ffprobe(), "-v", "quiet",
        "-print_format", "json", "-show_format", seg_path
    ], capture_output=True, text=True)
    try:
        import json
        data = json.loads(result.stdout)
        return float(data["format"]["duration"])
    except Exception:
        return 5.0


def _concat_with_xfade(segment_files: list[str], output_path: str,
                       slide_durations: dict | None, xfade_dur: float,
                       transition: str = "fade",
                       per_slide_transitions: list[dict] | None = None):
    """xfade 크로스페이드로 세그먼트 합성.

    영상: xfade=transition={transition} (모든 입력을 1080x1920/24fps로 정규화)
    오디오: 앞 패딩 atrim + hard-cut concat (44100Hz/stereo, 블렌딩 없음)

    Args:
        per_slide_transitions: 슬라이드별 전환 설정 리스트
            [{"slide": 1, "effect": "fade", "duration": 0.5}, ...]
            slide N → N번째 슬라이드에서 N+1번째로 넘어갈 때 적용
            None이면 글로벌 transition/xfade_dur 적용
    """
    n = len(segment_files)
    if n < 2:
        _concat_simple(segment_files, output_path)
        return

    # 슬라이드별 전환 설정 룩업 테이블 구성
    _per_slide = {}
    if per_slide_transitions:
        for t in per_slide_transitions:
            _per_slide[int(t.get("slide", 0))] = t

    # 세그먼트별 실제 길이 조회
    durations = []
    if slide_durations:
        for s in sorted(slide_durations.keys()):
            durations.append(slide_durations[s])
    if len(durations) != n:
        durations = [_get_segment_duration(seg) for seg in segment_files]

    # 슬라이드별 (effect, duration) 배열 구성 — n-1개 전환점
    transitions_list = []
    for i in range(1, n):
        t_cfg = _per_slide.get(i, {})  # slide i → i+1 전환
        t_effect = t_cfg.get("effect", transition)
        t_dur = float(t_cfg.get("duration", xfade_dur))
        # xfade 시간이 세그먼트보다 길면 줄임
        max_xd = min(durations[i - 1], durations[i]) * 0.4
        t_dur = min(t_dur, max_xd)
        transitions_list.append((t_effect, t_dur))

    inputs = []
    for seg in segment_files:
        inputs.extend(["-i", seg])

    # filter_complex 구성
    # 1) 각 입력의 비디오/오디오를 정규화 (fps, 해상도, 오디오 포맷 통일)
    # 2) xfade 체인 (비디오), 오디오는 앞 패딩 trim + concat (하드컷, 블렌딩 없음)
    norm_filters = []
    for i in range(n):
        norm_filters.append(
            f"[{i}:v]fps=24,scale=1080:1920:force_original_aspect_ratio=decrease,"
            f"pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[nv{i}]"
        )
        # 2번째 이후 오디오: 앞 xd초 trim (앞 패딩 중 xd만큼 제거 → 비디오 xfade와 싱크)
        if i > 0:
            _xd_i = transitions_list[i - 1][1]  # 이 세그먼트에 적용될 전환의 duration
            norm_filters.append(
                f"[{i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,"
                f"atrim=start={_xd_i:.3f},asetpts=PTS-STARTPTS[na{i}]"
            )
        else:
            norm_filters.append(
                f"[{i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[na{i}]"
            )

    vfilters = []
    offset = durations[0] - transitions_list[0][1]  # 첫 xfade 시작점

    for i in range(1, n):
        t_effect, t_dur = transitions_list[i - 1]
        vin = f"[xv{i-2}]" if i >= 2 else f"[nv0]"
        vout = f"[xv{i-1}]" if i < n - 1 else "[vout]"
        vfilters.append(
            f"{vin}[nv{i}]xfade=transition={t_effect}:duration={t_dur:.3f}:offset={offset:.3f}{vout}"
        )

        if i < n - 1:
            offset += durations[i] - transitions_list[i][1]

    # 오디오: 모든 스트림을 단순 concat (하드컷, acrossfade 없음)
    audio_inputs = "".join(f"[na{i}]" for i in range(n))
    afilters = [f"{audio_inputs}concat=n={n}:v=0:a=1[aout]"]

    filter_complex = ";".join(norm_filters + vfilters + afilters)

    _tr_summary = [(t[0], f"{t[1]:.2f}s") for t in transitions_list]
    print(f"[video_renderer] xfade: {n} segments, transitions={_tr_summary}, durations={durations}")

    result = subprocess.run([
        config.ffmpeg(), "-y",
        *inputs,
        "-filter_complex", filter_complex,
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "fast",
        "-c:a", "aac", "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        output_path
    ], capture_output=True, text=True)

    if result.returncode != 0:
        print(f"[video_renderer] xfade error: {result.stderr[:500]}")
        raise RuntimeError("xfade concat failed")


def _get_audio_path(subdir: str, filename: str) -> str | None:
    """data/{subdir}/ 폴더에서 오디오 파일 경로 반환"""
    if not filename:
        return None
    path = os.path.join(config.root_dir(), "data", subdir, filename)
    return path if os.path.exists(path) else None


def _mix_audio(input_path: str, output_path: str,
               cfg: dict, slide_durations: dict,
               mix_sfx: bool = False, mix_bgm: bool = False,
               xfade_dur: float = 0, audio_offset: float = 0):
    """ffmpeg로 BGM + 효과음을 영상에 믹싱.

    BGM: 전체 영상에 루프, 끝에서 페이드아웃
    효과음: 슬라이드 전환 시점에 삽입
    xfade_dur: 크로스페이드 적용 시 전환당 줄어드는 시간
    audio_offset: 인트로 세그먼트 길이 (SFX/BGM 타이밍 시프트)
    """
    # 슬라이드 전환 시점 계산 (누적 시간)
    sorted_slides = sorted(slide_durations.keys())
    cumulative = []
    acc = 0.0
    for s in sorted_slides:
        acc += slide_durations[s]
        cumulative.append(acc)

    # xfade 타이밍 보정: 각 전환마다 xfade_dur만큼 총 시간 감소
    # cumulative[i] -= i * xfade_dur (i번째 슬라이드까지 i번의 전환 발생)
    if xfade_dur > 0 and len(sorted_slides) > 1:
        for i in range(len(cumulative)):
            cumulative[i] -= min(i, len(sorted_slides) - 1) * xfade_dur

    # 인트로 오프셋: 슬라이드 타이밍을 인트로 길이만큼 시프트
    if audio_offset > 0:
        cumulative = [c + audio_offset for c in cumulative]

    total_dur = cumulative[-1] if cumulative else 0

    # 추가 입력 파일 수집: (파일경로, 필터라벨)
    extra_inputs = []  # [(path, ...)]
    filter_parts = []
    input_idx = 1  # 0 = 원본 영상

    # --- 나레이션 볼륨 ---
    narr_vol = (cfg.get("narr_volume", 100) or 100) / 100.0
    if narr_vol != 1.0:
        filter_parts.append(f"[0:a]volume={narr_vol}[narr]")
        mix_labels = ["[narr]"]
    else:
        mix_labels = ["[0:a]"]

    # --- BGM ---
    if mix_bgm:
        bgm_path = _get_audio_path("bgm", cfg.get("bgm_file", ""))
        if bgm_path:
            bgm_vol = (cfg.get("bgm_volume", 10) or 10) / 100.0
            narr_delay = cfg.get("narration_delay") if cfg.get("narration_delay") is not None else 2
            bgm_start_ms = int(narr_delay * 1000)  # BGM은 영상 시작부터 (인트로 중에도 재생)

            # 실제 영상 길이 기준으로 BGM 종료 시점 계산 (인트로/아웃트로 포함)
            video_total = _get_segment_duration(input_path)
            bgm_end = video_total - 1  # 영상 끝 1초 전에 완전히 페이드아웃
            bgm_dur = max(1, bgm_end - narr_delay)
            bgm_fade_in = cfg.get("bgm_fade_in", 0)  # 0이면 페이드인 없음
            fade_out_dur = min(5, bgm_dur * 0.2)
            fade_out_start = max(0, bgm_dur - fade_out_dur)

            fade_in_filter = f"afade=t=in:st=0:d={bgm_fade_in:.2f}," if bgm_fade_in > 0 else ""

            extra_inputs.append(bgm_path)
            filter_parts.append(
                f"[{input_idx}:a]aloop=loop=-1:size=2e+09,"
                f"atrim=0:{bgm_dur:.2f},"
                f"{fade_in_filter}"
                f"afade=t=out:st={fade_out_start:.2f}:d={fade_out_dur:.2f},"
                f"volume={bgm_vol},"
                f"adelay={bgm_start_ms}|{bgm_start_ms}[bgm]"
            )
            mix_labels.append("[bgm]")
            input_idx += 1

    # --- SFX ---
    if mix_sfx:
        sfx_vol = (cfg.get("sfx_volume", 15) or 15) / 100.0
        # (path, delay_ms, fade_filter) — fade_filter는 추가 afade 문자열
        sfx_events = []

        # 오프닝 SFX: 항상 영상 시작(0ms)에 재생 (인트로 중에 재생됨)
        intro_path = _get_audio_path("sfx", cfg.get("sfx_intro", ""))
        if intro_path:
            if audio_offset > 0:
                fade_start = max(1, audio_offset - 1)
            else:
                first_slide_dur = slide_durations[sorted_slides[0]] if sorted_slides else 7
                fade_start = max(1, first_slide_dur - 1)
            sfx_events.append((intro_path, 0,
                               f"afade=t=out:st={fade_start:.1f}:d=1"))

        # 슬라이드 전환
        trans_path = _get_audio_path("sfx", cfg.get("sfx_transition", ""))
        if trans_path and len(cumulative) > 1:
            for i in range(len(cumulative) - 2):
                sfx_events.append((trans_path, int(cumulative[i] * 1000), ""))

        # 클로징: 4초부터 페이드아웃
        outro_path = _get_audio_path("sfx", cfg.get("sfx_outro", ""))
        if outro_path and len(cumulative) >= 2:
            sfx_events.append((outro_path, int(cumulative[-2] * 1000),
                               "afade=t=out:st=4:d=4"))

        for si, (ev_path, delay_ms, fade) in enumerate(sfx_events):
            extra_inputs.append(ev_path)
            fade_part = f",{fade}" if fade else ""
            filter_parts.append(
                f"[{input_idx}:a]adelay={delay_ms}|{delay_ms},"
                f"volume={sfx_vol}{fade_part}[sfx{si}]"
            )
            mix_labels.append(f"[sfx{si}]")
            input_idx += 1

    if len(mix_labels) <= 1:
        os.replace(input_path, output_path)
        return

    # amix로 전체 믹싱 (normalize=0: 볼륨 자동 정규화 비활성화 — 스트림 추가/종료 시 뚝 끊김 방지)
    mix_inputs_str = "".join(mix_labels)
    filter_parts.append(
        f"{mix_inputs_str}amix=inputs={len(mix_labels)}"
        f":duration=first:dropout_transition=0:normalize=0[aout]"
    )

    filter_complex = ";".join(filter_parts)

    cmd = [config.ffmpeg(), "-y", "-i", input_path]
    for p in extra_inputs:
        cmd.extend(["-i", p])
    cmd.extend([
        "-filter_complex", filter_complex,
        "-map", "0:v", "-map", "[aout]",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        output_path
    ])

    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        print(f"[video_renderer] Audio mix ffmpeg error: {result.stderr[:500]}")
        raise RuntimeError("Audio mixing failed")


def apply_audio_mix(video_path: str, sfx_cfg: dict, slide_durations: dict,
                    xfade_dur: float = 0, audio_offset: float = 0):
    """SFX/BGM을 영상에 믹싱 (인트로/아웃트로 wrap 후 호출용).

    Args:
        video_path: 입력/출력 영상 경로 (in-place 교체)
        sfx_cfg: 채널 config dict
        slide_durations: {슬라이드번호: 초}
        xfade_dur: 크로스페이드 시간
        audio_offset: 인트로 세그먼트 길이 (타이밍 시프트)
    """
    needs_sfx = sfx_cfg.get("sfx_enabled") and slide_durations
    needs_bgm = sfx_cfg.get("bgm_enabled") and sfx_cfg.get("bgm_file")
    if not needs_sfx and not needs_bgm:
        return

    mixed_path = video_path.replace(".mp4", "_mixed.mp4")
    try:
        _mix_audio(video_path, mixed_path, sfx_cfg, slide_durations,
                   mix_sfx=bool(needs_sfx), mix_bgm=bool(needs_bgm),
                   xfade_dur=xfade_dur, audio_offset=audio_offset)
        if os.path.exists(mixed_path):
            os.replace(mixed_path, video_path)
    except Exception as e:
        print(f"[video_renderer] apply_audio_mix failed: {e}")
        if os.path.exists(mixed_path):
            os.remove(mixed_path)


# ── Voice Clips 믹싱 (Composer 음성/자막 분리 모드) ──────────────────────────────

def mix_voice_clips(clips: list[dict], output_path: str, total_duration: float):
    """voice_clips 배열 → 단일 나레이션 트랙 생성 (ffmpeg adelay + amix).

    Args:
        clips: [{"file": "path", "start_time": 0.0, "duration": 5.2, "volume": 100}, ...]
        output_path: 출력 오디오 파일 경로
        total_duration: 전체 영상 길이 (초)
    """
    if not clips:
        # 빈 무음 파일 생성
        cmd = [config.ffmpeg(), "-y", "-f", "lavfi", "-i",
               f"anullsrc=r=44100:cl=stereo:d={total_duration}",
               "-c:a", "libmp3lame", "-q:a", "4", output_path]
        subprocess.run(cmd, capture_output=True, timeout=30)
        return

    # 각 클립을 adelay로 시간 배치 후 amix
    inputs = []
    filter_parts = []
    idx = 0  # ffmpeg 입력 스트림 인덱스 (스킵된 클립 제외)
    for clip in clips:
        path = clip.get("path") or clip.get("file", "")
        if not os.path.isfile(path):
            continue
        inputs.extend(["-i", path])
        delay_ms = int(clip["start_time"] * 1000)
        vol = (clip.get("volume", 100)) / 100
        filter_parts.append(
            f"[{idx}]adelay={delay_ms}|{delay_ms},volume={vol:.2f}[a{idx}]"
        )
        idx += 1

    if not filter_parts:
        # 클립 파일 없음 → 무음
        cmd = [config.ffmpeg(), "-y", "-f", "lavfi", "-i",
               f"anullsrc=r=44100:cl=stereo:d={total_duration}",
               "-c:a", "libmp3lame", "-q:a", "4", output_path]
        subprocess.run(cmd, capture_output=True, timeout=30)
        return

    n = len(filter_parts)
    mix_inputs = "".join(f"[a{idx}]" for idx in range(n))
    filter_parts.append(f"{mix_inputs}amix=inputs={n}:duration=longest[out]")
    filter_str = ";".join(filter_parts)

    cmd = [config.ffmpeg(), "-y"] + inputs + [
        "-filter_complex", filter_str,
        "-map", "[out]",
        "-c:a", "libmp3lame", "-q:a", "4",
        "-t", str(total_duration),
        output_path
    ]
    print(f"[video_renderer] mix_voice_clips: {n} clips → {output_path}")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        print(f"[video_renderer] mix_voice_clips error: {result.stderr[:500]}")


def generate_srt_from_entries(entries: list[dict], output_path: str) -> str:
    """subtitle_entries → SRT 자막 파일 생성.

    Args:
        entries: [{"text": "문장", "start_time": 0.0, "end_time": 2.5}, ...]
        output_path: SRT 파일 저장 경로

    Returns:
        생성된 SRT 파일 경로
    """
    lines = []
    for i, entry in enumerate(sorted(entries, key=lambda e: e.get("start_time", 0))):
        text = entry.get("text", "").strip()
        if not text:
            continue
        start = entry.get("start_time", 0)
        end = entry.get("end_time", start + 2)
        lines.append(f"{len(lines) // 4 + 1}")
        lines.append(f"{_format_srt_time(start)} --> {_format_srt_time(end)}")
        lines.append(text)
        lines.append("")

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    count = len(lines) // 4
    print(f"[subtitle] SRT 생성 (entries): {count}개 자막, {output_path}")
    return output_path


# ── 자막 (SRT 생성 + 번인) ──────────────────────────────

def _format_srt_time(seconds: float) -> str:
    """초 → SRT 타임코드 (HH:MM:SS,mmm)"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def generate_srt(sentences: list[dict], timeline: dict,
                 output_path: str, narration_delay: float = 0) -> str:
    """나레이션 문장 + 타임라인으로 SRT 자막 파일 생성.

    Args:
        sentences: [{"text": "문장", "slide": 1}, ...]
        timeline: build_timeline() 결과 (durations, slide_durations 등)
        output_path: SRT 파일 저장 경로
        narration_delay: 인트로 등으로 인한 시작 오프셋(초)

    Returns:
        생성된 SRT 파일 경로
    """
    durations = timeline.get("durations", [])
    lines = []
    current_time = narration_delay

    for i, sent in enumerate(sentences):
        text = sent.get("text", "").strip()
        if not text:
            continue
        dur = durations[i] if i < len(durations) else 2.0
        start = current_time
        end = current_time + dur
        lines.append(f"{len(lines) + 1}")
        lines.append(f"{_format_srt_time(start)} --> {_format_srt_time(end)}")
        lines.append(text)
        lines.append("")
        current_time = end

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"[subtitle] SRT 생성: {len(lines) // 4}개 자막, {output_path}")
    return output_path


# ── 자막 필터 가용성 검사 + Pillow 폴백 ──────────────────────────

_subtitle_filter_ok: bool | None = None  # None=미확인, True/False=캐시


def _check_subtitle_filter() -> bool:
    """ffmpeg에 subtitles 필터(libass)가 있는지 확인 (결과 캐시)."""
    global _subtitle_filter_ok
    if _subtitle_filter_ok is not None:
        return _subtitle_filter_ok
    try:
        r = subprocess.run([config.ffmpeg(), "-filters"],
                           capture_output=True, text=True, timeout=10)
        _subtitle_filter_ok = any(
            "subtitles" in ln and "V->V" in ln
            for ln in r.stdout.split("\n")
        )
    except Exception:
        _subtitle_filter_ok = False
    if not _subtitle_filter_ok:
        print("[subtitle] ffmpeg에 subtitles 필터 없음 (libass 미설치). Pillow 폴백 사용.")
    return _subtitle_filter_ok


def _find_subtitle_font() -> str | None:
    """자막 렌더링용 폰트 파일 경로 탐색."""
    proj = os.path.join(os.path.dirname(os.path.dirname(__file__)),
                        "data", "fonts", "NotoSansCJKkr-Bold.otf")
    if os.path.exists(proj):
        return proj
    for c in ["/System/Library/Fonts/AppleSDGothicNeo.ttc",
              "C:/Windows/Fonts/malgunbd.ttf",
              "C:/Windows/Fonts/NotoSansCJKkr-Bold.otf",
              "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc"]:
        if os.path.exists(c):
            return c
    return None


def _parse_srt_entries(srt_path: str) -> list[tuple[float, float, str]]:
    """SRT → [(start_sec, end_sec, text), ...]"""
    with open(srt_path, "r", encoding="utf-8") as f:
        content = f.read().strip()
    entries: list[tuple[float, float, str]] = []
    for block in re.split(r"\n\s*\n", content):
        lines = block.strip().split("\n")
        tc_idx = next((i for i, ln in enumerate(lines) if "-->" in ln), None)
        if tc_idx is None:
            continue
        m = re.match(r"(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)",
                     lines[tc_idx])
        if not m:
            continue
        def _sec(s: str) -> float:
            s = s.replace(",", ".")
            p = s.split(":")
            return float(p[0]) * 3600 + float(p[1]) * 60 + float(p[2])
        text = "\n".join(lines[tc_idx + 1:]).strip()
        if text:
            entries.append((_sec(m.group(1)), _sec(m.group(2)), text))
    return entries


def _render_sub_png(text: str, out_path: str,
                    width: int = 1080, height: int = 1920,
                    font_size: int = 48, margin_v: int = 100,
                    outline: int = 3, alignment: int = 2,
                    bold: bool = True) -> bool:
    """자막 텍스트 → 투명 배경 PNG (Pillow).

    ⚠️ 자막 위치 로직 수정 금지 — 반드시 사용자 확인 후 수정할 것.
    CSS 미리보기(app.js pvSub.style.bottom)와 1:1 대응하는 핵심 로직임.
    미리보기와 실제 렌더링 일치를 2일간 검증하여 확정한 구조.

    - font_size: 픽셀(px) — CSS font-size와 동일
    - margin_v: 바닥(상단)에서 텍스트 하단(상단)까지의 거리(px) — CSS bottom/top과 동일
    - alignment: 2=하단, 8=상단, 5=중앙
    - 위치 계산: CSS `bottom: Xpx` = Pillow `y = height - X - th`
    """
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return False

    px_fs = max(24, font_size)
    px_mv = margin_v
    px_ol = max(1, round(outline * 0.8))

    font_path = _find_subtitle_font()
    if not font_path:
        return False
    try:
        font = ImageFont.truetype(font_path, px_fs)
    except Exception:
        return False

    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 줄바꿈 처리
    max_tw = width - 120

    def _wrap_text(txt, fnt):
        lines = []
        for line in txt.split("\n"):
            lb = draw.textbbox((0, 0), line, font=fnt)
            lw = lb[2] - lb[0]
            if lw > max_tw and len(line) > 5:
                cpl = max(4, int(len(line) * max_tw / lw))
                lines.extend(line[i:i + cpl] for i in range(0, len(line), cpl))
            else:
                lines.append(line)
        return "\n".join(lines)

    text = _wrap_text(text, font)
    bbox = draw.textbbox((0, 0), text, font=font, align="center")
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (width - tw) // 2

    # ⚠️ 위치 로직 수정 금지 — CSS 미리보기(app.js pvSub.style.bottom/top)와 1:1 대응
    # alignment=2: CSS `bottom: margin_v` = Pillow `y = height - margin_v - th`
    # alignment=8: CSS `top: margin_v`    = Pillow `y = margin_v`
    if alignment == 2:
        y = height - px_mv - th
    elif alignment == 8:
        y = px_mv
    else:
        y = (height - th) // 2
    y = max(0, min(y, height - th - 5))

    draw.text((x, y), text, font=font, fill=(255, 255, 255, 255),
              stroke_width=px_ol, stroke_fill=(0, 0, 0, 255),
              align="center")
    img.save(out_path, "PNG")
    return True


def _apply_subtitles_pillow(video_path: str, srt_path: str,
                             font_size: int = 48, margin_v: int = 100,
                             outline: int = 3, alignment: int = 2,
                             bold: bool = True):
    """Pillow + ffmpeg overlay. font_size/margin_v는 픽셀(px) 단위."""
    entries = _parse_srt_entries(srt_path)
    if not entries:
        return
    tmp_dir = os.path.dirname(srt_path) or "."
    pngs: list[str] = []
    valid: list[tuple[float, float]] = []
    for i, (start, end, text) in enumerate(entries):
        p = os.path.join(tmp_dir, f"_sub_ovl_{i}.png")
        if _render_sub_png(text, p, font_size=font_size, margin_v=margin_v,
                           outline=outline, alignment=alignment, bold=bold):
            pngs.append(p)
            valid.append((start, end))
    if not pngs:
        return

    # 영상 길이 가져오기 (PNG 입력 스트림 제한용)
    dur_str = "10"
    try:
        probe = subprocess.run(
            [config.ffprobe(), "-v", "error", "-show_entries",
             "format=duration", "-of", "default=noprint_wrappers=1:nokey=1",
             video_path],
            capture_output=True, text=True, timeout=5)
        if probe.returncode == 0 and probe.stdout.strip():
            dur_str = probe.stdout.strip()
    except Exception:
        pass

    output = video_path.replace(".mp4", "_sub.mp4")
    cmd = [config.ffmpeg(), "-y", "-i", video_path]
    for p in pngs:
        cmd.extend(["-loop", "1", "-t", dur_str, "-i", p])

    # filter_complex: 각 자막 PNG를 해당 시간에만 overlay
    fc_parts: list[str] = []
    for i in range(len(pngs)):
        fc_parts.append(f"[{i + 1}:v]format=rgba[s{i}]")
    prev = "[0:v]"
    for i, (start, end) in enumerate(valid):
        is_last = (i == len(valid) - 1)
        out_lbl = "[out]" if is_last else f"[v{i}]"
        shortest = ":shortest=1" if is_last else ""
        fc_parts.append(
            f"{prev}[s{i}]overlay=0:0{shortest}:enable='between(t,{start:.3f},{end:.3f})'{out_lbl}"
        )
        prev = f"[v{i}]"

    # 오디오 스트림 유무 확인
    probe = subprocess.run(
        [config.ffprobe(), "-v", "error", "-select_streams", "a",
         "-show_entries", "stream=index", "-of", "csv=p=0", video_path],
        capture_output=True, text=True, timeout=5)
    has_audio = bool(probe.stdout.strip())

    cmd.extend(["-filter_complex", ";".join(fc_parts), "-map", "[out]"])
    if has_audio:
        cmd.extend(["-map", "0:a", "-c:a", "copy"])
    cmd.extend(["-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p", output])

    result = subprocess.run(cmd, capture_output=True, text=True)
    for p in pngs:
        try:
            os.remove(p)
        except OSError:
            pass
    if result.returncode == 0 and os.path.exists(output):
        os.replace(output, video_path)
        print(f"[subtitle-pillow] 자막 번인 완료: {video_path}")
    else:
        print(f"[subtitle-pillow] 자막 번인 실패: {result.stderr[:300]}")
        if os.path.exists(output):
            os.remove(output)


def apply_subtitles(video_path: str, srt_path: str,
                    font_size: int = 48, margin_v: int = 100,
                    font_name: str = "Noto Sans KR",
                    outline: int = 3, shadow: int = 1,
                    alignment: int = 2,
                    font_color: str = "&H00FFFFFF",
                    outline_color: str = "&H00000000",
                    bold: bool = True):
    """SRT 자막을 영상에 번인.

    ⚠️ 자막 시스템 수정 시 반드시 사용자 확인 후 수정할 것.
    Pillow(px) + CSS 미리보기(px)가 1:1 대응하는 구조.
    font_size, margin_v는 픽셀(px) 단위.
    Pillow 렌더링 우선 → 실패 시 force_style 폴백.
    """
    if not os.path.exists(srt_path):
        print(f"[subtitle] SRT 파일 없음: {srt_path}")
        return

    # 1차: Pillow (px 기준 — CSS 미리보기와 동일)
    try:
        _apply_subtitles_pillow(video_path, srt_path,
                                font_size=font_size, margin_v=margin_v,
                                outline=outline, alignment=alignment, bold=bold)
        return
    except Exception as e:
        print(f"[subtitle] Pillow 실패: {e}")

    # 2차: ffmpeg force_style 폴백 (px → PlayRes ~288 스케일 변환)
    if not _check_subtitle_filter():
        print("[subtitle] ffmpeg subtitles 필터도 없음 — 자막 건너뜀")
        return

    _SCALE = 288 / 1920
    fs_scaled = max(1, round(font_size * _SCALE, 1))
    mv_scaled = max(0, round(margin_v * _SCALE))

    output = video_path.replace(".mp4", "_sub.mp4")
    style = (
        f"FontName={font_name},"
        f"FontSize={fs_scaled},"
        f"PrimaryColour={font_color},"
        f"OutlineColour={outline_color},"
        "BackColour=&H00000000,"
        f"Bold={'1' if bold else '0'},"
        f"Outline={outline},"
        f"Shadow={shadow},"
        f"MarginV={mv_scaled},"
        f"Alignment={alignment},"
        "BorderStyle=1"
    )

    srt_escaped = srt_path.replace("\\", "/").replace(":", "\\:")
    cmd = [
        config.ffmpeg(), "-y",
        "-i", video_path,
        "-vf", f"subtitles='{srt_escaped}':force_style='{style}'",
        "-c:a", "copy",
        output,
    ]

    print(f"[subtitle] force_style 폴백: {font_size}px → fs={fs_scaled}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0 and os.path.exists(output):
        os.replace(output, video_path)
        print(f"[subtitle] 자막 번인 완료: {video_path}")
    else:
        print(f"[subtitle] 자막 번인 실패: {result.stderr[:300] if result.stderr else ''}")
        if os.path.exists(output):
            os.remove(output)


def burn_subtitles_per_segment(
    segments: list[str],
    sentences: list[dict],
    timeline: dict,
    subtitle_cfg: dict,
):
    """각 세그먼트 영상에 해당 슬라이드 문장 자막을 번인.

    세그먼트별로 SRT를 생성하여 번인하므로 패딩/크로스페이드에 의한
    싱크 어긋남이 구조적으로 불가능하다.

    Args:
        segments: render_segments()가 반환한 세그먼트 MP4 경로 리스트
        sentences: [{"text": "...", "slide": 1}, ...]
        timeline: build_timeline() 결과 (durations 포함)
        subtitle_cfg: {"font_size", "margin_v", "font_name", "outline", "alignment"}
    """
    durations = timeline.get("durations", [])

    # 슬라이드별 문장 그룹핑: {slide_num: [(sentence_idx, text, dur), ...]}
    slide_sentences: dict[int, list[tuple[int, str, float]]] = {}
    for i, sent in enumerate(sentences):
        s = sent.get("slide", 1)
        text = sent.get("text", "").strip()
        if not text:
            continue
        dur = durations[i] if i < len(durations) else 2.0
        slide_sentences.setdefault(s, []).append((i, text, dur))

    sorted_slides = sorted(timeline.get("slide_durations", {}).keys())

    for seg_idx, seg_path in enumerate(segments):
        if seg_idx >= len(sorted_slides):
            break
        slide_num = sorted_slides[seg_idx]
        sents = slide_sentences.get(slide_num, [])
        if not sents:
            continue

        # 세그먼트 내 로컬 SRT 생성 — 문장별 개별 엔트리
        srt_path = seg_path.replace(".mp4", "_sub.srt")
        raw_sum = sum(d for _, _, d in sents)
        slide_dur = timeline["slide_durations"].get(slide_num, raw_sum)
        pre_pad = max(0, slide_dur - raw_sum) / 2

        lines = []
        current = pre_pad
        for idx, (_, text, dur) in enumerate(sents, 1):
            start_t = current
            end_t = current + dur
            lines.append(str(idx))
            lines.append(f"{_format_srt_time(start_t)} --> {_format_srt_time(end_t)}")
            lines.append(text)
            lines.append("")
            current = end_t

        with open(srt_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))

        apply_subtitles(
            seg_path, srt_path,
            font_size=subtitle_cfg.get("font_size", 48),
            margin_v=subtitle_cfg.get("margin_v", 100),
            font_name=subtitle_cfg.get("font_name", "Noto Sans KR"),
            outline=subtitle_cfg.get("outline", 3),
            alignment=subtitle_cfg.get("alignment", 2),
        )

    print(f"[subtitle] 세그먼트별 자막 번인 완료: {len(segments)}개 세그먼트")


# ── 배경 캡션 (선택적 텍스트 오버레이) ──────────────────────────

def apply_caption_to_segment(segment_path: str, caption: str,
                             font_size: int = 32, margin: int = 30,
                             position: str = "bottom_left",
                             font_name: str = "Malgun Gothic"):
    """개별 세그먼트 영상에 캡션 텍스트 오버레이.

    Args:
        segment_path: 세그먼트 MP4 (in-place 교체)
        caption: 캡션 텍스트 (빈 문자열이면 스킵)
        font_size: 캡션 폰트 크기
        margin: 모서리 여백 (px)
        position: 캡션 위치 (bottom_left, bottom_right, top_left, top_right)
        font_name: 폰트 이름
    """
    if not caption or not caption.strip():
        return
    if not os.path.exists(segment_path):
        return

    caption_text = caption.strip()

    # 위치 계산
    pos_map = {
        "bottom_left":  (f"x={margin}", f"y=h-th-{margin}"),
        "bottom_right": (f"x=w-tw-{margin}", f"y=h-th-{margin}"),
        "top_left":     (f"x={margin}", f"y={margin}"),
        "top_right":    (f"x=w-tw-{margin}", f"y={margin}"),
    }
    x_expr, y_expr = pos_map.get(position, pos_map["bottom_left"])

    # 텍스트에 특수문자 이스케이프 (ffmpeg drawtext용)
    safe_text = caption_text.replace("'", "\\'").replace(":", "\\:").replace("%", "%%")

    output = segment_path.replace(".mp4", "_cap.mp4")
    drawtext = (
        f"drawtext=text='{safe_text}':"
        f"fontfile='C\\:/Windows/Fonts/malgunbd.ttf':"
        f"fontsize={font_size}:"
        f"fontcolor=white:"
        f"borderw=2:bordercolor=black@0.6:"
        f"box=1:boxcolor=black@0.4:boxborderw=8:"
        f"{x_expr}:{y_expr}"
    )

    cmd = [
        config.ffmpeg(), "-y",
        "-i", segment_path,
        "-vf", drawtext,
        "-c:a", "copy",
        output,
    ]

    result = subprocess.run(cmd, capture_output=True)
    if result.returncode == 0 and os.path.exists(output):
        os.replace(output, segment_path)
        print(f"[caption] 캡션 적용: '{caption_text}' → {os.path.basename(segment_path)}")
    else:
        print(f"[caption] 캡션 실패: {result.stderr[:200]}")
        if os.path.exists(output):
            os.remove(output)
