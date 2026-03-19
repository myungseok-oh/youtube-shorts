"""파이프라인 실행기 — 단계별로 DB 상태를 갱신하며 영상 제작

Phase A: news_search + script → waiting_slides (병렬, CPU)
Phase B: slides + tts + render + upload (큐 순차, GPU)
"""
from __future__ import annotations
import io
import json
import os
import subprocess
import sys
import threading
import time
import traceback
from collections import deque
from datetime import datetime

# Windows cp949 콘솔에서 유니코드 print 에러 방지
if sys.stdout and hasattr(sys.stdout, 'encoding') and sys.stdout.encoding and sys.stdout.encoding.lower().replace('-', '') != 'utf8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
if sys.stderr and hasattr(sys.stderr, 'encoding') and sys.stderr.encoding and sys.stderr.encoding.lower().replace('-', '') != 'utf8':
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

from pipeline import config
from pipeline.agent import (
    generate_script, generate_image_prompts,
    generate_synopsis, generate_visual_plan, generate_script_from_plan,
    generate_all_in_one, _validate_with_claude,
)
from pipeline.tts_generator import generate_audio, GOOGLE_CLOUD_VOICES
from pipeline.slide_generator import generate_slides, generate_thumbnail
from pipeline.sync_engine import build_timeline, merge_slide_audio
from pipeline.video_renderer import (
    render_segments, concat_segments, render_static_silent,
    render_static_with_audio, apply_audio_mix,
)
from pipeline.metadata import generate_metadata
from pipeline.youtube_uploader import upload_video
from pipeline.image_generator import generate_backgrounds
from pipeline.sd_generator import agent_generate_image, generate_video as sd_generate_video, check_available as sd_check_available
from pipeline.gemini_generator import generate_image as gemini_generate_image
from pipeline.gemini_generator import image_to_video as gemini_image_to_video
# from pipeline.qa_agent import run_qa  # QA 비활성화


def _gc_voices():
    return GOOGLE_CLOUD_VOICES


# ─── 이미지 프롬프트 기반 모션/전환 자동 선정 ───

# motion 텍스트 → Ken Burns 프리셋 매핑 (video_renderer._MOTION_MAP 확장)
_AUTO_MOTION_MAP = {
    "slow zoom in": "zoom_in", "zoom in": "zoom_in", "push in": "zoom_in",
    "dolly in": "zoom_in", "close-up": "zoom_in", "close up": "zoom_in",
    "slow zoom out": "zoom_out", "zoom out": "zoom_out", "pull out": "zoom_out",
    "dolly out": "zoom_out", "reveal": "zoom_out", "pull back": "zoom_out",
    "crane descend": "zoom_in", "crane ascend": "zoom_out",
    "pan left": "pan_left", "gentle pan left": "pan_left",
    "pan right": "pan_right", "gentle pan right": "pan_right",
    "pan across": "pan_right", "tracking shot": "pan_right",
    "slide left": "pan_left", "slide right": "pan_right",
    "pan up": "pan_up", "tilt up": "pan_up", "gentle pan up": "pan_up",
    "pan down": "pan_down", "tilt down": "pan_down", "gentle pan down": "pan_down",
    "overhead": "zoom_out", "aerial": "zoom_out", "bird": "zoom_out",
    "establishing": "zoom_out", "wide shot": "zoom_out",
    "static": "none", "still": "none",
}

# bg_type별 기본 전환 효과 추천
_BG_TYPE_TRANSITIONS = {
    "photo":   ["fade", "dissolve", "smoothleft", "smoothright"],
    "broll":   ["dissolve", "fade", "smoothleft", "smoothright"],
    "graph":   ["wipeleft", "wiperight", "slideup", "slidedown"],
    "logo":    ["fade", "dissolve", "circlecrop"],
    "closing": ["fade"],
}

# 장면 전환 강도별 전환 효과 (같은 맥락 → 부드러운, 다른 맥락 → 강한)
_SMOOTH_TRANSITIONS = ["fade", "dissolve", "smoothleft", "smoothright"]
_STRONG_TRANSITIONS = ["wipeleft", "wiperight", "slideup", "slidedown",
                       "slideleft", "slideright", "circlecrop", "radial"]


def _auto_assign_effects(image_prompts: list[dict], ch_config: dict) -> tuple[list, list]:
    """이미지 프롬프트 내용으로 모션 효과 + 전환 효과 자동 선정.

    Returns:
        (slide_motions, slide_transitions) — compose_data에 저장할 형식
    """
    import random as _rand

    default_tr = ch_config.get("crossfade_transition", "fade")
    default_dur = ch_config.get("crossfade_duration", 0.5)

    # closing 슬라이드 제외 (프론트엔드 bgCount와 일치시킴)
    image_prompts = [p for p in image_prompts if p.get("en")]
    bg_count = len(image_prompts)

    # ── 1) 모션 선정 ──
    slide_motions = []
    for i, p in enumerate(image_prompts):
        slide_num = i + 1
        media = p.get("media", "image")
        motion_hint = (p.get("motion") or "").lower().strip()

        # 영상(video/mp4)이면 자체 모션 → 정적
        if media == "video":
            slide_motions.append({"slide": slide_num, "motion": "none"})
            continue

        # motion 힌트 텍스트 매핑 (긴 구문부터)
        matched = None
        for hint in sorted(_AUTO_MOTION_MAP.keys(), key=len, reverse=True):
            if hint in motion_hint:
                matched = _AUTO_MOTION_MAP[hint]
                break

        # en 프롬프트에서도 카메라 힌트 탐색
        if not matched:
            en = (p.get("en") or "").lower()
            for hint in sorted(_AUTO_MOTION_MAP.keys(), key=len, reverse=True):
                if hint in en:
                    matched = _AUTO_MOTION_MAP[hint]
                    break

        # bg_type별 기본값
        if not matched:
            bg_type = p.get("bg_type", "photo")
            if bg_type == "graph":
                matched = "none"  # 인포그래픽은 정적
            elif bg_type == "logo":
                matched = "zoom_in"  # 로고는 줌인
            else:
                matched = _rand.choice(["zoom_in", "zoom_out", "pan_right", "pan_left"])

        slide_motions.append({"slide": slide_num, "motion": matched})

    # ── 2) 전환 선정 ──
    slide_transitions = []
    for i in range(bg_count - 1):
        cur = image_prompts[i]
        nxt = image_prompts[i + 1]
        slide_num = i + 1

        cur_type = cur.get("bg_type", "photo")
        nxt_type = nxt.get("bg_type", "photo")
        cur_slide = cur.get("slide", i + 1)
        nxt_slide = nxt.get("slide", i + 2)

        # 같은 슬라이드(다중 배경) → 부드러운 전환
        if cur_slide == nxt_slide:
            effect = _rand.choice(["dissolve", "fade"])
            dur = 0.3
        # bg_type 동일 (같은 맥락) → 부드러운 전환
        elif cur_type == nxt_type:
            pool = _BG_TYPE_TRANSITIONS.get(cur_type, _SMOOTH_TRANSITIONS)
            effect = _rand.choice(pool)
            dur = default_dur
        # bg_type 변경 (맥락 전환) → 강한 전환
        else:
            effect = _rand.choice(_STRONG_TRANSITIONS)
            dur = default_dur

        slide_transitions.append({
            "slide": slide_num,
            "effect": effect,
            "duration": dur,
        })

    return slide_motions, slide_transitions


def _prompt_en(p) -> str:
    """이미지 프롬프트에서 영어 부분 추출. dict면 en, 문자열이면 그대로."""
    if isinstance(p, dict):
        return p.get("en", "")
    return str(p) if p else ""


STEP_DEFINITIONS = [
    {"name": "synopsis",     "order": 1, "label": "시놉시스"},
    {"name": "visual_plan",  "order": 2, "label": "비주얼 플랜"},
    {"name": "script",       "order": 3, "label": "대본 작성"},
    {"name": "slides",       "order": 4, "label": "슬라이드"},
    {"name": "tts",          "order": 5, "label": "TTS"},
    {"name": "render",       "order": 6, "label": "영상 합성"},
    {"name": "upload",       "order": 7, "label": "업로드"},
]

# Phase A step names (for retry/recover logic)
PHASE_A_STEPS = ("synopsis", "visual_plan", "script")

MAX_QA_RETRIES = 2


def _now():
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _update_step(db, job_id, step_name, status, output_data=None, error_msg=None):
    """DB에 단계 상태 갱신"""
    fields = {"status": status, "updated_at": _now()}
    if status == "running":
        fields["started_at"] = _now()
        fields["error_msg"] = ""  # 이전 오류 메시지 초기화
    if status in ("completed", "failed"):
        fields["completed_at"] = _now()
    if output_data:
        fields["output_data"] = json.dumps(output_data, ensure_ascii=False)
    if error_msg:
        fields["error_msg"] = error_msg

    set_clause = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values())
    db.execute(
        f"UPDATE job_steps SET {set_clause} WHERE job_id = ? AND step_name = ?",
        values + [job_id, step_name]
    )
    db.execute(
        "UPDATE jobs SET updated_at = ? WHERE id = ?",
        [_now(), job_id]
    )


def _get_job_dirs(job_id: str) -> dict:
    """작업별 디렉토리 경로 반환 + 생성"""
    job_dir = os.path.join(config.output_dir(), job_id)
    dirs = {
        "job": job_dir,
        "audio": os.path.join(job_dir, "audio"),
        "image": os.path.join(job_dir, "images"),
        "bg": os.path.join(job_dir, "backgrounds"),
        "segment": os.path.join(job_dir, "segments"),
        "video": os.path.join(job_dir, "video"),
    }
    for d in dirs.values():
        os.makedirs(d, exist_ok=True)
    return dirs


def _find_existing_audio(audio_dir: str, expected_count: int):
    """이미 생성된 오디오 파일이 모두 있으면 경로 리스트 반환, 없으면 None"""
    paths = []
    for i in range(1, expected_count + 1):
        mp3 = os.path.join(audio_dir, f"audio_{i}.mp3")
        wav = os.path.join(audio_dir, f"audio_{i}.wav")
        if os.path.exists(mp3):
            paths.append(mp3)
        elif os.path.exists(wav):
            paths.append(wav)
        else:
            return None
    return paths


def _build_sovits_cfg(ch_config: dict, channel_id: str) -> dict:
    """채널 config에서 GPT-SoVITS 설정 dict 생성"""
    ref_voice = ch_config.get("sovits_ref_voice", "")
    ref_audio = ""
    if ref_voice:
        voice_dir = os.path.join(config.root_dir(), "data", "ref_voices")
        p = os.path.join(voice_dir, ref_voice)
        if os.path.exists(p):
            ref_audio = p
    return {
        "host": ch_config.get("sovits_host", "127.0.0.1"),
        "port": ch_config.get("sovits_port", 9880),
        "ref_audio": ref_audio,
        "ref_text": ch_config.get("sovits_ref_text", ""),
        "speed": ch_config.get("sovits_speed", 1.0),
    }


# ─── Phase A: 뉴스 검색 + 대본 작성 → waiting_slides ───

