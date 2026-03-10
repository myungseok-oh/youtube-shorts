"""Gemini API 이미지 생성기 — Google AI Studio 무료 티어

google-genai SDK 사용, 공식 모델명:
- gemini-2.0-flash-exp-image-generation (무료, TEXT+IMAGE 혼합)
- gemini-2.5-flash-image (무료 제한적)
"""
import os
import time
from google import genai
from google.genai import types


# 시도할 모델 순서 (무료 티어 우선)
IMAGE_MODELS = [
    "gemini-2.0-flash-exp-image-generation",
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
