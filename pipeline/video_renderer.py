"""ffmpeg 기반 영상 합성기"""
from __future__ import annotations
import glob
import os
import random
import subprocess
from pipeline import config


# ── 지원하는 xfade 전환 효과 목록 ──
XFADE_TRANSITIONS = [
    {"id": "fade", "label": "페이드", "desc": "부드러운 밝기 전환"},
    {"id": "dissolve", "label": "디졸브", "desc": "녹아드는 전환"},
    {"id": "wipeleft", "label": "왼쪽 와이프", "desc": "왼쪽으로 밀기"},
    {"id": "wiperight", "label": "오른쪽 와이프", "desc": "오른쪽으로 밀기"},
    {"id": "slideup", "label": "위로 슬라이드", "desc": "위로 밀어올리기"},
    {"id": "slidedown", "label": "아래로 슬라이드", "desc": "아래로 내리기"},
    {"id": "slideleft", "label": "왼쪽 슬라이드", "desc": "왼쪽으로 밀기 (겹침)"},
    {"id": "slideright", "label": "오른쪽 슬라이드", "desc": "오른쪽으로 밀기 (겹침)"},
    {"id": "circlecrop", "label": "원형", "desc": "원형으로 확대"},
    {"id": "radial", "label": "시계방향", "desc": "시계 방향 회전"},
    {"id": "smoothleft", "label": "부드러운 좌측", "desc": "부드럽게 좌측 이동"},
    {"id": "smoothright", "label": "부드러운 우측", "desc": "부드럽게 우측 이동"},
    {"id": "smoothup", "label": "부드러운 상단", "desc": "부드럽게 위로 이동"},
    {"id": "smoothdown", "label": "부드러운 하단", "desc": "부드럽게 아래로 이동"},
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

    preset = _select_kb_preset(motion)
    if preset is None:
        # 정적: 단순 스케일
        if is_image:
            bg_input = ["-loop", "1", "-i", bg_path]
        filter_v = (
            "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,"
            "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,fps=24[vout]"
        )
    else:
        # 미리보기 전용 강화 프리셋 (3초 안에 효과 명확히 인지)
        _PREVIEW_PRESETS = {
            "zoom_in":  ("min(2.0,1+0.014*on)",  "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
            "zoom_out": ("if(eq(on,1),2.0,max(1,zoom-0.014))", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
            "pan_right": ("min(1.5,1+0.007*on)", "iw/2-(iw/zoom/2)+on*3", "ih/2-(ih/zoom/2)"),
            "pan_left":  ("min(1.5,1+0.007*on)", "iw/2-(iw/zoom/2)-on*3", "ih/2-(ih/zoom/2)"),
            "pan_down":  ("min(1.5,1+0.007*on)", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)+on*2"),
            "pan_up":    ("if(eq(on,1),1.5,max(1,zoom-0.007))", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)-on*2"),
        }
        motion_key = motion.lower().strip()
        if motion_key in _PREVIEW_PRESETS:
            zoom_expr, x_expr, y_expr = _PREVIEW_PRESETS[motion_key]
        else:
            zoom_expr, x_expr, y_expr = preset
        # zoompan은 단일 이미지에 직접 적용 (scale/crop 거치면 효과 미미)
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
        print(f"[video_renderer] motion preview error: {result.stderr[:300]}")
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
# 각 프리셋: (zoom_expr, x_expr, y_expr, 설명)
# 출력 해상도 1080x1920, 입력은 여유 있게 스케일 (1.15배)
_KB_PRESETS = {
    "zoom_in": ("min(1.15,1+0.0015*on)", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
    "zoom_out": ("if(eq(on,1),1.15,max(1,zoom-0.0015))", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
    "pan_right": ("min(1.15,1+0.001*on)", "iw/2-(iw/zoom/2)+on*0.3", "ih/2-(ih/zoom/2)"),
    "pan_left": ("min(1.15,1+0.001*on)", "iw/2-(iw/zoom/2)-on*0.3", "ih/2-(ih/zoom/2)"),
    "pan_down": ("min(1.15,1+0.001*on)", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)+on*0.2"),
    "pan_up": ("if(eq(on,1),1.15,max(1,zoom-0.001))", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)-on*0.2"),
}

# UI 표시용 모션 프리셋 목록
MOTION_PRESETS = [
    {"id": "none", "label": "정적", "desc": "모션 없음"},
    {"id": "random", "label": "랜덤", "desc": "랜덤 Ken Burns"},
    {"id": "zoom_in", "label": "줌 인", "desc": "느린 확대"},
    {"id": "zoom_out", "label": "줌 아웃", "desc": "느린 축소"},
    {"id": "pan_right", "label": "우측 패닝", "desc": "좌→우 이동 + 줌"},
    {"id": "pan_left", "label": "좌측 패닝", "desc": "우→좌 이동 + 줌"},
    {"id": "pan_down", "label": "하단 패닝", "desc": "위→아래 이동"},
    {"id": "pan_up", "label": "상단 패닝", "desc": "아래→위 이동"},
]

# motion 힌트 → Ken Burns 프리셋 매핑
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
    "pan up": "pan_up",
    "gentle pan up": "pan_up",
    "pan down": "pan_down",
    "gentle pan down": "pan_down",
    "tilt up": "pan_up",
    "tilt down": "pan_down",
}


def _select_kb_preset(motion: str = ""):
    """motion 힌트로 Ken Burns 프리셋 선택. 매칭 안 되면 랜덤.
    "none" → None 반환 (정적), 프리셋 ID 직접 매칭 지원.
    """
    if motion:
        motion_lower = motion.lower().strip()
        if motion_lower == "none":
            return None  # 정적: Ken Burns 미적용
        # 프리셋 ID 직접 매칭 (UI에서 선택)
        if motion_lower in _KB_PRESETS:
            return _KB_PRESETS[motion_lower]
        # 긴 구문부터 매칭
        for hint in sorted(_MOTION_MAP.keys(), key=len, reverse=True):
            if hint in motion_lower:
                return _KB_PRESETS[_MOTION_MAP[hint]]
    return random.choice(list(_KB_PRESETS.values()))


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
                    slide_bg_map: dict | None = None) -> list[str]:
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

    for s in sorted(slide_durations.keys()):
        img_path = os.path.join(image_dir, f"slide_{s}.png")
        overlay_path = os.path.join(image_dir, f"slide_{s}_overlay.png")
        audio_path = merged_audio[s]
        dur = slide_durations[s]
        has_overlay = os.path.exists(overlay_path)

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

            if video_bg and has_overlay:
                print(f"[video_renderer] slide {s}: video_bg + overlay")
                _render_video_segment(video_bg, overlay_path, audio_path, seg_path,
                                      dur, vcfg)
            elif image_bg and has_overlay:
                print(f"[video_renderer] slide {s}: Ken Burns ({motion or 'random'}) + overlay")
                _render_kenburns_segment(image_bg, overlay_path, audio_path,
                                         seg_path, dur, vcfg, motion=motion)
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


def _render_kenburns_segment(bg_path: str, overlay_path: str, audio_path: str,
                              output_path: str, duration: float, vcfg: dict,
                              motion: str = ""):
    """이미지 배경 + Ken Burns 효과 + PNG 오버레이 + 오디오 합성.
    motion="none"이면 정적 배경 (zoom/pan 없음).
    """
    preset = _select_kb_preset(motion)
    if preset is None:
        # 정적: Ken Burns 없이 이미지 + 오버레이 합성
        _render_static_bg_segment(bg_path, overlay_path, audio_path,
                                   output_path, duration, vcfg)
        return
    zoom_expr, x_expr, y_expr = preset
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
    if _aspect > 0.8:  # 1:1 또는 가로 이미지 (center/top/bottom 레이아웃)
        # Cover 모드: 프레임 전체를 채우도록 스케일 + 중앙 크롭 (검정 여백 제거)
        _scale_h = 2208
        _scale_w = max(1242, int(2208 * _aspect))
        _pad = f",crop=1242:2208:(iw-1242)/2:(ih-2208)/2"
    else:  # 9:16 세로 이미지 (full 레이아웃)
        _scale_w, _scale_h = 1242, 2208
        _pad = ""

    filter_complex = (
        f"[0:v]scale={_scale_w}:{_scale_h},format=rgba{_pad},"
        f"zoompan=z='{zoom_expr}':x='{x_expr}':y='{y_expr}'"
        f":d={total_frames}:s=1080x1920:fps=24[bg];"
        f"[bg][1:v]overlay=0:0:shortest=1[out]"
    )

    result = subprocess.run([
        config.ffmpeg(), "-y",
        "-i", bg_path,
        "-loop", "1", "-i", overlay_path,
        "-i", audio_path,
        "-filter_complex", filter_complex,
        "-map", "[out]", "-map", "2:a",
        "-c:v", "libx264", "-preset", "fast",
        "-c:a", "aac", "-b:a", vcfg["audio_bitrate"],
        "-pix_fmt", "yuv420p",
        "-t", str(duration + 0.1),
        output_path
    ], capture_output=True, text=True)

    if result.returncode != 0:
        print(f"[video_renderer] Ken Burns failed: {result.stderr[:300]}")
        _render_static_segment(
            overlay_path.replace("_overlay.png", ".png"),
            audio_path, output_path, duration, vcfg)


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