def _run_phase_a(db_ch, db, job_id: str, script_json: dict = None,
                  use_gemini_draft: bool = False):
    """Phase A v2: synopsis → visual_plan → script → waiting_slides"""
    _pa_start = time.time()
    _pa_tag = f"[PhaseA {job_id[:8]}]"
    print(f"{_pa_tag} === Phase A 시작 ===")
    try:
        db.execute("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
                    ["running", _now(), job_id])

        job_row = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
        channel_id = job_row["channel_id"]
        topic = job_row["topic"]
        print(f"{_pa_tag} 채널={channel_id}, 주제={topic[:50]}")

        channel = db_ch.fetchone("SELECT * FROM channels WHERE id = ?", [channel_id])
        instructions = channel.get("instructions", "") if channel else ""
        brand = channel.get("name", "이슈60초") if channel else "이슈60초"
        ch_config = json.loads(channel.get("config", "{}")) if channel else {}
        image_prompt_style = ch_config.get("image_prompt_style", "")
        image_scene_references = ch_config.get("image_scene_references", "")
        channel_format = ch_config.get("format", "single")
        script_rules = ch_config.get("script_rules", "")
        roundup_rules = ch_config.get("roundup_rules", "")

        # 디렉토리 생성
        _get_job_dirs(job_id)

        # 인트로 나레이션 템플릿 치환 + 대본 연결 지시
        intro_narration_raw = ch_config.get("intro_narration", "").strip()
        if intro_narration_raw:
            _dt = datetime.now()
            _resolved = intro_narration_raw.replace(
                "{날짜}", f"{_dt.month}월 {_dt.day}일"
            ).replace(
                "{요일}", ["월", "화", "수", "목", "금", "토", "일"][_dt.weekday()] + "요일"
            ).replace(
                "{오전오후}", "오전" if _dt.hour < 12 else "오후"
            )
            instructions += (f"\n\n★ 이 채널은 별도 인트로 나레이션이 있습니다: \"{_resolved}\"\n"
                             "인트로 나레이션이 먼저 재생된 후 첫 슬라이드 나레이션이 이어집니다.\n"
                             "첫 슬라이드 sentences는 인트로와 자연스럽게 이어지도록 작성하세요.\n"
                             "인트로에서 이미 한 인사/소개를 반복하지 마세요.")

        # 아웃트로가 있으면 나래이션에 마무리 멘트 금지
        has_outro = bool(ch_config.get("outro_narration", "").strip())
        if _find_channel_image(channel_id, "outro_bg"):
            has_outro = True
            instructions += ("\n\n★ 이 채널은 별도 아웃트로 영상이 있습니다. "
                             "나레이션(sentences)에 마무리 인사, 구독/좋아요 요청, "
                             "'~였습니다' 같은 엔딩 멘트를 절대 포함하지 마세요. "
                             "마지막 콘텐츠 문장까지만 작성하세요.")

        # 채널 config에 market_data_sources가 있으면 시장 데이터 크롤링 → 프롬프트에 주입
        market_sources = ch_config.get("market_data_sources", [])
        if market_sources:
            _t_market = time.time()
            print(f"{_pa_tag} [1/4] 시장 데이터 크롤링 시작: {market_sources}")
            try:
                from pipeline.market_crawler import collect_market_data, format_market_context
                market_data = collect_market_data(sources=market_sources)
                market_context = format_market_context(market_data)
                instructions = instructions + "\n\n" + market_context
                print(f"{_pa_tag} [1/4] 시장 데이터 크롤링 완료: {time.time()-_t_market:.1f}초")
            except Exception as e:
                print(f"{_pa_tag} [1/4] 시장 데이터 크롤링 실패 ({time.time()-_t_market:.1f}초): {e}")

        if script_json is None:
            target_duration = int(ch_config.get("target_duration", 60))

            # ── 통합 1회 호출: 시놉시스 + 비주얼 플랜 + 대본 ──
            _update_step(db, job_id, "synopsis", "running")
            try:
                # 시장 데이터가 이미 주입된 채널 또는 skip_web_search 설정 → 웹검색 스킵 (속도 향상)
                _skip_web = bool(ch_config.get("market_data_sources")) or ch_config.get("skip_web_search", False)
                # Gemini 드래프트 모드: 토글 ON + API 키 존재 시
                _gemini_key = ch_config.get("gemini_api_key", "") if use_gemini_draft else ""
                _mode = "Gemini+Claude" if _gemini_key else ("Claude(no-web)" if _skip_web else "Claude(web)")
                print(f"{_pa_tag} [2/4] 대본 생성 시작: mode={_mode}, target={target_duration}초")
                _t_script = time.time()
                result = generate_all_in_one(
                    topic, instructions, brand,
                    channel_format=channel_format,
                    has_outro=has_outro,
                    target_duration=target_duration,
                    prompt_style=image_prompt_style,
                    layout=ch_config.get("slide_layout", "full"),
                    image_style=ch_config.get("image_style", "mixed"),
                    scene_references=image_scene_references,
                    bg_display_mode=ch_config.get("bg_display_mode", "zone"),
                    bg_media_type=ch_config.get("bg_media_type", "auto"),
                    script_rules=script_rules,
                    roundup_rules=roundup_rules,
                    skip_web_search=_skip_web,
                    gemini_api_key=_gemini_key,
                )
            except Exception as e:
                print(f"{_pa_tag} [2/4] 대본 생성 실패 ({time.time()-_t_script:.1f}초): {e}")
                _update_step(db, job_id, "synopsis", "failed", error_msg=str(e))
                raise

            _elapsed_script = time.time() - _t_script
            synopsis = result.get("synopsis", {})
            visual_plan = result.get("visual_plan", [])
            script_json = result.get("script", {})
            print(f"{_pa_tag} [2/4] 대본 생성 완료: {_elapsed_script:.1f}초, "
                  f"scenes={len(synopsis.get('scenes',[]))}, vp={len(visual_plan)}, "
                  f"sentences={len(script_json.get('sentences',[]))}, slides={len(script_json.get('slides',[]))}")

            # 3개 step 모두 완료 처리
            _update_step(db, job_id, "synopsis", "completed",
                         output_data={
                             "scenes": len(synopsis.get("scenes", [])),
                             "facts": len(synopsis.get("news_facts", [])),
                         })
            _update_step(db, job_id, "visual_plan", "completed",
                         output_data={"scenes": len(visual_plan)})
            _update_step(db, job_id, "script", "completed",
                         output_data={
                             "sentences": len(script_json.get("sentences", [])),
                             "slides": len(script_json.get("slides", [])),
                         })

            # topic을 youtube_title로 업데이트
            _t_save = time.time()
            print(f"{_pa_tag} [3/4] DB 저장 시작")
            _yt_title = script_json.get("youtube_title", "").strip()
            _real_topic = _yt_title or synopsis.get("youtube_title", "").strip() or topic
            db.execute(
                "UPDATE jobs SET script_json = ?, topic = ?, updated_at = ? WHERE id = ?",
                [json.dumps(script_json, ensure_ascii=False), _real_topic, _now(), job_id]
            )

            # ── meta_json에 synopsis + visual_plan + image_prompts 저장 ──
            meta = {}
            existing = db.fetchone("SELECT meta_json FROM jobs WHERE id = ?", [job_id])
            if existing and existing.get("meta_json"):
                try:
                    meta = json.loads(existing["meta_json"])
                except (json.JSONDecodeError, TypeError):
                    pass

            meta["synopsis"] = synopsis
            meta["visual_plan"] = visual_plan
            meta["style_guide"] = result.get("style_guide", {})

            # visual_plan → image_prompts 변환 (Phase B 호환)
            # 기존 프롬프트가 있고 visual_plan이 비어있으면 보존 (수동 대본 보호)
            image_prompts = []
            for vp in visual_plan:
                image_prompts.append({
                    "ko": vp.get("ko", ""),
                    "en": vp.get("en", ""),
                    "motion": vp.get("motion", ""),
                    "media": vp.get("media", "image"),
                    "slide": vp.get("scene", 1),
                })
            if image_prompts and any(p.get("en") for p in image_prompts):
                meta["image_prompts"] = image_prompts
            elif not meta.get("image_prompts") or not any(
                    (p.get("en") if isinstance(p, dict) else "") for p in meta.get("image_prompts", [])):
                meta["image_prompts"] = image_prompts

            db.execute(
                "UPDATE jobs SET meta_json = ?, updated_at = ? WHERE id = ?",
                [json.dumps(meta, ensure_ascii=False), _now(), job_id]
            )
            print(f"{_pa_tag} [3/4] DB 저장 완료: {time.time()-_t_save:.1f}초")

        else:
            # script_json 직접 제공 (수동 대본) → Claude 후처리
            target_duration = int(ch_config.get("target_duration", 60))

            # 슬라이드 내장 이미지 프롬프트 or meta_json에 저장된 프롬프트 → visual_plan으로 변환
            _existing_vp = []
            _meta_existing = {}
            _meta_row = db.fetchone("SELECT meta_json FROM jobs WHERE id = ?", [job_id])
            if _meta_row and _meta_row.get("meta_json"):
                try:
                    _meta_existing = json.loads(_meta_row["meta_json"])
                except (json.JSONDecodeError, TypeError):
                    pass
            _saved_prompts = _meta_existing.get("image_prompts", [])

            if _saved_prompts and any(p.get("en") for p in _saved_prompts):
                # meta_json에 저장된 프롬프트 사용 (프론트에서 보낸 다중 프롬프트)
                for i, p in enumerate(_saved_prompts):
                    _existing_vp.append({
                        "scene": p.get("slide", i + 1),
                        "media": p.get("media", "image"),
                        "duration": 5,
                        "bg_type": "photo",
                        "ko": p.get("ko", ""),
                        "en": p.get("en", ""),
                        "motion": p.get("motion", ""),
                    })
            else:
                # 슬라이드에 내장된 프롬프트 추출
                _scene = 1
                for s in script_json.get("slides", []):
                    if s.get("bg_type") == "closing":
                        continue
                    _existing_vp.append({
                        "scene": _scene,
                        "media": "image",
                        "duration": 5,
                        "bg_type": s.get("bg_type", "photo"),
                        "ko": s.get("image_prompt_ko", ""),
                        "en": s.get("image_prompt_en", ""),
                        "motion": "",
                    })
                    _scene += 1

            draft_json = {"script": script_json}
            if any(vp.get("en") for vp in _existing_vp):
                draft_json["visual_plan"] = _existing_vp

            _update_step(db, job_id, "synopsis", "running")
            try:
                _t_validate = time.time()
                print(f"{_pa_tag} [2/4] 수동 대본 Claude 검증 시작")
                result = _validate_with_claude(
                    draft_json, instructions, brand, topic,
                    target_duration=target_duration,
                    prompt_style=image_prompt_style,
                    layout=ch_config.get("slide_layout", "full"),
                    image_style=ch_config.get("image_style", "mixed"),
                    scene_references=image_scene_references,
                    bg_display_mode=ch_config.get("bg_display_mode", "zone"),
                    bg_media_type=ch_config.get("bg_media_type", "auto"),
                    channel_format=channel_format,
                    has_outro=has_outro,
                    script_rules=script_rules,
                    roundup_rules=roundup_rules,
                )
                script_json = result.get("script", script_json)
                visual_plan = result.get("visual_plan", [])
                print(f"{_pa_tag} [2/4] 수동 대본 검증 완료: {time.time()-_t_validate:.1f}초, "
                      f"sentences={len(script_json.get('sentences',[]))}, "
                      f"slides={len(script_json.get('slides',[]))}, vp={len(visual_plan)}")
            except Exception as e:
                print(f"{_pa_tag} [2/4] 수동 대본 검증 실패 ({time.time()-_t_validate:.1f}초): {e}")
                visual_plan = []
                result = {}
                traceback.print_exc()

            _update_step(db, job_id, "synopsis", "completed",
                         output_data={"message": "대본 검토 완료"})
            _update_step(db, job_id, "visual_plan", "completed",
                         output_data={"scenes": len(visual_plan)})
            _update_step(db, job_id, "script", "completed",
                         output_data={
                             "sentences": len(script_json.get("sentences", [])),
                             "slides": len(script_json.get("slides", [])),
                         })

            # topic을 youtube_title로 업데이트
            _yt_title = script_json.get("youtube_title", "").strip()
            if _yt_title:
                db.execute("UPDATE jobs SET topic = ?, updated_at = ? WHERE id = ?",
                           [_yt_title, _now(), job_id])

            # script_json + meta_json 저장
            db.execute("UPDATE jobs SET script_json = ?, updated_at = ? WHERE id = ?",
                       [json.dumps(script_json, ensure_ascii=False), _now(), job_id])

            meta = {}
            existing = db.fetchone("SELECT meta_json FROM jobs WHERE id = ?", [job_id])
            if existing and existing.get("meta_json"):
                try:
                    meta = json.loads(existing["meta_json"])
                except (json.JSONDecodeError, TypeError):
                    pass
            meta["visual_plan"] = visual_plan
            meta["style_guide"] = result.get("style_guide", {}) if visual_plan else {}
            image_prompts = []
            for vp in visual_plan:
                image_prompts.append({
                    "ko": vp.get("ko", ""),
                    "en": vp.get("en", ""),
                    "motion": vp.get("motion", ""),
                    "media": vp.get("media", "image"),
                    "slide": vp.get("scene", 1),
                })
            if image_prompts and any(p.get("en") for p in image_prompts):
                meta["image_prompts"] = image_prompts
            elif not meta.get("image_prompts") or not any(
                    (p.get("en") if isinstance(p, dict) else "") for p in meta.get("image_prompts", [])):
                meta["image_prompts"] = image_prompts
            db.execute("UPDATE jobs SET meta_json = ?, updated_at = ? WHERE id = ?",
                       [json.dumps(meta, ensure_ascii=False), _now(), job_id])

        # 모션/전환 효과 자동 선정 (이미지 프롬프트 기반)
        try:
            _ip = meta.get("image_prompts", [])
            if _ip:
                _auto_mo, _auto_tr = _auto_assign_effects(_ip, ch_config)
                from pipeline.composer import load_compose_data, save_compose_data
                _cd = load_compose_data(job_id)
                # 기존 설정이 없을 때만 자동 할당 (사용자 수동 설정 보호)
                if not _cd.get("slide_motions"):
                    _cd["slide_motions"] = _auto_mo
                if not _cd.get("slide_transitions"):
                    _cd["slide_transitions"] = _auto_tr
                save_compose_data(job_id, _cd)
                print(f"{_pa_tag} [4/4] 모션/전환 자동 선정: {len(_auto_mo)}모션, {len(_auto_tr)}전환")
        except Exception as _fx_err:
            print(f"{_pa_tag} [4/4] 모션/전환 자동 선정 실패 (무시): {_fx_err}")

        # Phase A 완료 → waiting_slides
        db.execute(
            "UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
            ["waiting_slides", _now(), job_id]
        )
        _pa_total = time.time() - _pa_start
        print(f"{_pa_tag} === Phase A 완료: 총 {_pa_total:.1f}초 ({_pa_total/60:.1f}분) ===")

    except Exception as e:
        _pa_total = time.time() - _pa_start
        print(f"{_pa_tag} === Phase A 실패: {_pa_total:.1f}초 ({_pa_total/60:.1f}분) === {e}")
        # 실패한 step 찾아서 에러 기록
        _pending = db.fetchone(
            "SELECT step_name FROM job_steps WHERE job_id = ? AND status IN ('running','pending') ORDER BY step_order LIMIT 1",
            [job_id])
        if _pending:
            _update_step(db, job_id, _pending["step_name"], "failed",
                         error_msg=str(e)[:1000])
        db.execute(
            "UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
            ["failed", _now(), job_id]
        )
        traceback.print_exc()
    finally:
        try:
            db.checkpoint()
        except Exception:
            pass


