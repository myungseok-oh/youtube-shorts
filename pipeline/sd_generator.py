"""Stable Diffusion 이미지/영상 생성 — ComfyUI API 클라이언트"""
from __future__ import annotations
import json
import os
import random
import shutil
import time
import urllib.request
import urllib.error


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8188


def _base_url(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> str:
    return f"http://{host}:{port}"


def _post_json(url: str, data: dict, timeout: int = 10) -> dict:
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def _get_json(url: str, timeout: int = 10) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read())


def _get_bytes(url: str, timeout: int = 30) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read()


def check_available(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> bool:
    """ComfyUI 서버가 실행 중인지 확인"""
    try:
        _get_json(f"{_base_url(host, port)}/system_stats", timeout=3)
        return True
    except Exception:
        return False


# ─── 모델 설정 ───

SD15_CKPT = "realisticVisionV51_v51VAE.safetensors"
SDXL_CKPT = "RealVisXL_V4.0.safetensors"

SAFE_NEGATIVE = (
    "nsfw, nude, naked, porn, sex, erotic, lingerie, underwear, bikini, cleavage, "
    "breast, topless, provocative, seductive, sensual, intimate, "
    "person, human, man, woman, girl, boy, face, body, skin, "
    "worst quality, low quality, normal quality, lowres, blurry, "
    "text, watermark, logo, letters, numbers, words, signature, "
    "deformed, ugly, duplicate, bad anatomy, bad proportions, "
    "extra fingers, mutated hands, poorly drawn hands, "
    "poorly drawn face, extra limbs, disfigured, static, frozen"
)


# ─── Motion LoRA 자동 감지 ───

_MOTION_LORA_MAP = {
    "slow zoom in": "v2_lora_ZoomIn.ckpt",
    "zoom in": "v2_lora_ZoomIn.ckpt",
    "slow zoom out": "v2_lora_ZoomOut.ckpt",
    "zoom out": "v2_lora_ZoomOut.ckpt",
    "camera pan left": "v2_lora_PanLeft.ckpt",
    "pan left": "v2_lora_PanLeft.ckpt",
    "camera pan right": "v2_lora_PanRight.ckpt",
    "pan right": "v2_lora_PanRight.ckpt",
    "gentle camera pan": "v2_lora_PanRight.ckpt",
    "camera pan": "v2_lora_PanRight.ckpt",
    "tilt up": "v2_lora_TiltUp.ckpt",
    "tilt down": "v2_lora_TiltDown.ckpt",
}


def _detect_motion_lora(prompt: str) -> str | None:
    """프롬프트에서 카메라 모션 힌트를 감지하여 Motion LoRA 파일명 반환"""
    prompt_lower = prompt.lower()
    # 긴 구문부터 매칭 (partial match 방지)
    for hint in sorted(_MOTION_LORA_MAP.keys(), key=len, reverse=True):
        if hint in prompt_lower:
            return _MOTION_LORA_MAP[hint]
    return None


# ─── txt2img 워크플로 ───

def _build_txt2img_workflow(prompt: str, negative: str = "",
                            width: int = 512, height: int = 912,
                            seed: int = -1, steps: int = 25,
                            cfg: float = 7.0,
                            ckpt: str = SD15_CKPT) -> dict:
    """SD 1.5 txt2img ComfyUI 워크플로 (API 형식)"""
    if seed < 0:
        seed = random.randint(0, 2**32 - 1)

    if not negative:
        negative = ("worst quality, low quality, normal quality, lowres, blurry, "
                    "text, watermark, logo, letters, numbers, words, signature, "
                    "deformed, ugly, duplicate, morbid, mutilated, "
                    "out of frame, extra fingers, mutated hands, poorly drawn hands, "
                    "poorly drawn face, mutation, bad anatomy, bad proportions, "
                    "extra limbs, cloned face, disfigured, gross proportions, "
                    "malformed limbs, missing arms, missing legs, extra arms, extra legs")

    return {
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": ckpt}
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": prompt, "clip": ["4", 1]}
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": negative, "clip": ["4", 1]}
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": width, "height": height, "batch_size": 1}
        },
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["4", 0],
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": "dpmpp_2m",
                "scheduler": "karras",
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0],
                "denoise": 1.0,
            }
        },
        "8": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["3", 0], "vae": ["4", 2]}
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {"images": ["8", 0], "filename_prefix": "sd_output"}
        },
    }


