"""Gemini API 이미지/영상 생성기 — Google AI Studio 무료 티어

google-genai SDK 사용, 공식 모델명:
- gemini-2.5-flash-image (이미지, 무료)
- veo-3.1-generate-001 (영상, Veo 3.1 Fast image-to-video)
"""
import hashlib
import os
import subprocess
import time
import httpx
from google import genai
from google.genai import types
from pipeline import config

_REF_CACHE_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "ref_cache")


# 시도할 모델 순서
IMAGE_MODELS = [
    "gemini-2.5-flash-image",
]


def _normalize_gdrive_url(url: str) -> str:
    """Google Drive 공유 URL → 직접 다운로드 URL 변환."""
    import re
    m = re.match(r"https?://drive\.google\.com/file/d/([^/]+)", url)
    if m:
        return f"https://drive.google.com/uc?export=download&id={m.group(1)}"
    return url


def _download_ref_image(url: str):
    """참조 이미지 URL -> 로컬 캐시 경로. 이미 다운로드된 경우 캐시 반환."""
    url = _normalize_gdrive_url(url)
    os.makedirs(_REF_CACHE_DIR, exist_ok=True)
    url_hash = hashlib.md5(url.encode()).hexdigest()[:12]
    ext = os.path.splitext(url.split("?")[0])[-1] or ".png"
    cached = os.path.join(_REF_CACHE_DIR, f"ref_{url_hash}{ext}")
    if os.path.exists(cached):
        return cached
    try:
        resp = httpx.get(url, follow_redirects=True, timeout=30)
        resp.raise_for_status()
        with open(cached, "wb") as f:
            f.write(resp.content)
        print(f"[gemini] ref image cached: {cached}")
        return cached
    except Exception as e:
        print(f"[gemini] ref image download failed: {e}")
        return None


def generate_image(prompt: str, output_path: str, api_key: str,
                   aspect_ratio: str = "9:16", max_retries: int = 1,
                   reference_image_url: str = None,
                   reference_image_path: str = None,
                   style_reference_path: str = None) -> bool:
    """Gemini 이미지 생성.

    Args:
        prompt: 영어 이미지 프롬프트
        output_path: 저장 경로 (.png)
        api_key: Google AI Studio API key
        aspect_ratio: 비율 (9:16, 1:1, 4:3 등)
        max_retries: 재시도 횟수 (429 시 즉시 중단)
        reference_image_url: 캐릭터 참조 이미지 URL (선택, 하위 호환)
        reference_image_path: 캐릭터 참조 이미지 로컬 경로 (선택, 우선)
        style_reference_path: 스타일 참조 이미지 경로 (선택, 화풍/색감 유지)

    Returns:
        성공 여부
    """
    client = genai.Client(api_key=api_key)

    # 참조 이미지 준비
    import mimetypes

    def _make_image_part(path):
        mime = mimetypes.guess_type(path)[0] or "image/png"
        with open(path, "rb") as f:
            return types.Part.from_bytes(data=f.read(), mime_type=mime), mime

    # 캐릭터 참조 (로컬 파일 우선, 없으면 URL 다운로드)
    char_ref_path = None
    if reference_image_path and os.path.exists(reference_image_path):
        char_ref_path = reference_image_path
    elif reference_image_url:
        char_ref_path = _download_ref_image(reference_image_url)

    # 스타일 참조
    style_ref_path = None
    if style_reference_path and os.path.exists(style_reference_path):
        style_ref_path = style_reference_path

    contents = None
    if char_ref_path or style_ref_path:
        parts = []
        instructions = []

        if style_ref_path:
            style_part, style_mime = _make_image_part(style_ref_path)
            parts.append(style_part)
            instructions.append(
                "STYLE REFERENCE: Match the artistic style, color palette, lighting, "
                "and rendering technique of this reference image. "
                "Do NOT copy the background scene — generate a completely new scene as described below."
            )
            print(f"[gemini] style ref attached: {style_ref_path} ({style_mime})")

        if char_ref_path:
            char_part, char_mime = _make_image_part(char_ref_path)
            parts.append(char_part)
            instructions.append(
                "CHARACTER REFERENCE: Include the character from this reference image in the scene. "
                "Keep the character's exact appearance (face, body, outfit, colors). "
                "Place the character naturally in the scene — do NOT force a fixed position."
            )
            print(f"[gemini] char ref attached: {char_ref_path} ({char_mime})")

        parts.append("\n".join(instructions) + f"\n\nSCENE TO GENERATE:\n{prompt}")
        contents = parts

    if contents is None:
        contents = prompt

    for model_name in IMAGE_MODELS:
        for attempt in range(max_retries + 1):
            try:
                response = client.models.generate_content(
                    model=model_name,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        response_modalities=["IMAGE"],
                        image_config=types.ImageConfig(
                            aspect_ratio=aspect_ratio,
                        ),
                    ),
                )

                if response.parts:
                    for part in response.parts:
                        if part.inline_data:
                            os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
                            image = part.as_image()
                            image.save(output_path)
                            print(f"[gemini] image saved: {os.path.basename(output_path)} (model={model_name})")
                            return True

                print(f"[gemini] no image data from {model_name} (attempt {attempt + 1})")

            except Exception as e:
                err_msg = str(e)
                if "400" in err_msg and "modalities" in err_msg.lower():
                    print(f"[gemini] {model_name} does not support IMAGE modality, trying next")
                    break
                print(f"[gemini] {model_name} failed (attempt {attempt + 1}): {err_msg[:200]}")
                if "429" in err_msg or "RESOURCE_EXHAUSTED" in err_msg.upper():
                    print(f"[gemini] quota exhausted — skipping (수동 업로드로 대체)")
                    return False
                elif attempt < max_retries:
                    time.sleep(3)

    return False