def _get_qa_retry_count(db, job_id: str) -> int:
    """현재 QA 재시도 횟수를 DB에서 조회 (script step의 qa_retry 필드)"""
    step = db.fetchone(
        "SELECT output_data FROM job_steps WHERE job_id = ? AND step_name = 'script'",
        [job_id])
    if step and step.get("output_data"):
        try:
            data = json.loads(step["output_data"])
            return data.get("qa_retry", 0)
        except (json.JSONDecodeError, TypeError):
            pass
    return 0


def _qa_restart(db, job_id, restart_from, retry_count,
                channel, topic, brand, dirs,
                tts_voice_override, tts_rate_override, sovits_cfg_override,
                qa_feedback: str = ""):
    """QA 실패 시 해당 단계부터 재작업"""
    instructions = channel.get("instructions", "") if channel else ""
    ch_config_qa = json.loads(channel.get("config", "{}")) if channel else {}

    if restart_from == "script":
        # 대본 재생성 (QA 피드백 포함)
        _update_step(db, job_id, "script", "running")
        feedback_section = ""
        if qa_feedback:
            feedback_section = f"\n\n⚠️ 이전 대본이 QA 검토에서 탈락했습니다. 아래 문제점을 반드시 수정해주세요:\n{qa_feedback}\n"
        try:
            new_script = generate_script(topic, instructions + feedback_section, brand,
                                         script_rules=ch_config_qa.get("script_rules", ""),
                                         roundup_rules=ch_config_qa.get("roundup_rules", ""),
                                         has_outro=bool(ch_config_qa.get("outro_narration", "").strip()),
                                         use_subagent=bool(ch_config_qa.get("use_subagent", False)))
            _yt_title_qa = new_script.get("youtube_title", "").strip()
            _real_topic_qa = _yt_title_qa or new_script.get("title", "").strip() or topic
            db.execute("UPDATE jobs SET script_json = ?, topic = ?, updated_at = ? WHERE id = ?",
                       [json.dumps(new_script, ensure_ascii=False), _real_topic_qa, _now(), job_id])
            _update_step(db, job_id, "script", "completed",
                         output_data={"sentences": len(new_script.get("sentences", [])),
                                      "slides": len(new_script.get("slides", [])),
                                      "qa_retry": retry_count})
        except Exception as e:
            _update_step(db, job_id, "script", "failed", error_msg=str(e))
            db.execute("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
                       ["failed", _now(), job_id])
            return

        # script 재생성 후 slides부터 이어서
        _reset_steps_from(db, job_id, ["slides", "tts", "render", "qa", "upload"])

    elif restart_from == "slides":
        _reset_steps_from(db, job_id, ["slides", "tts", "render", "qa", "upload"])
    else:
        return

    # Phase B 재실행 (재귀적으로 _run_phase_b 호출)
    print(f"[runner] QA restart from '{restart_from}' (retry {retry_count})")
    _run_phase_b(db, job_id, tts_voice_override, tts_rate_override, sovits_cfg_override)


def _reset_steps_from(db, job_id, step_names):
    """지정된 step들을 pending으로 리셋"""
    for name in step_names:
        db.execute(
            "UPDATE job_steps SET status = 'pending', error_msg = NULL, "
            "output_data = NULL, started_at = NULL, completed_at = NULL "
            "WHERE job_id = ? AND step_name = ?",
            [job_id, name])


# ─── Phase B: 슬라이드 + TTS + 렌더 + 업로드 ───

