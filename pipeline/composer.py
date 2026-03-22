"""프리프로덕션 편집기(Composer) — 슬라이드+나레이션+SFX/BGM 조립 후 렌더링."""
from __future__ import annotations
import json
import os
from pipeline import config
from pipeline.editor import _list_audio_files, _get_duration


def get_composer_data(job_id: str, script: dict | None = None,
                      channel_config: dict | None = None) -> dict:
    """편집기에 필요한 슬라이드/배경/오디오/SFX/BGM 데이터 수집."""
    job_dir = os.path.join(config.output_dir(), job_id)
    bg_dir = os.path.join(job_dir, "backgrounds")
    audio_dir = os.path.join(job_dir, "audio")

    slides = []
    if script:
        raw_slides = script.get("slides", [])
        sentences = script.get("sentences", [])
        # 문장→슬라이드 매핑으로 정확한 오디오 연결
        slide_audio_map = get_slide_audio_files(job_id, script)

        for i, sl in enumerate(raw_slides):
            slide_num = i + 1
            slide_sents = [s for s in sentences if s.get("slide") == slide_num]
            bg_file, bg_url = _find_bg(bg_dir, slide_num, job_id)
            audio_files = slide_audio_map.get(slide_num, [])

            slides.append({
                "num": slide_num,
                "main": sl.get("main", ""),
                "sub": sl.get("sub", ""),
                "bg_type": sl.get("bg_type", "photo"),
                "category": sl.get("category", ""),
                "sentences": slide_sents,
                "bg_file": bg_file,
                "bg_url": bg_url,
                "audio_files": audio_files,
                "duration": sum(a["duration"] for a in audio_files) if audio_files else 3.0,
            })

    # SFX/BGM
    sfx_list = _list_audio_files("sfx")
    bgm_list = _list_audio_files("bgm")

    # composer 편집 상태 로드
    compose_data = load_compose_data(job_id)

    # TTS 음성 목록
    from pipeline.tts_generator import EDGE_VOICES, GOOGLE_CLOUD_VOICES
    tts_voices = {
        "edge-tts": {k: v for k, v in EDGE_VOICES.items()},
        "google-cloud": {k: v for k, v in GOOGLE_CLOUD_VOICES.items()},
    }

    return {
        "job_id": job_id,
        "slides": slides,
        "sfx_list": sfx_list,
        "bgm_list": bgm_list,
        "compose_data": compose_data,
        "channel_config": channel_config or {},
        "tts_voices": tts_voices,
    }


def _find_bg(bg_dir: str, slide_num: int, job_id: str) -> tuple[str, str]:
    """슬라이드 번호에 해당하는 배경 파일 검색."""
    if not os.path.isdir(bg_dir):
        return "", ""
    for ext in ("jpg", "jpeg", "png", "webp", "mp4", "gif"):
        fname = f"bg_{slide_num}.{ext}"
        if os.path.exists(os.path.join(bg_dir, fname)):
            return fname, f"/api/jobs/{job_id}/backgrounds/{fname}"
    return "", ""


def _find_slide_audio(audio_dir: str, slide_num: int,
                      sentence_count: int, job_id: str) -> list[dict]:
    """슬라이드에 속하는 오디오 파일 목록 반환."""
    if not os.path.isdir(audio_dir):
        return []
    result = []
    # audio_dir의 모든 파일 중 매칭 (audio_1.mp3, audio_2.mp3, ...)
    for f in sorted(os.listdir(audio_dir)):
        if not f.startswith("audio_"):
            continue
        for ext in ("mp3", "wav", "m4a"):
            if f.endswith(f".{ext}"):
                path = os.path.join(audio_dir, f)
                dur = _get_duration(path)
                result.append({
                    "file": f,
                    "path": f"/api/jobs/{job_id}/audio/{f}",
                    "duration": dur,
                })
                break
    return result


def get_slide_audio_files(job_id: str, script: dict) -> dict:
    """문장-슬라이드 매핑으로 슬라이드별 오디오 파일 반환."""
    audio_dir = os.path.join(config.output_dir(), job_id, "audio")
    sentences = script.get("sentences", [])
    slide_audio: dict[int, list[dict]] = {}

    for i, sen in enumerate(sentences):
        slide_num = sen.get("slide", 1)
        if slide_num not in slide_audio:
            slide_audio[slide_num] = []
        # 오디오 파일 확인
        for ext in ("mp3", "wav"):
            fpath = os.path.join(audio_dir, f"audio_{i+1}.{ext}")
            if os.path.exists(fpath):
                dur = _get_duration(fpath)
                slide_audio[slide_num].append({
                    "file": f"audio_{i+1}.{ext}",
                    "path": f"/api/jobs/{job_id}/audio/{f'audio_{i+1}.{ext}'}",
                    "duration": dur,
                    "sentence_idx": i,
                    "text": sen.get("text", ""),
                })
                break

    return slide_audio


