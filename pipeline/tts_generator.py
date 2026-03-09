"""TTS 음성 생성 — Edge TTS / Google Cloud TTS / GPT-SoVITS 지원"""
from __future__ import annotations
import asyncio
import base64
import os
import subprocess
import threading
import requests
from pipeline import config


EDGE_VOICES = {
    "ko-KR-HyunsuNeural": "현수 (남성)",
    "ko-KR-HyunsuMultilingualNeural": "현수 멀티링구얼 (남성)",
    "ko-KR-InJoonNeural": "인준 (남성)",
    "ko-KR-SunHiNeural": "선히 (여성)",
}

GOOGLE_CLOUD_VOICES = {
    "ko-KR-Wavenet-A": "Wavenet A (여성)",
    "ko-KR-Wavenet-B": "Wavenet B (여성)",
    "ko-KR-Wavenet-C": "Wavenet C (남성)",
    "ko-KR-Wavenet-D": "Wavenet D (남성)",
    "ko-KR-Neural2-A": "Neural2 A (여성)",
    "ko-KR-Neural2-B": "Neural2 B (여성)",
    "ko-KR-Neural2-C": "Neural2 C (남성)",
}

DEFAULT_VOICE = "ko-KR-SunHiNeural"

GOOGLE_TTS_KEY_PATH = os.path.join(config.root_dir(), "data", "google-tts.json")
_google_creds = None
_google_creds_lock = threading.Lock()

SOVITS_DEFAULT_HOST = "127.0.0.1"
SOVITS_DEFAULT_PORT = 9880


def _get_google_tts_token() -> str:
    """서비스 계정 키파일에서 access token 획득 (자동 갱신)."""
    global _google_creds
    from google.oauth2 import service_account
    from google.auth.transport.requests import Request

    with _google_creds_lock:
        if _google_creds is None:
            if not os.path.exists(GOOGLE_TTS_KEY_PATH):
                raise RuntimeError(
                    f"Google Cloud TTS 키 파일이 없습니다: {GOOGLE_TTS_KEY_PATH}")
            _google_creds = service_account.Credentials.from_service_account_file(
                GOOGLE_TTS_KEY_PATH,
                scopes=["https://www.googleapis.com/auth/cloud-platform"],
            )
        if not _google_creds.valid:
            _google_creds.refresh(Request())
        return _google_creds.token


async def _edge_tts_generate(text: str, voice: str, out_path: str,
                              rate: str = "+0%"):
    """Edge TTS로 음성 생성."""
    import edge_tts
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    await communicate.save(out_path)


def _generate_edge(sentences: list[dict], audio_dir: str,
                   voice: str, rate: str = "+0%") -> list[str]:
    """Edge TTS로 전체 문장 음성 생성."""
    paths = []
    for i, item in enumerate(sentences):
        out_path = os.path.join(audio_dir, f"audio_{i + 1}.mp3")
        asyncio.run(_edge_tts_generate(item["text"], voice, out_path, rate=rate))
        paths.append(out_path)
    return paths


def _generate_google_cloud(sentences: list[dict], audio_dir: str,
                           voice: str,
                           rate: str = "+0%") -> list[str]:
    """Google Cloud TTS REST API로 음성 생성 (서비스 계정 인증)."""
    token = _get_google_tts_token()

    # rate 변환: "+10%" → 1.1, "-20%" → 0.8
    speaking_rate = 1.0
    try:
        rate_val = int(rate.replace("%", "").replace("+", ""))
        speaking_rate = 1.0 + rate_val / 100.0
    except (ValueError, AttributeError):
        pass
    speaking_rate = max(0.25, min(4.0, speaking_rate))

    url = "https://texttospeech.googleapis.com/v1/text:synthesize"
    headers = {"Authorization": f"Bearer {token}"}
    paths = []
    for i, item in enumerate(sentences):
        out_path = os.path.join(audio_dir, f"audio_{i + 1}.mp3")
        resp = requests.post(url, headers=headers, json={
            "input": {"text": item["text"]},
            "voice": {"languageCode": "ko-KR", "name": voice},
            "audioConfig": {
                "audioEncoding": "MP3",
                "speakingRate": speaking_rate,
            },
        }, timeout=30)
        if resp.status_code != 200:
            err = resp.text[:300] if resp.text else f"HTTP {resp.status_code}"
            raise RuntimeError(f"Google Cloud TTS 실패 (문장 {i+1}): {err}")
        audio_bytes = base64.b64decode(resp.json()["audioContent"])
        with open(out_path, "wb") as f:
            f.write(audio_bytes)
        paths.append(out_path)
    return paths