VIDEO_MODEL = "veo-3.1-fast-generate-preview"


def _strip_audio(video_path: str):
    """영상에서 오디오 스트림 제거 (배경 영상용)."""
    tmp = video_path + ".tmp.mp4"
    try:
        subprocess.run(
            [config.ffmpeg(), "-y", "-i", video_path, "-an", "-c:v", "copy", tmp],
            capture_output=True, timeout=30,
        )
        if os.path.exists(tmp) and os.path.getsize(tmp) > 0:
            os.replace(tmp, video_path)
            print(f"[gemini] audio stripped: {os.path.basename(video_path)}")
    except Exception as e:
        print(f"[gemini] audio strip failed: {e}")
        if os.path.exists(tmp):
            os.remove(tmp)

VIDEO_POLL_INTERVAL = 10   # 폴링 간격 (초)
VIDEO_POLL_TIMEOUT = 300   # 최대 대기 시간 (초)


def extract_last_frame(mp4_path: str, output_path: str) -> bool:
    """mp4 영상의 마지막 프레임을 이미지로 추출.

    Args:
        mp4_path: 원본 영상 경로
        output_path: 저장할 이미지 경로 (.png)

    Returns:
        성공 여부
    """
    if not os.path.exists(mp4_path):
        print(f"[gemini] extract_last_frame: file not found: {mp4_path}")
        return False
    try:
        # sseof -0.1: 끝에서 0.1초 전부터 → 마지막 프레임 1장
        result = subprocess.run(
            [config.ffmpeg(), "-y", "-sseof", "-0.1", "-i", mp4_path,
             "-frames:v", "1", "-q:v", "2", output_path],
            capture_output=True, timeout=30,
        )
        if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            print(f"[gemini] last frame extracted: {os.path.basename(output_path)}")
            return True
        print(f"[gemini] extract_last_frame failed: empty output")
        return False
    except Exception as e:
        print(f"[gemini] extract_last_frame error: {e}")
        return False


def image_to_video(image_path: str, prompt: str, output_path: str,
                   api_key: str, duration: int = 6,
                   keep_audio: bool = False) -> bool:
    """Veo 3.1 Fast image-to-video 변환.

    기존 이미지를 가이드로 사용하여 영상 생성.
    비용: ~$0.15/초, 5초 = ~$0.75

    Args:
        image_path: 원본 이미지 경로 (.png/.jpg)
        prompt: 영어 모션 프롬프트 (카메라 움직임 등)
        output_path: 저장 경로 (.mp4)
        api_key: Google AI Studio API key
        duration: 영상 길이 (초, 5~8)
        keep_audio: True면 Veo 생성 오디오 유지, False면 제거 (기본)

    Returns:
        성공 여부
    """
    if not os.path.exists(image_path):
        print(f"[gemini] image not found: {image_path}")
        return False

    client = genai.Client(api_key=api_key)

    try:
        # 이미지 로드
        image = types.Image.from_file(location=image_path)

        print(f"[gemini] image-to-video start: {VIDEO_MODEL} "
              f"({duration}s, {os.path.basename(image_path)})")
        operation = client.models.generate_videos(
            model=VIDEO_MODEL,
            prompt=f"Cinematic motion, {prompt}",
            image=image,
            config=types.GenerateVideosConfig(
                aspect_ratio="9:16",
                number_of_videos=1,
                duration_seconds=min(max(duration, 4), 8),
            ),
        )

        # 비동기 폴링
        elapsed = 0
        while not operation.done:
            if elapsed >= VIDEO_POLL_TIMEOUT:
                print(f"[gemini] video generation timeout ({VIDEO_POLL_TIMEOUT}s)")
                return False
            time.sleep(VIDEO_POLL_INTERVAL)
            elapsed += VIDEO_POLL_INTERVAL
            print(f"[gemini] video polling... {elapsed}s")
            operation = client.operations.get(operation)

        if operation.response and operation.response.generated_videos:
            video = operation.response.generated_videos[0]
            os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
            # 리모트 영상 다운로드
            uri = video.video.uri
            if uri:
                import httpx
                headers = {"x-goog-api-key": api_key}
                resp = httpx.get(uri, headers=headers, follow_redirects=True, timeout=60)
                if resp.status_code == 200:
                    with open(output_path, "wb") as f:
                        f.write(resp.content)
                else:
                    print(f"[gemini] video download failed: HTTP {resp.status_code}")
                    return False
            else:
                print(f"[gemini] no video uri")
                return False
            # Veo 3.1은 오디오를 항상 포함 — keep_audio=False면 제거
            if not keep_audio:
                _strip_audio(output_path)
            else:
                print(f"[gemini] keeping Veo audio: {os.path.basename(output_path)}")
            print(f"[gemini] video saved: {os.path.basename(output_path)} "
                  f"(model={VIDEO_MODEL}, {elapsed}s)")
            return True

        print(f"[gemini] no video data from {VIDEO_MODEL}")

    except Exception as e:
        err_msg = str(e)
        print(f"[gemini] video {VIDEO_MODEL} failed: {err_msg[:300]}")

    return False


def generate_infographic(prompt: str, output_path: str, api_key: str,
                         aspect_ratio: str = "1:1") -> bool:
    """뉴스 인포그래픽 이미지 생성 (graph 타입용)."""
    return generate_image(prompt, output_path, api_key,
                          aspect_ratio=aspect_ratio, max_retries=2)


def check_available(api_key: str) -> bool:
    """API key 유효성 확인 (텍스트 요청으로 테스트)."""
    if not api_key:
        return False
    try:
        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model="gemini-2.0-flash",
            contents="hello",
        )
        return True
    except Exception as e:
        print(f"[gemini] API check failed: {str(e)[:100]}")
        return False
