"""파이프라인 실행기 — 단계별로 DB 상태를 갱신하며 영상 제작

Phase A: news_search + script → waiting_slides (병렬, CPU)
Phase B: slides + tts + render + upload (큐 순차, GPU)
"""
from __future__ import annotations
import json
import os
import subprocess
import threading
import time
import traceback
from collections import deque
from datetime import datetime

from pipeline import config
from pipeline.agent import generate_script, generate_image_prompts
from pipeline.tts_generator import generate_audio, GOOGLE_CLOUD_VOICES
from pipeline.slide_generator import generate_slides, generate_chart, generate_infographic, generate_thumbnail
from pipeline.sync_engine import build_timeline, merge_slide_audio
from pipeline.video_renderer import render_segments, concat_segments
from pipeline.metadata import generate_metadata
from pipeline.youtube_uploader import upload_video
from pipeline.image_generator import generate_backgrounds
from pipeline.sd_generator import agent_generate_image, generate_video as sd_generate_video, check_available as sd_check_available
from pipeline.gemini_generator import generate_image as gemini_generate_image
# from pipeline.qa_agent import run_qa  # QA 비활성화


def _gc_voices():
    return GOOGLE_CLOUD_VOICES


def _prompt_en(p) -> str:
    """이미지 프롬프트에서 영어 부분 추출. dict면 en, 문자열이면 그대로."""
    if isinstance(p, dict):
        return p.get("en", "")
    return str(p) if p else ""


STEP_DEFINITIONS = [
    {"name": "news_search", "order": 1, "label": "뉴스 검색"},
    {"name": "script",      "order": 2, "label": "대본 작성"},
    {"name": "slides",      "order": 3, "label": "슬라이드"},
    {"name": "tts",          "order": 4, "label": "TTS"},
    {"name": "render",       "order": 5, "label": "영상 합성"},
    {"name": "qa",           "order": 6, "label": "QA 검토"},
    {"name": "upload",       "order": 7, "label": "업로드"},
]

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

def _run_phase_a(db, job_id: str, script_json: dict = None):
    """Phase A: news_search + script → status waiting_slides"""
    try:
        db.execute("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
                    ["running", _now(), job_id])

        job_row = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
        channel_id = job_row["channel_id"]
        topic = job_row["topic"]

        channel = db.fetchone("SELECT * FROM channels WHERE id = ?", [channel_id])
        instructions = channel.get("instructions", "") if channel else ""
        brand = channel.get("name", "이슈60초") if channel else "이슈60초"
        ch_config = json.loads(channel.get("config", "{}")) if channel else {}
        image_prompt_style = ch_config.get("image_prompt_style", "")
        target_duration = ch_config.get("target_duration", 60)
        channel_format = ch_config.get("format", "single")

        # 디렉토리 생성
        _get_job_dirs(job_id)

        if script_json is None:
            _update_step(db, job_id, "news_search", "running")
            try:
                script_json = generate_script(topic, instructions, brand,
                                              target_duration=target_duration,
                                              channel_format=channel_format)

                _update_step(db, job_id, "news_search", "completed",
                             output_data={"message": "뉴스 검색 완료"})
                _update_step(db, job_id, "script", "completed",
                             output_data={
                                 "sentences": len(script_json.get("sentences", [])),
                                 "slides": len(script_json.get("slides", [])),
                             })

                db.execute(
                    "UPDATE jobs SET script_json = ?, updated_at = ? WHERE id = ?",
                    [json.dumps(script_json, ensure_ascii=False), _now(), job_id]
                )

            except Exception as e:
                _update_step(db, job_id, "news_search", "failed", error_msg=str(e))
                raise
        else:
            _update_step(db, job_id, "news_search", "skipped",
                         output_data={"message": "script 직접 제공"})
            _update_step(db, job_id, "script", "skipped",
                         output_data={"message": "script 직접 제공"})

        # 이미지 프롬프트 생성 (자동/수동 대본 모두)
        try:
            slides = script_json.get("slides", [])
            slide_layout_a = ch_config.get("slide_layout", "full")
            image_style_a = ch_config.get("image_style", "mixed")

            _existing_a = [
                {"ko": s.get("image_prompt_ko", ""), "en": s.get("image_prompt_en", "")}
                for s in slides if s.get("bg_type") != "closing"
            ]
            if all(p.get("en") for p in _existing_a):
                image_prompts = _existing_a
                print(f"[runner] 슬라이드에 image_prompt 존재 → Claude 프롬프트 생성 스킵 ({len(_existing_a)}개)")
            else:
                image_prompts = generate_image_prompts(topic, slides, prompt_style=image_prompt_style, layout=slide_layout_a, image_style=image_style_a)
            if image_prompts:
                meta = {}
                existing = db.fetchone("SELECT meta_json FROM jobs WHERE id = ?", [job_id])
                if existing and existing.get("meta_json"):
                    try:
                        meta = json.loads(existing["meta_json"])
                    except (json.JSONDecodeError, TypeError):
                        pass
                meta["image_prompts"] = image_prompts
                db.execute(
                    "UPDATE jobs SET meta_json = ?, updated_at = ? WHERE id = ?",
                    [json.dumps(meta, ensure_ascii=False), _now(), job_id]
                )
        except Exception:
            pass  # 이미지 프롬프트 실패해도 대본은 유지

        # Phase A 완료 → waiting_slides
        db.execute(
            "UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
            ["waiting_slides", _now(), job_id]
        )

    except Exception:
        db.execute(
            "UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
            ["failed", _now(), job_id]
        )
        traceback.print_exc()


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
                qa_feedback: str = "", target_duration: int = 60):
    """QA 실패 시 해당 단계부터 재작업"""
    instructions = channel.get("instructions", "") if channel else ""

    if restart_from == "script":
        # 대본 재생성 (QA 피드백 포함)
        _update_step(db, job_id, "script", "running")
        feedback_section = ""
        if qa_feedback:
            feedback_section = f"\n\n⚠️ 이전 대본이 QA 검토에서 탈락했습니다. 아래 문제점을 반드시 수정해주세요:\n{qa_feedback}\n"
        try:
            new_script = generate_script(topic, instructions + feedback_section, brand,
                                         target_duration=target_duration)
            db.execute("UPDATE jobs SET script_json = ?, updated_at = ? WHERE id = ?",
                       [json.dumps(new_script, ensure_ascii=False), _now(), job_id])
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

