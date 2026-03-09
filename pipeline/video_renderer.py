"""ffmpeg 기반 영상 합성기"""
from __future__ import annotations
import glob
import os
import random
import subprocess
from pipeline import config


# Ken Burns 효과 프리셋 (zoompan 필터용)
# 각 프리셋: (zoom_expr, x_expr, y_expr, 설명)
# 출력 해상도 1080x1920, 입력은 여유 있게 스케일 (1.15배)
_KB_PRESETS = [
    # 느린 줌인 (중앙)
    ("min(1.15,1+0.0015*in)", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
    # 느린 줌아웃
    ("if(eq(in,1),1.15,max(1,zoom-0.0015))", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
    # 줌인 + 좌→우 패닝
    ("min(1.15,1+0.001*in)", "iw/2-(iw/zoom/2)+in*0.3", "ih/2-(ih/zoom/2)"),
    # 줌인 + 우→좌 패닝
    ("min(1.15,1+0.001*in)", "iw/2-(iw/zoom/2)-in*0.3", "ih/2-(ih/zoom/2)"),
    # 줌인 + 상→하 패닝
    ("min(1.15,1+0.001*in)", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)+in*0.2"),
    # 줌아웃 + 하→상 패닝
    ("if(eq(in,1),1.15,max(1,zoom-0.001))", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)-in*0.2"),
]


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


def render_segments(slide_durations: dict, image_dir: str,
                    merged_audio: dict, segment_dir: str) -> list[str]:
    """슬라이드별 세그먼트 영상 생성.

    배경 유형에 따라:
    - 영상 배경 (MP4/GIF) → 영상 루프 + 오버레이
    - 이미지 배경 (PNG/JPG) → Ken Burns 효과 + 오버레이
    - 배경 없음 → 정적 슬라이드

    Returns:
        세그먼트 MP4 파일 경로 리스트 (순서대로)
    """
    os.makedirs(segment_dir, exist_ok=True)
    vcfg = config.video_cfg()
    segment_files = []

    for s in sorted(slide_durations.keys()):
        img_path = os.path.join(image_dir, f"slide_{s}.png")
        overlay_path = os.path.join(image_dir, f"slide_{s}_overlay.png")
        audio_path = merged_audio[s]
        seg_path = os.path.join(segment_dir, f"segment_{s}.mp4")
        dur = slide_durations[s]

        video_bg = _find_video_bg(image_dir, s)
        image_bg = _find_image_bg(image_dir, s)

        if video_bg and os.path.exists(overlay_path):
            # 영상 배경 + 투명 오버레이 합성
            _render_video_segment(video_bg, overlay_path, audio_path, seg_path,
                                  dur, vcfg)
        elif image_bg and os.path.exists(overlay_path):
            # 이미지 배경 + Ken Burns + 오버레이
            _render_kenburns_segment(image_bg, overlay_path, audio_path,
                                     seg_path, dur, vcfg)
        else:
            # 정적 슬라이드 (배경 없음 또는 오버레이 없음)
            _render_static_segment(img_path, audio_path, seg_path, dur, vcfg)

        segment_files.append(seg_path)

    return segment_files


def _render_static_segment(img_path: str, audio_path: str,
                            output_path: str, duration: float, vcfg: dict):
    """정적 이미지 슬라이드"""
    subprocess.run([
        config.ffmpeg(), "-y",
        "-loop", "1", "-i", img_path,
        "-i", audio_path,
        "-c:v", "libx264", "-tune", "stillimage",
        "-c:a", "aac", "-b:a", vcfg["audio_bitrate"],
        "-pix_fmt", "yuv420p",
        "-shortest",
        "-t", str(duration + 0.1),
        output_path
    ], capture_output=True)


def _render_kenburns_segment(bg_path: str, overlay_path: str, audio_path: str,
                              output_path: str, duration: float, vcfg: dict):
    """이미지 배경 + Ken Burns 효과 + PNG 오버레이 + 오디오 합성"""
    preset = random.choice(_KB_PRESETS)
    zoom_expr, x_expr, y_expr = preset
    total_frames = int(duration * 24) + 5  # 24fps

    # zoompan: 입력 이미지를 줌/패닝하여 영상화
    # 입력을 1.15배 스케일하여 줌아웃 시에도 검은 테두리 방지
    filter_complex = (
        f"[0:v]scale=1242:2208,format=rgba,"
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
        "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,"
        "crop=1080:1920,fps=24[bg];"
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


def concat_segments(segment_files: list[str], output_path: str) -> str:
    """세그먼트들을 하나의 최종 영상으로 합침.

    Returns:
        최종 영상 파일 경로
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
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

    if not os.path.exists(output_path):
        raise RuntimeError("Video rendering failed")

    return output_path
