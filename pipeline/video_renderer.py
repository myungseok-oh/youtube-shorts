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


def render_static_silent(image_path: str, output_path: str,
                          duration: float, vcfg: dict):
    """정적 이미지 → 무음 오디오 포함 MP4 (Ken Burns 효과, 1080x1920, 24fps).

    인트로/아웃트로 세그먼트 생성용. concat demuxer 호환을 위해 무음 오디오 트랙 포함.
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    preset = random.choice(_KB_PRESETS)
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
    preset = random.choice(_KB_PRESETS)
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
        has_overlay = os.path.exists(overlay_path)

        if video_bg and has_overlay:
            print(f"[video_renderer] slide {s}: video_bg + overlay")
            _render_video_segment(video_bg, overlay_path, audio_path, seg_path,
                                  dur, vcfg)
        elif image_bg and has_overlay:
            print(f"[video_renderer] slide {s}: Ken Burns + overlay")
            _render_kenburns_segment(image_bg, overlay_path, audio_path,
                                     seg_path, dur, vcfg)
        else:
            print(f"[video_renderer] slide {s}: static (bg={bool(image_bg)}, overlay={has_overlay})")
            _render_static_segment(img_path, audio_path, seg_path, dur, vcfg)

        segment_files.append(seg_path)

    return segment_files


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


def concat_segments(segment_files: list[str], output_path: str,
                    sfx_cfg: dict | None = None,
                    slide_durations: dict | None = None) -> str:
    """세그먼트들을 하나의 최종 영상으로 합침 (크로스페이드) + BGM/효과음 믹싱.

    Args:
        sfx_cfg: 채널 config dict (sfx_*, bgm_*, crossfade_* 설정 포함)
        slide_durations: {슬라이드번호: 초} — 전환 시점 계산용

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
    if sfx_cfg:
        xfade_dur = sfx_cfg.get("crossfade_duration", 0.5) or 0.5

    print(f"[video_renderer] concat_segments: {len(segment_files)} files, "
          f"xfade={xfade_dur}s, sfx={bool(needs_sfx)}, bgm={bool(needs_bgm)}")

    actual_xfade = 0  # 실제 적용된 xfade 시간 (fallback 시 0)
    if len(segment_files) >= 2 and xfade_dur > 0:
        try:
            _concat_with_xfade(segment_files, concat_out, slide_durations, xfade_dur)
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
                       slide_durations: dict | None, xfade_dur: float):
    """xfade 크로스페이드로 세그먼트 합성.

    영상: xfade=transition=fade (모든 입력을 1080x1920/24fps로 정규화)
    오디오: acrossfade (44100Hz/stereo로 정규화)
    """
    n = len(segment_files)
    if n < 2:
        _concat_simple(segment_files, output_path)
        return

    # 세그먼트별 실제 길이 조회
    durations = []
    if slide_durations:
        for s in sorted(slide_durations.keys()):
            durations.append(slide_durations[s])
    if len(durations) != n:
        durations = [_get_segment_duration(seg) for seg in segment_files]

    # xfade 시간이 세그먼트보다 길면 줄임
    xd = min(xfade_dur, min(durations) * 0.4)

    # 입력 파일
    inputs = []
    for seg in segment_files:
        inputs.extend(["-i", seg])

    # filter_complex 구성
    # 1) 각 입력의 비디오/오디오를 정규화 (fps, 해상도, 오디오 포맷 통일)
    # 2) xfade 체인 (비디오), acrossfade 체인 (오디오)
    norm_filters = []
    for i in range(n):
        norm_filters.append(
            f"[{i}:v]fps=24,scale=1080:1920:force_original_aspect_ratio=decrease,"
            f"pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[nv{i}]"
        )
        norm_filters.append(
            f"[{i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[na{i}]"
        )

    vfilters = []
    afilters = []
    offset = durations[0] - xd  # 첫 xfade 시작점

    for i in range(1, n):
        vin = f"[xv{i-2}]" if i >= 2 else f"[nv0]"
        vout = f"[xv{i-1}]" if i < n - 1 else "[vout]"
        vfilters.append(
            f"{vin}[nv{i}]xfade=transition=fade:duration={xd:.3f}:offset={offset:.3f}{vout}"
        )

        ain = f"[xa{i-2}]" if i >= 2 else f"[na0]"
        aout = f"[xa{i-1}]" if i < n - 1 else "[aout]"
        afilters.append(
            f"{ain}[na{i}]acrossfade=d={xd:.3f}:c1=tri:c2=tri{aout}"
        )

        if i < n - 1:
            offset += durations[i] - xd

    filter_complex = ";".join(norm_filters + vfilters + afilters)

    print(f"[video_renderer] xfade: {n} segments, xd={xd:.3f}s, durations={durations}")

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
    mix_labels = ["[0:a]"]  # 원본 오디오는 항상 첫 번째
    input_idx = 1  # 0 = 원본 영상

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
