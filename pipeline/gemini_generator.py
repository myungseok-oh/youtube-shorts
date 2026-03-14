"""Gemini API 이미지/영상 생성기 — Google AI Studio 무료 티어

google-genai SDK 사용, 공식 모델명:
- gemini-2.5-flash-image (이미지, 무료)
- veo-2.0-generate-001 (영상, 무료 티어 제한적)
"""
import os
import time
from google import genai
from google.genai import types


# 시도할 모델 순서
IMAGE_MODELS = [
    "gemini-2.5-flash-image",
]


def generate_image(prompt: str, output_path: str, api_key: str,
                   aspect_ratio: str = "9:16", max_retries: int = 1) -> bool:
    """Gemini 이미지 생성.

    Args:
        prompt: 영어 이미지 프롬프트
        output_path: 저장 경로 (.png)
        api_key: Google AI Studio API key
        aspect_ratio: 비율 (9:16, 1:1, 4:3 등)
        max_retries: 재시도 횟수 (429 시 즉시 중단)

    Returns:
        성공 여부
    """
    client = genai.Client(api_key=api_key)

    for model_name in IMAGE_MODELS:
        for attempt in range(max_retries + 1):
            try:
                response = client.models.generate_content(
                    model=model_name,
                    contents=prompt,
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


VIDEO_MODELS = [
    "veo-2.0-generate-001",
]

VIDEO_POLL_INTERVAL = 10   # 폴링 간격 (초)
VIDEO_POLL_TIMEOUT = 300   # 최대 대기 시간 (초)


def generate_video(prompt: str, output_path: str, api_key: str,
                   aspect_ratio: str = "9:16", duration: int = 4) -> bool:
    """Gemini Veo 영상 생성 (기본 4초).

    Args:
        prompt: 영어 영상 프롬프트
        output_path: 저장 경로 (.mp4)
        api_key: Google AI Studio API key
        aspect_ratio: 비율 (9:16, 16:9, 1:1)
        duration: 영상 길이 (초, 4~8)

    Returns:
        성공 여부
    """
    client = genai.Client(api_key=api_key)

    for model_name in VIDEO_MODELS:
        try:
            print(f"[gemini] video generation start: {model_name} ({duration}s, {aspect_ratio})")
            operation = client.models.generate_videos(
                model=model_name,
                prompt=prompt,
                config=types.GenerateVideosConfig(
                    personGeneration="dont_allow",
                    aspectRatio=aspect_ratio,
                    numberOfVideos=1,
                    durationSeconds=max(duration, 5),
                ),
            )

            # 비동기 폴링 — 영상 생성은 수십 초 소요
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
                client.files.download(file=video.video)
                video.video.save(output_path)
                print(f"[gemini] video saved: {os.path.basename(output_path)} "
                      f"(model={model_name}, {elapsed}s)")
                return True

            print(f"[gemini] no video data from {model_name}")

        except Exception as e:
            err_msg = str(e)
            print(f"[gemini] video {model_name} failed: {err_msg[:300]}")
            if "429" in err_msg or "RESOURCE_EXHAUSTED" in err_msg.upper():
                print(f"[gemini] video quota exhausted — 이미지로 폴백")
                return False

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