def load_compose_data(job_id: str) -> dict:
    """편집 상태 로드."""
    path = _compose_data_path(job_id)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"slide_order": [], "slide_durations": {}, "sfx_markers": [], "bgm": None}


def save_compose_data(job_id: str, data: dict):
    """편집 상태 저장."""
    path = _compose_data_path(job_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _compose_data_path(job_id: str) -> str:
    return os.path.join(config.output_dir(), job_id, "compose_data.json")


# ─── Narration File Pool ───

def _narr_files_dir(job_id: str) -> str:
    return os.path.join(config.output_dir(), job_id, "narration_files")


def list_narration_files(job_id: str) -> list[dict]:
    """narration_files/ 폴더의 파일 목록 + duration 반환."""
    d = _narr_files_dir(job_id)
    if not os.path.isdir(d):
        return []
    result = []
    for f in sorted(os.listdir(d)):
        ext = f.rsplit(".", 1)[-1].lower() if "." in f else ""
        if ext not in ("mp3", "wav", "m4a", "ogg", "flac"):
            continue
        path = os.path.join(d, f)
        dur = _get_duration(path)
        result.append({
            "filename": f,
            "duration": dur,
            "url": f"/api/jobs/{job_id}/narration-files/{f}",
        })
    return result


def save_narration_files(job_id: str, files: list[tuple[str, bytes]]) -> list[dict]:
    """여러 음성 파일을 narration_files/ 폴더에 저장. 파일명 중복 시 접미사 부여."""
    d = _narr_files_dir(job_id)
    os.makedirs(d, exist_ok=True)
    saved = []
    for orig_name, content in files:
        name = _unique_filename(d, orig_name)
        path = os.path.join(d, name)
        with open(path, "wb") as fp:
            fp.write(content)
        dur = _get_duration(path)
        saved.append({
            "filename": name,
            "duration": dur,
            "url": f"/api/jobs/{job_id}/narration-files/{name}",
        })
    return saved


def delete_narration_file(job_id: str, filename: str) -> bool:
    """narration_files/ 에서 파일 삭제."""
    path = os.path.join(_narr_files_dir(job_id), filename)
    if os.path.exists(path):
        os.remove(path)
        return True
    return False


def assign_narration_to_slide(job_id: str, slide_num: int,
                               source_file: str, script: dict) -> dict:
    """narration_files/ 의 파일을 해당 슬라이드 오디오로 복사."""
    import shutil
    src = os.path.join(_narr_files_dir(job_id), source_file)
    if not os.path.exists(src):
        raise FileNotFoundError(f"파일 없음: {source_file}")

    sentences = script.get("sentences", [])
    audio_dir = os.path.join(config.output_dir(), job_id, "audio")
    os.makedirs(audio_dir, exist_ok=True)

    # 해당 슬라이드 첫 번째 문장 인덱스
    first_idx = None
    for i, sen in enumerate(sentences):
        if sen.get("slide") == slide_num:
            if first_idx is None:
                first_idx = i

    if first_idx is None:
        raise ValueError(f"슬라이드 {slide_num}에 해당하는 문장 없음")

    # 기존 오디오 삭제
    for i, sen in enumerate(sentences):
        if sen.get("slide") == slide_num:
            for e in ("mp3", "wav", "m4a"):
                old = os.path.join(audio_dir, f"audio_{i+1}.{e}")
                if os.path.exists(old):
                    os.remove(old)

    ext = source_file.rsplit(".", 1)[-1] if "." in source_file else "mp3"
    out_path = os.path.join(audio_dir, f"audio_{first_idx + 1}.{ext}")
    shutil.copy2(src, out_path)

    dur = _get_duration(out_path)
    return {"ok": True, "file": f"audio_{first_idx + 1}.{ext}", "duration": dur}


def _unique_filename(directory: str, name: str) -> str:
    """디렉토리 내 중복 방지 파일명 생성."""
    if not os.path.exists(os.path.join(directory, name)):
        return name
    base, ext = (name.rsplit(".", 1) + [""])[:2]
    counter = 1
    while True:
        candidate = f"{base}_{counter}.{ext}" if ext else f"{base}_{counter}"
        if not os.path.exists(os.path.join(directory, candidate)):
            return candidate
        counter += 1