def _run_phase_b(db, job_id: str, tts_voice_override: str = "",
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

        channel = db.fetchone("SELECT * FROM channels WHERE id = ?", [channel_id])
        brand = channel.get("name", "이슈60초") if channel else "이슈60초"
        ch_config_pb = json.loads(channel.get("config", "{}")) if channel else {}
        slide_layout = ch_config_pb.get("slide_layout", "full")
        target_duration = ch_config_pb.get("target_duration", 60)

        dirs = _get_job_dirs(job_id)
        sentences = script_json.get("sentences", [])
        slides_data = script_json.get("slides", [])
        date_str = script_json.get("date", "")

        # --- Step 3: slides (배경 자동 생성 + 슬라이드 렌더링) ---
        _update_step(db, job_id, "slides", "running")
        try:
            # 기존 배경이 없으면 자동 생성
            bg_results = _load_uploaded_backgrounds(dirs["bg"], len(slides_data))
            existing_bg_count = sum(1 for bg in bg_results if bg.get("path"))

            if existing_bg_count == 0:
                # 배경 자동 생성
                ch_config_b = json.loads(channel.get("config", "{}")) if channel else {}
                auto_bg_source = ch_config_b.get("auto_bg_source", "sd_image")
                image_prompt_style_b = ch_config_b.get("image_prompt_style", "")

                slide_layout_b = ch_config_b.get("slide_layout", "full")
                image_style_b = ch_config_b.get("image_style", "mixed")

                # script_json 슬라이드에 image_prompt_en이 있으면 그대로 사용
                _existing = [
                    {"ko": s.get("image_prompt_ko", ""), "en": s.get("image_prompt_en", "")}
                    for s in slides_data if s.get("bg_type") != "closing"
                ]
                if all(p.get("en") for p in _existing):
                    image_prompts = _existing
                    print(f"[runner] 슬라이드에 image_prompt 존재 → Claude 프롬프트 생성 스킵 ({len(_existing)}개)")
                else:
                    image_prompts = generate_image_prompts(topic, slides_data, prompt_style=image_prompt_style_b, layout=slide_layout_b, image_style=image_style_b)
                if image_prompts:
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

                    # 대본 컨텍스트 (인포그래픽용)
                    full_text = " ".join(s["text"] for s in sentences)

                    # graph 타입 공통 처리 함수
                    def _generate_graph_bg(idx, slide):
                        out = os.path.join(dirs["bg"], f"bg_{idx + 1}.png")
                        try:
                            generate_infographic(slide, full_text, out, width=1080, height=960)
                            print(f"[runner] bg_{idx+1}.png 인포그래픽 생성 완료")
                        except Exception as e:
                            print(f"[runner] bg_{idx+1} 인포그래픽 실패, 기본 차트로 폴백: {e}")
                            try:
                                generate_chart(slide, out, width=1080, height=960)
                            except Exception as e2:
                                print(f"[runner] bg_{idx+1} 차트 폴백도 실패: {e2}")

                    if auto_bg_source == "gemini":
                        gemini_key = ch_config_b.get("gemini_api_key", "")
                        if gemini_key:
                            for idx, prompt in enumerate(image_prompts):
                                slide = slides_data[idx] if idx < len(slides_data) else {}
                                bg_type = slide.get("bg_type", "photo")
                                if bg_type == "closing":
                                    continue
                                en_prompt = _prompt_en(prompt)
                                if not en_prompt:
                                    continue
                                out = os.path.join(dirs["bg"], f"bg_{idx + 1}.png")
                                try:
                                    if idx > 0:
                                        time.sleep(5)  # Gemini 분당 요청 제한 대응
                                    # overview 슬라이드는 항상 전체 배경(9:16) 사용
                                    if bg_type == "overview":
                                        _ar = "9:16"
                                    else:
                                        _ar = "1:1" if slide_layout_b in ("center", "top", "bottom") else "9:16"
                                    gemini_generate_image(en_prompt, out, gemini_key,
                                                         aspect_ratio=_ar)
                                    print(f"[runner] bg_{idx+1}.png Gemini 생성 완료")
                                except Exception as e:
                                    print(f"[runner] bg_{idx+1} Gemini 생성 실패: {e}")
                        else:
                            print("[runner] Gemini API key 없음 — 배경 생성 스킵")

                    elif auto_bg_source in ("sd_video", "sd_image"):
                        comfyui_cfg = config.comfyui_cfg()
                        sd_available = sd_check_available(comfyui_cfg["host"], comfyui_cfg["port"])
                        if sd_available:
                            for idx, prompt in enumerate(image_prompts):
                                slide = slides_data[idx] if idx < len(slides_data) else {}
                                bg_type = slide.get("bg_type", "photo")
                                if bg_type == "graph":
                                    _generate_graph_bg(idx, slide)
                                    continue
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

            slide_paths = generate_slides(slides_data, dirs["image"],
                                          date=date_str, brand=brand,
                                          backgrounds=bg_results,
                                          layout=slide_layout)
            bg_count = sum(1 for bg in bg_results if bg.get("path"))
            _update_step(db, job_id, "slides", "completed",
                         output_data={"files": slide_paths,
                                      "count": len(slide_paths),
                                      "backgrounds": bg_count})

        except Exception as e:
            _update_step(db, job_id, "slides", "failed", error_msg=str(e))
            raise

        # 나레이션 파일 감지
        narration_path = _find_narration(dirs["job"])

        if narration_path:
            # --- 나레이션 업로드 모드: TTS 스킵, 나레이션 기반 렌더 ---
            _update_step(db, job_id, "tts", "skipped",
                         output_data={"message": "나레이션 직접 업로드"})

            _update_step(db, job_id, "render", "running")
            try:
                final_path = os.path.join(dirs["video"], f"{job_id}.mp4")
                total_dur = _render_with_narration(
                    narration_path, dirs["image"], slides_data, final_path)

                file_size = os.path.getsize(final_path) / (1024 * 1024)
                _update_step(db, job_id, "render", "completed",
                             output_data={
                                 "file": final_path,
                                 "duration": round(total_dur, 1),
                                 "size_mb": round(file_size, 1),
                             })
                # render 완료 즉시 output_path 기록 (영상 미리보기용)
                db.execute("UPDATE jobs SET output_path = ?, updated_at = ? WHERE id = ?",
                           [final_path, _now(), job_id])
                generate_metadata(topic, sentences, dirs["job"],
                                  youtube_title=script_json.get("youtube_title", ""),
                                  brand=brand)
            except Exception as e:
                _update_step(db, job_id, "render", "failed", error_msg=str(e))
                raise
        else:
            # --- TTS 모드 ---
            # 이미 오디오 파일이 모두 있으면 스킵
            existing_audio = _find_existing_audio(dirs["audio"], len(sentences))
            if existing_audio:
                _update_step(db, job_id, "tts", "completed",
                             output_data={"files": existing_audio,
                                          "count": len(existing_audio),
                                          "engine": "cached"})
            else:
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

                timeline = build_timeline(sentences, dirs["audio"])
                merged_audio = merge_slide_audio(timeline["slide_audio_map"],
                                                 dirs["segment"],
                                                 narration_delay=narration_delay)
                # 딜레이가 있으면 첫 슬라이드 duration에 반영
                if narration_delay > 0:
                    first_s = min(timeline["slide_durations"].keys())
                    timeline["slide_durations"][first_s] += narration_delay
                    timeline["total_duration"] += narration_delay

                segments = render_segments(timeline["slide_durations"], dirs["image"],
                                           merged_audio, dirs["segment"])
                final_path = os.path.join(dirs["video"], f"{job_id}.mp4")

                # 효과음 설정 로드
                sfx_cfg = _ch_cfg_render if (_ch_cfg_render.get("sfx_enabled") or _ch_cfg_render.get("bgm_enabled") or _ch_cfg_render.get("crossfade_duration")) else None

                concat_segments(segments, final_path,
                                sfx_cfg=sfx_cfg,
                                slide_durations=timeline["slide_durations"])

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

def _run_pipeline(db, job_id: str, script_json: dict = None):
    """기존 원스탑 파이프라인 (Phase A + B 연속 실행)"""
    try:
        db.execute("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
                    ["running", _now(), job_id])

        job_row = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
        channel_id = job_row["channel_id"]
        topic = job_row["topic"]

        channel = db.fetchone("SELECT * FROM channels WHERE id = ?", [channel_id])
        instructions = channel.get("instructions", "") if channel else ""
        brand = channel.get("name", "이슈60초") if channel else "이슈60초"
        ch_config_fp = json.loads(channel.get("config", "{}")) if channel else {}
        slide_layout = ch_config_fp.get("slide_layout", "full")
        target_duration = ch_config_fp.get("target_duration", 60)

        dirs = _get_job_dirs(job_id)

        # --- Step 1+2: 뉴스 검색 + 대본 ---
        if script_json is None:
            _update_step(db, job_id, "news_search", "running")
            try:
                script_json = generate_script(topic, instructions, brand,
                                              target_duration=target_duration)
                _update_step(db, job_id, "news_search", "completed",
                             output_data={"message": "뉴스 검색 완료"})
                _update_step(db, job_id, "script", "completed",
                             output_data={
                                 "sentences": len(script_json.get("sentences", [])),
                                 "slides": len(script_json.get("slides", [])),
                             })
                db.execute(
                    "UPDATE jobs SET script_json = ?, updated_at = ? WHERE id = ?",
                    [json.dumps(script_json, ensure_ascii=False), _now(), job_id]
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

        # --- Step 3: slides (배경 소스 선택에 따라 분기) ---
        _update_step(db, job_id, "slides", "running")
        try:
            ch_config_s3 = json.loads(channel.get("config", "{}")) if channel else {}
            auto_bg_source = ch_config_s3.get("auto_bg_source", "sd_image")
            image_prompt_style_s3 = ch_config_s3.get("image_prompt_style", "")

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
                print(f"[runner] 슬라이드에 image_prompt 존재 → Claude 프롬프트 생성 스킵 ({len(_existing_s3)}개)")
            else:
                image_prompts = generate_image_prompts(topic, slides_data, prompt_style=image_prompt_style_s3, layout=slide_layout_s3, image_style=image_style_s3)
            if image_prompts:
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
            full_text_fp = " ".join(s["text"] for s in sentences)

            # graph 타입 공통 처리
            def _gen_graph_fp(idx, slide):
                output_path = os.path.join(dirs["bg"], f"bg_{idx + 1}.png")
                try:
                    generate_infographic(slide, full_text_fp, output_path, width=1080, height=960)
                    print(f"[runner] bg_{idx+1}.png 인포그래픽 생성 완료")
                except Exception as e:
                    print(f"[runner] bg_{idx+1} 인포그래픽 실패, 차트 폴백: {e}")
                    try:
                        generate_chart(slide, output_path, width=1080, height=960)
                    except Exception as e2:
                        print(f"[runner] bg_{idx+1} 차트 폴백도 실패: {e2}")

            if auto_bg_source == "openverse":
                generate_backgrounds(slides_data, dirs["bg"])
            elif auto_bg_source == "gemini":
                gemini_key = ch_config_s3.get("gemini_api_key", "")
                if gemini_key and image_prompts:
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
                                time.sleep(5)  # Gemini 분당 요청 제한 대응
                            _ar = "1:1" if slide_layout_s3 in ("center", "top", "bottom") else "9:16"
                            gemini_generate_image(en_prompt, output_path, gemini_key,
                                                  aspect_ratio=_ar)
                            print(f"[runner] bg_{idx+1}.png Gemini 생성 완료")
                        except Exception as e:
                            print(f"[runner] bg_{idx+1} Gemini 생성 실패: {e}")
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
                        if bg_type == "graph":
                            _gen_graph_fp(idx, slide)
                            continue
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
                        if bg_type == "graph":
                            _gen_graph_fp(idx, slide)
                            continue
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
            slide_paths = generate_slides(slides_data, dirs["image"],
                                          date=date_str, brand=brand,
                                          backgrounds=bg_results,
                                          layout=slide_layout)
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

            timeline = build_timeline(sentences, dirs["audio"])
            merged_audio = merge_slide_audio(timeline["slide_audio_map"],
                                             dirs["segment"],
                                             narration_delay=narration_delay_r)
            if narration_delay_r > 0:
                first_s = min(timeline["slide_durations"].keys())
                timeline["slide_durations"][first_s] += narration_delay_r
                timeline["total_duration"] += narration_delay_r

            segments = render_segments(timeline["slide_durations"], dirs["image"],
                                       merged_audio, dirs["segment"])
            final_path = os.path.join(dirs["video"], f"{job_id}.mp4")

            # 효과음 설정
            sfx_cfg_r = _ch_cfg_r if (_ch_cfg_r.get("sfx_enabled") or _ch_cfg_r.get("bgm_enabled") or _ch_cfg_r.get("crossfade_duration")) else None

            concat_segments(segments, final_path,
                            sfx_cfg=sfx_cfg_r,
                            slide_durations=timeline["slide_durations"])

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
        self._queue = deque()  # [(db, job_id, kwargs), ...]
        self._lock = threading.Lock()
        self._worker_running = False
        self._current_job_id = None

    def enqueue(self, db, job_id: str, **kwargs):
        """Phase B 작업을 큐에 등록. 워커가 없으면 자동 시작."""
        with self._lock:
            # 중복 등록 방지
            if any(item[1] == job_id for item in self._queue):
                return
            if self._current_job_id == job_id:
                return

            self._queue.append((db, job_id, kwargs))
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
                "waiting": [item[1] for item in self._queue],
                "total": len(self._queue) + (1 if self._current_job_id else 0),
            }

    def get_position(self, job_id: str) -> int:
        """큐에서의 위치 반환. 0=현재 실행중, 1=다음, -1=큐에 없음"""
        with self._lock:
            if self._current_job_id == job_id:
                return 0
            for i, item in enumerate(self._queue):
                if item[1] == job_id:
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
                db, job_id, kwargs = self._queue.popleft()
                self._current_job_id = job_id

            try:
                _run_phase_b(db, job_id, **kwargs)
            except Exception:
                traceback.print_exc()

            with self._lock:
                self._current_job_id = None


# 전역 큐 인스턴스
_job_queue = JobQueue()


# ─── Public API ───

def start_pipeline(db, job_id: str, script_json: dict = None):
    """Phase A 실행 (대본까지 → waiting_slides). 병렬 OK."""
    t = threading.Thread(target=_run_phase_a, args=(db, job_id, script_json),
                         daemon=True)
    t.start()
    return t


def resume_pipeline(db, job_id: str, tts_voice: str = "", tts_rate=None,
                    tts_engine: str = "", sovits_cfg: dict = None):
    """Phase B를 큐에 등록 (순차 실행)"""
    _job_queue.enqueue(db, job_id, tts_voice_override=tts_voice,
                       tts_rate_override=tts_rate,
                       tts_engine_override=tts_engine,
                       sovits_cfg_override=sovits_cfg)


def start_pipeline_full(db, job_id: str, script_json: dict = None):
    """원스탑: Phase A 실행 후 완료되면 Phase B 큐 등록"""
    def _run_then_queue():
        _run_phase_a(db, job_id, script_json)
        # Phase A 성공 시 자동으로 Phase B 큐 등록
        job = db.fetchone("SELECT status FROM jobs WHERE id = ?", [job_id])
        if job and job["status"] == "waiting_slides":
            _job_queue.enqueue(db, job_id)

    t = threading.Thread(target=_run_then_queue, daemon=True)
    t.start()
    return t


def get_queue_status() -> dict:
    """큐 상태 조회"""
    return _job_queue.get_status()


def get_queue_position(job_id: str) -> int:
    """큐에서의 위치 조회"""
    return _job_queue.get_position(job_id)