def _build_sdxl_workflow(prompt: str, negative: str = "",
                         width: int = 768, height: int = 1344,
                         seed: int = -1, steps: int = 30,
                         cfg: float = 5.0,
                         ckpt: str = SDXL_CKPT) -> dict:
    """SDXL txt2img ComfyUI 워크플로 (고품질, 8GB VRAM 최적화)"""
    if seed < 0:
        seed = random.randint(0, 2**32 - 1)

    if not negative:
        negative = SAFE_NEGATIVE

    return {
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": ckpt}
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": prompt, "clip": ["4", 1]}
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": negative, "clip": ["4", 1]}
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": width, "height": height, "batch_size": 1}
        },
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["4", 0],
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": "dpmpp_2m_sde",
                "scheduler": "karras",
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0],
                "denoise": 1.0,
            }
        },
        "8": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["3", 0], "vae": ["4", 2]}
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {"images": ["8", 0], "filename_prefix": "sdxl_output"}
        },
    }


# ─── AnimateDiff 워크플로 (txt2vid) ───

def _build_animatediff_workflow(prompt: str, negative: str = "",
                                 width: int = 512, height: int = 768,
                                 seed: int = -1, steps: int = 25,
                                 cfg: float = 7.0, frames: int = 32,
                                 ckpt: str = SD15_CKPT,
                                 motion_lora: str = None,
                                 motion_lora_strength: float = 0.8,
                                 use_rife: bool = False,
                                 rife_multiplier: int = 3) -> dict:
    """SD 1.5 + AnimateDiff txt2vid 워크플로

    Args:
        motion_lora: Motion LoRA 파일명 (None이면 자동 감지)
        use_rife: RIFE 프레임 보간 사용 여부
        rife_multiplier: RIFE 프레임 배수 (2 또는 3)
    """
    if seed < 0:
        seed = random.randint(0, 2**32 - 1)

    if not negative:
        negative = SAFE_NEGATIVE

    # Motion LoRA 자동 감지
    if motion_lora is None:
        motion_lora = _detect_motion_lora(prompt)

    # 기본 프레임레이트 및 RIFE 적용 시 조정
    base_fps = 12
    output_fps = base_fps * rife_multiplier if use_rife else base_fps

    workflow = {
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": ckpt}
        },
        "10": {
            "class_type": "ADE_LoadAnimateDiffModel",
            "inputs": {"model_name": "mm_sd15_v3.ckpt"}
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": prompt, "clip": ["4", 1]}
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": negative, "clip": ["4", 1]}
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": width, "height": height, "batch_size": frames}
        },
        "8": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["3", 0], "vae": ["4", 2]}
        },
    }

    # Motion LoRA 노드 (선택)
    apply_inputs = {"motion_model": ["10", 0]}
    if motion_lora:
        workflow["15"] = {
            "class_type": "ADE_AnimateDiffLoRALoader",
            "inputs": {
                "name": motion_lora,
                "strength": motion_lora_strength,
            }
        }
        apply_inputs["motion_lora"] = ["15", 0]

    workflow["11"] = {
        "class_type": "ADE_ApplyAnimateDiffModelSimple",
        "inputs": apply_inputs,
    }

    workflow["13"] = {
        "class_type": "ADE_UseEvolvedSampling",
        "inputs": {
            "model": ["4", 0],
            "beta_schedule": "autoselect",
            "m_models": ["11", 0],
        }
    }

    workflow["3"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["13", 0],
            "seed": seed,
            "steps": steps,
            "cfg": cfg,
            "sampler_name": "dpmpp_2m",
            "scheduler": "karras",
            "positive": ["6", 0],
            "negative": ["7", 0],
            "latent_image": ["5", 0],
            "denoise": 1.0,
        }
    }

    # RIFE 프레임 보간 (선택)
    video_input = ["8", 0]
    if use_rife:
        workflow["16"] = {
            "class_type": "RIFE VFI",
            "inputs": {
                "ckpt_name": "rife49.pth",
                "frames": ["8", 0],
                "clear_cache_after_n_frames": 10,
                "multiplier": rife_multiplier,
                "fast_mode": True,
                "ensemble": True,
                "scale_factor": 1.0,
                "dtype": "float32",
                "torch_compile": False,
                "batch_size": 1,
            }
        }
        video_input = ["16", 0]

    workflow["12"] = {
        "class_type": "VHS_VideoCombine",
        "inputs": {
            "images": video_input,
            "frame_rate": output_fps,
            "loop_count": 0,
            "filename_prefix": "animdiff_output",
            "format": "video/h264-mp4",
            "pingpong": False,
            "save_output": True,
            "pix_fmt": "yuv420p",
            "crf": 19,
            "save_metadata": True,
        }
    }

    return workflow