def _generate_sovits(sentences: list[dict], audio_dir: str,
                     sovits_cfg: dict) -> list[str]:
    """GPT-SoVITS API로 슬라이드 단위 음성 생성 (문장을 슬라이드별로 합쳐서 호출 수 감소)."""
    import requests

    host = sovits_cfg.get("host", SOVITS_DEFAULT_HOST)
    port = sovits_cfg.get("port", SOVITS_DEFAULT_PORT)
    ref_audio = sovits_cfg.get("ref_audio", "")
    ref_text = sovits_cfg.get("ref_text", "")
    speed = sovits_cfg.get("speed", 1.0)

    if not ref_audio or not os.path.exists(ref_audio):
        raise RuntimeError(f"GPT-SoVITS 참조 음성 파일이 없습니다: {ref_audio}")

    url = f"http://{host}:{port}/tts"

    # 슬라이드별로 문장 그룹핑
    slide_groups = {}
    for i, item in enumerate(sentences):
        slide_num = item.get("slide", i + 1)
        slide_groups.setdefault(slide_num, []).append((i, item["text"]))

    paths = [""] * len(sentences)

    for slide_num in sorted(slide_groups.keys()):
        group = slide_groups[slide_num]
        # 같은 슬라이드의 문장을 합침
        combined_text = "\n".join(text for _, text in group)

        resp = requests.post(url, json={
            "text": combined_text,
            "text_lang": "ko",
            "ref_audio_path": ref_audio,
            "prompt_text": ref_text,
            "prompt_lang": "ko",
            "text_split_method": "cut5",
            "media_type": "wav",
            "speed_factor": speed,
        }, timeout=180)

        if resp.status_code != 200:
            err = resp.text[:200] if resp.text else f"HTTP {resp.status_code}"
            raise RuntimeError(f"GPT-SoVITS TTS 실패 (슬라이드 {slide_num}): {err}")

        if len(group) == 1:
            # 문장 1개 → 그대로 저장
            idx = group[0][0]
            out_path = os.path.join(audio_dir, f"audio_{idx + 1}.wav")
            with open(out_path, "wb") as f:
                f.write(resp.content)
            paths[idx] = out_path
        else:
            # 문장 여러 개 → 슬라이드 오디오를 첫 문장 파일로 저장, 나머지는 빈 파일
            first_idx = group[0][0]
            out_path = os.path.join(audio_dir, f"audio_{first_idx + 1}.wav")
            with open(out_path, "wb") as f:
                f.write(resp.content)
            paths[first_idx] = out_path

            # 나머지 문장은 빈(무음) 마커 파일 → sync_engine에서 처리
            for idx, _ in group[1:]:
                empty_path = os.path.join(audio_dir, f"audio_{idx + 1}.wav")
                _create_silent_wav(empty_path, duration=0.01)
                paths[idx] = empty_path

    return paths


def _create_silent_wav(path: str, duration: float = 0.01):
    """짧은 무음 WAV 파일 생성"""
    import struct
    sample_rate = 24000
    num_samples = int(sample_rate * duration)
    data_size = num_samples * 2  # 16-bit mono

    with open(path, "wb") as f:
        # WAV header
        f.write(b"RIFF")
        f.write(struct.pack("<I", 36 + data_size))
        f.write(b"WAVE")
        f.write(b"fmt ")
        f.write(struct.pack("<I", 16))      # chunk size
        f.write(struct.pack("<H", 1))       # PCM
        f.write(struct.pack("<H", 1))       # mono
        f.write(struct.pack("<I", sample_rate))
        f.write(struct.pack("<I", sample_rate * 2))
        f.write(struct.pack("<H", 2))       # block align
        f.write(struct.pack("<H", 16))      # bits per sample
        f.write(b"data")
        f.write(struct.pack("<I", data_size))
        f.write(b"\x00" * data_size)


def check_sovits_available(host: str = SOVITS_DEFAULT_HOST,
                           port: int = SOVITS_DEFAULT_PORT) -> bool:
    """GPT-SoVITS API 서버 연결 확인"""
    import requests
    try:
        resp = requests.get(f"http://{host}:{port}/docs", timeout=3)
        return resp.status_code == 200
    except Exception:
        return False


def _format_rate(rate_value) -> str:
    """rate 값을 edge-tts 형식 문자열로 변환. 예: 10 → '+10%', -20 → '-20%', '+10%' → '+10%'"""
    if isinstance(rate_value, str) and rate_value.endswith("%"):
        return rate_value  # 이미 포맷된 문자열
    try:
        n = int(rate_value)
    except (TypeError, ValueError):
        return "+0%"
    if n >= 0:
        return f"+{n}%"
    return f"{n}%"


def generate_audio(sentences: list[dict], audio_dir: str,
                   voice: str = "", rate=None,
                   sovits_cfg: dict = None) -> list[str]:
    """문장 리스트로부터 오디오 파일 생성.

    Args:
        sentences: [{"text": "...", "slide": 1}, ...]
        audio_dir: 오디오 저장 디렉토리
        voice: TTS 음성 이름 (Edge TTS / Google Cloud TTS voice name)
        rate: 속도 조절 (-50 ~ 200, 정수). None이면 기본 속도.
        sovits_cfg: GPT-SoVITS 설정 dict (있으면 GPT-SoVITS 사용)

    Returns:
        생성된 오디오 파일 경로 리스트
    """
    os.makedirs(audio_dir, exist_ok=True)

    # GPT-SoVITS 모드
    if sovits_cfg and sovits_cfg.get("ref_audio"):
        return _generate_sovits(sentences, audio_dir, sovits_cfg)

    rate_str = _format_rate(rate) if rate is not None else "+0%"

    if voice and voice in GOOGLE_CLOUD_VOICES:
        return _generate_google_cloud(sentences, audio_dir, voice, rate=rate_str)
    elif voice and voice in EDGE_VOICES:
        return _generate_edge(sentences, audio_dir, voice, rate=rate_str)
    else:
        # 기본값: Edge TTS
        return _generate_edge(sentences, audio_dir, DEFAULT_VOICE, rate=rate_str)


def get_audio_duration(filepath: str) -> float:
    """ffprobe로 오디오 길이(초) 측정"""
    result = subprocess.run(
        [config.ffprobe(), "-v", "quiet",
         "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1",
         filepath],
        capture_output=True, text=True
    )
    return float(result.stdout.strip())
