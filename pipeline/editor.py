"""편집 파이프라인 — 텍스트 오버레이 + SFX 적용 후 재렌더."""
from __future__ import annotations
import json
import os
import re
import subprocess
from pipeline import config


def get_editor_data(job_id: str) -> dict:
    """편집에 필요한 세그먼트/오디오/타임라인 정보 반환."""
    job_dir = os.path.join(config.output_dir(), job_id)
    seg_dir = os.path.join(job_dir, "segments")
    img_dir = os.path.join(job_dir, "images")
    bg_dir = os.path.join(job_dir, "backgrounds")
    video_dir = os.path.join(job_dir, "video")

    # 세그먼트 파일 수집 (segment_1.mp4, segment_2.mp4, ...)
    segments = []
    if os.path.isdir(seg_dir):
        # intro → segment_* → outro 순서로 수집
        all_files = os.listdir(seg_dir)
        ordered = []
        for f in all_files:
            if f == "intro.mp4":
                ordered.insert(0, f)
        # segment_* 정렬 (분할 세그먼트 포함: segment_1_0.mp4 등)
        content_segs = [f for f in all_files
                        if f.startswith("segment_") and f.endswith(".mp4") and "edited_" not in f]
        def _seg_key(name):
            m = re.match(r"segment_(\d+)(?:_(\d+))?\.mp4", name)
            return (int(m.group(1)), int(m.group(2) or 0)) if m else (9999, 0)
        ordered.extend(sorted(content_segs, key=_seg_key))
        for f in all_files:
            if f == "outro.mp4":
                ordered.append(f)

        for f in ordered:
            path = os.path.join(seg_dir, f)
            dur = _get_duration(path)
            seg_type = "intro" if f == "intro.mp4" else "outro" if f == "outro.mp4" else "content"
            seg_data = {
                "file": f,
                "duration": dur,
                "type": seg_type,
                "path": f"/api/jobs/{job_id}/segments/{f}",
            }
            # 콘텐츠 세그먼트 → 슬라이드 번호 추출 (segment_3.mp4→3, segment_3_1.mp4→3)
            if seg_type == "content":
                m = re.match(r"segment_(\d+)", f)
                if m:
                    seg_data["slide_num"] = int(m.group(1))
            # 인트로/아웃트로 → 비디오에서 썸네일 추출
            if seg_type in ("intro", "outro"):
                thumb = _extract_thumbnail(path, seg_dir, seg_type)
                if thumb:
                    seg_data["thumbnail"] = f"/api/jobs/{job_id}/segments/{os.path.basename(thumb)}"
            segments.append(seg_data)

    # 슬라이드 이미지 (썸네일용)
    slide_images = []
    if os.path.isdir(img_dir):
        for f in sorted(os.listdir(img_dir)):
            if f.startswith("slide_") and f.endswith(".png") and "_overlay" not in f:
                slide_images.append({
                    "file": f,
                    "path": f"/api/jobs/{job_id}/images/{f}",
                })

    # 배경 파일
    backgrounds = []
    if os.path.isdir(bg_dir):
        for f in sorted(os.listdir(bg_dir)):
            if f.startswith("bg_"):
                backgrounds.append({
                    "file": f,
                    "path": f"/api/jobs/{job_id}/backgrounds/{f}",
                })

    # 최종 영상
    final_video = ""
    if os.path.isdir(video_dir):
        for f in os.listdir(video_dir):
            if f.endswith(".mp4"):
                final_video = f"/api/jobs/{job_id}/video"
                break

    # 기존 편집 데이터 로드
    edit_data = load_edit_data(job_id)

    # SFX 목록 (data/sfx/)
    sfx_list = _list_audio_files("sfx")
    bgm_list = _list_audio_files("bgm")

    return {
        "job_id": job_id,
        "segments": segments,
        "slide_images": slide_images,
        "backgrounds": backgrounds,
        "final_video": final_video,
        "edit_data": edit_data,
        "sfx_list": sfx_list,
        "bgm_list": bgm_list,
        "total_duration": sum(s["duration"] for s in segments),
    }


def load_edit_data(job_id: str) -> dict:
    """편집 데이터 로드 (edit_data.json)."""
    path = _edit_data_path(job_id)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"text_overlays": [], "sfx_markers": []}


