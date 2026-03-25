"""TTS 음성 생성 — Edge TTS / Google Cloud TTS / GPT-SoVITS / Gemini TTS 지원"""
from __future__ import annotations
import asyncio
import base64
import os
import re
import subprocess
import threading
import requests
from pipeline import config


def _strip_html(text: str) -> str:
    """HTML 태그 제거 — sentences에 <span class="hl"> 등이 섞여 들어올 때 방어"""
    return re.sub(r"<[^>]+>", "", text)


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

GEMINI_VOICES = {
    "Kore": "Kore (Firm)",
    "Puck": "Puck (Upbeat)",
    "Sulafat": "Sulafat (Warm)",
    "Charon": "Charon (Informative)",
    "Fenrir": "Fenrir (Excitable)",
    "Leda": "Leda (Youthful)",
    "Orus": "Orus (Firm)",
    "Aoede": "Aoede (Breezy)",
    "Zephyr": "Zephyr (Bright)",
    "Enceladus": "Enceladus (Breathy)",
    "Iapetus": "Iapetus (Clear)",
    "Umbriel": "Umbriel (Easy-going)",
    "Algieba": "Algieba (Smooth)",
    "Despina": "Despina (Smooth)",
    "Erinome": "Erinome (Clear)",
    "Algenib": "Algenib (Gravelly)",
    "Rasalgethi": "Rasalgethi (Informative)",
    "Laomedeia": "Laomedeia (Upbeat)",
    "Achernar": "Achernar (Soft)",
    "Alnilam": "Alnilam (Firm)",
    "Schedar": "Schedar (Even)",
    "Gacrux": "Gacrux (Mature)",
    "Pulcherrima": "Pulcherrima (Forward)",
    "Achird": "Achird (Friendly)",
    "Zubenelgenubi": "Zubenelgenubi (Casual)",
    "Vindemiatrix": "Vindemiatrix (Gentle)",
    "Sadachbia": "Sadachbia (Lively)",
    "Sadaltager": "Sadaltager (Knowledgeable)",
    "Callirrhoe": "Callirrhoe (Easy-going)",
    "Autonoe": "Autonoe (Bright)",
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


def _generate_gemini(sentences: list[dict], audio_dir: str,
                     gemini_cfg: dict) -> list[str]:
    """Gemini TTS API로 음성 생성 (Flash TTS 무료 티어)."""
    import struct
    from google import genai
    from google.genai import types

    api_key = gemini_cfg.get("api_key", "")
    voice_name = gemini_cfg.get("voice", "Kore")
    style = gemini_cfg.get("style", "")

    if not api_key:
        raise RuntimeError("Gemini TTS: API 키가 없습니다")

    client = genai.Client(api_key=api_key)

    paths = []
    for i, item in enumerate(sentences):
        text = item["text"]
        if style:
            text = f"{style}: {text}"

        wav_path = os.path.join(audio_dir, f"audio_{i + 1}.wav")
        mp3_path = os.path.join(audio_dir, f"audio_{i + 1}.mp3")

        response = client.models.generate_content(
            model="gemini-2.5-flash-preview-tts",
            contents=text,
            config=types.GenerateContentConfig(
                response_modalities=["AUDIO"],
                speech_config=types.SpeechConfig(
                    voice_config=types.VoiceConfig(
                        prebuilt_voice_config=types.PrebuiltVoiceConfig(
                            voice_name=voice_name,
                        )
                    )
                ),
            ),
        )

        # PCM → WAV 변환
        if not response.candidates or not response.candidates[0].content.parts:
            raise RuntimeError(f"Gemini TTS: 문장 {i+1} 응답 없음")

        audio_data = response.candidates[0].content.parts[0].inline_data.data
        sample_rate = 24000
        num_samples = len(audio_data) // 2  # 16-bit

        with open(wav_path, "wb") as f:
            f.write(b"RIFF")
            f.write(struct.pack("<I", 36 + len(audio_data)))
            f.write(b"WAVE")
            f.write(b"fmt ")
            f.write(struct.pack("<I", 16))
            f.write(struct.pack("<H", 1))       # PCM
            f.write(struct.pack("<H", 1))       # mono
            f.write(struct.pack("<I", sample_rate))
            f.write(struct.pack("<I", sample_rate * 2))
            f.write(struct.pack("<H", 2))       # block align
            f.write(struct.pack("<H", 16))      # bits per sample
            f.write(b"data")
            f.write(struct.pack("<I", len(audio_data)))
            f.write(audio_data)

        # WAV → MP3 변환
        ffmpeg = config.ffmpeg()
        try:
            subprocess.run([
                ffmpeg, "-y", "-i", wav_path,
                "-codec:a", "libmp3lame", "-q:a", "2",
                mp3_path,
            ], capture_output=True, timeout=30)
            if os.path.exists(mp3_path):
                os.remove(wav_path)
                paths.append(mp3_path)
            else:
                paths.append(wav_path)
        except Exception:
            paths.append(wav_path)

        print(f"[tts] Gemini TTS 생성 완료: audio_{i+1} ({voice_name})")

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
                   sovits_cfg: dict = None,
                   rvc_cfg: dict = None,
                   gemini_cfg: dict = None) -> list[str]:
    """문장 리스트로부터 오디오 파일 생성.

    Args:
        sentences: [{"text": "...", "slide": 1}, ...]
        audio_dir: 오디오 저장 디렉토리
        voice: TTS 음성 이름 (Edge TTS / Google Cloud TTS voice name)
        rate: 속도 조절 (-50 ~ 200, 정수). None이면 기본 속도.
        sovits_cfg: GPT-SoVITS 설정 dict (있으면 GPT-SoVITS 사용)
        rvc_cfg: RVC 음성 변환 설정 dict (있으면 TTS 후 RVC 적용)
            {"model": "chisaka_airi", "pitch": 0, "index_influence": 0.5}
        gemini_cfg: Gemini TTS 설정 dict (있으면 Gemini TTS 사용)
            {"api_key": "...", "voice": "Kore", "style": "..."}

    Returns:
        생성된 오디오 파일 경로 리스트
    """
    os.makedirs(audio_dir, exist_ok=True)

    # sentences 내 HTML 태그 제거 (방어)
    for sen in sentences:
        sen["text"] = _strip_html(sen.get("text", ""))

    # Gemini TTS 모드
    if gemini_cfg and gemini_cfg.get("api_key"):
        return _generate_gemini(sentences, audio_dir, gemini_cfg)

    # GPT-SoVITS 모드
    if sovits_cfg and sovits_cfg.get("ref_audio"):
        if not check_sovits_available(sovits_cfg.get("host", SOVITS_DEFAULT_HOST),
                                       sovits_cfg.get("port", SOVITS_DEFAULT_PORT)):
            print("[tts] GPT-SoVITS 서버 미응답 — Edge-TTS로 폴백합니다")
        else:
            return _generate_sovits(sentences, audio_dir, sovits_cfg)

    rate_str = _format_rate(rate) if rate is not None else "+0%"

    if voice and voice in GOOGLE_CLOUD_VOICES:
        paths = _generate_google_cloud(sentences, audio_dir, voice, rate=rate_str)
    elif voice and voice in EDGE_VOICES:
        paths = _generate_edge(sentences, audio_dir, voice, rate=rate_str)
    else:
        paths = _generate_edge(sentences, audio_dir, DEFAULT_VOICE, rate=rate_str)

    # RVC 음성 변환 후처리
    if rvc_cfg and rvc_cfg.get("model"):
        paths = _apply_rvc_batch(paths, rvc_cfg)

    return paths