def _run_phase_b(db_ch, db, job_id: str, tts_voice_override: str = "",
                  tts_rate_override=None, tts_engine_override: str = "",
                  sovits_cfg_override: dict = None):
    """Phase B: slides → tts → render → upload (업로드된 배경 이미지 사용)"""
    try:
        db.execute("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
                    ["running", _now(), job_id])

        job_row = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
        channel_id = job_row["channel_id"]
        topic = job_row["topic"]
        script_json = json.loads(job_row["script_json"])

        channel = db_ch.fetchone("SELECT * FROM channels WHERE id = ?", [channel_id])
        brand = channel.get("name", "이슈60초") if channel else "이슈60초"
        ch_config_pb = json.loads(channel.get("config", "{}")) if channel else {}
        slide_layout = ch_config_pb.get("slide_layout", "full")
        bg_display_mode = ch_config_pb.get("bg_display_mode", "zone")
        dirs = _get_job_dirs(job_id)
        sentences = script_json.get("sentences", [])
        slides_data = script_json.get("slides", [])
        date_str = script_json.get("date", "")

        # 빈 문장 필터링 (클로징 멘트 삭제 등으로 빈 문장 남은 경우)
        orig_sent_count = len(sentences)
        sentences = [s for s in sentences if s.get("text", "").strip()]
        if len(sentences) < orig_sent_count:
            # 오디오 캐시 무효화 (인덱스 불일치 방지)
            import glob as glob_mod
            for f in glob_mod.glob(os.path.join(dirs["audio"], "audio_*")):
                os.remove(f)
            print(f"[runner] 빈 문장 {orig_sent_count - len(sentences)}개 제거, 오디오 캐시 삭제")

        # --- Step 3: slides (배경 자동 생성 + 슬라이드 렌더링) ---
        _update_step(db, job_id, "slides", "running")
        try:
            # 기존 배경이 없으면 자동 생성
            bg_results = _load_uploaded_backgrounds(dirs["bg"], len(slides_data))
            existing_bg_count = sum(1 for bg in bg_results if bg.get("path"))

            if existing_bg_count <= 0:
                # 배경 자동 생성
                ch_config_b = json.loads(channel.get("config", "{}")) if channel else {}
                auto_bg_source = ch_config_b.get("auto_bg_source", "sd_image")
                image_prompt_style_b = ch_config_b.get("image_prompt_style", "")
                image_scene_references_b = ch_config_b.get("image_scene_references", "")

                slide_layout_b = ch_config_b.get("slide_layout", "full")
                image_style_b = ch_config_b.get("image_style", "mixed")

                # script_json 슬라이드에 image_prompt_en이 있으면 그대로 사용
                _existing = [
                    {"ko": s.get("image_prompt_ko", ""), "en": s.get("image_prompt_en", "")}
                    for s in slides_data if s.get("bg_type") != "closing"
                ]
                if all(p.get("en") for p in _existing):
                    image_prompts = _existing
                    print(f"[runner] 슬라이드에 image_prompt 존재 ({len(_existing)}개)")
                    # meta_json에 프롬프트 저장
                    meta = {}
                    existing_meta = db.fetchone("SELECT meta_json FROM jobs WHERE id = ?", [job_id])
                    if existing_meta and existing_meta.get("meta_json"):
                        try:
                            meta = json.loads(existing_meta["meta_json"])
                        except (json.JSONDecodeError, TypeError):
                            pass
                    meta["image_prompts"] = image_prompts
                    db.execute("UPDATE jobs SET meta_json = ?, updated_at = ? WHERE id = ?",
                               [json.dumps(meta, ensure_ascii=False), _now(), job_id])
                else:
                    # 슬라이드에 프롬프트 없음 → Phase A에서 생성한 meta_json 프롬프트 사용
                    image_prompts = []
                    existing_meta = db.fetchone("SELECT meta_json FROM jobs WHERE id = ?", [job_id])
                    if existing_meta and existing_meta.get("meta_json"):
                        try:
                            meta = json.loads(existing_meta["meta_json"])
                            image_prompts = meta.get("image_prompts", [])
                            if image_prompts and any(_prompt_en(p) for p in image_prompts):
                                print(f"[runner] Phase A 프롬프트 사용 ({len(image_prompts)}개)")
                            else:
                                image_prompts = []
                        except (json.JSONDecodeError, TypeError):
                            image_prompts = []

                    # Phase A에서 프롬프트 생성 실패 → Phase B에서 재생성
                    if not image_prompts or not any(_prompt_en(p) for p in image_prompts):
                        print("[runner] image_prompt 없음 - Phase B에서 재생성 시도")
                        try:
                            bg_display_mode_b = ch_config_b.get("bg_display_mode", "zone")
                            image_prompts = generate_image_prompts(
                                topic, slides_data,
                                prompt_style=image_prompt_style_b,
                                layout=slide_layout_b,
                                image_style=image_style_b,
                                scene_references=image_scene_references_b,
                                bg_display_mode=bg_display_mode_b,
                                sentences=sentences,
                                bg_media_type=ch_config_b.get("bg_media_type", "auto"),
                                auto_bg_source=ch_config_b.get("auto_bg_source", ""),
                                first_slide_single_bg=ch_config_b.get("first_slide_single_bg", False),
                            )
                            if image_prompts and any(_prompt_en(p) for p in image_prompts):
                                print(f"[runner] Phase B 프롬프트 재생성 성공 ({len(image_prompts)}개)")
                                meta = {}
                                if existing_meta and existing_meta.get("meta_json"):
                                    try:
                                        meta = json.loads(existing_meta["meta_json"])
                                    except (json.JSONDecodeError, TypeError):
                                        pass
                                meta["image_prompts"] = image_prompts
                                db.execute("UPDATE jobs SET meta_json = ?, updated_at = ? WHERE id = ?",
                                           [json.dumps(meta, ensure_ascii=False), _now(), job_id])
                            else:
                                image_prompts = []
                                print("[runner] Phase B 프롬프트 재생성도 빈 결과")
                        except Exception as regen_err:
                            print(f"[runner] Phase B 프롬프트 재생성 실패: {regen_err}")
                            image_prompts = []

                    if auto_bg_source == "gemini":
                        gemini_key = ch_config_b.get("gemini_api_key", "")
                        if gemini_key:
                            # ── Step 1: 전체 이미지 생성 ──
                            for idx, prompt in enumerate(image_prompts):
                                slide_num = prompt.get("slide", idx + 1) if isinstance(prompt, dict) else idx + 1
                                slide = slides_data[slide_num - 1] if slide_num <= len(slides_data) else {}
                                bg_type = slide.get("bg_type", "photo")
                                if bg_type == "closing":
                                    continue
                                en_prompt = _prompt_en(prompt)
                                if not en_prompt:
                                    continue
                                out = os.path.join(dirs["bg"], f"bg_{idx + 1}.png")
                                try:
                                    if idx > 0:
                                        time.sleep(5)
                                    if bg_type == "overview" or bg_display_mode == "fullscreen":
                                        _ar = "9:16"
                                    else:
                                        _ar = "1:1" if slide_layout_b in ("center", "top", "bottom") else "9:16"
                                    _char_ref_path = _find_channel_image(channel_id, "character_ref")
                                    gemini_generate_image(en_prompt, out, gemini_key,
                                                          aspect_ratio=_ar,
                                                          reference_image_path=_char_ref_path)
                                    print(f"[runner] bg_{idx+1}.png Gemini 이미지 생성 완료 (slide {slide_num})")
                                except Exception as e:
                                    print(f"[runner] bg_{idx+1} Gemini 이미지 생성 실패: {e}")

                            # ── Step 2: video 추천 이미지 → Veo 3.1 Fast 영상화 ──
                            for idx, prompt in enumerate(image_prompts):
                                media_rec = prompt.get("media", "image") if isinstance(prompt, dict) else "image"
                                if media_rec != "video":
                                    continue
                                slide_num = prompt.get("slide", idx + 1) if isinstance(prompt, dict) else idx + 1
                                slide = slides_data[slide_num - 1] if slide_num <= len(slides_data) else {}
                                bg_type = slide.get("bg_type", "photo")
                                if bg_type in ("graph", "overview", "closing"):
                                    continue
                                img_path = os.path.join(dirs["bg"], f"bg_{idx + 1}.png")
                                if not os.path.exists(img_path):
                                    continue
                                mp4_path = os.path.join(dirs["bg"], f"bg_{idx + 1}.mp4")
                                motion = prompt.get("motion", "") if isinstance(prompt, dict) else ""
                                en_prompt = _prompt_en(prompt)
                                vid_prompt = f"{en_prompt}, {motion}" if motion else en_prompt
                                try:
                                    ok = gemini_image_to_video(img_path, vid_prompt, mp4_path,
                                                              gemini_key, duration=6)
                                    if ok:
                                        print(f"[runner] bg_{idx+1}.mp4 Veo 영상화 완료 (slide {slide_num})")
                                    else:
                                        print(f"[runner] bg_{idx+1} 영상화 실패 — 이미지 유지")
                                except Exception as e:
                                    print(f"[runner] bg_{idx+1} Veo 영상화 실패: {e}")
                        else:
                            print("[runner] Gemini API key 없음 — 배경 생성 스킵")

                    elif auto_bg_source in ("sd_video", "sd_image"):
                        comfyui_cfg = config.comfyui_cfg()
                        sd_available = sd_check_available(comfyui_cfg["host"], comfyui_cfg["port"])
                        if sd_available:
                            for idx, prompt in enumerate(image_prompts):
                                slide_num = prompt.get("slide", idx + 1) if isinstance(prompt, dict) else idx + 1
                                slide = slides_data[slide_num - 1] if slide_num <= len(slides_data) else {}
                                bg_type = slide.get("bg_type", "photo")
                                en_prompt = _prompt_en(prompt)
                                if not en_prompt:
                                    continue
                                if auto_bg_source == "sd_video":
                                    out = os.path.join(dirs["bg"], f"bg_{idx + 1}.mp4")
                                    try:
                                        sd_generate_video(en_prompt, out,
                                                          host=comfyui_cfg["host"],
                                                          port=comfyui_cfg["port"],
                                                          timeout=600)
                                        print(f"[runner] bg_{idx+1}.mp4 생성 완료")
                                    except Exception as e:
                                        print(f"[runner] bg_{idx+1} 영상 생성 실패: {e}")
                                else:
                                    out = os.path.join(dirs["bg"], f"bg_{idx + 1}.png")
                                    try:
                                        agent_generate_image(en_prompt, out,
                                                             host=comfyui_cfg["host"],
                                                             port=comfyui_cfg["port"],
                                                             max_retries=2)
                                        print(f"[runner] bg_{idx+1}.png 생성 완료")
                                    except Exception as e:
                                        print(f"[runner] bg_{idx+1} 이미지 생성 실패: {e}")
                        else:
                            print(f"[runner] ComfyUI 연결 불가 — 배경 생성 스킵")
                    elif auto_bg_source == "openverse":
                        generate_backgrounds(slides_data, dirs["bg"])

                # 배경 다시 로드
                bg_results = _load_uploaded_backgrounds(dirs["bg"], len(slides_data),
                                                        source=auto_bg_source)

            # compose_data에서 슬라이드 오버라이드 로드
            _compose_ovr = {}
            _cd = {}
            try:
                from pipeline.composer import load_compose_data
                _cd = load_compose_data(job_id)
                _compose_ovr = _cd.get("slide_overrides", {})
            except Exception:
                pass

            _ch_format_b = ch_config_pb.get("format", "single")
            _show_badge_b = ch_config_pb.get("show_badge", True)
            if isinstance(_show_badge_b, str):
                _show_badge_b = _show_badge_b.lower() != "false"
            slide_paths = generate_slides(slides_data, dirs["image"],
                                          date=date_str, brand=brand,
                                          backgrounds=bg_results,
                                          layout=slide_layout,
                                          bg_display_mode=bg_display_mode,
                                          zone_ratio=ch_config_pb.get("slide_zone_ratio", ""),
                                          text_bg=ch_config_pb.get("slide_text_bg", 4),
                                          slide_overrides=_compose_ovr,
                                          sub_text_size=ch_config_pb.get("sub_text_size", 0),
                                          accent_color=ch_config_pb.get("slide_accent_color", ""),
                                          hl_color=ch_config_pb.get("slide_hl_color", ""),
                                          bg_gradient=ch_config_pb.get("slide_bg_gradient", ""),
                                          main_text_size=ch_config_pb.get("slide_main_text_size", 0),
                                          badge_size=ch_config_pb.get("slide_badge_size", 0),
                                          show_badge=_show_badge_b,
                                          channel_format=_ch_format_b)
            bg_count = sum(1 for bg in bg_results if bg.get("path"))
            _update_step(db, job_id, "slides", "completed",
                         output_data={"files": slide_paths,
                                      "count": len(slide_paths),
                                      "backgrounds": bg_count})

        except Exception as e:
            _update_step(db, job_id, "slides", "failed", error_msg=str(e))
            raise

        # 나레이션 파일 감지 (TTS 엔진/음성 변경 시 나레이션 무시 → TTS 사용)
        force_tts = bool(tts_engine_override or tts_voice_override or sovits_cfg_override)
        narration_path = None if force_tts else _find_narration(dirs["job"])

        if narration_path:
            # --- 나레이션 업로드 모드: 무음 기준 분할 → 기존 렌더 파이프라인 합류 ---
            content_slides = [s for s in slides_data if s.get("bg_type") != "closing"]
            split_result = _split_narration(narration_path, len(content_slides),
                                            dirs["segment"])
            _update_step(db, job_id, "tts", "skipped",
                         output_data={"message": "나레이션 업로드 (자동 분할)",
                                      "segments": len(split_result)})

            # 분할 결과 → merged_audio, slide_durations (기존 TTS 파이프라인 형식)
            merged_audio = {k: v["path"] for k, v in split_result.items()}
            slide_durations = {k: v["duration"] for k, v in split_result.items()}
            total_duration = sum(slide_durations.values())

            _update_step(db, job_id, "render", "running")
            try:
                _ch_cfg_render = json.loads(channel.get("config", "{}")) if channel else {}

                # 슬라이드간 나래이션 갭
                _xfade_dur = ch_config_pb.get("crossfade_duration", 0.5) or 0.5
                _pad_gap = max(0.3, _xfade_dur + 0.1)
                _timeline_narr = {"slide_durations": slide_durations,
                                  "total_duration": total_duration}
                _pad_slide_audio(merged_audio, _timeline_narr, gap=_pad_gap)
                slide_durations = _timeline_narr["slide_durations"]
                total_duration = _timeline_narr["total_duration"]

                # motion 힌트 + 슬라이드→bg 매핑
                _motion_hints = {}
                _slide_bg_map = {}
                try:
                    _meta_raw = job_row.get("meta_json", "")
                    if _meta_raw:
                        _meta = json.loads(_meta_raw)
                        for i, p in enumerate(_meta.get("image_prompts", [])):
                            bg_idx = i + 1
                            m = p.get("motion", "") if isinstance(p, dict) else ""
                            if m:
                                _motion_hints[bg_idx] = m
                            slide_num = p.get("slide", bg_idx) if isinstance(p, dict) else bg_idx
                            _slide_bg_map.setdefault(slide_num, []).append(bg_idx)
                except (json.JSONDecodeError, TypeError):
                    pass

                # compose_data에서 슬라이드별 모션 오버라이드
                _slide_motions = _cd.get("slide_motions", [])
                if _slide_motions:
                    for sm in _slide_motions:
                        _s = int(sm.get("slide", 0))
                        _m = sm.get("motion", "")
                        if _s > 0 and _m:
                            _motion_hints[_s] = _m

                segments = render_segments(slide_durations, dirs["image"],
                                           merged_audio, dirs["segment"],
                                           motion_hints=_motion_hints,
                                           slide_bg_map=_slide_bg_map)
                final_path = os.path.join(dirs["video"], f"{job_id}.mp4")

                # 효과음 설정
                sfx_cfg = _ch_cfg_render if (_ch_cfg_render.get("sfx_enabled") or _ch_cfg_render.get("bgm_enabled") or _ch_cfg_render.get("crossfade_duration")) else None
                if _cd.get("narr_volume") is not None:
                    if sfx_cfg is None:
                        sfx_cfg = dict(_ch_cfg_render)
                    sfx_cfg["narr_volume"] = _cd["narr_volume"]

                # 슬라이드별 전환 효과 로드 (개별 설정 우선)
                _per_slide_tr = _cd.get("slide_transitions") or None

                # compose_data 글로벌 전환 (슬라이드별 설정 없을 때 폴백)
                if not _per_slide_tr:
                    _tr = _cd.get("transition", {})
                    if _tr.get("effect"):
                        _ch_cfg_render["crossfade_transition"] = _tr["effect"]
                    if _tr.get("duration") is not None:
                        _ch_cfg_render["crossfade_duration"] = _tr["duration"]

                # SFX/BGM 없이 concat
                concat_cfg = dict(_ch_cfg_render)
                concat_cfg["sfx_enabled"] = False
                concat_cfg["bgm_enabled"] = False
                concat_segments(segments, final_path,
                                sfx_cfg=concat_cfg,
                                slide_durations=slide_durations,
                                per_slide_transitions=_per_slide_tr)

                # 인트로/아웃트로
                intro_offset, wrap_dur = _wrap_with_intro_outro(
                    channel_id, final_path, dirs["segment"], _ch_cfg_render)
                total_duration += wrap_dur

                # SFX/BGM 믹싱
                if sfx_cfg:
                    actual_xfade = _ch_cfg_render.get("crossfade_duration", 0.5) or 0.5
                    apply_audio_mix(final_path, sfx_cfg, slide_durations,
                                    xfade_dur=actual_xfade, audio_offset=intro_offset)

                file_size = os.path.getsize(final_path) / (1024 * 1024)
                _update_step(db, job_id, "render", "completed",
                             output_data={
                                 "file": final_path,
                                 "duration": round(total_duration, 1),
                                 "size_mb": round(file_size, 1),
                             })
                db.execute("UPDATE jobs SET output_path = ?, updated_at = ? WHERE id = ?",
                           [final_path, _now(), job_id])
                generate_metadata(topic, sentences, dirs["job"],
                                  youtube_title=script_json.get("youtube_title", ""),
                                  brand=brand)

                # 썸네일 생성
                try:
                    _generate_job_thumbnail(job_id, script_json, slides_data, [], brand, dirs["job"])
                except Exception as e:
                    print(f"[thumbnail] 썸네일 생성 실패 (무시): {e}")

            except Exception as e:
                _update_step(db, job_id, "render", "failed", error_msg=str(e))
                raise
        else:
            # --- TTS 모드 ---
            # 이미 오디오 파일이 모두 있으면 스킵 (단, 엔진/음성 변경 시 재생성)
            force_tts = bool(tts_engine_override or tts_voice_override or sovits_cfg_override)
            existing_audio = _find_existing_audio(dirs["audio"], len(sentences))
            if existing_audio and not force_tts:
                _update_step(db, job_id, "tts", "completed",
                             output_data={"files": existing_audio,
                                          "count": len(existing_audio),
                                          "engine": "cached"})
            else:
                # 엔진/음성 변경 시 기존 오디오 삭제
                if force_tts:
                    import glob as glob_mod
                    for f in glob_mod.glob(os.path.join(dirs["audio"], "audio_*")):
                        os.remove(f)
                _update_step(db, job_id, "tts", "running")
                try:
                    ch_config = json.loads(channel.get("config", "{}")) if channel else {}

                    # UI에서 선택한 엔진이 우선, 없으면 채널 설정
                    tts_engine = tts_engine_override or ch_config.get("tts_engine", "edge-tts")
                    if sovits_cfg_override:
                        sovits_cfg = sovits_cfg_override
                    elif tts_engine == "gpt-sovits":
                        sovits_cfg = _build_sovits_cfg(ch_config, channel_id)
                    else:
                        sovits_cfg = None

                    if tts_engine == "google-cloud":
                        tts_voice = tts_voice_override or ch_config.get("google_voice", "ko-KR-Wavenet-A")
                        tts_rate = tts_rate_override if tts_rate_override is not None else ch_config.get("google_rate", None)
                    else:
                        tts_voice = tts_voice_override or ch_config.get("tts_voice", "")
                        tts_rate = tts_rate_override if tts_rate_override is not None else ch_config.get("tts_rate", None)
                    audio_paths = generate_audio(sentences, dirs["audio"],
                                                 voice=tts_voice, rate=tts_rate,
                                                 sovits_cfg=sovits_cfg)
                    engine_label = "GPT-SoVITS" if sovits_cfg else ("Google Cloud TTS" if tts_voice in _gc_voices() else "Edge TTS")
                    _update_step(db, job_id, "tts", "completed",
                                 output_data={"files": audio_paths,
                                              "count": len(audio_paths),
                                              "engine": engine_label})
                except Exception as e:
                    _update_step(db, job_id, "tts", "failed", error_msg=str(e))
                    # TTS 실패 시 waiting_slides로 되돌림 (재시도 가능)
                    db.execute("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
                               ["waiting_slides", _now(), job_id])
                    return  # Phase B 중단, 화면은 이미지 대기 상태로 유지

            _update_step(db, job_id, "render", "running")
            try:
                _ch_cfg_render = json.loads(channel.get("config", "{}")) if channel else {}
                narration_delay = _ch_cfg_render.get("narration_delay") or 2

                # 인트로가 있으면 첫 슬라이드 딜레이 축소 (인트로가 리드인 역할)
                has_intro = bool(_find_channel_image(channel_id, "intro_bg"))
                if has_intro:
                    narration_delay = min(narration_delay, 1.0)

                timeline = build_timeline(sentences, dirs["audio"])

                # 아웃트로 있으면 마지막 슬라이드 클로징 나래이션 제거
                has_outro = bool(_find_channel_image(channel_id, "outro_bg"))
                if has_outro:
                    _strip_closing_audio(sentences, timeline)

                merged_audio = merge_slide_audio(timeline["slide_audio_map"],
                                                 dirs["segment"],
                                                 narration_delay=narration_delay)
                # 딜레이가 있으면 첫 슬라이드 duration에 반영
                if narration_delay > 0:
                    first_s = min(timeline["slide_durations"].keys())
                    timeline["slide_durations"][first_s] += narration_delay
                    timeline["total_duration"] += narration_delay

                # 슬라이드간 나래이션 갭 (crossfade 겹침 방지용, 최소 crossfade 이상)
                _xfade_dur = ch_config_pb.get("crossfade_duration", 0.5) or 0.5
                _pad_gap = max(0.3, _xfade_dur + 0.1)
                _pad_slide_audio(merged_audio, timeline, gap=_pad_gap)

                # motion 힌트 + 슬라이드→bg 매핑 추출 (meta_json → image_prompts)
                _motion_hints = {}
                _slide_bg_map = {}  # {slide_num: [bg_idx, ...]}  (1-based)
                try:
                    _meta_raw = job_row.get("meta_json", "")
                    if _meta_raw:
                        _meta = json.loads(_meta_raw)
                        for i, p in enumerate(_meta.get("image_prompts", [])):
                            bg_idx = i + 1  # bg_1, bg_2, ...
                            m = p.get("motion", "") if isinstance(p, dict) else ""
                            if m:
                                _motion_hints[bg_idx] = m
                            slide_num = p.get("slide", bg_idx) if isinstance(p, dict) else bg_idx
                            _slide_bg_map.setdefault(slide_num, []).append(bg_idx)
                except (json.JSONDecodeError, TypeError):
                    pass

                # compose_data에서 슬라이드별 모션 오버라이드
                _slide_motions = _cd.get("slide_motions", [])
                if _slide_motions:
                    for sm in _slide_motions:
                        _s = int(sm.get("slide", 0))
                        _m = sm.get("motion", "")
                        if _s > 0 and _m:
                            _motion_hints[_s] = _m

                segments = render_segments(timeline["slide_durations"], dirs["image"],
                                           merged_audio, dirs["segment"],
                                           motion_hints=_motion_hints,
                                           slide_bg_map=_slide_bg_map)
                final_path = os.path.join(dirs["video"], f"{job_id}.mp4")

                # 효과음 설정 로드
                sfx_cfg = _ch_cfg_render if (_ch_cfg_render.get("sfx_enabled") or _ch_cfg_render.get("bgm_enabled") or _ch_cfg_render.get("crossfade_duration")) else None
                # compose_data에서 나레이션 볼륨 로드
                if _cd.get("narr_volume") is not None:
                    if sfx_cfg is None:
                        sfx_cfg = dict(_ch_cfg_render)
                    sfx_cfg["narr_volume"] = _cd["narr_volume"]

                # 슬라이드별 전환 효과 로드 (개별 설정 우선)
                _per_slide_tr = _cd.get("slide_transitions") or None

                if not _per_slide_tr:
                    _tr = _cd.get("transition", {})
                    if _tr.get("effect"):
                        _ch_cfg_render["crossfade_transition"] = _tr["effect"]
                    if _tr.get("duration") is not None:
                        _ch_cfg_render["crossfade_duration"] = _tr["duration"]

                # SFX/BGM은 인트로 wrap 후 별도 적용 (타이밍 오프셋 보정)
                concat_cfg = dict(_ch_cfg_render)
                concat_cfg["sfx_enabled"] = False
                concat_cfg["bgm_enabled"] = False
                concat_segments(segments, final_path,
                                sfx_cfg=concat_cfg,
                                slide_durations=timeline["slide_durations"],
                                per_slide_transitions=_per_slide_tr)

                # 인트로/아웃트로 세그먼트 이어붙이기
                intro_offset, wrap_dur = _wrap_with_intro_outro(
                    channel_id, final_path, dirs["segment"], _ch_cfg_render)
                timeline["total_duration"] += wrap_dur

                # SFX/BGM 믹싱 (인트로 길이만큼 오프셋)
                if sfx_cfg:
                    actual_xfade = _ch_cfg_render.get("crossfade_duration", 0.5) or 0.5
                    apply_audio_mix(final_path, sfx_cfg, timeline["slide_durations"],
                                    xfade_dur=actual_xfade, audio_offset=intro_offset)

                file_size = os.path.getsize(final_path) / (1024 * 1024)
                _update_step(db, job_id, "render", "completed",
                             output_data={
                                 "file": final_path,
                                 "duration": round(timeline["total_duration"], 1),
                                 "size_mb": round(file_size, 1),
                             })
                # render 완료 즉시 output_path 기록 (영상 미리보기용)
                db.execute("UPDATE jobs SET output_path = ?, updated_at = ? WHERE id = ?",
                           [final_path, _now(), job_id])
                generate_metadata(topic, sentences, dirs["job"],
                                  youtube_title=script_json.get("youtube_title", ""),
                                  brand=brand)

                # 썸네일 생성 (render 완료 후 — 배경 이미지 확보된 상태)
                try:
                    _generate_job_thumbnail(job_id, script_json, slides_data, [], brand, dirs["job"])
                except Exception as e:
                    print(f"[thumbnail] 썸네일 생성 실패 (무시): {e}")

            except Exception as e:
                _update_step(db, job_id, "render", "failed", error_msg=str(e))
                raise

        # --- QA 스킵 ---
        _update_step(db, job_id, "qa", "skipped",
                     output_data={"message": "QA 비활성화"})

        # --- Step 7: upload ---
        ch_config = json.loads(channel.get("config", "{}")) if channel else {}
        yt_upload_mode = ch_config.get("youtube_upload_mode", "manual")
        yt_client_id = ch_config.get("youtube_client_id", "")
        yt_client_secret = ch_config.get("youtube_client_secret", "")
        yt_refresh_token = ch_config.get("youtube_refresh_token", "")
        yt_privacy = ch_config.get("youtube_privacy", "private")

        if yt_upload_mode == "manual":
            _update_step(db, job_id, "upload", "skipped",
                         output_data={"message": "수동 업로드 모드 — 완성 후 업로드 버튼 사용"})
        elif yt_client_id and yt_client_secret and yt_refresh_token:
            _update_step(db, job_id, "upload", "running")
            try:
                meta_path = os.path.join(dirs["job"], "metadata.json")
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)

                title = meta["title"]
                if "#Shorts" not in title and "#shorts" not in title:
                    title = f"{title} #Shorts"

                thumb_path = os.path.join(dirs["job"], "thumbnail.png")
                result = upload_video(
                    video_path=final_path,
                    title=title,
                    description=meta["description"],
                    tags=meta.get("tags", []),
                    client_id=yt_client_id,
                    client_secret=yt_client_secret,
                    refresh_token=yt_refresh_token,
                    privacy_status=yt_privacy,
                    thumbnail_path=thumb_path if os.path.isfile(thumb_path) else "",
                )
                _update_step(db, job_id, "upload", "completed",
                             output_data=result)
            except Exception as e:
                _update_step(db, job_id, "upload", "failed", error_msg=str(e))
                raise
        else:
            _update_step(db, job_id, "upload", "skipped",
                         output_data={"message": "YouTube 인증 미설정"})

        # 작업 완료
        db.execute(
            "UPDATE jobs SET status = ?, output_path = ?, updated_at = ? WHERE id = ?",
            ["completed", final_path, _now(), job_id]
        )

    except Exception:
        db.execute(
            "UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
            ["failed", _now(), job_id]
        )
        traceback.print_exc()