# ─── img2vid 워크플로 (이미지 먼저 → AnimateDiff) ───

def _build_img2vid_workflow(prompt: str, negative: str = "",
                             width: int = 512, height: int = 768,
                             seed: int = -1,
                             img_steps: int = 30, vid_steps: int = 20,
                             cfg: float = 7.0, frames: int = 32,
                             denoise: float = 0.65,
                             ckpt: str = SD15_CKPT,
                             motion_lora: str = None,
                             motion_lora_strength: float = 0.8,
                             use_rife: bool = False,
                             rife_multiplier: int = 3) -> dict:
    """2단계 워크플로: 고품질 이미지 생성 → AnimateDiff로 모션 추가

    Stage 1: txt2img (1 frame, high steps) → 레퍼런스 이미지 latent
    Stage 2: RepeatLatentBatch → AnimateDiff KSampler (lower denoise) → 영상

    Args:
        img_steps: Stage 1 이미지 생성 스텝 수
        vid_steps: Stage 2 영상 생성 스텝 수
        denoise: Stage 2 디노이즈 (0.5=원본 유지, 0.8=많은 변형)
    """
    if seed < 0:
        seed = random.randint(0, 2**32 - 1)

    if not negative:
        negative = SAFE_NEGATIVE

    if motion_lora is None:
        motion_lora = _detect_motion_lora(prompt)

    base_fps = 12
    output_fps = base_fps * rife_multiplier if use_rife else base_fps

    workflow = {
        # 체크포인트 & 텍스트 인코딩 (공유)
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": ckpt}
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": prompt, "clip": ["4", 1]}
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": negative, "clip": ["4", 1]}
        },

        # ── Stage 1: 레퍼런스 이미지 생성 (1 frame) ──
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": width, "height": height, "batch_size": 1}
        },
        "20": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["4", 0],
                "seed": seed,
                "steps": img_steps,
                "cfg": cfg,
                "sampler_name": "dpmpp_2m",
                "scheduler": "karras",
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0],
                "denoise": 1.0,
            }
        },

        # ── Latent 복제 (1 → N frames) ──
        "21": {
            "class_type": "RepeatLatentBatch",
            "inputs": {
                "samples": ["20", 0],
                "amount": frames,
            }
        },

        # ── Stage 2: AnimateDiff 모션 추가 ──
        "10": {
            "class_type": "ADE_LoadAnimateDiffModel",
            "inputs": {"model_name": "mm_sd15_v3.ckpt"}
        },

        # VAEDecode & 출력
        "8": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["3", 0], "vae": ["4", 2]}
        },
    }

    # Motion LoRA (선택)
    apply_inputs = {"motion_model": ["10", 0]}
    if motion_lora:
        workflow["15"] = {
            "class_type": "ADE_AnimateDiffLoRALoader",
            "inputs": {
                "name": motion_lora,
                "strength": motion_lora_strength,
            }
        }
        apply_inputs["motion_lora"] = ["15", 0]

    workflow["11"] = {
        "class_type": "ADE_ApplyAnimateDiffModelSimple",
        "inputs": apply_inputs,
    }

    workflow["13"] = {
        "class_type": "ADE_UseEvolvedSampling",
        "inputs": {
            "model": ["4", 0],
            "beta_schedule": "autoselect",
            "m_models": ["11", 0],
        }
    }

    # Stage 2 KSampler: init latent에서 시작, 낮은 denoise로 모션만 추가
    workflow["3"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["13", 0],
            "seed": seed + 1,
            "steps": vid_steps,
            "cfg": cfg,
            "sampler_name": "dpmpp_2m",
            "scheduler": "karras",
            "positive": ["6", 0],
            "negative": ["7", 0],
            "latent_image": ["21", 0],
            "denoise": denoise,
        }
    }

    # RIFE 프레임 보간 (선택)
    video_input = ["8", 0]
    if use_rife:
        workflow["16"] = {
            "class_type": "RIFE VFI",
            "inputs": {
                "ckpt_name": "rife49.pth",
                "frames": ["8", 0],
                "clear_cache_after_n_frames": 10,
                "multiplier": rife_multiplier,
                "fast_mode": True,
                "ensemble": True,
                "scale_factor": 1.0,
                "dtype": "float32",
                "torch_compile": False,
                "batch_size": 1,
            }
        }
        video_input = ["16", 0]

    workflow["12"] = {
        "class_type": "VHS_VideoCombine",
        "inputs": {
            "images": video_input,
            "frame_rate": output_fps,
            "loop_count": 0,
            "filename_prefix": "img2vid_output",
            "format": "video/h264-mp4",
            "pingpong": False,
            "save_output": True,
            "pix_fmt": "yuv420p",
            "crf": 19,
            "save_metadata": True,
        }
    }

    return workflow