# ─── RVC 음성 변환 ───

_rvc_instance = None

def _get_rvc_loader():
    """RVC BaseLoader 싱글턴 (fairseq 몽키패치 포함)."""
    global _rvc_instance
    if _rvc_instance is not None:
        return _rvc_instance

    import sys
    import types
    os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'

    import torch
    from transformers import HubertModel

    class _HubertWrapper(torch.nn.Module):
        def __init__(self, model):
            super().__init__()
            self.model = model
            self.final_proj = torch.nn.Linear(768, 256)
        def extract_features(self, source=None, padding_mask=None, output_layer=None, **kwargs):
            if source.dim() == 1:
                source = source.unsqueeze(0)
            outputs = self.model(source, output_hidden_states=True)
            feats = outputs.hidden_states[output_layer] if output_layer and outputs.hidden_states else outputs.last_hidden_state
            return (feats,)

    hubert_cache = os.path.join(config.root_dir(), "data", "rvc_models", "hubert")

    class _FakeCU:
        @staticmethod
        def load_model_ensemble_and_task(paths, **kwargs):
            m = HubertModel.from_pretrained('lengyue233/content-vec-best', cache_dir=hubert_cache)
            m.eval()
            return [_HubertWrapper(m)], None, None

    # fairseq 몽키패치
    if 'fairseq' not in sys.modules:
        fm = types.ModuleType('fairseq')
        fm.checkpoint_utils = _FakeCU()
        sys.modules['fairseq'] = fm
        sys.modules['fairseq.checkpoint_utils'] = _FakeCU()

    from infer_rvc_python import BaseLoader

    rvc_base = os.path.join(config.root_dir(), "data", "rvc_models")
    hubert_path = os.path.join(rvc_base, "hubert", "hubert_base.pt")
    rmvpe_path = os.path.join(rvc_base, "rmvpe.pt")

    _rvc_instance = BaseLoader(only_cpu=False, hubert_path=hubert_path, rmvpe_path=rmvpe_path)
    print("[rvc] RVC 엔진 초기화 완료")
    return _rvc_instance