def _find_first_bg(bg_dir: str) -> str:
    """배경 디렉토리에서 첫 번째 배경 파일 경로 반환.
    정적 이미지 우선, 없으면 MP4/GIF에서 프레임 추출."""
    if not os.path.isdir(bg_dir):
        return ""

    # 정적 이미지 우선
    for f in sorted(os.listdir(bg_dir)):
        if f.startswith("bg_") and f.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
            return os.path.join(bg_dir, f)

    # MP4/GIF → 첫 프레임 추출
    for f in sorted(os.listdir(bg_dir)):
        if f.startswith("bg_") and f.lower().endswith((".mp4", ".gif")):
            src = os.path.join(bg_dir, f)
            thumb = os.path.join(bg_dir, "_thumb_bg.jpg")
            try:
                subprocess.run([
                    config.ffmpeg(), "-y", "-i", src,
                    "-vframes", "1", "-q:v", "2", thumb
                ], capture_output=True)
                if os.path.exists(thumb):
                    return thumb
            except Exception:
                pass

    return ""


def _generate_job_thumbnail(job_id: str, script: dict, slides_data: list,
                            bg_results: list, brand: str, job_dir: str):
    """영상 렌더 완료 후 썸네일 자동 생성."""
    title = script.get("youtube_title", "")
    if not title:
        title = slides_data[0].get("main", "").replace('<span class="hl">', "").replace("</span>", "")
    category = slides_data[0].get("category", "") if slides_data else ""
    accent = slides_data[0].get("accent", "#ff6b35") if slides_data else "#ff6b35"

    # 배경 이미지 결정
    bg_path = ""
    if bg_results:
        bg_path = bg_results[0].get("path", "")
    if not bg_path:
        bg_dir = os.path.join(job_dir, "backgrounds")
        bg_path = _find_first_bg(bg_dir)

    output_path = os.path.join(job_dir, "thumbnail.png")
    generate_thumbnail(title, output_path, category=category,
                       accent=accent, brand=brand, background=bg_path)
    print(f"[thumbnail] 썸네일 생성 완료: {output_path}")


def _find_narration(job_dir: str) -> str | None:
    """job 디렉토리에서 나레이션 파일 검색. 있으면 경로, 없으면 None."""
    for ext in ["mp3", "wav", "m4a", "ogg", "webm"]:
        path = os.path.join(job_dir, f"narration.{ext}")
        if os.path.exists(path):
            return path
    return None


def _split_narration(narration_path: str, slide_count: int,
                     output_dir: str) -> dict:
    """업로드된 나레이션을 무음 구간 기준으로 슬라이드별 분할.

    ffmpeg silencedetect로 무음 구간을 감지하고, 가장 긴 (slide_count - 1)개
    무음 구간을 경계로 분할. 무음 구간 부족 시 균등 분할 폴백.

    Returns:
        {1: {"path": ".../slide_audio_1.mp3", "duration": 5.2}, 2: {...}, ...}
    """
    import re
    from pipeline.tts_generator import get_audio_duration

    os.makedirs(output_dir, exist_ok=True)
    total_dur = get_audio_duration(narration_path)
    if total_dur <= 0:
        raise RuntimeError("나레이션 파일 길이를 측정할 수 없습니다")

    # 1) silencedetect로 무음 구간 감지
    result = subprocess.run(
        [config.ffmpeg(), "-i", narration_path,
         "-af", "silencedetect=noise=-35dB:d=0.3",
         "-f", "null", "-"],
        capture_output=True, text=True
    )
    stderr = result.stderr

    # silence_start / silence_end 파싱
    starts = [float(m) for m in re.findall(r"silence_start:\s*([\d.]+)", stderr)]
    ends = [float(m) for m in re.findall(r"silence_end:\s*([\d.]+)", stderr)]

    silences = []
    for i in range(min(len(starts), len(ends))):
        s, e = starts[i], ends[i]
        dur = e - s
        mid = (s + e) / 2
        silences.append({"start": s, "end": e, "duration": dur, "mid": mid})

    # 2) 분할 지점 결정: 균등 시간 기준으로 가장 가까운 무음 선택
    needed = slide_count - 1
    if len(silences) >= needed and needed > 0:
        # 이상적 분할 시간 계산 (균등 배분)
        ideal_splits = [total_dur * (i + 1) / slide_count for i in range(needed)]
        # 각 이상적 시간에 가장 가까운 무음 구간 선택 (중복 방지)
        used = set()
        split_points = []
        for ideal in ideal_splits:
            best_idx = None
            best_dist = float('inf')
            for j, s in enumerate(silences):
                if j in used:
                    continue
                dist = abs(s["mid"] - ideal)
                if dist < best_dist:
                    best_dist = dist
                    best_idx = j
            if best_idx is not None:
                split_points.append(silences[best_idx]["mid"])
                used.add(best_idx)
            else:
                split_points.append(ideal)
        split_points.sort()
        print(f"[runner] narration split: {slide_count} segments "
              f"(silence gaps: {len(silences)}, nearest-to-ideal)")
    else:
        # 무음 구간 부족 → 균등 분할
        split_points = [total_dur * (i + 1) / slide_count
                        for i in range(needed)]
        print(f"[runner] narration split: {slide_count} segments "
              f"(uniform fallback, silence gaps: {len(silences)})")

    # 3) 분할 지점 → 구간 리스트
    boundaries = [0.0] + split_points + [total_dur]
    result_map = {}
    for i in range(slide_count):
        start = boundaries[i]
        end = boundaries[i + 1]
        duration = end - start
        out_path = os.path.join(output_dir, f"slide_audio_{i + 1}.mp3")
        subprocess.run(
            [config.ffmpeg(), "-y",
             "-i", narration_path,
             "-ss", str(start), "-t", str(duration),
             "-c:a", "libmp3lame", "-q:a", "2",
             out_path],
            capture_output=True
        )
        # 실제 duration 측정 (ffmpeg 인코딩 오차 보정)
        actual_dur = get_audio_duration(out_path)
        if actual_dur <= 0:
            actual_dur = duration
        result_map[i + 1] = {"path": out_path, "duration": actual_dur}

    return result_map


