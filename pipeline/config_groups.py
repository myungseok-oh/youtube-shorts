# -*- coding: utf-8 -*-
"""
채널 설정 옵션 그룹 및 기본값 정의.
- 모든 채널 config 필드의 기본값을 한곳에서 관리
- 옵션 그룹 정의 (UI 탭 + 활성/비활성 제어)
"""

# ── 전체 기본값 ──────────────────────────────────────────
DEFAULTS = {
    # 기본 (basic) — 항상 표시
    "fixed_topic":       False,
    "use_subagent":      False,

    # 콘텐츠 (content) — 항상 표시
    "target_duration":   60,
    "format":            "single",
    "dedup_hours":       24,
    "skip_web_search":   False,
    "production_mode":   "manual",
    "auto_bg_source":    "sd_image",

    # 슬라이드 스타일 (slide_style)
    "slide_layout":          "full",
    "bg_display_mode":       "zone",
    "slide_zone_ratio":      "",
    "slide_text_bg":         4,
    "sub_text_size":         0,
    "slide_main_text_size":  0,
    "slide_badge_size":      0,
    "slide_accent_color":    "#ff6b35",
    "slide_hl_color":        "#ffd700",
    "slide_bg_gradient":     "",

    # 이미지/영상 (image)
    "bg_media_type":             "auto",
    "first_slide_single_bg":     False,
    "image_style":               "mixed",
    "image_prompt_style":        "",
    # image_scene_references 제거됨 (고정 매핑 → 이미지 다양성 저해)

    # 인트로/아웃트로 (intro_outro)
    "intro_duration":    3,
    "outro_duration":    3,
    "intro_narration":   "",
    "outro_narration":   "",
    "narration_delay":   2,

    # TTS (tts) — 항상 표시
    "tts_engine":        "edge-tts",
    "tts_voice":         "ko-KR-SunHiNeural",
    "tts_rate":          "+0%",
    "google_voice":      "ko-KR-Wavenet-A",
    "google_rate":       "+0%",
    "sovits_ref_voice":  "",
    "sovits_ref_text":   "",
    "sovits_speed":      1.0,

    # BGM/SFX (audio_fx)
    "bgm_enabled":       False,
    "bgm_file":          "",
    "bgm_volume":        10,
    "subtitle_enabled":  False,
    "sfx_enabled":       False,
    "sfx_volume":        15,
    "sfx_transition":    "",
    "sfx_intro":         "",
    "sfx_outro":         "",
    "sfx_highlight":     "",
    "crossfade_transition": "fade",
    "crossfade_duration":   0.5,

    # 시장 데이터 (market_data)
    "market_data_sources": [],

    # 프롬프트 (prompt)
    "script_rules":      "",
    "roundup_rules":     "",

    # YouTube (youtube)
    "gemini_api_key":        "",
    "youtube_client_id":     "",
    "youtube_client_secret": "",
    "youtube_refresh_token": "",
    "youtube_privacy":       "private",
    "youtube_upload_mode":   "manual",

    # 스케줄 (schedule)
    "schedule_enabled":  False,
    "schedule_times":    [],
    "schedule_days":     ["mon", "tue", "wed", "thu", "fri"],
}

# ── 옵션 그룹 정의 ──────────────────────────────────────
# 각 그룹: id, label, icon, fields 목록, always_on 여부
OPTION_GROUPS = [
    {
        "id": "basic",
        "label": "기본",
        "icon": "B",
        "always_on": True,
        "fields": ["fixed_topic", "use_subagent"],
    },
    {
        "id": "content",
        "label": "콘텐츠",
        "icon": "C",
        "always_on": True,
        "fields": [
            "target_duration", "format", "dedup_hours",
            "skip_web_search", "production_mode", "auto_bg_source",
            "image_style",
        ],
    },
    {
        "id": "tts",
        "label": "TTS",
        "icon": "T",
        "always_on": True,
        "fields": [
            "tts_engine", "tts_voice", "tts_rate",
            "google_voice", "google_rate",
            "sovits_ref_voice", "sovits_ref_text", "sovits_speed",
        ],
    },
    {
        "id": "slide_style",
        "label": "슬라이드",
        "icon": "S",
        "always_on": False,
        "fields": [
            "slide_layout", "bg_display_mode", "slide_zone_ratio",
            "slide_text_bg", "sub_text_size", "slide_main_text_size",
            "slide_badge_size", "slide_accent_color", "slide_hl_color",
            "slide_bg_gradient",
        ],
    },
    {
        "id": "image",
        "label": "이미지",
        "icon": "I",
        "always_on": False,
        "fields": [
            "bg_media_type", "first_slide_single_bg",
        ],
    },
    {
        "id": "intro_outro",
        "label": "인트로/아웃트로",
        "icon": "IO",
        "always_on": False,
        "fields": [
            "intro_duration", "outro_duration",
            "intro_narration", "outro_narration", "narration_delay",
        ],
    },
    {
        "id": "audio_fx",
        "label": "BGM/SFX",
        "icon": "FX",
        "always_on": False,
        "fields": [
            "bgm_enabled", "bgm_file", "bgm_volume",
            "subtitle_enabled",
            "sfx_enabled", "sfx_volume",
            "sfx_transition", "sfx_intro", "sfx_outro", "sfx_highlight",
            "crossfade_transition", "crossfade_duration",
        ],
    },
    {
        "id": "market_data",
        "label": "시장 데이터",
        "icon": "M",
        "always_on": False,
        "fields": ["market_data_sources"],
    },
    # prompt 그룹 제거됨: script_rules / roundup_rules / image_prompt_style → 기본 탭 통합 지침으로 이동
    {
        "id": "youtube",
        "label": "YouTube",
        "icon": "YT",
        "always_on": False,
        "fields": [
            "gemini_api_key",
            "youtube_client_id", "youtube_client_secret",
            "youtube_refresh_token", "youtube_privacy", "youtube_upload_mode",
        ],
    },
    {
        "id": "schedule",
        "label": "스케줄",
        "icon": "SC",
        "always_on": False,
        "fields": ["schedule_enabled", "schedule_times", "schedule_days"],
    },
]


def get_config_groups_payload():
    """API 응답용: 그룹 정의 + 기본값"""
    return {
        "defaults": DEFAULTS,
        "groups": OPTION_GROUPS,
    }


def detect_enabled_groups(config: dict) -> list[str]:
    """기존 채널 config에서 활성 그룹을 자동 감지.
    config에 값이 있는(기본값과 다른) 필드가 속한 그룹을 활성으로 판정."""
    enabled = set()
    for group in OPTION_GROUPS:
        if group["always_on"]:
            enabled.add(group["id"])
            continue
        for field in group["fields"]:
            val = config.get(field)
            default_val = DEFAULTS.get(field)
            if val is not None and val != default_val:
                enabled.add(group["id"])
                break
    return sorted(enabled)