def _resolve_rvc_model(model_name: str) -> tuple[str, str]:
    """모델 이름 → (pth_path, index_path) 반환."""
    rvc_base = os.path.join(config.root_dir(), "data", "rvc_models")
    model_dir = os.path.join(rvc_base, model_name)
    if not os.path.isdir(model_dir):
        raise FileNotFoundError(f"RVC 모델 폴더 없음: {model_dir}")

    pth_path, index_path = "", ""
    for root, _, files in os.walk(model_dir):
        for f in files:
            if f.endswith(".pth") and not pth_path:
                pth_path = os.path.join(root, f)
            if f.endswith(".index") and not index_path:
                index_path = os.path.join(root, f)
    if not pth_path:
        raise FileNotFoundError(f"RVC .pth 파일 없음: {model_dir}")
    return pth_path, index_path


def _apply_rvc_batch(audio_paths: list[str], rvc_cfg: dict) -> list[str]:
    """TTS 생성 파일들에 RVC 음성 변환 일괄 적용."""
    import soundfile as sf

    model_name = rvc_cfg["model"]
    pitch = int(rvc_cfg.get("pitch", 0))
    index_influence = float(rvc_cfg.get("index_influence", 0.5))

    try:
        pth_path, index_path = _resolve_rvc_model(model_name)
    except FileNotFoundError as e:
        print(f"[rvc] {e} — RVC 스킵")
        return audio_paths

    rvc = _get_rvc_loader()
    tag = f"rvc_{model_name}"
    rvc.apply_conf(
        tag=tag,
        file_model=pth_path,
        pitch_algo="rmvpe",
        pitch_lvl=pitch,
        file_index=index_path,
        index_influence=index_influence,
        respiration_median_filtering=int(rvc_cfg.get("respiration_filter", 3)),
        envelope_ratio=float(rvc_cfg.get("envelope_ratio", 0.25)),
        consonant_breath_protection=float(rvc_cfg.get("consonant_protection", 0.33)),
    )

    converted = []
    for i, path in enumerate(audio_paths):
        try:
            result = rvc.generate_from_cache(audio_data=path, tag=tag)
            # RVC 출력은 40000Hz — MP3는 이 샘플레이트 미지원
            # WAV로 임시 저장 → ffmpeg로 원본 포맷+44100Hz 변환
            tmp_wav = path + ".rvc_tmp.wav"
            sf.write(tmp_wav, result[0], result[1])
            ext = os.path.splitext(path)[1].lower()
            codec = "libmp3lame" if ext == ".mp3" else "pcm_s16le"
            subprocess.run([
                config.ffmpeg(), "-y", "-i", tmp_wav,
                "-ar", "44100", "-ac", "1",
                "-c:a", codec, "-q:a", "2",
                path
            ], capture_output=True)
            os.remove(tmp_wav)
            converted.append(path)
        except Exception as e:
            print(f"[rvc] 변환 실패 ({os.path.basename(path)}): {e}")
            converted.append(path)  # 원본 유지

    print(f"[rvc] {len(converted)}개 파일 변환 완료 (model={model_name}, pitch={pitch})")
    return converted


def list_rvc_models() -> list[dict]:
    """사용 가능한 RVC 모델 목록 반환."""
    rvc_base = os.path.join(config.root_dir(), "data", "rvc_models")
    if not os.path.isdir(rvc_base):
        return []
    models = []
    for name in sorted(os.listdir(rvc_base)):
        model_dir = os.path.join(rvc_base, name)
        if not os.path.isdir(model_dir) or name in ("hubert",):
            continue
        has_pth = any(f.endswith(".pth") for _, _, files in os.walk(model_dir) for f in files)
        if has_pth:
            models.append({"id": name, "label": name})
    return models


def get_audio_duration(filepath: str) -> float:
    """ffprobe로 오디오 길이(초) 측정"""
    result = subprocess.run(
        [config.ffprobe(), "-v", "quiet",
         "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1",
         filepath],
        capture_output=True, text=True
    )
    try:
        return float(result.stdout.strip())
    except (ValueError, AttributeError):
        return 0.0