def _render_with_narration(narration_path: str, image_dir: str,
                            slides_data: list, output_path: str) -> float:
    """업로드된 나레이션 + 슬라이드 이미지로 영상 생성.

    각 슬라이드에 나레이션 길이를 균등 배분하여 슬라이드쇼 영상을 만들고
    나레이션 오디오를 합성합니다.

    Returns:
        영상 총 길이(초)
    """
    from pipeline.tts_generator import get_audio_duration

    total_dur = get_audio_duration(narration_path)
    slide_count = len(slides_data)
    if slide_count == 0:
        raise RuntimeError("슬라이드가 없습니다")

    per_slide = total_dur / slide_count
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    vcfg = config.video_cfg()

    # 슬라이드 이미지 → concat용 입력 생성
    segment_dir = os.path.join(os.path.dirname(output_path), "..", "segments")
    os.makedirs(segment_dir, exist_ok=True)

    # 무음 슬라이드쇼 영상 생성 (배경 유형별 처리)
    from pipeline.video_renderer import _find_video_bg, _find_image_bg
    segment_files = []
    for i in range(1, slide_count + 1):
        img_path = os.path.join(image_dir, f"slide_{i}.png")
        overlay_path = os.path.join(image_dir, f"slide_{i}_overlay.png")
        seg_path = os.path.join(segment_dir, f"narr_seg_{i}.mp4")

        video_bg = _find_video_bg(image_dir, i)
        image_bg = _find_image_bg(image_dir, i)

        if video_bg and os.path.exists(overlay_path):
            # MP4/GIF 배경 + 오버레이 합성 (무음)
            is_gif = video_bg.lower().endswith(".gif")
            bg_input = (["-ignore_loop", "0"] if is_gif else ["-stream_loop", "-1"]) + ["-i", video_bg]
            subprocess.run([
                config.ffmpeg(), "-y",
                *bg_input,
                "-loop", "1", "-i", overlay_path,
                "-filter_complex",
                "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,"
                "crop=1080:1920,fps=24[bg];"
                "[bg][1:v]overlay=0:0:shortest=1[out]",
                "-map", "[out]",
                "-c:v", "libx264", "-preset", "fast",
                "-pix_fmt", "yuv420p",
                "-t", str(per_slide),
                "-an",
                seg_path
            ], capture_output=True)
        elif image_bg and os.path.exists(overlay_path):
            # 정적 이미지 배경 + Ken Burns + 오버레이 (무음)
            import random
            from pipeline.video_renderer import _KB_PRESETS
            preset = random.choice(_KB_PRESETS)
            zoom_expr, x_expr, y_expr = preset
            total_frames = int(per_slide * 24) + 5
            filter_complex = (
                f"[0:v]scale=1242:2208,format=rgba,"
                f"zoompan=z='{zoom_expr}':x='{x_expr}':y='{y_expr}'"
                f":d={total_frames}:s=1080x1920:fps=24[bg];"
                f"[bg][1:v]overlay=0:0:shortest=1[out]"
            )
            subprocess.run([
                config.ffmpeg(), "-y",
                "-i", image_bg,
                "-loop", "1", "-i", overlay_path,
                "-filter_complex", filter_complex,
                "-map", "[out]",
                "-c:v", "libx264", "-preset", "fast",
                "-pix_fmt", "yuv420p",
                "-t", str(per_slide),
                "-an",
                seg_path
            ], capture_output=True)
        else:
            # 정적 슬라이드 (배경 없음)
            subprocess.run([
                config.ffmpeg(), "-y",
                "-loop", "1", "-i", img_path,
                "-c:v", "libx264", "-tune", "stillimage",
                "-pix_fmt", "yuv420p",
                "-t", str(per_slide),
                "-an",
                seg_path
            ], capture_output=True)
        segment_files.append(seg_path)

    # 세그먼트 concat → 무음 영상
    silent_path = os.path.join(segment_dir, "silent_slideshow.mp4")
    concat_file = os.path.join(segment_dir, "concat_narr.txt")
    with open(concat_file, "w", encoding="utf-8") as f:
        for seg in segment_files:
            abs_seg = os.path.abspath(seg).replace("\\", "/")
            f.write(f"file '{abs_seg}'\n")

    subprocess.run([
        config.ffmpeg(), "-y",
        "-f", "concat", "-safe", "0",
        "-i", concat_file,
        "-c:v", "libx264",
        "-an",
        silent_path
    ], capture_output=True)

    # 무음 영상 + 나레이션 합성
    subprocess.run([
        config.ffmpeg(), "-y",
        "-i", silent_path,
        "-i", narration_path,
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", vcfg["audio_bitrate"],
        "-shortest",
        "-movflags", "+faststart",
        output_path
    ], capture_output=True)

    if not os.path.exists(output_path):
        raise RuntimeError("나레이션 영상 렌더링 실패")

    return total_dur



def _strip_closing_audio(sentences: list, timeline: dict):
    """아웃트로 있을 때 마지막 콘텐츠 슬라이드에서 클로징 나래이션 오디오 제거.

    build_timeline() 후, merge_slide_audio() 전에 호출.
    slide_audio_map에서 클로징 문장의 오디오 경로를 제거하고 duration 재계산.
    """
    from pipeline.tts_generator import get_audio_duration
    if not timeline.get("slide_durations"):
        return

    try:
        closing_patterns = ["구독", "좋아요", "부탁드립니다", "감사합니다", "시청해 주"]
        last_slide = max(timeline["slide_durations"].keys())

        # 마지막 슬라이드에 배정된 문장들 추출
        slide_sents = [s for s in sentences if s["slide"] == last_slide]
        audio_paths = timeline["slide_audio_map"].get(last_slide, [])
        if len(slide_sents) != len(audio_paths) or not audio_paths:
            return

        keep = []
        removed_dur = 0.0
        for sent, audio_path in zip(slide_sents, audio_paths):
            text = sent.get("text", "")
            if any(p in text for p in closing_patterns) and os.path.exists(audio_path):
                dur = get_audio_duration(audio_path)
                if dur > 0:
                    removed_dur += dur
                    print(f"[runner] 클로징 문장 제거: {text[:40]}")
                    continue
            keep.append(audio_path)

        if removed_dur == 0:
            return

        if keep:
            timeline["slide_audio_map"][last_slide] = keep
            new_dur = sum(get_audio_duration(p) for p in keep if os.path.exists(p))
            timeline["slide_durations"][last_slide] = max(new_dur, 2.0)
        else:
            # 모든 문장이 클로징 → 2.5초 유지 (배경 이미지 트랜지션용)
            timeline["slide_audio_map"][last_slide] = audio_paths[:1]
            timeline["slide_durations"][last_slide] = 2.5

        timeline["total_duration"] -= removed_dur
        print(f"[runner] 마지막 슬라이드 클로징 오디오 제거: {removed_dur:.1f}초 감소")
    except Exception as e:
        print(f"[runner] _strip_closing_audio 오류 (무시): {e}")


def _pad_slide_audio(merged_audio: dict, timeline: dict, gap: float = 0.3):
    """각 슬라이드 오디오에 무음 패딩 추가.

    - 끝 패딩: 마지막 슬라이드 제외 (나래이션 간 자연스러운 쉼)
    - 앞 패딩: 첫 슬라이드 제외 (crossfade가 블렌딩하는 구간을 무음으로 채워 나레이션 보호)
      앞 패딩 >= crossfade duration 이면 crossfade는 무음만 블렌딩하고 나레이션은 온전히 재생됨.

    주의: 원본 오디오의 샘플레이트/채널 수를 감지하여 무음 패딩도 동일하게 맞춤.
    """
    sorted_keys = sorted(merged_audio.keys())
    if len(sorted_keys) <= 1:
        return

    def _probe_audio(path: str) -> tuple[int, int]:
        """오디오 파일의 (sample_rate, channels) 반환."""
        try:
            r = subprocess.run(
                [config.ffprobe(), "-v", "quiet", "-print_format", "json",
                 "-show_streams", path],
                capture_output=True, text=True
            )
            import json as _json
            info = _json.loads(r.stdout)
            for st in info.get("streams", []):
                if st.get("codec_type") == "audio":
                    return int(st.get("sample_rate", 44100)), int(st.get("channels", 1))
        except Exception:
            pass
        return 44100, 1

    for idx, s_key in enumerate(sorted_keys):
        audio_path = merged_audio[s_key]
        if not os.path.exists(audio_path):
            continue

        is_first = (idx == 0)
        is_last = (idx == len(sorted_keys) - 1)
        sr, ch = _probe_audio(audio_path)
        cl = "stereo" if ch >= 2 else "mono"

        # 앞 패딩: 첫 슬라이드 제외 (crossfade 나레이션 보호)
        if not is_first:
            pre_padded = audio_path + ".prepad.wav"
            result = subprocess.run([
                config.ffmpeg(), "-y",
                "-f", "lavfi", "-i", f"anullsrc=r={sr}:cl={cl}:d={gap}",
                "-i", audio_path,
                "-filter_complex", f"[0:a][1:a]concat=n=2:v=0:a=1[out]",
                "-map", "[out]", "-ar", str(sr), "-ac", str(ch),
                pre_padded
            ], capture_output=True)
            if result.returncode == 0 and os.path.exists(pre_padded):
                os.replace(pre_padded, audio_path)
                timeline["slide_durations"][s_key] += gap
                timeline["total_duration"] += gap

        # 끝 패딩: 마지막 슬라이드 제외
        if not is_last:
            padded = audio_path + ".padded.wav"
            result = subprocess.run([
                config.ffmpeg(), "-y",
                "-i", audio_path,
                "-af", f"apad=pad_dur={gap}",
                "-ar", str(sr), "-ac", str(ch),
                padded
            ], capture_output=True)
            if result.returncode == 0 and os.path.exists(padded):
                os.replace(padded, audio_path)
                timeline["slide_durations"][s_key] += gap
                timeline["total_duration"] += gap


def _find_channel_image(channel_id: str, prefix: str) -> str | None:
    """채널 디렉토리에서 이미지 파일 탐색 (intro_bg, outro_bg 등)."""
    ch_dir = os.path.join("data", "channels", channel_id)
    for ext in ("jpg", "jpeg", "png", "webp"):
        path = os.path.join(ch_dir, f"{prefix}.{ext}")
        if os.path.exists(path):
            return path
    return None


def _generate_narration_audio(text: str, output_path: str, ch_config: dict,
                               channel_id: str) -> str | None:
    """나레이션 텍스트 → TTS 오디오 파일 생성. 실패 시 None 반환."""
    try:
        sentences = [{"text": text, "slide": 1}]
        out_dir = os.path.dirname(output_path)
        os.makedirs(out_dir, exist_ok=True)

        tts_engine = ch_config.get("tts_engine", "edge-tts")
        if tts_engine == "google-cloud":
            voice = ch_config.get("google_voice", "ko-KR-Wavenet-A")
            rate = ch_config.get("google_rate", None)
        else:
            voice = ch_config.get("tts_voice", "")
            rate = ch_config.get("tts_rate", None)

        sovits_cfg = None
        if tts_engine == "gpt-sovits":
            sovits_cfg = _build_sovits_cfg(ch_config, channel_id)

        paths = generate_audio(sentences, out_dir, voice=voice, rate=rate,
                               sovits_cfg=sovits_cfg)
        if paths and os.path.exists(paths[0]):
            os.replace(paths[0], output_path)
            return output_path
    except Exception as e:
        print(f"[runner] 나레이션 TTS 실패: {e}")
    return None


def _wrap_with_intro_outro(channel_id: str, final_path: str,
                            segment_dir: str, ch_config: dict):
    """인트로/아웃트로 이미지가 있으면 영상 앞뒤에 세그먼트로 이어붙임.

    나레이션 텍스트가 있으면 TTS → 이미지+나레이션 (duration=오디오 길이),
    없으면 이미지+무음 (duration=설정값).

    Returns:
        (intro_dur, total_added_dur) 튜플. 없으면 (0, 0).
    """
    intro_bg = _find_channel_image(channel_id, "intro_bg")
    outro_bg = _find_channel_image(channel_id, "outro_bg")

    if not intro_bg and not outro_bg:
        return (0.0, 0.0)

    vcfg = config.video_cfg()
    intro_dur = ch_config.get("intro_duration", 3) or 3
    outro_dur = ch_config.get("outro_duration", 3) or 3
    added_dur = 0.0
    intro_added = 0.0  # 인트로만의 실제 길이 (SFX 오프셋용)

    intro_narration = (ch_config.get("intro_narration") or "").strip()
    outro_narration = (ch_config.get("outro_narration") or "").strip()

    # 나레이션 템플릿 변수 치환: {날짜} → "3월 11일", {요일} → "화요일"
    now = datetime.now()
    _narr_vars = {
        "날짜": f"{now.month}월 {now.day}일",
        "요일": ["월", "화", "수", "목", "금", "토", "일"][now.weekday()] + "요일",
        "오전오후": "오전" if now.hour < 12 else "오후",
    }
    for k, v in _narr_vars.items():
        intro_narration = intro_narration.replace(f"{{{k}}}", v)
        outro_narration = outro_narration.replace(f"{{{k}}}", v)

    parts = []

    if intro_bg:
        intro_seg = os.path.join(segment_dir, "intro.mp4")
        if intro_narration:
            audio_path = os.path.join(segment_dir, "intro_narration.mp3")
            audio = _generate_narration_audio(intro_narration, audio_path,
                                               ch_config, channel_id)
            if audio:
                # SFX 오프닝 재생 여유 시간 (narration_delay, 기본 2초)
                narr_delay = ch_config.get("narration_delay", 2) or 2
                actual_dur = render_static_with_audio(
                    intro_bg, audio, intro_seg, vcfg, audio_delay=narr_delay)
                if os.path.exists(intro_seg):
                    parts.append(intro_seg)
                    added_dur += actual_dur
                    intro_added = actual_dur
                    print(f"[runner] 인트로 세그먼트 생성 (나레이션): {actual_dur:.1f}초")
            else:
                # TTS 실패 → 무음 폴백
                render_static_silent(intro_bg, intro_seg, intro_dur, vcfg)
                if os.path.exists(intro_seg):
                    parts.append(intro_seg)
                    added_dur += intro_dur
                    intro_added = intro_dur
                    print(f"[runner] 인트로 나레이션 TTS 실패 → 무음: {intro_dur}초")
        else:
            render_static_silent(intro_bg, intro_seg, intro_dur, vcfg)
            if os.path.exists(intro_seg):
                parts.append(intro_seg)
                added_dur += intro_dur
                intro_added = intro_dur
                print(f"[runner] 인트로 세그먼트 생성: {intro_dur}초")

    parts.append(final_path)

    if outro_bg:
        outro_seg = os.path.join(segment_dir, "outro.mp4")
        if outro_narration:
            audio_path = os.path.join(segment_dir, "outro_narration.mp3")
            audio = _generate_narration_audio(outro_narration, audio_path,
                                               ch_config, channel_id)
            if audio:
                actual_dur = render_static_with_audio(outro_bg, audio, outro_seg, vcfg)
                if os.path.exists(outro_seg):
                    parts.append(outro_seg)
                    added_dur += actual_dur
                    print(f"[runner] 아웃트로 세그먼트 생성 (나레이션): {actual_dur:.1f}초")
            else:
                render_static_silent(outro_bg, outro_seg, outro_dur, vcfg)
                if os.path.exists(outro_seg):
                    parts.append(outro_seg)
                    added_dur += outro_dur
                    print(f"[runner] 아웃트로 나레이션 TTS 실패 → 무음: {outro_dur}초")
        else:
            render_static_silent(outro_bg, outro_seg, outro_dur, vcfg)
            if os.path.exists(outro_seg):
                parts.append(outro_seg)
                added_dur += outro_dur
                print(f"[runner] 아웃트로 세그먼트 생성: {outro_dur}초")

    if len(parts) <= 1:
        return (0.0, 0.0)

    # concat demuxer로 이어붙이기
    wrapped_path = final_path.replace(".mp4", "_wrapped.mp4")
    concat_file = os.path.join(segment_dir, "concat_wrap.txt")
    with open(concat_file, "w", encoding="utf-8") as f:
        for p in parts:
            abs_p = os.path.abspath(p).replace("\\", "/")
            f.write(f"file '{abs_p}'\n")

    result = subprocess.run([
        config.ffmpeg(), "-y",
        "-f", "concat", "-safe", "0",
        "-i", concat_file,
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
        "-movflags", "+faststart",
        wrapped_path
    ], capture_output=True, text=True)

    if result.returncode != 0:
        print(f"[runner] 인트로/아웃트로 concat 실패: {result.stderr[:300]}")
        return (0.0, 0.0)

    if os.path.exists(wrapped_path):
        os.replace(wrapped_path, final_path)
        print(f"[runner] 인트로/아웃트로 적용 완료 (+{added_dur}초, 인트로={intro_added}초)")
        return (intro_added, added_dur)

    return (0.0, 0.0)



