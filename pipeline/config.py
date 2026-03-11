"""설정 로더 — config.json 읽기 + 경로 해석"""
import json
import os

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_CFG_PATH = os.path.join(_ROOT, "config.json")
_cache = None


def load() -> dict:
    global _cache
    if _cache is None:
        with open(_CFG_PATH, "r", encoding="utf-8") as f:
            _cache = json.load(f)
    return _cache


def root_dir() -> str:
    return _ROOT


def ffmpeg() -> str:
    return load()["ffmpeg"]


def ffprobe() -> str:
    return load()["ffprobe"]


def output_dir() -> str:
    return os.path.join(_ROOT, load()["output_dir"])


def db_path() -> str:
    return os.path.join(_ROOT, load()["db_path"])


def channels_db_path() -> str:
    return os.path.join(_ROOT, "data", "channels.db")


def video_cfg() -> dict:
    return load()["video"]


def tts_cfg() -> dict:
    return load()["tts"]


def comfyui_cfg() -> dict:
    return load().get("comfyui", {"host": "127.0.0.1", "port": 8188})