# ─── 실행 + 결과 수신 ───

def _queue_prompt(workflow: dict, host: str, port: int) -> str:
    """워크플로를 큐에 넣고 prompt_id 반환"""
    data = {"prompt": workflow}
    result = _post_json(f"{_base_url(host, port)}/prompt", data)
    return result["prompt_id"]


def _wait_for_result(prompt_id: str, host: str, port: int,
                     timeout: int = 300, poll_interval: float = 1.0) -> dict:
    """생성 완료까지 대기 후 히스토리 반환"""
    base = _base_url(host, port)
    start = time.time()
    while time.time() - start < timeout:
        try:
            history = _get_json(f"{base}/history/{prompt_id}")
            if prompt_id in history:
                return history[prompt_id]
        except Exception:
            pass
        time.sleep(poll_interval)
    raise TimeoutError(f"ComfyUI 생성 타임아웃 ({timeout}초)")


def _download_output(history: dict, host: str, port: int) -> list[bytes]:
    """히스토리에서 생성된 이미지/GIF/MP4 다운로드"""
    base = _base_url(host, port)
    results = []
    outputs = history.get("outputs", {})
    for node_id, node_out in outputs.items():
        for key in ("images", "gifs", "videos"):
            for item in node_out.get(key, []):
                filename = item["filename"]
                subfolder = item.get("subfolder", "")
                item_type = item.get("type", "output")
                url = f"{base}/view?filename={filename}&subfolder={subfolder}&type={item_type}"
                results.append(_get_bytes(url))
    return results


# ─── 공개 API ───

def _layout_image_dims(layout: str, model: str = "sdxl") -> tuple[int, int]:
    """layout에 따른 이미지 해상도 반환 (width, height)"""
    if model == "sdxl":
        if layout in ("top", "bottom"):
            return 768, 576   # 4:3 landscape, fills half screen
        elif layout == "center":
            return 768, 768   # 1:1 square, fills center zone
        else:  # "full"
            return 768, 1344  # 9:16 full screen
    else:  # sd15
        if layout in ("top", "bottom"):
            return 512, 384
        elif layout == "center":
            return 512, 512
        else:
            return 512, 912