def _load_uploaded_backgrounds(bg_dir: str, slide_count: int,
                               source: str = "upload") -> list[dict]:
    """backgrounds 디렉토리에서 배경 이미지를 슬라이드 순서대로 로드.

    파일명 규칙: bg_1.jpg, bg_2.png, ... (확장자 무관)
    마지막 슬라이드(closing)는 빈 배경.
    """
    results = []
    for i in range(1, slide_count + 1):
        found = False
        for ext in ["mp4", "jpg", "jpeg", "png", "webp", "gif"]:
            path = os.path.join(bg_dir, f"bg_{i}.{ext}")
            if os.path.exists(path):
                results.append({"path": path, "source": source})
                found = True
                break

        if not found:
            results.append({"path": "", "source": ""})

    # 클로징(마지막) 슬라이드에 배경이 없으면 이전 슬라이드 배경 재사용
    if slide_count >= 2 and not results[-1]["path"]:
        for j in range(len(results) - 2, -1, -1):
            if results[j]["path"]:
                results[-1] = dict(results[j])
                break

    return results


# ─── 기존 호환: 원스탑 파이프라인 (Openverse 자동 배경) ───

def _run_pipeline(db_ch, db, job_id: str, script_json: dict = None):
    """기존 원스탑 파이프라인 (Phase A + B 연속 실행)"""
    try:
        db.execute("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
                    ["running", _now(), job_id])

        job_row = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
        channel_id = job_row["channel_id"]
        topic = job_row["topic"]

        channel = db_ch.fetchone("SELECT * FROM channels WHERE id = ?", [channel_id])
        instructions = channel.get("instructions", "") if channel else ""
        brand = channel.get("name", "이슈60초") if channel else "이슈60초"
        ch_config_fp = json.loads(channel.get("config", "{}")) if channel else {}
        slide_layout = ch_config_fp.get("slide_layout", "full")
        bg_display_mode = ch_config_fp.get("bg_display_mode", "zone")
        dirs = _get_job_dirs(job_id)

        # 인트로 나레이션 템플릿 치환 + 대본 연결 지시
        intro_narration_fp_raw = ch_config_fp.get("intro_narration", "").strip()
        if intro_narration_fp_raw:
            _dt_fp = datetime.now()
            _resolved_fp = intro_narration_fp_raw.replace(
                "{날짜}", f"{_dt_fp.month}월 {_dt_fp.day}일"
            ).replace(
                "{요일}", ["월", "화", "수", "목", "금", "토", "일"][_dt_fp.weekday()] + "요일"
            ).replace(
                "{오전오후}", "오전" if _dt_fp.hour < 12 else "오후"
            )
            instructions += (f"\n\n★ 이 채널은 별도 인트로 나레이션이 있습니다: \"{_resolved_fp}\"\n"
                             "인트로 나레이션이 먼저 재생된 후 첫 슬라이드 나레이션이 이어집니다.\n"
                             "첫 슬라이드 sentences는 인트로와 자연스럽게 이어지도록 작성하세요.\n"
                             "인트로에서 이미 한 인사/소개를 반복하지 마세요.")

        # 아웃트로가 있으면 나래이션에 마무리 멘트 금지
        if _find_channel_image(channel_id, "outro_bg"):
            instructions += ("\n\n★ 이 채널은 별도 아웃트로 영상이 있습니다. "
                             "나레이션(sentences)에 마무리 인사, 구독/좋아요 요청, "
                             "'~였습니다' 같은 엔딩 멘트를 절대 포함하지 마세요. "
                             "마지막 콘텐츠 문장까지만 작성하세요.")

        # --- Step 1+2: 뉴스 검색 + 대본 ---
        if script_json is None:
            _update_step(db, job_id, "news_search", "running")
            try:
                script_json = generate_script(topic, instructions, brand,
                                              script_rules=ch_config_fp.get("script_rules", ""),
                                              roundup_rules=ch_config_fp.get("roundup_rules", ""),
                                              has_outro=bool(ch_config_fp.get("outro_narration", "").strip()),
                                              use_subagent=bool(ch_config_fp.get("use_subagent", False)))
                _update_step(db, job_id, "news_search", "completed",
                             output_data={"message": "뉴스 검색 완료"})
                _update_step(db, job_id, "script", "completed",
                             output_data={
                                 "sentences": len(script_json.get("sentences", [])),
                                 "slides": len(script_json.get("slides", [])),
                             })
                _yt_title_fp = script_json.get("youtube_title", "").strip()
                _real_topic_fp = _yt_title_fp or script_json.get("title", "").strip() or topic
                db.execute(
                    "UPDATE jobs SET script_json = ?, topic = ?, updated_at = ? WHERE id = ?",
                    [json.dumps(script_json, ensure_ascii=False), _real_topic_fp, _now(), job_id]
                )
            except Exception as e:
                _update_step(db, job_id, "news_search", "failed", error_msg=str(e))
                raise
        else:
            _update_step(db, job_id, "news_search", "skipped",
                         output_data={"message": "script 직접 제공"})
            _update_step(db, job_id, "script", "skipped",
                         output_data={"message": "script 직접 제공"})

        script_data = script_json
        sentences = script_data.get("sentences", [])
        slides_data = script_data.get("slides", [])
        date_str = script_data.get("date", "")

        # 빈 문장 필터링 (클로징 멘트 삭제 등으로 빈 문장 남은 경우)
        orig_sent_count = len(sentences)
        sentences = [s for s in sentences if s.get("text", "").strip()]
        if len(sentences) < orig_sent_count:
            import glob as glob_mod
            for f in glob_mod.glob(os.path.join(dirs["audio"], "audio_*")):
                os.remove(f)
            print(f"[runner] 빈 문장 {orig_sent_count - len(sentences)}개 제거, 오디오 캐시 삭제")

        # --- Step 3: slides (배경 소스 선택에 따라 분기) ---
        _update_step(db, job_id, "slides", "running")
        try:
            ch_config_s3 = json.loads(channel.get("config", "{}")) if channel else {}
            auto_bg_source = ch_config_s3.get("auto_bg_source", "sd_image")
            image_prompt_style_s3 = ch_config_s3.get("image_prompt_style", "")
            image_scene_references_s3 = ch_config_s3.get("image_scene_references", "")

            # 이미지 프롬프트 생성
            slide_layout_s3 = ch_config_s3.get("slide_layout", "full")
            image_style_s3 = ch_config_s3.get("image_style", "mixed")

            # script_json 슬라이드에 image_prompt_en이 있으면 그대로 사용
            _existing_s3 = [
                {"ko": s.get("image_prompt_ko", ""), "en": s.get("image_prompt_en", "")}
                for s in slides_data if s.get("bg_type") != "closing"
            ]
            if all(p.get("en") for p in _existing_s3):
                image_prompts = _existing_s3
                print(f"[runner] 슬라이드에 image_prompt 존재 ({len(_existing_s3)}개)")
                meta = {}
                existing = db.fetchone("SELECT meta_json FROM jobs WHERE id = ?", [job_id])
                if existing and existing.get("meta_json"):
                    try:
                        meta = json.loads(existing["meta_json"])
                    except (json.JSONDecodeError, TypeError):
                        pass
                meta["image_prompts"] = image_prompts
                db.execute("UPDATE jobs SET meta_json = ?, updated_at = ? WHERE id = ?",
                           [json.dumps(meta, ensure_ascii=False), _now(), job_id])

            bg_source_log = auto_bg_source

            if auto_bg_source == "openverse":
                generate_backgrounds(slides_data, dirs["bg"])
            elif auto_bg_source == "gemini":
                gemini_key = ch_config_s3.get("gemini_api_key", "")
                if gemini_key and image_prompts:
                    # ── Step 1: 전체 이미지 생성 ──
                    for idx, prompt in enumerate(image_prompts):
                        slide = slides_data[idx] if idx < len(slides_data) else {}
                        bg_type = slide.get("bg_type", "photo")
                        if bg_type == "closing":
                            continue
                        en_prompt = _prompt_en(prompt)
                        if not en_prompt:
                            continue
                        output_path = os.path.join(dirs["bg"], f"bg_{idx + 1}.png")
                        try:
                            if idx > 0:
                                time.sleep(5)
                            if bg_display_mode == "fullscreen":
                                _ar = "9:16"
                            else:
                                _ar = "1:1" if slide_layout_s3 in ("center", "top", "bottom") else "9:16"
                            _char_ref_path_s3 = _find_channel_image(channel_id, "character_ref")
                            gemini_generate_image(en_prompt, output_path, gemini_key,
                                                  aspect_ratio=_ar,
                                                  reference_image_path=_char_ref_path_s3)
                            print(f"[runner] bg_{idx+1}.png Gemini 이미지 생성 완료")
                        except Exception as e:
                            print(f"[runner] bg_{idx+1} Gemini 이미지 생성 실패: {e}")

                    # ── Step 2: video 추천 이미지 → Veo 3.1 Fast 영상화 ──
                    for idx, prompt in enumerate(image_prompts):
                        media_rec = prompt.get("media", "image") if isinstance(prompt, dict) else "image"
                        if media_rec != "video":
                            continue
                        slide = slides_data[idx] if idx < len(slides_data) else {}
                        bg_type = slide.get("bg_type", "photo")
                        if bg_type in ("graph", "overview", "closing"):
                            continue
                        img_path = os.path.join(dirs["bg"], f"bg_{idx + 1}.png")
                        if not os.path.exists(img_path):
                            continue
                        mp4_path = os.path.join(dirs["bg"], f"bg_{idx + 1}.mp4")
                        motion = prompt.get("motion", "") if isinstance(prompt, dict) else ""
                        en_prompt = _prompt_en(prompt)
                        vid_prompt = f"{en_prompt}, {motion}" if motion else en_prompt
                        try:
                            ok = gemini_image_to_video(img_path, vid_prompt, mp4_path,
                                                      gemini_key, duration=6)
                            if ok:
                                print(f"[runner] bg_{idx+1}.mp4 Veo 영상화 완료")
                            else:
                                print(f"[runner] bg_{idx+1} 영상화 실패 — 이미지 유지")
                        except Exception as e:
                            print(f"[runner] bg_{idx+1} Veo 영상화 실패: {e}")
                else:
                    print("[runner] Gemini API key 없음 — 배경 생성 스킵")
            elif auto_bg_source in ("sd_video", "sd_image"):
                comfyui_cfg = config.comfyui_cfg()
                sd_available = sd_check_available(comfyui_cfg["host"], comfyui_cfg["port"])
                if not sd_available:
                    print(f"[runner] ComfyUI 서버 연결 불가 — 배경 생성 스킵 (그라디언트 폴백)")
                    bg_source_log = f"{auto_bg_source} (ComfyUI 불가 → 폴백)"
                elif not image_prompts:
                    print(f"[runner] 이미지 프롬프트 없음 — 배경 생성 스킵")
                elif auto_bg_source == "sd_video":
                    for idx, prompt in enumerate(image_prompts):
                        slide = slides_data[idx] if idx < len(slides_data) else {}
                        bg_type = slide.get("bg_type", "photo")
                        en_prompt = _prompt_en(prompt)
                        if not en_prompt:
                            continue
                        output_path = os.path.join(dirs["bg"], f"bg_{idx + 1}.mp4")
                        try:
                            sd_generate_video(en_prompt, output_path,
                                              host=comfyui_cfg["host"],
                                              port=comfyui_cfg["port"],
                                              timeout=600)
                            print(f"[runner] bg_{idx+1}.mp4 생성 완료")
                        except Exception as e:
                            print(f"[runner] bg_{idx+1} 영상 생성 실패: {e}")
                else:
                    for idx, prompt in enumerate(image_prompts):
                        slide = slides_data[idx] if idx < len(slides_data) else {}
                        bg_type = slide.get("bg_type", "photo")
                        en_prompt = _prompt_en(prompt)
                        if not en_prompt:
                            continue
                        output_path = os.path.join(dirs["bg"], f"bg_{idx + 1}.png")
                        try:
                            agent_generate_image(en_prompt, output_path,
                                                 host=comfyui_cfg["host"],
                                                 port=comfyui_cfg["port"],
                                                 max_retries=2)
                            print(f"[runner] bg_{idx+1}.png 생성 완료")
                        except Exception as e:
                            print(f"[runner] bg_{idx+1} 이미지 생성 실패: {e}")

            # 업로드/생성된 배경 로드 → 슬라이드 렌더
            bg_results = _load_uploaded_backgrounds(dirs["bg"], len(slides_data),
                                                    source=auto_bg_source)
            _ch_format_fp = ch_config_fp.get("format", "single")
            _show_badge_fp = ch_config_fp.get("show_badge", True)
            if isinstance(_show_badge_fp, str):
                _show_badge_fp = _show_badge_fp.lower() != "false"
            slide_paths = generate_slides(slides_data, dirs["image"],
                                          date=date_str, brand=brand,
                                          backgrounds=bg_results,
                                          layout=slide_layout,
                                          bg_display_mode=bg_display_mode,
                                          zone_ratio=ch_config_fp.get("slide_zone_ratio", ""),
                                          text_bg=ch_config_fp.get("slide_text_bg", 4),
                                          slide_overrides={},
                                          sub_text_size=ch_config_fp.get("sub_text_size", 0),
                                          accent_color=ch_config_fp.get("slide_accent_color", ""),
                                          hl_color=ch_config_fp.get("slide_hl_color", ""),
                                          bg_gradient=ch_config_fp.get("slide_bg_gradient", ""),
                                          main_text_size=ch_config_fp.get("slide_main_text_size", 0),
                                          badge_size=ch_config_fp.get("slide_badge_size", 0),
                                          show_badge=_show_badge_fp,
                                          channel_format=_ch_format_fp)
            bg_count = sum(1 for bg in bg_results if bg.get("path"))
            _update_step(db, job_id, "slides", "completed",
                         output_data={"files": slide_paths,
                                      "count": len(slide_paths),
                                      "backgrounds": bg_count,
                                      "bg_source": bg_source_log})

        except Exception as e:
            _update_step(db, job_id, "slides", "failed", error_msg=str(e))
            raise

        # --- Step 4: tts ---
        _update_step(db, job_id, "tts", "running")
        try:
            ch_config = json.loads(channel.get("config", "{}")) if channel else {}
            tts_engine = ch_config.get("tts_engine", "edge-tts")
            sovits_cfg = None

            if tts_engine == "gpt-sovits":
                sovits_cfg = _build_sovits_cfg(ch_config, channel_id)

            if tts_engine == "google-cloud":
                tts_voice = ch_config.get("google_voice", "ko-KR-Wavenet-A")
                tts_rate = ch_config.get("google_rate", None)
            else:
                tts_voice = ch_config.get("tts_voice", "")
                tts_rate = ch_config.get("tts_rate", None)
            audio_paths = generate_audio(sentences, dirs["audio"],
                                         voice=tts_voice, rate=tts_rate,
                                         sovits_cfg=sovits_cfg)
            engine_label = "GPT-SoVITS" if sovits_cfg else ("Google Cloud TTS" if tts_voice in _gc_voices() else "Edge TTS")
            _update_step(db, job_id, "tts", "completed",
                         output_data={"files": audio_paths,
                                      "count": len(audio_paths),
                                      "engine": engine_label})
        except Exception as e:
            _update_step(db, job_id, "tts", "failed", error_msg=str(e))
            raise

        # --- Step 5: render ---
        _update_step(db, job_id, "render", "running")
        try:
            _ch_cfg_r = json.loads(channel.get("config", "{}")) if channel else {}
            narration_delay_r = _ch_cfg_r.get("narration_delay") or 2

            # 인트로가 있으면 첫 슬라이드 딜레이 축소
            has_intro_r = bool(_find_channel_image(channel_id, "intro_bg"))
            if has_intro_r:
                narration_delay_r = min(narration_delay_r, 1.0)

            timeline = build_timeline(sentences, dirs["audio"])

            # 아웃트로 있으면 마지막 슬라이드 클로징 나래이션 제거
            has_outro_r = bool(_find_channel_image(channel_id, "outro_bg"))
            if has_outro_r:
                _strip_closing_audio(sentences, timeline)

            merged_audio = merge_slide_audio(timeline["slide_audio_map"],
                                             dirs["segment"],
                                             narration_delay=narration_delay_r)
            if narration_delay_r > 0:
                first_s = min(timeline["slide_durations"].keys())
                timeline["slide_durations"][first_s] += narration_delay_r
                timeline["total_duration"] += narration_delay_r

            # 슬라이드간 나래이션 갭 (crossfade 겹침 방지용)
            _xfade_dur_r = ch_config_fp.get("crossfade_duration", 0.5) or 0.5
            _pad_gap_r = max(0.3, _xfade_dur_r + 0.1)
            _pad_slide_audio(merged_audio, timeline, gap=_pad_gap_r)

            # motion 힌트 추출 (image_prompts 변수에서 직접)
            _motion_hints_r = {}
            try:
                for i, p in enumerate(image_prompts or []):
                    m = p.get("motion", "") if isinstance(p, dict) else ""
                    if m:
                        _motion_hints_r[i + 1] = m
            except (TypeError, AttributeError):
                pass

            segments = render_segments(timeline["slide_durations"], dirs["image"],
                                       merged_audio, dirs["segment"],
                                       motion_hints=_motion_hints_r)
            final_path = os.path.join(dirs["video"], f"{job_id}.mp4")

            # 효과음 설정
            sfx_cfg_r = _ch_cfg_r if (_ch_cfg_r.get("sfx_enabled") or _ch_cfg_r.get("bgm_enabled") or _ch_cfg_r.get("crossfade_duration")) else None

            # SFX/BGM은 인트로 wrap 후 별도 적용 (타이밍 오프셋 보정)
            concat_cfg_r = dict(_ch_cfg_r)
            concat_cfg_r["sfx_enabled"] = False
            concat_cfg_r["bgm_enabled"] = False
            concat_segments(segments, final_path,
                            sfx_cfg=concat_cfg_r,
                            slide_durations=timeline["slide_durations"])

            # 인트로/아웃트로 세그먼트 이어붙이기
            intro_offset_r, wrap_dur = _wrap_with_intro_outro(
                channel_id, final_path, dirs["segment"], _ch_cfg_r)
            timeline["total_duration"] += wrap_dur

            # SFX/BGM 믹싱 (인트로 길이만큼 오프셋)
            if sfx_cfg_r:
                actual_xfade_r = _ch_cfg_r.get("crossfade_duration", 0.5) or 0.5
                apply_audio_mix(final_path, sfx_cfg_r, timeline["slide_durations"],
                                xfade_dur=actual_xfade_r, audio_offset=intro_offset_r)

            file_size = os.path.getsize(final_path) / (1024 * 1024)
            _update_step(db, job_id, "render", "completed",
                         output_data={
                             "file": final_path,
                             "duration": round(timeline["total_duration"], 1),
                             "size_mb": round(file_size, 1),
                         })
            # render 완료 즉시 output_path 기록 (영상 미리보기용)
            db.execute("UPDATE jobs SET output_path = ?, updated_at = ? WHERE id = ?",
                       [final_path, _now(), job_id])
            generate_metadata(topic, sentences, dirs["job"],
                              youtube_title=script_json.get("youtube_title", ""))

            # 썸네일 생성 (render 완료 후)
            try:
                _generate_job_thumbnail(job_id, script_json, slides_data, [], brand, dirs["job"])
            except Exception as e:
                print(f"[thumbnail] 썸네일 생성 실패 (무시): {e}")

        except Exception as e:
            _update_step(db, job_id, "render", "failed", error_msg=str(e))
            raise

        # --- QA 스킵 ---
        _update_step(db, job_id, "qa", "skipped",
                     output_data={"message": "QA 비활성화"})

        # --- Step 7: upload ---
        ch_config = json.loads(channel.get("config", "{}")) if channel else {}
        yt_upload_mode = ch_config.get("youtube_upload_mode", "manual")
        yt_client_id = ch_config.get("youtube_client_id", "")
        yt_client_secret = ch_config.get("youtube_client_secret", "")
        yt_refresh_token = ch_config.get("youtube_refresh_token", "")
        yt_privacy = ch_config.get("youtube_privacy", "private")

        if yt_upload_mode == "manual":
            _update_step(db, job_id, "upload", "skipped",
                         output_data={"message": "수동 업로드 모드 — 완성 후 업로드 버튼 사용"})
        elif yt_client_id and yt_client_secret and yt_refresh_token:
            _update_step(db, job_id, "upload", "running")
            try:
                meta_path = os.path.join(dirs["job"], "metadata.json")
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                title = meta["title"]
                if "#Shorts" not in title and "#shorts" not in title:
                    title = f"{title} #Shorts"

                thumb_path = os.path.join(dirs["job"], "thumbnail.png")
                result = upload_video(
                    video_path=final_path,
                    title=title,
                    description=meta["description"],
                    tags=meta.get("tags", []),
                    client_id=yt_client_id,
                    client_secret=yt_client_secret,
                    refresh_token=yt_refresh_token,
                    privacy_status=yt_privacy,
                    thumbnail_path=thumb_path if os.path.isfile(thumb_path) else "",
                )
                _update_step(db, job_id, "upload", "completed", output_data=result)
            except Exception as e:
                _update_step(db, job_id, "upload", "failed", error_msg=str(e))
                raise
        else:
            _update_step(db, job_id, "upload", "skipped",
                         output_data={"message": "YouTube 인증 미설정"})

        db.execute(
            "UPDATE jobs SET status = ?, output_path = ?, updated_at = ? WHERE id = ?",
            ["completed", final_path, _now(), job_id]
        )

    except Exception:
        db.execute(
            "UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
            ["failed", _now(), job_id]
        )
        traceback.print_exc()


