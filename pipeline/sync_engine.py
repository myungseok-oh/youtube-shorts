"""타임라인 동기화 엔진 — 오디오와 슬라이드 매핑 계산"""
from __future__ import annotations
import os
import shutil
import subprocess
from pipeline import config
from pipeline.tts_generator import get_audio_duration


def build_timeline(script: list[dict], audio_dir: str) -> dict:
    """스크립트와 오디오 파일로부터 슬라이드별 타임라인 계산.

    Args:
        script: [{"text": "...", "slide": 1}, ...]
        audio_dir: 오디오 파일 디렉토리

    Returns:
        {
            "durations": [float, ...],          # 문장별 오디오 길이
            "slide_durations": {1: float, ...}, # 슬라이드별 총 시간
            "slide_audio_map": {1: ["path", ...], ...},
            "total_duration": float
        }
    """
    durations = []
    slide_durations = {}
    slide_audio_map = {}

    for i, item in enumerate(script):
        # mp3 또는 wav 파일 탐색 (GPT-SoVITS는 wav 생성)
        audio_path = os.path.join(audio_dir, f"audio_{i + 1}.mp3")
        if not os.path.exists(audio_path):
            audio_path = os.path.join(audio_dir, f"audio_{i + 1}.wav")
        dur = get_audio_duration(audio_path)
        durations.append(dur)

        s = item["slide"]
        slide_durations[s] = slide_durations.get(s, 0) + dur
        slide_audio_map.setdefault(s, []).append(audio_path)

    total = sum(slide_durations.values())
    return {
        "durations": durations,
        "slide_durations": slide_durations,
        "slide_audio_map": slide_audio_map,
        "total_duration": total,
    }


def merge_slide_audio(slide_audio_map: dict, segment_dir: str) -> dict[int, str]:
    """같은 슬라이드에 매핑된 오디오 파일들을 하나로 합침.

    Returns:
        {slide_num: merged_audio_path, ...}
    """
    os.makedirs(segment_dir, exist_ok=True)
    merged = {}

    for s in sorted(slide_audio_map.keys()):
        files = slide_audio_map[s]
        # 확장자를 소스 파일에 맞춤 (wav/mp3)
        ext = os.path.splitext(files[0])[1] if files else ".mp3"
        merged_path = os.path.join(segment_dir, f"slide_audio_{s}{ext}")

        if len(files) == 1:
            shutil.copy2(files[0], merged_path)
        else:
            list_file = os.path.join(segment_dir, f"concat_list_{s}.txt")
            with open(list_file, "w", encoding="utf-8") as f:
                for fp in files:
                    abs_fp = os.path.abspath(fp).replace("\\", "/")
                    f.write(f"file '{abs_fp}'\n")
            subprocess.run(
                [config.ffmpeg(), "-y", "-f", "concat", "-safe", "0",
                 "-i", list_file, "-c", "copy", merged_path],
                capture_output=True
            )

        merged[s] = merged_path

    return merged