def generate_image(prompt: str, output_path: str,
                   negative: str = "", seed: int = -1,
                   model: str = "sdxl",
                   host: str = DEFAULT_HOST, port: int = DEFAULT_PORT,
                   timeout: int = 300,
                   layout: str = "full") -> str:
    """SD 이미지 생성 → output_path에 저장. model='sdxl' 또는 'sd15'"""
    w, h = _layout_image_dims(layout, model)
    if model == "sdxl":
        workflow = _build_sdxl_workflow(prompt, negative, seed=seed, width=w, height=h)
    else:
        workflow = _build_txt2img_workflow(prompt, negative, seed=seed, width=w, height=h)
    prompt_id = _queue_prompt(workflow, host, port)
    history = _wait_for_result(prompt_id, host, port, timeout=timeout)
    images = _download_output(history, host, port)
    if not images:
        raise RuntimeError("ComfyUI에서 이미지를 반환하지 않음")

    parent = os.path.dirname(output_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(output_path, "wb") as f:
        f.write(images[0])
    return output_path


def generate_video(prompt: str, output_path: str,
                   negative: str = "", seed: int = -1,
                   frames: int = 32,
                   mode: str = "img2vid",
                   use_rife: bool = True,
                   rife_multiplier: int = 3,
                   host: str = DEFAULT_HOST, port: int = DEFAULT_PORT,
                   timeout: int = 600,
                   layout: str = "full") -> str:
    """AnimateDiff 영상 생성 → output_path에 저장

    Args:
        mode: "img2vid" (이미지→영상, 고품질) 또는 "txt2vid" (직접 생성)
        use_rife: RIFE 프레임 보간 (32→96프레임, 부드러운 모션)
        rife_multiplier: RIFE 배수 (기본 3배)
        layout: 슬라이드 레이아웃 ("full", "center", "top", "bottom")
    """
    # layout에 따른 영상 해상도 (SD 1.5 기반)
    if layout in ("top", "bottom"):
        vid_w, vid_h = 512, 384
    elif layout == "center":
        vid_w, vid_h = 512, 512
    else:
        vid_w, vid_h = 512, 768

    if mode == "img2vid":
        workflow = _build_img2vid_workflow(
            prompt, negative, seed=seed, frames=frames,
            width=vid_w, height=vid_h,
            use_rife=use_rife, rife_multiplier=rife_multiplier,
        )
    else:
        workflow = _build_animatediff_workflow(
            prompt, negative, seed=seed, frames=frames,
            width=vid_w, height=vid_h,
            use_rife=use_rife, rife_multiplier=rife_multiplier,
        )

    prompt_id = _queue_prompt(workflow, host, port)
    history = _wait_for_result(prompt_id, host, port, timeout=timeout)
    results = _download_output(history, host, port)
    if not results:
        raise RuntimeError("ComfyUI에서 영상을 반환하지 않음")

    parent = os.path.dirname(output_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(output_path, "wb") as f:
        f.write(results[0])
    return output_path


def generate_sd_prompts(slides: list[dict], topic: str) -> list[str]:
    """Claude CLI로 슬라이드별 SD 프롬프트 생성 (영어) — 하위호환용"""
    result = generate_all_prompts(slides, topic)
    return result["sd_prompts"]


def generate_all_prompts(slides: list[dict], topic: str) -> dict:
    """Claude CLI로 슬라이드별 SD + 이미지 생성 프롬프트 동시 생성

    Returns: {"sd_prompts": [...], "genspark_prompts": [...]}
    """
    from pipeline.agent import _run_claude
    import re

    slide_descs = []
    for i, s in enumerate(slides):
        if i == len(slides) - 1:  # closing 스킵
            continue
        clean_main = (s.get("main", "")).replace("<span class=\"hl\">", "").replace("</span>", "")
        slide_descs.append(f"Slide {i+1}: category=\"{s.get('category', '')}\", text=\"{clean_main}\", sub=\"{s.get('sub', '')}\"")

    num_slides = len(slide_descs)

    prompt = f"""You generate background image prompts for YouTube Shorts NEWS videos.
Each slide needs a background image. Text overlay is added separately — images must contain NO text, letters, or numbers.

Topic: {topic}

Slides:
{chr(10).join(slide_descs)}

Generate TWO types of prompts for each slide:

=== TYPE 1: SD (Stable Diffusion XL) ===
SDXL is capable of detailed, high-quality images. Write rich, descriptive prompts.

RULES:
- Describe a specific, detailed scene matching the news content
- Can handle complex compositions, multiple elements, and people
- Use photorealistic style with vivid, bright colors
- 30-60 words per prompt
- Always end with: high quality, photorealistic, vivid colors, cinematic lighting, 9:16 portrait
- NO text, letters, numbers, watermarks

GOOD SDXL examples:
- Economy: "professional stock trading floor with multiple monitors showing colorful charts, traders in suits, bright modern office with glass walls, golden sunlight streaming through, high quality, photorealistic, vivid colors, cinematic lighting, 9:16 portrait"
- Politics: "grand government building interior with marble columns, Korean national flags, press conference setup with microphones, warm golden lighting, professional atmosphere, high quality, photorealistic, 9:16 portrait"
- Tech: "futuristic server room with rows of glowing blue racks, fiber optic cables, holographic displays, clean modern aesthetic, high quality, photorealistic, vivid colors, cinematic lighting, 9:16 portrait"
- Crypto: "golden bitcoin coins floating above a glowing digital world map, neon blue data streams, dark modern background with bright accents, high quality, photorealistic, vivid colors, 9:16 portrait"

=== TYPE 2: Genspark (AI image generator) ===
Genspark is more capable. Write natural, descriptive prompts.

RULES:
- Describe a SPECIFIC scene that matches the news content of each slide
- Be concrete: what objects, what setting, what mood
- Mention the news context without using actual text/numbers in the image
- Style: realistic photo, bright vivid tone (60-80% brightness), slight bokeh
- 9:16 portrait, leave center-bottom space for text overlay
- NO text, letters, numbers, watermarks, logos
- 40-60 words per prompt

Output ONLY this JSON (no other text):
{{
  "sd_prompts": ["sd prompt 1", "sd prompt 2", ...],
  "genspark_prompts": ["genspark prompt 1", "genspark prompt 2", ...]
}}

Each array must have exactly {num_slides} items.
"""

    raw = _run_claude(prompt, timeout=120, use_web=False,
                      model="claude-sonnet-4-6")

    # 파싱
    try:
        wrapper = json.loads(raw)
        if isinstance(wrapper, dict) and "result" in wrapper:
            raw = wrapper["result"]
    except (json.JSONDecodeError, TypeError):
        pass

    m = re.search(r'```json\s*\n(.*?)\n\s*```', raw, re.DOTALL)
    if m:
        raw = m.group(1)

    m = re.search(r'\{.*\}', raw, re.DOTALL)
    if m:
        parsed = json.loads(m.group(0))
        if isinstance(parsed, dict):
            sd = [str(p) for p in parsed.get("sd_prompts", [])]
            gs = [str(p) for p in parsed.get("genspark_prompts", [])]
            if sd:
                return {"sd_prompts": sd, "genspark_prompts": gs}

    # 폴백: 이전 배열 형식도 시도
    m = re.search(r'\[.*\]', raw, re.DOTALL)
    if m:
        prompts = json.loads(m.group(0))
        if isinstance(prompts, list):
            return {"sd_prompts": [str(p) for p in prompts], "genspark_prompts": []}

    raise RuntimeError(f"프롬프트 파싱 실패: {raw[:500]}")


# ─── 이미지 에이전트: 한국어→영문 변환 + SD 생성 + Vision 검토 + 재시도 ───

def _translate_prompt_to_sd(kr_prompt: str) -> str:
    """한국어 이미지 프롬프트를 SDXL용 영문 프롬프트로 변환"""
    from pipeline.agent import _run_claude

    prompt = f"""Convert this Korean image description to an SDXL (Stable Diffusion XL) prompt (English).

Korean: {kr_prompt}

SDXL RULES:
- Detailed, descriptive scene with rich visual elements
- Photorealistic style with vivid, bright colors
- 30-60 words
- End with: high quality, photorealistic, vivid colors, cinematic lighting, 9:16 portrait
- AVOID dark, moody, red, or gloomy tones. Use bright, warm, vivid colors.
- NO text, letters, numbers, watermarks
- Output ONLY the English prompt, nothing else."""

    raw = _run_claude(prompt, timeout=60, use_web=False,
                      model="claude-sonnet-4-6")
    try:
        wrapper = json.loads(raw)
        if isinstance(wrapper, dict) and "result" in wrapper:
            return wrapper["result"].strip().strip('"')
    except (json.JSONDecodeError, TypeError):
        pass
    return raw.strip().strip('"')


def _review_image(image_path: str, kr_prompt: str) -> dict:
    """Claude Vision으로 생성된 이미지가 프롬프트 의도와 일치하는지 검토

    Returns: {"ok": bool, "feedback": str}
    """
    from pipeline.agent import _clean_env
    import subprocess
    import tempfile

    review_prompt = f"""이 이미지를 확인하고 아래 의도와 일치하는지 평가해줘.

의도한 이미지: {kr_prompt}

평가 기준:
1. 의도한 피사체/장면이 이미지에 표현되어 있는가?
2. 이상한 아티팩트(깨진 형태, 의미 없는 패턴)가 없는가?
3. 뉴스 배경 이미지로 사용 가능한 품질인가?

JSON만 출력:
{{"ok": true/false, "feedback": "부족한 점 또는 OK 사유"}}"""

    abs_path = os.path.abspath(image_path).replace("\\", "/")
    full_prompt = f"{abs_path} 파일을 Read 도구로 읽고, 다음 평가를 해줘:\n\n{review_prompt}"
    output_dir = os.path.dirname(os.path.dirname(abs_path))

    from pipeline.agent import _find_claude_bin
    claude_bin = _find_claude_bin()
    result = subprocess.run(
        f'"{claude_bin}" -p --output-format json --allowedTools "Read" --add-dir "{output_dir}"',
        input=full_prompt,
        capture_output=True, text=True, timeout=60,
        encoding="utf-8", shell=True, env=_clean_env(),
        cwd=tempfile.gettempdir(),
    )

    if result.returncode != 0:
        return {"ok": True, "feedback": "Vision 검토 실패, 스킵"}

    raw = result.stdout
    import re
    try:
        wrapper = json.loads(raw)
        if isinstance(wrapper, dict) and "result" in wrapper:
            raw = wrapper["result"]
    except (json.JSONDecodeError, TypeError):
        pass

    m = re.search(r'\{.*\}', raw, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass

    return {"ok": True, "feedback": "파싱 실패, 스킵"}


def _refine_sd_prompt(sd_prompt: str, feedback: str) -> str:
    """Vision 피드백을 반영하여 SD 프롬프트 수정"""
    from pipeline.agent import _run_claude

    prompt = f"""The following SDXL prompt produced a bad result.

Original prompt: {sd_prompt}
Problem: {feedback}

Write an improved SDXL prompt that fixes the problem.
RULES: Detailed scene, 30-60 words, end with "high quality, photorealistic, vivid colors, cinematic lighting, 9:16 portrait", NO text/letters/numbers.
Output ONLY the improved prompt."""

    raw = _run_claude(prompt, timeout=60, use_web=False,
                      model="claude-sonnet-4-6")
    try:
        wrapper = json.loads(raw)
        if isinstance(wrapper, dict) and "result" in wrapper:
            return wrapper["result"].strip().strip('"')
    except (json.JSONDecodeError, TypeError):
        pass
    return raw.strip().strip('"')


def agent_generate_image(kr_prompt: str, output_path: str,
                         host: str = DEFAULT_HOST, port: int = DEFAULT_PORT,
                         max_retries: int = 3) -> dict:
    """이미지 에이전트: 한국어 프롬프트 → SD 영문 변환 → 생성 → Vision 검토 → 재시도

    Returns: {"ok": bool, "path": str, "sd_prompt": str, "attempts": int, "feedback": str}
    """
    sd_prompt = _translate_prompt_to_sd(kr_prompt)

    for attempt in range(1, max_retries + 1):
        # 기존 파일 삭제
        if os.path.exists(output_path):
            os.remove(output_path)

        try:
            generate_image(sd_prompt, output_path, host=host, port=port)
        except Exception as e:
            return {"ok": False, "path": output_path, "sd_prompt": sd_prompt,
                    "attempts": attempt, "feedback": f"생성 실패: {e}"}

        # Vision 검토
        review = _review_image(output_path, kr_prompt)
        if review.get("ok", True):
            return {"ok": True, "path": output_path, "sd_prompt": sd_prompt,
                    "attempts": attempt, "feedback": review.get("feedback", "OK")}

        # 재시도: 피드백 반영하여 프롬프트 수정
        if attempt < max_retries:
            sd_prompt = _refine_sd_prompt(sd_prompt, review.get("feedback", ""))

    return {"ok": False, "path": output_path, "sd_prompt": sd_prompt,
            "attempts": max_retries, "feedback": review.get("feedback", "최대 재시도 초과")}