def save_edit_data(job_id: str, data: dict):
    """편집 데이터 저장."""
    path = _edit_data_path(job_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def apply_edits(job_id: str) -> str:
    """편집 데이터를 기존 최종 영상 위에 적용.

    기존 최종 영상(BGM+인트로SFX 포함)을 원본으로 사용하고,
    에디터에서 추가한 SFX 마커만 추가 믹싱합니다.

    Returns:
        최종 영상 경로
    """
    job_dir = os.path.join(config.output_dir(), job_id)
    video_dir = os.path.join(job_dir, "video")
    edit_data = load_edit_data(job_id)
    os.makedirs(video_dir, exist_ok=True)

    final_path = os.path.join(video_dir, f"{job_id}.mp4")
    backup_path = os.path.join(video_dir, f"{job_id}_backup.mp4")

    # 원본 백업 (최초 1회) — 항상 원본 기준으로 작업
    if not os.path.exists(backup_path) and os.path.exists(final_path):
        import shutil
        shutil.copy2(final_path, backup_path)
        print(f"[editor] 원본 백업 생성: {backup_path}")

    # 원본 영상 (백업이 있으면 백업 = 원본, 없으면 현재 파일)
    source_path = backup_path if os.path.exists(backup_path) else final_path
    if not os.path.exists(source_path):
        raise RuntimeError("원본 영상 파일이 없습니다")

    sfx_markers = edit_data.get("sfx_markers", [])
    print(f"[editor] SFX markers: {len(sfx_markers)}개, 원본: {source_path}")

    if not sfx_markers:
        # SFX 없으면 원본 복원
        if source_path != final_path:
            import shutil
            shutil.copy2(source_path, final_path)
            print("[editor] SFX 없음 — 원본 복원")
        return final_path

    # SFX 마커를 원본 영상에 추가 믹싱
    sfx_out = os.path.join(video_dir, f"{job_id}_sfx.mp4")
    _apply_sfx_markers(source_path, sfx_out, sfx_markers)

    if os.path.exists(sfx_out) and os.path.getsize(sfx_out) > 0:
        os.replace(sfx_out, final_path)
        print(f"[editor] SFX 적용 완료: {final_path}")
    else:
        print("[editor] SFX 출력 실패 — 원본 유지")

    return final_path


def _apply_text_overlays(input_path: str, output_path: str,
                         overlays: list[dict]):
    """ffmpeg drawtext 필터로 텍스트 오버레이 적용."""
    filters = []
    for t in overlays:
        text = t.get("text", "").replace("'", "\\'").replace(":", "\\:")
        x = t.get("x", 540)
        y = t.get("y", 960)
        font_size = t.get("font_size", 48)
        font_color = t.get("font_color", "white")
        bg_color = t.get("bg_color", "")
        start = t.get("start_time", 0)
        end = t.get("end_time", 999)

        dt = f"drawtext=text='{text}'"
        dt += f":x={x}:y={y}"
        dt += f":fontsize={font_size}"
        dt += f":fontcolor={font_color}"
        if bg_color:
            dt += f":box=1:boxcolor={bg_color}@0.7:boxborderw=8"
        dt += f":enable='between(t,{start},{end})'"

        # 한국어 폰트
        font_file = _find_korean_font()
        if font_file:
            dt += f":fontfile='{font_file}'"

        filters.append(dt)

    vf = ",".join(filters) if filters else "copy"
    cmd = [
        config.ffmpeg(), "-y",
        "-i", input_path,
        "-vf", vf,
        "-c:v", "libx264", "-preset", "fast",
        "-c:a", "copy",
        output_path,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"[editor] drawtext failed: {r.stderr[:500]}")
        # 실패 시 원본 복사
        import shutil
        shutil.copy2(input_path, output_path)


def _apply_sfx_markers(input_path: str, output_path: str,
                       markers: list[dict]):
    """SFX 마커들을 영상에 믹싱."""
    sfx_dir = os.path.join(config.root_dir(), "data", "sfx")

    inputs = ["-i", input_path]
    filter_parts = []
    amix_parts = []
    sfx_idx = 0

    # 원본 오디오 유무 확인
    has_audio = _has_audio_stream(input_path)
    if has_audio:
        # 원본 오디오를 anull로 패스스루
        filter_parts.append("[0:a]anull[orig]")
        amix_parts.append("[orig]")
    else:
        # 오디오 없으면 무음 생성
        dur = _get_duration(input_path)
        filter_parts.append(
            f"anullsrc=r=44100:cl=stereo:d={dur}[silence]"
        )
        amix_parts.append("[silence]")

    for i, m in enumerate(markers):
        sfx_file = os.path.join(sfx_dir, m.get("file", ""))
        if not os.path.exists(sfx_file):
            print(f"[editor] SFX 파일 없음: {sfx_file}")
            continue
        input_idx = len(inputs) // 2  # -i 쌍 기준 인덱스
        inputs.extend(["-i", sfx_file])
        vol = m.get("volume", 0.8)
        delay_ms = int(m.get("time", 0) * 1000)
        filter_parts.append(
            f"[{input_idx}:a]volume={vol},adelay={delay_ms}|{delay_ms}[sfx{i}]"
        )
        amix_parts.append(f"[sfx{i}]")
        sfx_idx += 1

    if sfx_idx == 0:
        import shutil
        shutil.copy2(input_path, output_path)
        return

    # amix로 전부 믹싱
    n = len(amix_parts)
    filter_str = ";".join(filter_parts)
    filter_str += f";{''.join(amix_parts)}amix=inputs={n}:duration=first:dropout_transition=2[out]"

    cmd = [
        config.ffmpeg(), "-y",
        *inputs,
        "-filter_complex", filter_str,
        "-map", "0:v", "-map", "[out]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        output_path,
    ]
    print(f"[editor] SFX mix cmd: {' '.join(cmd[:6])}... ({sfx_idx} SFX markers)")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"[editor] SFX mix failed: {r.stderr[:500]}")
        import shutil
        shutil.copy2(input_path, output_path)
    else:
        print(f"[editor] SFX mix 성공: {output_path}")