# ─── Job Queue (Phase B 순차 실행) ───

class JobQueue:
    """Phase B 전용 싱글 워커 큐. GPU 리소스 충돌 방지."""

    def __init__(self):
        self._queue = deque()  # [(db_ch, db, job_id, kwargs), ...]
        self._lock = threading.Lock()
        self._worker_running = False
        self._current_job_id = None

    def enqueue(self, db_ch, db, job_id: str, **kwargs):
        """Phase B 작업을 큐에 등록. 워커가 없으면 자동 시작."""
        with self._lock:
            # 중복 등록 방지
            if any(item[2] == job_id for item in self._queue):
                return
            if self._current_job_id == job_id:
                return

            self._queue.append((db_ch, db, job_id, kwargs))
            db.execute(
                "UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
                ["queued", _now(), job_id]
            )

            if not self._worker_running:
                self._worker_running = True
                t = threading.Thread(target=self._worker, daemon=True)
                t.start()

    def get_status(self) -> dict:
        """현재 큐 상태 반환"""
        with self._lock:
            return {
                "current": self._current_job_id,
                "waiting": [item[2] for item in self._queue],
                "total": len(self._queue) + (1 if self._current_job_id else 0),
            }

    def get_position(self, job_id: str) -> int:
        """큐에서의 위치 반환. 0=현재 실행중, 1=다음, -1=큐에 없음"""
        with self._lock:
            if self._current_job_id == job_id:
                return 0
            for i, item in enumerate(self._queue):
                if item[2] == job_id:
                    return i + 1
            return -1

    def _worker(self):
        """큐에서 하나씩 꺼내서 Phase B 실행"""
        while True:
            with self._lock:
                if not self._queue:
                    self._worker_running = False
                    self._current_job_id = None
                    return
                db_ch, db, job_id, kwargs = self._queue.popleft()
                self._current_job_id = job_id

            try:
                _run_phase_b(db_ch, db, job_id, **kwargs)
            except Exception:
                traceback.print_exc()
            finally:
                # WAL 체크포인트 — 읽기 성능 유지
                try:
                    db.checkpoint()
                except Exception:
                    pass

            with self._lock:
                self._current_job_id = None


# 전역 큐 인스턴스
_job_queue = JobQueue()

# ─── Public API ───

def start_pipeline(db_ch, db, job_id: str, script_json: dict = None,
                    use_gemini_draft: bool = False):
    """Phase A 실행 (대본까지 → waiting_slides)."""
    def _run():
        _run_phase_a(db_ch, db, job_id, script_json,
                     use_gemini_draft=use_gemini_draft)
    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t


def resume_pipeline(db_ch, db, job_id: str, tts_voice: str = "", tts_rate=None,
                    tts_engine: str = "", sovits_cfg: dict = None):
    """Phase B를 큐에 등록 (순차 실행)"""
    _job_queue.enqueue(db_ch, db, job_id, tts_voice_override=tts_voice,
                       tts_rate_override=tts_rate,
                       tts_engine_override=tts_engine,
                       sovits_cfg_override=sovits_cfg)


def start_pipeline_full(db_ch, db, job_id: str, script_json: dict = None,
                        use_gemini_draft: bool = False):
    """원스탑: Phase A 실행 후 완료되면 Phase B 큐 등록"""
    def _run_then_queue():
        _run_phase_a(db_ch, db, job_id, script_json,
                     use_gemini_draft=use_gemini_draft)
        # Phase A 성공 시 자동으로 Phase B 큐 등록
        job = db.fetchone("SELECT status FROM jobs WHERE id = ?", [job_id])
        if job and job["status"] == "waiting_slides":
            _job_queue.enqueue(db_ch, db, job_id)

    t = threading.Thread(target=_run_then_queue, daemon=True)
    t.start()
    return t


def get_queue_status() -> dict:
    """큐 상태 조회"""
    return _job_queue.get_status()


def get_queue_position(job_id: str) -> int:
    """큐에서의 위치 조회"""
    return _job_queue.get_position(job_id)