def _concat_segments(segments: list[str], output_path: str):
    """세그먼트들을 concat demuxer로 합침."""
    list_file = output_path + ".txt"
    with open(list_file, "w", encoding="utf-8") as f:
        for seg in segments:
            f.write(f"file '{seg}'\n")
    cmd = [
        config.ffmpeg(), "-y",
        "-f", "concat", "-safe", "0",
        "-i", list_file,
        "-c", "copy",
        output_path,
    ]
    subprocess.run(cmd, capture_output=True)
    if os.path.exists(list_file):
        os.remove(list_file)


def _collect_segments(seg_dir: str) -> list[str]:
    """세그먼트 파일 수집 (intro, segment_*, outro 순서)."""
    if not os.path.isdir(seg_dir):
        return []
    files = sorted(os.listdir(seg_dir))
    result = []
    # intro 먼저
    for f in files:
        if f == "intro.mp4":
            result.append(f)
    # segment_* 순서대로 (segment_1.mp4, segment_1_0.mp4, segment_1_1.mp4, ...)
    segs = [f for f in files if f.startswith("segment_") and f.endswith(".mp4")
            and not f.startswith("edited_")]
    def _seg_sort_key(name):
        m = re.match(r"segment_(\d+)(?:_(\d+))?\.mp4", name)
        if m:
            return (int(m.group(1)), int(m.group(2) or 0))
        return (9999, 0)
    result.extend(sorted(segs, key=_seg_sort_key))
    # outro 마지막
    for f in files:
        if f == "outro.mp4":
            result.append(f)
    return result


def _has_audio_stream(path: str) -> bool:
    """ffprobe로 오디오 스트림 유무 확인."""
    try:
        r = subprocess.run([
            config.ffprobe(), "-v", "error",
            "-select_streams", "a",
            "-show_entries", "stream=codec_type",
            "-of", "csv=p=0",
            path,
        ], capture_output=True, text=True, timeout=10)
        return bool(r.stdout.strip())
    except Exception:
        return False


def _extract_thumbnail(video_path: str, seg_dir: str, name: str) -> str | None:
    """비디오 첫 프레임을 썸네일로 추출. 이미 있으면 재사용."""
    thumb_path = os.path.join(seg_dir, f"{name}_thumb.jpg")
    if os.path.exists(thumb_path):
        return thumb_path
    if not os.path.exists(video_path):
        return None
    try:
        cmd = [
            config.ffmpeg(), "-y",
            "-i", video_path,
            "-vframes", "1",
            "-q:v", "5",
            thumb_path,
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and os.path.exists(thumb_path):
            return thumb_path
    except Exception:
        pass
    return None


def _get_duration(path: str) -> float:
    """ffprobe로 영상 길이(초) 반환."""
    try:
        r = subprocess.run([
            config.ffprobe(), "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
        ], capture_output=True, text=True, timeout=10)
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def _list_audio_files(subdir: str) -> list[dict]:
    """data/{subdir}/ 폴더의 오디오 파일 목록."""
    audio_dir = os.path.join(config.root_dir(), "data", subdir)
    if not os.path.isdir(audio_dir):
        return []
    result = []
    for f in sorted(os.listdir(audio_dir)):
        if f.lower().endswith((".mp3", ".wav", ".ogg", ".m4a")):
            path = os.path.join(audio_dir, f)
            dur = _get_duration(path)
            result.append({
                "file": f,
                "duration": dur,
                "path": f"/api/audio/{subdir}/{f}",
            })
    return result


def _find_korean_font() -> str:
    """시스템에서 한국어 폰트 경로 검색."""
    candidates = [
        "C:/Windows/Fonts/malgun.ttf",         # 맑은 고딕
        "C:/Windows/Fonts/NanumGothic.ttf",
        "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
        "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c.replace("\\", "/")
    return ""


def _edit_data_path(job_id: str) -> str:
    return os.path.join(config.output_dir(), job_id, "edit_data.json")
