"""yShorts — FastAPI 백엔드"""
from __future__ import annotations
import json
import asyncio
import os
import re
import shutil
from datetime import datetime
from contextlib import asynccontextmanager
import uvicorn
from fastapi import FastAPI, Request, HTTPException, UploadFile, File
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from db.database import Database
from db.models import (
    create_channel, list_channels, get_channel, update_channel, delete_channel,
    create_job, list_jobs, get_job, get_job_steps, delete_job,
)
from pipeline import config
from pipeline.runner import (
    start_pipeline, resume_pipeline, start_pipeline_full,
    get_queue_status, get_queue_position, STEP_DEFINITIONS,
    _load_uploaded_backgrounds,
)
from pipeline.agent import parse_request
from pipeline.trend_collector import collect_trends, collect_news, format_trend_context
from pipeline.sd_generator import (
    generate_image, generate_video, generate_sd_prompts, generate_all_prompts,
    agent_generate_image,
    check_available as sd_check_available,
)
from pipeline.slide_generator import generate_slides, generate_chart, generate_infographic
from pipeline.gemini_generator import generate_image as gemini_gen_image

db = Database(config.db_path())
db_ch = Database(config.channels_db_path())

DEFAULT_INSTRUCTIONS = """\
# 유튜브 쇼츠 뉴스 브리핑 에이전트

너는 유튜브 쇼츠 뉴스 영상 제작 전문가야.
주어진 주제에 대해 최신 뉴스를 검색/분석해서
쇼츠 뉴스 브리핑 영상을 만들어줘.

## 대본 규칙
- 존댓말 기반이되, 문장 끝을 다양하게: ~입니다, ~인데요, ~한 상황, ~일까요?, ~됩니다, ~했는데요
- "~습니다"만 반복 금지. 3문장 연속 같은 어미 사용하지 않기
- 한 문장 20자 이내
- 수치/데이터 1개 이상 포함
- 감정적 표현 자제, 팩트 중심
"""


# ── 조사/어미 패턴 (한국어 단어 분리용) ──
_JOSA_PATTERN = re.compile(
    r'(은|는|이|가|을|를|의|에|에서|로|으로|와|과|도|만|까지|부터|에게|한테|께|라|이라|으로서|에게서)$'
)


def _tokenize_ko(text: str) -> set:
    """한국어 텍스트에서 핵심 단어 집합 추출 (간이 토크나이저).

    공백 분리 → 조사/어미 제거 → 2자 이상 단어만 유지.
    """
    words = set()
    for w in re.split(r'[\s,·…/()"\'\[\]]+', text):
        w = w.strip('.,!?~·""''「」『』')
        w = _JOSA_PATTERN.sub('', w)
        if len(w) >= 2:
            words.add(w)
    return words


def _is_duplicate(topic: str, recent_topics: list, threshold: float = 0.5) -> bool:
    """topic이 recent_topics 중 하나와 유사한지 Jaccard similarity로 판정.

    threshold: 0.5 (50%) 이상이면 중복으로 판정.
    """
    if not recent_topics:
        return False

    topic_words = _tokenize_ko(topic)
    if not topic_words:
        return False

    for recent in recent_topics:
        recent_words = _tokenize_ko(recent)
        if not recent_words:
            continue

        intersection = topic_words & recent_words
        union = topic_words | recent_words
        similarity = len(intersection) / len(union) if union else 0

        if similarity >= threshold:
            return True

        # 핵심 고유명사 겹침 체크: 3자 이상 단어가 정확히 일치하면 중복 가능성 높음
        long_words = {w for w in topic_words if len(w) >= 3}
        recent_long = {w for w in recent_words if len(w) >= 3}
        common_long = long_words & recent_long
        if common_long and len(common_long) >= 2:
            return True

    return False


def _migrate_channels_db():
    """shorts.db → channels.db 마이그레이션: channels.db가 비어있으면 shorts.db에서 복사"""
    existing = db_ch.fetchone("SELECT COUNT(*) as cnt FROM channels")
    if existing and existing["cnt"] > 0:
        return  # 이미 데이터 있음

    rows = db.fetchall("SELECT * FROM channels")
    if not rows:
        return

    for row in rows:
        db_ch.insert("channels", dict(row))
    print(f"[마이그레이션] channels.db로 {len(rows)}개 채널 복사 완료")


def _recover_orphan_jobs():
    """서버 시작 시 running 상태로 남은 고아 작업을 감지하여 재시작"""
    orphans = db.fetchall(
        "SELECT id, status FROM jobs WHERE status IN ('running', 'queued')"
    )
    if not orphans:
        return

    now = datetime.now().isoformat()
    for job in orphans:
        job_id = job["id"]
        # running step 찾기
        running_step = db.fetchone(
            "SELECT step_name FROM job_steps WHERE job_id = ? AND status = 'running'",
            [job_id]
        )
        step_name = running_step["step_name"] if running_step else "unknown"

        # running step → failed 처리
        db.execute(
            "UPDATE job_steps SET status = 'failed', completed_at = ?, "
            "error_msg = '서버 재시작으로 중단됨' "
            "WHERE job_id = ? AND status = 'running'", [now, job_id])

        print(f"[복구] {job_id}: {step_name} 단계에서 중단됨 → 재시작")

        # Phase A (news_search, script) → Phase A 재시작
        if step_name in ("news_search", "script"):
            # 대본 없으면 처음부터, 있으면 Phase B
            job_row = db.fetchone("SELECT script_json FROM jobs WHERE id = ?", [job_id])
            if job_row and job_row.get("script_json"):
                db.execute("UPDATE jobs SET status = 'waiting_slides', updated_at = ? WHERE id = ?",
                           [now, job_id])
                print(f"[복구] {job_id}: 대본 있음 → waiting_slides")
            else:
                # Phase A 재시작
                db.execute("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?",
                           [now, job_id])
                db.execute(
                    "UPDATE job_steps SET status = 'pending', error_msg = '' "
                    "WHERE job_id = ? AND status = 'failed'", [job_id])
                start_pipeline(db_ch, db, job_id)
                print(f"[복구] {job_id}: Phase A 재시작")
        # Phase B (slides, tts, render, qa, upload) → 큐 재등록
        elif step_name in ("slides", "tts", "render", "qa", "upload"):
            db.execute("UPDATE jobs SET status = 'waiting_slides', updated_at = ? WHERE id = ?",
                       [now, job_id])
            # failed step을 pending으로 되돌리고 큐 재등록
            db.execute(
                "UPDATE job_steps SET status = 'pending', error_msg = '' "
                "WHERE job_id = ? AND step_name = ?", [job_id, step_name])
            resume_pipeline(db_ch, db, job_id)
            print(f"[복구] {job_id}: Phase B 큐 재등록 ({step_name}부터)")
        else:
            # 알 수 없는 상태 → failed로 두고 수동 처리
            db.execute("UPDATE jobs SET status = 'failed', updated_at = ? WHERE id = ?",
                       [now, job_id])
            print(f"[복구] {job_id}: 알 수 없는 단계 → failed 처리")


@asynccontextmanager
async def lifespan(app):
    _migrate_channels_db()
    channels = list_channels(db_ch, db)
    if not channels:
        create_channel(db_ch, name="새 채널", handle="",
                       description="뉴스 브리핑 채널",
                       instructions=DEFAULT_INSTRUCTIONS,
                       default_topics="오늘 주요 뉴스 3개 만들어줘")
    _recover_orphan_jobs()
    yield

app = FastAPI(title="yShorts", version="1.0.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


# ─── Dashboard ───

@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    channels = list_channels(db_ch, db)
    return templates.TemplateResponse("dashboard.html", {
        "request": request,
        "channels": channels,
        "step_definitions": STEP_DEFINITIONS,
    })


# ─── Usage API ───

import subprocess as _sp
import time as _time

_CCUSAGE_CMD = shutil.which("ccusage") or "ccusage"
_PLAN_LIMITS = {"session_cost": 49.0, "weekly_cost": 203.0}
_usage_cache: dict = {"data": None, "ts": 0}

def _run_ccusage(args: list[str], timeout: int = 15) -> dict | None:
    try:
        result = _sp.run([_CCUSAGE_CMD] + args + ["--json"],
                         capture_output=True, text=True, timeout=timeout)
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout)
    except Exception:
        pass
    return None

@app.get("/api/usage")
async def api_usage():
    now = _time.time()
    if _usage_cache["data"] and now - _usage_cache["ts"] < 30:
        return _usage_cache["data"]

    from datetime import date, timedelta
    week_start = (date.today() - timedelta(days=date.today().weekday())).strftime("%Y%m%d")

    block = _run_ccusage(["blocks", "--active", "--token-limit", "max"])
    daily = _run_ccusage(["daily", "--since", week_start, "--breakdown"])

    active_block = None
    session_pct = 0
    if block and block.get("blocks"):
        for b in block["blocks"]:
            if b.get("isActive"):
                active_block = b
                cost = b.get("costUSD", 0)
                session_pct = round(cost / _PLAN_LIMITS["session_cost"] * 100)
                break

    weekly_pct = 0
    if daily and daily.get("totals"):
        weekly_pct = round(daily["totals"].get("totalCost", 0) / _PLAN_LIMITS["weekly_cost"] * 100)

    result = {"session_pct": session_pct, "weekly_pct": weekly_pct}
    _usage_cache["data"] = result
    _usage_cache["ts"] = now
    return result


# ─── Prompt Defaults API ───

@app.get("/api/prompt-defaults")
async def api_prompt_defaults():
    from pipeline.agent import DEFAULT_SCRIPT_RULES, DEFAULT_ROUNDUP_RULES
    return {
        "script_rules": DEFAULT_SCRIPT_RULES,
        "roundup_rules": DEFAULT_ROUNDUP_RULES,
    }


# ─── Channel API ───

@app.get("/api/channels")
async def api_list_channels():
    return list_channels(db_ch, db)


@app.post("/api/channels")
async def api_create_channel(request: Request):
    body = await request.json()
    name = body.get("name")
    if not name:
        raise HTTPException(400, "name is required")
    ch = create_channel(
        db_ch, name=name,
        handle=body.get("handle", ""),
        description=body.get("description", ""),
        instructions=body.get("instructions", ""),
        cfg=body.get("config"),
    )
    return ch


@app.post("/api/channels/{channel_id}/clone")
async def api_clone_channel(channel_id: str):
    """기존 채널을 복사하여 새 채널 생성 (원본 채널만 가능)"""
    src = get_channel(db_ch, channel_id)
    if not src:
        raise HTTPException(404, "Channel not found")
    if src.get("cloned_from"):
        raise HTTPException(400, "복사된 채널은 다시 복사할 수 없습니다. 원본 채널에서 복사하세요.")
    src_cfg = json.loads(src.get("config", "{}"))
    clone = create_channel(
        db_ch,
        name=f"{src['name']} (복사)",
        handle=src.get("handle", ""),
        description=src.get("description", ""),
        instructions=src.get("instructions", ""),
        default_topics=src.get("default_topics", ""),
        cfg=src_cfg,
    )
    # cloned_from 기록
    db_ch.execute("UPDATE channels SET cloned_from = ? WHERE id = ?", [channel_id, clone["id"]])
    clone["cloned_from"] = channel_id
    return clone


@app.put("/api/channels/reorder")
async def api_reorder_channels(request: Request):
    """채널 순서 변경"""
    body = await request.json()
    order = body.get("order", [])  # [channel_id, ...]
    for i, cid in enumerate(order):
        db_ch.execute("UPDATE channels SET sort_order = ? WHERE id = ?", [i, cid])
    return {"ok": True}


@app.put("/api/channels/{channel_id}")
async def api_update_channel(channel_id: str, request: Request):
    if not get_channel(db_ch, channel_id):
        raise HTTPException(404, "Channel not found")
    body = await request.json()
    return update_channel(db_ch, channel_id, **body)


@app.delete("/api/channels/{channel_id}")
async def api_delete_channel(channel_id: str):
    if not get_channel(db_ch, channel_id):
        raise HTTPException(404, "Channel not found")
    delete_channel(db_ch, db, channel_id)
    return {"ok": True}


# ─── Channel Fixed Images (Intro/Outro) ───

def _channel_asset_dir(channel_id: str) -> str:
    d = os.path.join("data", "channels", channel_id)
    os.makedirs(d, exist_ok=True)
    return d


def _find_channel_image(channel_id: str, prefix: str) -> str | None:
    """data/channels/{id}/{prefix}.* 파일 탐색"""
    d = os.path.join("data", "channels", channel_id)
    if not os.path.isdir(d):
        return None
    for ext in ["jpg", "jpeg", "png", "webp"]:
        p = os.path.join(d, f"{prefix}.{ext}")
        if os.path.exists(p):
            return p
    return None




@app.post("/api/channels/{channel_id}/{img_type}-bg")
async def api_upload_channel_bg(channel_id: str, img_type: str,
                                 file: UploadFile = File(...)):
    if img_type not in ("intro", "outro"):
        raise HTTPException(400, "img_type must be intro or outro")
    if not get_channel(db_ch, channel_id):
        raise HTTPException(404, "Channel not found")

    d = _channel_asset_dir(channel_id)
    # 기존 파일 삭제
    for ext in ["jpg", "jpeg", "png", "webp"]:
        old = os.path.join(d, f"{img_type}_bg.{ext}")
        if os.path.exists(old):
            os.remove(old)

    original = file.filename or f"{img_type}_bg.jpg"
    ext = original.rsplit(".", 1)[-1].lower() if "." in original else "jpg"
    if ext not in ("jpg", "jpeg", "png", "webp"):
        ext = "jpg"
    out_path = os.path.join(d, f"{img_type}_bg.{ext}")
    content = await file.read()
    with open(out_path, "wb") as f:
        f.write(content)

    return {"ok": True, "path": out_path, "size_kb": round(len(content) / 1024, 1)}


@app.get("/api/channels/{channel_id}/{img_type}-bg")
async def api_get_channel_bg(channel_id: str, img_type: str):
    if img_type not in ("intro", "outro"):
        raise HTTPException(400, "img_type must be intro or outro")
    path = _find_channel_image(channel_id, f"{img_type}_bg")
    if not path:
        raise HTTPException(404, "Not found")
    return FileResponse(path)


@app.delete("/api/channels/{channel_id}/{img_type}-bg")
async def api_delete_channel_bg(channel_id: str, img_type: str):
    if img_type not in ("intro", "outro"):
        raise HTTPException(400, "img_type must be intro or outro")
    path = _find_channel_image(channel_id, f"{img_type}_bg")
    if path:
        os.remove(path)
    return {"ok": True}


# ─── Job API ───

@app.get("/api/jobs")
async def api_list_jobs(channel_id: str = None, status: str = None):
    return list_jobs(db, channel_id=channel_id, status=status)


@app.post("/api/jobs")
async def api_create_job(request: Request):
    body = await request.json()
    channel_id = body.get("channel_id")
    topic = body.get("topic")
    script_json = body.get("script_json")

    if not channel_id or not topic:
        raise HTTPException(400, "channel_id and topic are required")
    if not get_channel(db_ch, channel_id):
        raise HTTPException(404, "Channel not found")

    job = create_job(
        db, channel_id=channel_id,
        topic=topic,
        category=body.get("category", ""),
        script_json=script_json,
    )

    # script_json이 있으면 원스탑 파이프라인
    if script_json:
        start_pipeline_full(db_ch, db, job["id"], script_json)

    return job


@app.post("/api/jobs/create-manual")
async def api_create_manual_job(request: Request):
    """수동 모드: 사용자가 직접 작성한 대본으로 작업 생성 (Claude 호출 없음)"""
    body = await request.json()
    channel_id = body.get("channel_id")
    topic = body.get("topic")
    script_json = body.get("script_json")

    if not channel_id or not topic or not script_json:
        raise HTTPException(400, "channel_id, topic, script_json are required")
    if not get_channel(db_ch, channel_id):
        raise HTTPException(404, "Channel not found")

    job = create_job(
        db, channel_id=channel_id,
        topic=topic,
        script_json=script_json,
    )

    # 슬라이드에 image_prompt_en이 있으면 meta_json에 복사
    slides = script_json.get("slides", [])
    _prompts = [
        {"ko": s.get("image_prompt_ko", ""), "en": s.get("image_prompt_en", "")}
        for s in slides if s.get("bg_type") != "closing"
    ]
    if any(p.get("en") for p in _prompts):
        meta = {"image_prompts": _prompts}
        db.execute("UPDATE jobs SET meta_json = ? WHERE id = ?",
                   [json.dumps(meta, ensure_ascii=False), job["id"]])

    # Phase A 스킵 → 바로 waiting_slides
    db.execute("UPDATE jobs SET status = 'waiting_slides' WHERE id = ?", [job["id"]])
    db.execute(
        "UPDATE job_steps SET status = 'skipped' WHERE job_id = ? AND step_name IN ('news_search', 'script')",
        [job["id"]],
    )

    return {"id": job["id"], "status": "waiting_slides"}


@app.post("/api/channels/{channel_id}/run")
async def api_run_channel(channel_id: str, request: Request):
    """채널의 요청을 Claude가 해석 → 주제별 작업 생성 → Phase A (대본까지)"""
    import traceback, asyncio

    ch = get_channel(db_ch, channel_id)
    if not ch:
        raise HTTPException(404, "Channel not found")

    # body에 request가 있으면 우선 사용, 없으면 채널 기본값
    request_text = ""
    try:
        body = await request.json()
        request_text = (body.get("request") or "").strip()
    except Exception:
        pass
    if not request_text:
        request_text = (ch.get("default_topics") or "").strip()
    if not request_text:
        raise HTTPException(400, "요청이 설정되지 않았습니다. 채널 설정에서 요청을 추가하세요.")

    try:
        instructions = ch.get("instructions") or ""

        # 트렌드 데이터 수집
        cfg = {}
        try:
            cfg = json.loads(ch.get("config") or "{}")
        except (json.JSONDecodeError, TypeError):
            pass
        trend_sources = cfg.get("trend_sources", [])
        yt_api_key = cfg.get("youtube_api_key", "")
        trend_context = ""
        if trend_sources:
            trends = collect_trends(trend_sources, youtube_api_key=yt_api_key)
            trend_context = format_trend_context(trends)

        # 최근 24시간 내 작업 주제 수집 (중복 방지)
        recent_jobs = db.fetchall(
            "SELECT topic FROM jobs WHERE channel_id = ? AND created_at >= datetime('now', 'localtime', '-24 hours') ORDER BY created_at DESC LIMIT 20",
            [channel_id]
        )
        recent_topics = [j["topic"] for j in recent_jobs] if recent_jobs else []

        production_mode = cfg.get("production_mode", "manual")
        channel_format = cfg.get("format", "single")

        # 고정 주제 채널: parse_request 스킵, request_text를 그대로 topic으로 사용
        if cfg.get("fixed_topic"):
            topics = [request_text]
        else:
            # 동기 함수를 스레드에서 실행 (이벤트 루프 블록 방지)
            topics = await asyncio.to_thread(
                parse_request, request_text, instructions,
                trend_context=trend_context, recent_topics=recent_topics
            )

            # 코드 레벨 중복 필터 (프롬프트 의존 보완)
            filtered = []
            for topic in topics:
                if _is_duplicate(topic, recent_topics):
                    print(f"[중복 필터] 제거: {topic}")
                else:
                    filtered.append(topic)
            if not filtered:
                raise HTTPException(400, "중복되지 않는 새 뉴스를 찾지 못했습니다. 다시 시도해주세요.")
            topics = filtered

        jobs = []
        if channel_format == "roundup" and len(topics) > 1:
            # 라운드업: 여러 주제를 하나의 Job으로 합침
            combined_topic = " / ".join(topics)
            job = create_job(db, channel_id=channel_id, topic=combined_topic)
            jobs.append(job)
            if production_mode == "auto":
                start_pipeline_full(db_ch, db, job["id"])
            else:
                start_pipeline(db_ch, db, job["id"])
        else:
            for topic in topics:
                job = create_job(db, channel_id=channel_id, topic=topic)
                jobs.append(job)
                if production_mode == "auto":
                    start_pipeline_full(db_ch, db, job["id"])
                else:
                    start_pipeline(db_ch, db, job["id"])
        return {"created": len(jobs), "jobs": jobs, "mode": production_mode}

    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, detail=str(e))


@app.get("/api/channels/{channel_id}/trends")
async def api_get_channel_trends(channel_id: str):
    """트렌드 미리보기 — 채널 설정의 소스로 수집"""
    ch = get_channel(db_ch, channel_id)
    if not ch:
        raise HTTPException(404, "Channel not found")

    cfg = {}
    try:
        cfg = json.loads(ch.get("config") or "{}")
    except (json.JSONDecodeError, TypeError):
        pass
    trend_sources = cfg.get("trend_sources", [])
    yt_api_key = cfg.get("youtube_api_key", "")

    if not trend_sources:
        return {"trends": {}, "formatted": "", "message": "트렌드 소스가 설정되지 않았습니다."}

    trends = collect_trends(trend_sources, youtube_api_key=yt_api_key)
    formatted = format_trend_context(trends)
    return {"trends": trends, "formatted": formatted}


@app.get("/api/news/browse")
async def api_news_browse(category: str = ""):
    """뉴스 탐색 — Google News / Trends / YouTube Trending 통합 조회"""
    sources = ["google_news", "google_trends"]
    yt_api_key = ""

    # YouTube API 키: 채널 config에서 찾기
    channels = list_channels(db_ch, db)
    for ch in channels:
        try:
            cfg = json.loads(ch.get("config") or "{}")
        except (json.JSONDecodeError, TypeError):
            continue
        key = cfg.get("youtube_api_key", "")
        if key:
            yt_api_key = key
            sources.append("youtube_trending")
            break

    return collect_news(sources=sources, youtube_api_key=yt_api_key, category=category)


@app.get("/api/jobs/{job_id}")
async def api_get_job(job_id: str):
    job = get_job(db, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@app.get("/api/jobs/{job_id}/steps")
async def api_get_job_steps(job_id: str):
    steps = get_job_steps(db, job_id)
    if not steps:
        raise HTTPException(404, "Job not found")
    job = db.fetchone("SELECT status FROM jobs WHERE id = ?", [job_id])
    return {"job_id": job_id, "job_status": job["status"] if job else None,
            "steps": steps}


@app.get("/api/jobs/{job_id}/script")
async def api_get_job_script(job_id: str):
    """대본 + 슬라이드 정보 조회 (팝업용)"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")

    script_json = None
    if job.get("script_json"):
        script_json = json.loads(job["script_json"])

    # 업로드된 배경 이미지 확인
    bg_dir = os.path.join(config.output_dir(), job_id, "backgrounds")
    uploaded_bgs = {}
    if os.path.isdir(bg_dir):
        for fname in os.listdir(bg_dir):
            for ext in ["mp4", "jpg", "jpeg", "png", "webp", "gif"]:
                if fname.lower().endswith(f".{ext}"):
                    # bg_1.jpg → 1
                    parts = fname.rsplit(".", 1)[0]  # bg_1
                    try:
                        idx = int(parts.split("_")[1])
                        fpath = os.path.join(bg_dir, fname)
                        mtime = int(os.path.getmtime(fpath))
                        uploaded_bgs[idx] = f"/api/jobs/{job_id}/backgrounds/{fname}?t={mtime}"
                    except (IndexError, ValueError):
                        pass

    # 나레이션 파일 확인
    has_narration = False
    job_dir = os.path.join(config.output_dir(), job_id)
    for ext in ["mp3", "wav", "m4a", "ogg", "webm"]:
        if os.path.exists(os.path.join(job_dir, f"narration.{ext}")):
            has_narration = True
            break

    meta = json.loads(job["meta_json"]) if job.get("meta_json") else {}

    # 채널 config (배경 소스 정보)
    channel = db_ch.fetchone("SELECT config FROM channels WHERE id = ?", [job.get("channel_id", "")])
    ch_cfg = json.loads(channel.get("config", "{}")) if channel else {}

    # 썸네일 확인
    thumb_path = os.path.join(job_dir, "thumbnail.png")
    has_thumbnail = os.path.exists(thumb_path)

    return {
        "job_id": job_id,
        "topic": job.get("topic", ""),
        "status": job.get("status", ""),
        "script": script_json,
        "uploaded_backgrounds": uploaded_bgs,
        "has_narration": has_narration,
        "has_thumbnail": has_thumbnail,
        "image_prompts": meta.get("image_prompts", []),
        "genspark_prompts": meta.get("genspark_prompts", []),
        "auto_bg_source": ch_cfg.get("auto_bg_source", "sd_image"),
        "slide_layout": ch_cfg.get("slide_layout", "full"),
    }


@app.put("/api/jobs/{job_id}/script")
async def api_update_script(job_id: str, request: Request):
    """나레이션 대본(sentences) 텍스트 수정."""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job or not job.get("script_json"):
        raise HTTPException(404, "Job or script not found")

    body = await request.json()
    updated_sentences = body.get("sentences")  # [{text, slide}, ...]
    if not isinstance(updated_sentences, list):
        raise HTTPException(400, "sentences must be a list")

    script = json.loads(job["script_json"])
    script["sentences"] = updated_sentences
    db.execute("UPDATE jobs SET script_json = ? WHERE id = ?",
               [json.dumps(script, ensure_ascii=False), job_id])
    return {"ok": True}


@app.post("/api/jobs/{job_id}/backgrounds")
async def api_upload_backgrounds(job_id: str, files: list[UploadFile] = File(...)):
    """슬라이드별 배경 이미지 업로드.

    파일명으로 슬라이드 번호 결정: bg_1, bg_2, ... 또는 순서대로 할당.
    """
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")

    bg_dir = os.path.join(config.output_dir(), job_id, "backgrounds")
    os.makedirs(bg_dir, exist_ok=True)

    saved = []
    for i, file in enumerate(files, start=1):
        # 파일명에서 슬라이드 번호 추출 시도
        original = file.filename or f"bg_{i}.jpg"
        name_part = original.rsplit(".", 1)[0]
        ext = original.rsplit(".", 1)[-1] if "." in original else "jpg"

        # bg_N 패턴이면 N 사용, 아니면 순서대로
        try:
            idx = int(name_part.split("_")[-1]) if "_" in name_part else i
        except ValueError:
            idx = i

        out_path = os.path.join(bg_dir, f"bg_{idx}.{ext}")
        content = await file.read()
        with open(out_path, "wb") as f:
            f.write(content)

        saved.append({"index": idx, "filename": f"bg_{idx}.{ext}",
                      "size_kb": round(len(content) / 1024, 1)})

    return {"uploaded": len(saved), "files": saved}


@app.post("/api/jobs/{job_id}/backgrounds/{index}")
async def api_upload_single_background(job_id: str, index: int,
                                        file: UploadFile = File(...)):
    """단일 슬라이드 배경 이미지 업로드"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")

    bg_dir = os.path.join(config.output_dir(), job_id, "backgrounds")
    os.makedirs(bg_dir, exist_ok=True)

    # 기존 파일 삭제
    for ext in ["jpg", "jpeg", "png", "webp", "gif", "mp4"]:
        old = os.path.join(bg_dir, f"bg_{index}.{ext}")
        if os.path.exists(old):
            os.remove(old)

    original = file.filename or f"bg_{index}.jpg"
    ext = original.rsplit(".", 1)[-1] if "." in original else "jpg"
    out_path = os.path.join(bg_dir, f"bg_{index}.{ext}")

    content = await file.read()
    with open(out_path, "wb") as f:
        f.write(content)

    return {"index": index, "filename": f"bg_{index}.{ext}",
            "size_kb": round(len(content) / 1024, 1)}


@app.get("/api/jobs/{job_id}/backgrounds/{filename}")
async def api_get_background(job_id: str, filename: str):
    """업로드된 배경 이미지 서빙"""
    bg_path = os.path.join(config.output_dir(), job_id, "backgrounds", filename)
    if not os.path.exists(bg_path):
        raise HTTPException(404, "Background not found")
    return FileResponse(bg_path)


@app.get("/api/jobs/{job_id}/thumbnail")
async def api_get_thumbnail(job_id: str):
    """썸네일 이미지 서빙"""
    thumb_path = os.path.join(config.output_dir(), job_id, "thumbnail.png")
    if not os.path.exists(thumb_path):
        raise HTTPException(404, "Thumbnail not found")
    return FileResponse(thumb_path)


@app.post("/api/jobs/{job_id}/thumbnail")
async def api_upload_thumbnail(job_id: str, file: UploadFile = File(...)):
    """썸네일 수동 업로드 (교체)"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")
    job_dir = os.path.join(config.output_dir(), job_id)
    os.makedirs(job_dir, exist_ok=True)
    thumb_path = os.path.join(job_dir, "thumbnail.png")
    content = await file.read()
    with open(thumb_path, "wb") as f:
        f.write(content)
    return {"ok": True, "size_kb": round(len(content) / 1024, 1)}


@app.post("/api/jobs/{job_id}/generate-thumbnail")
async def api_generate_thumbnail(job_id: str):
    """썸네일 수동 생성/재생성"""
    from pipeline.slide_generator import generate_thumbnail
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job or not job.get("script_json"):
        raise HTTPException(404, "Job or script not found")
    script = json.loads(job["script_json"])
    slides = script.get("slides", [])
    if not slides:
        raise HTTPException(400, "No slides in script")

    channel = db_ch.fetchone("SELECT * FROM channels WHERE id = ?", [job.get("channel_id", "")])
    brand = channel["name"] if channel else ""

    title = script.get("youtube_title", "")
    if not title:
        title = slides[0].get("main", "").replace('<span class="hl">', "").replace("</span>", "")
    category = slides[0].get("category", "")
    accent = slides[0].get("accent", "#ff6b35")

    # 첫 번째 배경 이미지 찾기
    bg_dir = os.path.join(config.output_dir(), job_id, "backgrounds")
    bg_path = ""
    if os.path.isdir(bg_dir):
        for ext in ["jpg", "jpeg", "png", "webp"]:
            p = os.path.join(bg_dir, f"bg_1.{ext}")
            if os.path.exists(p):
                bg_path = p
                break

    output_path = os.path.join(config.output_dir(), job_id, "thumbnail.png")
    generate_thumbnail(title, output_path, category=category,
                       accent=accent, brand=brand, background=bg_path)
    return {"ok": True, "path": output_path}


@app.post("/api/jobs/{job_id}/narration")
async def api_upload_narration(job_id: str, file: UploadFile = File(...)):
    """나레이션 음성 파일 업로드"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")

    job_dir = os.path.join(config.output_dir(), job_id)
    os.makedirs(job_dir, exist_ok=True)

    # 기존 나레이션 삭제
    for ext in ["mp3", "wav", "m4a", "ogg", "webm"]:
        old = os.path.join(job_dir, f"narration.{ext}")
        if os.path.exists(old):
            os.remove(old)

    original = file.filename or "narration.mp3"
    ext = original.rsplit(".", 1)[-1].lower() if "." in original else "mp3"
    out_path = os.path.join(job_dir, f"narration.{ext}")

    content = await file.read()
    with open(out_path, "wb") as f:
        f.write(content)

    return {"filename": f"narration.{ext}", "size_kb": round(len(content) / 1024, 1)}


@app.get("/api/jobs/{job_id}/narration")
async def api_get_narration(job_id: str):
    """업로드된 나레이션 음성 서빙"""
    job_dir = os.path.join(config.output_dir(), job_id)
    for ext in ["mp3", "wav", "m4a", "ogg", "webm"]:
        path = os.path.join(job_dir, f"narration.{ext}")
        if os.path.exists(path):
            return FileResponse(path, media_type=f"audio/{ext}")
    raise HTTPException(404, "Narration not found")


@app.delete("/api/jobs/{job_id}/narration")
async def api_delete_narration(job_id: str):
    """업로드된 나레이션 삭제"""
    job_dir = os.path.join(config.output_dir(), job_id)
    deleted = False
    for ext in ["mp3", "wav", "m4a", "ogg", "webm"]:
        path = os.path.join(job_dir, f"narration.{ext}")
        if os.path.exists(path):
            os.remove(path)
            deleted = True
    if not deleted:
        raise HTTPException(404, "Narration not found")
    return {"ok": True}


# ─── 작업 상태 강제 변경 ───

ALLOWED_FORCE_STATUSES = {"completed", "failed", "waiting_slides"}

@app.post("/api/jobs/{job_id}/force-status")
async def api_force_status(job_id: str, request: Request):
    """관리용: stuck 상태 작업의 상태를 강제 변경"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")

    body = await request.json()
    new_status = body.get("status", "")
    if new_status not in ALLOWED_FORCE_STATUSES:
        raise HTTPException(400, f"허용된 상태: {', '.join(sorted(ALLOWED_FORCE_STATUSES))}")

    old_status = job.get("status", "")
    now = datetime.now().isoformat()
    db.execute("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
               [new_status, now, job_id])

    # step 상태도 일괄 갱신
    if new_status == "completed":
        # running → completed, pending → skipped
        db.execute(
            "UPDATE job_steps SET status = 'completed', completed_at = ? "
            "WHERE job_id = ? AND status = 'running'", [now, job_id])
        db.execute(
            "UPDATE job_steps SET status = 'skipped', completed_at = ? "
            "WHERE job_id = ? AND status = 'pending'", [now, job_id])
    elif new_status == "failed":
        # running → failed
        db.execute(
            "UPDATE job_steps SET status = 'failed', completed_at = ?, "
            "error_msg = '수동 실패 처리' "
            "WHERE job_id = ? AND status = 'running'", [now, job_id])

    return {"ok": True, "job_id": job_id,
            "old_status": old_status, "new_status": new_status}


# ─── 수동 YouTube 업로드 ───

@app.post("/api/jobs/{job_id}/youtube-upload")
async def api_manual_youtube_upload(job_id: str):
    """완성된 영상을 수동으로 YouTube에 업로드"""
    from pipeline.youtube_uploader import upload_video

    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")
    if job.get("status") != "completed":
        raise HTTPException(400, "영상이 완성되지 않았습니다")

    channel = db_ch.fetchone("SELECT * FROM channels WHERE id = ?", [job["channel_id"]])
    ch_config = json.loads(channel.get("config", "{}")) if channel else {}

    yt_client_id = ch_config.get("youtube_client_id", "")
    yt_client_secret = ch_config.get("youtube_client_secret", "")
    yt_refresh_token = ch_config.get("youtube_refresh_token", "")
    yt_privacy = ch_config.get("youtube_privacy", "private")

    if not (yt_client_id and yt_client_secret and yt_refresh_token):
        raise HTTPException(400, "YouTube 인증이 설정되지 않았습니다. 채널 설정에서 OAuth 정보를 입력하세요.")

    job_dir = os.path.join(config.output_dir(), job_id)
    final_path = job.get("output_path", "")
    if not final_path or not os.path.exists(final_path):
        raise HTTPException(404, "영상 파일을 찾을 수 없습니다")

    meta_path = os.path.join(job_dir, "metadata.json")
    if not os.path.exists(meta_path):
        raise HTTPException(404, "메타데이터 파일을 찾을 수 없습니다")

    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)

    import re
    def _strip_html(text: str) -> str:
        return re.sub(r"<[^>]+>", "", text)

    thumb_path = os.path.join(job_dir, "thumbnail.png")

    try:
        result = await asyncio.to_thread(
            upload_video,
            video_path=final_path,
            title=_strip_html(meta["title"])[:100],
            description=_strip_html(meta["description"]),
            tags=meta.get("tags", []),
            client_id=yt_client_id,
            client_secret=yt_client_secret,
            refresh_token=yt_refresh_token,
            privacy_status=yt_privacy,
            thumbnail_path=thumb_path if os.path.isfile(thumb_path) else "",
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"YouTube 업로드 실패: {e}")

    # upload 스텝 상태 업데이트 (없으면 INSERT)
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    output_json = json.dumps(result, ensure_ascii=False)
    existing = db.fetchone(
        "SELECT id FROM job_steps WHERE job_id = ? AND step_name = ?",
        [job_id, "upload"]
    )
    if existing:
        db.execute(
            "UPDATE job_steps SET status = ?, completed_at = ?, output_data = ?, updated_at = ? "
            "WHERE job_id = ? AND step_name = ?",
            ["completed", now, output_json, now, job_id, "upload"]
        )
    else:
        db.execute(
            "INSERT INTO job_steps (job_id, step_name, step_order, status, started_at, completed_at, output_data, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [job_id, "upload", 7, "completed", now, now, output_json, now]
        )

    return result


# ─── 이미지 프롬프트 생성 API ───

@app.post("/api/jobs/{job_id}/generate-image-prompts")
async def api_generate_image_prompts(job_id: str):
    """대본 기반으로 이미지 생성 프롬프트(한국어) 생성"""
    from pipeline.agent import generate_image_prompts

    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")
    if not job.get("script_json"):
        raise HTTPException(400, "대본이 없습니다")

    script = json.loads(job["script_json"])
    slides = script.get("slides", [])
    topic = job.get("topic", "")

    channel = db_ch.fetchone("SELECT config FROM channels WHERE id = ?", [job["channel_id"]])
    ch_cfg = json.loads(channel.get("config", "{}")) if channel else {}
    prompt_style = ch_cfg.get("image_prompt_style", "")
    slide_layout = ch_cfg.get("slide_layout", "full")
    image_style = ch_cfg.get("image_style", "mixed")

    prompts = await asyncio.to_thread(generate_image_prompts, topic, slides, prompt_style, slide_layout, image_style)

    meta = json.loads(job["meta_json"]) if job.get("meta_json") else {}
    meta["image_prompts"] = prompts
    db.execute("UPDATE jobs SET meta_json = ? WHERE id = ?",
               [json.dumps(meta, ensure_ascii=False), job_id])

    return {"image_prompts": prompts}


# ─── Stable Diffusion API ───

@app.get("/api/sd/status")
async def api_sd_status():
    """ComfyUI 연결 상태 확인"""
    cfg = config.comfyui_cfg()
    available = sd_check_available(cfg["host"], cfg["port"])
    return {"available": available, "host": cfg["host"], "port": cfg["port"]}


@app.post("/api/jobs/{job_id}/sd-prompts")
async def api_generate_sd_prompts(job_id: str):
    """Claude로 슬라이드별 SD 프롬프트 생성"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")
    if not job.get("script_json"):
        raise HTTPException(400, "대본이 없습니다")

    script = json.loads(job["script_json"])
    slides = script.get("slides", [])
    topic = job.get("topic", "")

    result = await asyncio.to_thread(generate_all_prompts, slides, topic)

    # 프롬프트를 job 메타데이터에 저장
    meta = json.loads(job["meta_json"]) if job.get("meta_json") else {}
    meta["sd_prompts"] = result["sd_prompts"]
    meta["genspark_prompts"] = result["genspark_prompts"]
    db.execute("UPDATE jobs SET meta_json = ? WHERE id = ?",
               [json.dumps(meta, ensure_ascii=False), job_id])

    return {"prompts": result["sd_prompts"], "genspark_prompts": result["genspark_prompts"]}


@app.get("/api/jobs/{job_id}/sd-prompts")
async def api_get_sd_prompts(job_id: str):
    """저장된 SD 프롬프트 조회"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")

    meta = json.loads(job["meta_json"]) if job.get("meta_json") else {}
    raw = meta.get("sd_prompts", []) or meta.get("image_prompts", [])
    # image_prompts가 dict 배열이면 영어만 추출
    en_prompts = [p.get("en", p) if isinstance(p, dict) else p for p in raw]
    return {"prompts": en_prompts, "genspark_prompts": meta.get("genspark_prompts", [])}


@app.put("/api/jobs/{job_id}/sd-prompts/{index}")
async def api_update_sd_prompt(job_id: str, index: int, request: Request):
    """개별 슬롯 SD 프롬프트 수정"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")

    body = await request.json()
    new_prompt = body.get("prompt", "")

    meta = json.loads(job["meta_json"]) if job.get("meta_json") else {}
    prompts = meta.get("sd_prompts", [])

    # index는 1-based
    idx = index - 1
    while len(prompts) <= idx:
        prompts.append("")
    prompts[idx] = new_prompt

    meta["sd_prompts"] = prompts
    db.execute("UPDATE jobs SET meta_json = ? WHERE id = ?",
               [json.dumps(meta, ensure_ascii=False), job_id])

    return {"ok": True, "index": index, "prompt": new_prompt}


@app.put("/api/jobs/{job_id}/image-prompts/{index}")
async def api_update_image_prompt(job_id: str, index: int, request: Request):
    """개별 슬롯 이미지 생성 프롬프트(한국어) 수정"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")

    body = await request.json()
    new_ko = body.get("ko", "")
    new_en = body.get("en", body.get("prompt", ""))

    meta = json.loads(job["meta_json"]) if job.get("meta_json") else {}
    prompts = meta.get("image_prompts", [])

    idx = index - 1
    while len(prompts) <= idx:
        prompts.append({"ko": "", "en": ""})
    # 기존 값이 string이면 dict로 변환
    existing = prompts[idx]
    if isinstance(existing, str):
        existing = {"ko": "", "en": existing}
    existing["ko"] = new_ko if new_ko else existing.get("ko", "")
    existing["en"] = new_en if new_en else existing.get("en", "")
    prompts[idx] = existing

    meta["image_prompts"] = prompts
    db.execute("UPDATE jobs SET meta_json = ? WHERE id = ?",
               [json.dumps(meta, ensure_ascii=False), job_id])

    return {"ok": True, "index": index, "prompt": existing}


@app.post("/api/jobs/{job_id}/agent-generate/{index}")
async def api_agent_generate_single(job_id: str, index: int):
    """이미지 에이전트: 한국어 프롬프트 → 영문 변환 → SD 생성 → Vision 검토 → 재시도"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")

    cfg = config.comfyui_cfg()
    if not sd_check_available(cfg["host"], cfg["port"]):
        raise HTTPException(503, "ComfyUI 서버가 실행 중이 아닙니다")

    meta = json.loads(job["meta_json"]) if job.get("meta_json") else {}
    prompts = meta.get("image_prompts", [])
    idx = index - 1
    if idx >= len(prompts) or not prompts[idx]:
        raise HTTPException(400, "이미지 프롬프트가 없습니다")

    raw_prompt = prompts[idx]
    kr_prompt = raw_prompt.get("en", raw_prompt) if isinstance(raw_prompt, dict) else raw_prompt

    bg_dir = os.path.join(config.output_dir(), job_id, "backgrounds")
    os.makedirs(bg_dir, exist_ok=True)
    output_path = os.path.join(bg_dir, f"bg_{index}.jpg")

    # 기존 파일 삭제
    for ext in ["jpg", "jpeg", "png", "webp", "gif", "mp4"]:
        old = os.path.join(bg_dir, f"bg_{index}.{ext}")
        if os.path.exists(old):
            os.remove(old)

    result = await asyncio.to_thread(
        agent_generate_image, kr_prompt, output_path,
        host=cfg["host"], port=cfg["port"], max_retries=3
    )

    # 사용된 SD 프롬프트를 meta에 저장
    sd_prompts = meta.get("sd_prompts", [])
    while len(sd_prompts) <= idx:
        sd_prompts.append("")
    sd_prompts[idx] = result.get("sd_prompt", "")
    meta["sd_prompts"] = sd_prompts
    db.execute("UPDATE jobs SET meta_json = ? WHERE id = ?",
               [json.dumps(meta, ensure_ascii=False), job_id])

    return result


@app.post("/api/jobs/{job_id}/agent-generate")
async def api_agent_generate_all(job_id: str):
    """전체 슬롯 이미지 에이전트 실행"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")

    cfg = config.comfyui_cfg()
    if not sd_check_available(cfg["host"], cfg["port"]):
        raise HTTPException(503, "ComfyUI 서버가 실행 중이 아닙니다")

    meta = json.loads(job["meta_json"]) if job.get("meta_json") else {}
    prompts = meta.get("image_prompts", [])
    if not prompts:
        raise HTTPException(400, "이미지 프롬프트가 없습니다. 대본을 먼저 생성하세요.")

    bg_dir = os.path.join(config.output_dir(), job_id, "backgrounds")
    os.makedirs(bg_dir, exist_ok=True)

    results = []
    sd_prompts = meta.get("sd_prompts", [])

    for idx, raw_prompt in enumerate(prompts):
        en_prompt = raw_prompt.get("en", raw_prompt) if isinstance(raw_prompt, dict) else raw_prompt
        if not en_prompt:
            results.append({"index": idx + 1, "ok": False, "feedback": "프롬프트 없음"})
            continue

        output_path = os.path.join(bg_dir, f"bg_{idx + 1}.jpg")
        for ext in ["jpg", "jpeg", "png", "webp", "gif", "mp4"]:
            old = os.path.join(bg_dir, f"bg_{idx + 1}.{ext}")
            if os.path.exists(old):
                os.remove(old)

        result = await asyncio.to_thread(
            agent_generate_image, en_prompt, output_path,
            host=cfg["host"], port=cfg["port"], max_retries=3
        )
        result["index"] = idx + 1
        results.append(result)

        while len(sd_prompts) <= idx:
            sd_prompts.append("")
        sd_prompts[idx] = result.get("sd_prompt", "")

    meta["sd_prompts"] = sd_prompts
    db.execute("UPDATE jobs SET meta_json = ? WHERE id = ?",
               [json.dumps(meta, ensure_ascii=False), job_id])

    return {"results": results}


@app.post("/api/jobs/{job_id}/sd-generate/{index}")
async def api_sd_generate_single(job_id: str, index: int, request: Request):
    """개별 슬롯 이미지 생성 — 채널 auto_bg_source에 따라 Gemini/SD 라우팅"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")

    # 채널 config에서 소스 결정
    channel = db_ch.fetchone("SELECT config FROM channels WHERE id = ?", [job["channel_id"]])
    ch_cfg = json.loads(channel.get("config", "{}")) if channel else {}
    auto_bg_source = ch_cfg.get("auto_bg_source", "sd_image")
    gemini_key = ch_cfg.get("gemini_api_key", "")

    # 프롬프트 가져오기
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    prompt = body.get("prompt", "")

    if not prompt:
        meta = json.loads(job["meta_json"]) if job.get("meta_json") else {}
        prompts = meta.get("sd_prompts", []) or meta.get("image_prompts", [])
        idx = index - 1
        if idx < len(prompts):
            p = prompts[idx]
            prompt = p.get("en", p) if isinstance(p, dict) else p

    if not prompt:
        raise HTTPException(400, "프롬프트가 없습니다. 먼저 프롬프트를 생성하세요.")

    bg_dir = os.path.join(config.output_dir(), job_id, "backgrounds")

    # 기존 파일 삭제
    for ext in ["jpg", "jpeg", "png", "webp", "gif", "mp4"]:
        old = os.path.join(bg_dir, f"bg_{index}.{ext}")
        if os.path.exists(old):
            os.remove(old)
        old_thumb = os.path.join(bg_dir, f"bg_{index}_thumb.{ext}")
        if os.path.exists(old_thumb):
            os.remove(old_thumb)

    if auto_bg_source == "gemini" and gemini_key:
        # Gemini 이미지 생성 — 레이아웃에 따라 비율 결정
        slide_layout = ch_cfg.get("slide_layout", "full")
        _ar = "1:1" if slide_layout in ("center", "top", "bottom") else "9:16"
        output_path = os.path.join(bg_dir, f"bg_{index}.png")
        ok = await asyncio.to_thread(
            gemini_gen_image, prompt, output_path, gemini_key, _ar
        )
        if not ok:
            raise HTTPException(500, "Gemini 이미지 생성 실패")
        return {"ok": True, "index": index, "source": "gemini",
                "path": f"/api/jobs/{job_id}/backgrounds/bg_{index}.png"}
    else:
        # SD 이미지 생성
        comfyui_cfg = config.comfyui_cfg()
        if not sd_check_available(comfyui_cfg["host"], comfyui_cfg["port"]):
            raise HTTPException(503, "ComfyUI 서버가 실행 중이 아닙니다")
        seed = body.get("seed", -1)
        output_path = os.path.join(bg_dir, f"bg_{index}.jpg")
        await asyncio.to_thread(
            generate_image, prompt, output_path,
            seed=seed, host=comfyui_cfg["host"], port=comfyui_cfg["port"]
        )
        return {"ok": True, "index": index, "source": "sd",
                "path": f"/api/jobs/{job_id}/backgrounds/bg_{index}.jpg"}


@app.post("/api/jobs/{job_id}/sd-generate")
async def api_sd_generate_all(job_id: str):
    """전체 슬롯 SD 이미지 일괄 생성"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")

    cfg = config.comfyui_cfg()
    if not sd_check_available(cfg["host"], cfg["port"]):
        raise HTTPException(503, "ComfyUI 서버가 실행 중이 아닙니다")

    meta = json.loads(job["meta_json"]) if job.get("meta_json") else {}
    prompts = meta.get("sd_prompts", []) or meta.get("image_prompts", [])
    if not prompts:
        raise HTTPException(400, "프롬프트가 없습니다. 먼저 프롬프트를 생성하세요.")

    script = json.loads(job["script_json"])
    bg_count = len(script.get("slides", [])) - 1

    bg_dir = os.path.join(config.output_dir(), job_id, "backgrounds")
    results = []

    for i in range(min(len(prompts), bg_count)):
        idx = i + 1
        output_path = os.path.join(bg_dir, f"bg_{idx}.jpg")

        for ext in ["jpg", "jpeg", "png", "webp", "gif", "mp4"]:
            old = os.path.join(bg_dir, f"bg_{idx}.{ext}")
            if os.path.exists(old):
                os.remove(old)

        try:
            p = prompts[i]
            en_p = p.get("en", p) if isinstance(p, dict) else p
            await asyncio.to_thread(
                generate_image, en_p, output_path,
                host=cfg["host"], port=cfg["port"]
            )
            results.append({"index": idx, "ok": True})
        except Exception as e:
            results.append({"index": idx, "ok": False, "error": str(e)})

    return {"results": results}


@app.post("/api/jobs/{job_id}/sd-generate-video/{index}")
async def api_sd_generate_video_single(job_id: str, index: int, request: Request):
    """개별 슬롯 AnimateDiff 영상 생성"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")

    cfg = config.comfyui_cfg()
    if not sd_check_available(cfg["host"], cfg["port"]):
        raise HTTPException(503, "ComfyUI 서버가 실행 중이 아닙니다")

    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    prompt = body.get("prompt", "")

    if not prompt:
        meta = json.loads(job["meta_json"]) if job.get("meta_json") else {}
        prompts = meta.get("sd_prompts", []) or meta.get("image_prompts", [])
        idx = index - 1
        if idx < len(prompts):
            p = prompts[idx]
            prompt = p.get("en", p) if isinstance(p, dict) else p

    if not prompt:
        raise HTTPException(400, "프롬프트가 없습니다.")

    seed = body.get("seed", -1)
    frames = body.get("frames", 16)

    bg_dir = os.path.join(config.output_dir(), job_id, "backgrounds")
    output_path = os.path.join(bg_dir, f"bg_{index}.mp4")

    for ext in ["jpg", "jpeg", "png", "webp", "gif", "mp4"]:
        old = os.path.join(bg_dir, f"bg_{index}.{ext}")
        if os.path.exists(old):
            os.remove(old)

    await asyncio.to_thread(
        generate_video, prompt, output_path,
        seed=seed, frames=frames, host=cfg["host"], port=cfg["port"]
    )

    return {"ok": True, "index": index, "path": f"/api/jobs/{job_id}/backgrounds/bg_{index}.mp4"}


@app.post("/api/jobs/{job_id}/sd-generate-video")
async def api_sd_generate_video_all(job_id: str):
    """전체 슬롯 AnimateDiff 영상 일괄 생성"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")

    cfg = config.comfyui_cfg()
    if not sd_check_available(cfg["host"], cfg["port"]):
        raise HTTPException(503, "ComfyUI 서버가 실행 중이 아닙니다")

    meta = json.loads(job["meta_json"]) if job.get("meta_json") else {}
    prompts = meta.get("sd_prompts", []) or meta.get("image_prompts", [])
    if not prompts:
        raise HTTPException(400, "프롬프트가 없습니다.")

    script = json.loads(job["script_json"])
    bg_count = len(script.get("slides", [])) - 1

    bg_dir = os.path.join(config.output_dir(), job_id, "backgrounds")
    results = []

    for i in range(min(len(prompts), bg_count)):
        idx = i + 1
        output_path = os.path.join(bg_dir, f"bg_{idx}.mp4")

        for ext in ["jpg", "jpeg", "png", "webp", "gif", "mp4"]:
            old = os.path.join(bg_dir, f"bg_{idx}.{ext}")
            if os.path.exists(old):
                os.remove(old)

        try:
            p = prompts[i]
            en_p = p.get("en", p) if isinstance(p, dict) else p
            await asyncio.to_thread(
                generate_video, en_p, output_path,
                host=cfg["host"], port=cfg["port"]
            )
            results.append({"index": idx, "ok": True})
        except Exception as e:
            results.append({"index": idx, "ok": False, "error": str(e)})

    return {"results": results}


@app.post("/api/jobs/{job_id}/sd-generate-auto")
async def api_sd_generate_auto(job_id: str):
    """bg_type에 따라 이미지/영상 자동 생성 — Gemini/SD/graph 라우팅"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")

    meta = json.loads(job["meta_json"]) if job.get("meta_json") else {}
    prompts = meta.get("sd_prompts", []) or meta.get("image_prompts", [])
    if not prompts:
        raise HTTPException(400, "프롬프트가 없습니다. 먼저 프롬프트를 생성하세요.")

    script = json.loads(job["script_json"])
    slides = script.get("slides", [])
    sentences = script.get("sentences", [])
    bg_count = len(slides) - 1  # closing 제외

    # 채널 config
    channel = db_ch.fetchone("SELECT config FROM channels WHERE id = ?", [job["channel_id"]])
    ch_cfg = json.loads(channel.get("config", "{}")) if channel else {}
    slide_layout = ch_cfg.get("slide_layout", "full")
    auto_bg_source = ch_cfg.get("auto_bg_source", "sd_image")
    gemini_key = ch_cfg.get("gemini_api_key", "")

    # SD 사용 시 ComfyUI 체크
    use_sd = auto_bg_source in ("sd_image", "sd_video")
    if use_sd:
        comfyui_cfg = config.comfyui_cfg()
        if not sd_check_available(comfyui_cfg["host"], comfyui_cfg["port"]):
            raise HTTPException(503, "ComfyUI 서버가 실행 중이 아닙니다")

    # Gemini 사용 시 key 체크
    if auto_bg_source == "gemini" and not gemini_key:
        raise HTTPException(400, "Gemini API key가 채널 설정에 없습니다")

    bg_dir = os.path.join(config.output_dir(), job_id, "backgrounds")
    results = []
    full_text = " ".join(s["text"] for s in sentences)

    gemini_count = 0  # Gemini 요청 간 딜레이용 카운터
    for i in range(min(len(prompts), bg_count)):
        idx = i + 1
        slide = slides[i] if i < len(slides) else {}
        bg_type = slide.get("bg_type", "photo")

        # dict → 영어 프롬프트 문자열 추출
        raw_p = prompts[i]
        en_prompt = raw_p.get("en", raw_p) if isinstance(raw_p, dict) else raw_p

        # 기존 파일 정리
        for ext in ["jpg", "jpeg", "png", "webp", "gif", "mp4"]:
            old = os.path.join(bg_dir, f"bg_{idx}.{ext}")
            if os.path.exists(old):
                os.remove(old)
            # 썸네일도 정리
            old_thumb = os.path.join(bg_dir, f"bg_{idx}_thumb.{ext}")
            if os.path.exists(old_thumb):
                os.remove(old_thumb)

        try:
            if bg_type == "closing":
                results.append({"index": idx, "ok": True, "skipped": True, "bg_type": bg_type})
                continue

            elif auto_bg_source == "gemini":
                # Gemini 이미지 생성 — 레이아웃에 따라 비율 결정
                if not en_prompt:
                    results.append({"index": idx, "ok": True, "skipped": True, "bg_type": bg_type})
                    continue
                if gemini_count > 0:
                    await asyncio.sleep(5)  # Gemini 분당 요청 제한 대응
                _ar = "1:1" if slide_layout in ("center", "top", "bottom") else "9:16"
                output_path = os.path.join(bg_dir, f"bg_{idx}.png")
                await asyncio.to_thread(
                    gemini_gen_image, en_prompt, output_path, gemini_key,
                    _ar
                )
                gemini_count += 1

            elif bg_type == "graph":
                # SD 모드: graph → Claude 인포그래픽
                output_path = os.path.join(bg_dir, f"bg_{idx}.png")
                await asyncio.to_thread(
                    generate_infographic, slide, full_text, output_path,
                    1080, 960
                )

            elif auto_bg_source == "sd_video" or bg_type == "broll":
                # SD 영상 생성
                output_path = os.path.join(bg_dir, f"bg_{idx}.mp4")
                await asyncio.to_thread(
                    generate_video, en_prompt, output_path,
                    host=comfyui_cfg["host"], port=comfyui_cfg["port"],
                    layout=slide_layout
                )

            else:
                # SD 이미지 생성 (기본)
                output_path = os.path.join(bg_dir, f"bg_{idx}.jpg")
                await asyncio.to_thread(
                    generate_image, en_prompt, output_path,
                    host=comfyui_cfg["host"], port=comfyui_cfg["port"],
                    layout=slide_layout
                )

            results.append({"index": idx, "ok": True, "bg_type": bg_type})
        except Exception as e:
            results.append({"index": idx, "ok": False, "error": str(e), "bg_type": bg_type})

    return {"results": results}


@app.post("/api/jobs/{job_id}/rerender-slides")
async def api_rerender_slides(job_id: str):
    """배경 유지, 슬라이드만 재렌더링 (레이아웃 변경 시 사용)"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")

    script = json.loads(job["script_json"])
    slides_data = script.get("slides", [])
    date_str = script.get("date", "")

    channel = db_ch.fetchone("SELECT * FROM channels WHERE id = ?", [job["channel_id"]])
    brand = channel.get("name", "") if channel else ""
    ch_cfg = json.loads(channel.get("config", "{}")) if channel else {}
    slide_layout = ch_cfg.get("slide_layout", "full")

    job_dir = os.path.join(config.output_dir(), job_id)
    bg_dir = os.path.join(job_dir, "backgrounds")
    img_dir = os.path.join(job_dir, "images")

    # 기존 배경 로드
    bg_results = _load_uploaded_backgrounds(bg_dir, len(slides_data))

    # 슬라이드 재렌더링
    slide_paths = await asyncio.to_thread(
        generate_slides, slides_data, img_dir,
        date=date_str, brand=brand,
        backgrounds=bg_results, layout=slide_layout
    )

    return {"ok": True, "layout": slide_layout, "slides": len(slide_paths)}


@app.post("/api/jobs/{job_id}/retry")
async def api_retry_job(job_id: str):
    """실패한 작업 재시도 (Phase A 또는 Phase B)"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] != "failed":
        raise HTTPException(400, f"Job status is '{job['status']}', expected 'failed'")

    # 실패한 단계 확인
    failed_step = db.fetchone(
        "SELECT step_name FROM job_steps WHERE job_id = ? AND status = 'failed' ORDER BY id LIMIT 1",
        [job_id])
    failed_name = failed_step["step_name"] if failed_step else ""

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    if failed_name in ("news_search", "script") or not job.get("script_json"):
        # Phase A 실패 또는 script_json 없음 → Phase A 재실행
        db.execute("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
                   ["pending", now, job_id])
        db.execute(
            "UPDATE job_steps SET status = 'pending', error_msg = NULL, output_data = NULL, started_at = NULL, completed_at = NULL WHERE job_id = ? AND step_name IN ('news_search', 'script')",
            [job_id])
        start_pipeline(db_ch, db, job_id)
        return {"ok": True, "message": "Phase A retry started"}
    else:
        # Phase B 실패 → waiting_slides로 되돌린 후 resume
        db.execute("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
                   ["waiting_slides", now, job_id])
        db.execute(
            "UPDATE job_steps SET status = 'pending', error_msg = NULL, output_data = NULL, started_at = NULL, completed_at = NULL WHERE job_id = ? AND step_name IN ('slides', 'tts', 'render', 'qa', 'upload')",
            [job_id])

        # 기존 오디오 삭제 (재생성)
        audio_dir = os.path.join(config.output_dir(), job_id, "audio")
        if os.path.isdir(audio_dir):
            shutil.rmtree(audio_dir, ignore_errors=True)

        resume_pipeline(db_ch, db, job_id)
        return {"ok": True, "message": "Phase B retry queued"}


@app.post("/api/jobs/{job_id}/reset")
async def api_reset_job(job_id: str):
    """실패한 작업을 이미지 대기 상태로 되돌리기"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] not in ("failed", "completed"):
        raise HTTPException(400, f"Job status is '{job['status']}'")

    db.execute("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
               ["waiting_slides", datetime.now().strftime("%Y-%m-%d %H:%M:%S"), job_id])
    db.execute(
        "UPDATE job_steps SET status = 'pending', error_msg = NULL, output_data = NULL, started_at = NULL, completed_at = NULL WHERE job_id = ? AND step_name IN ('slides', 'tts', 'render', 'qa', 'upload')",
        [job_id])

    # 기존 슬라이드/오디오/영상 삭제 (재생성)
    job_out = os.path.join(config.output_dir(), job_id)
    for sub in ("images", "audio", "video", "segments"):
        d = os.path.join(job_out, sub)
        if os.path.isdir(d):
            shutil.rmtree(d, ignore_errors=True)

    return {"ok": True, "message": "Reset to waiting_slides"}


@app.post("/api/jobs/{job_id}/resume")
async def api_resume_job(job_id: str, request: Request):
    """Phase B 시작 (이미지 업로드 후 영상 제작 재개)"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] != "waiting_slides":
        raise HTTPException(400, f"Job status is '{job['status']}', expected 'waiting_slides'")

    # TTS 설정 (팝업에서 선택 — 엔진/음성/속도/GPT-SoVITS)
    tts_voice = ""
    tts_rate = None
    tts_engine = "edge-tts"
    sovits_override = None
    try:
        body = await request.json()
        tts_engine = body.get("tts_engine", "edge-tts")
        tts_voice = body.get("tts_voice", "")
        if body.get("tts_rate") is not None:
            tts_rate = int(body["tts_rate"])
        if tts_engine == "gpt-sovits" and body.get("sovits_ref_voice"):
            ref_voice = body["sovits_ref_voice"]
            voice_dir = os.path.join(config.root_dir(), "data", "ref_voices")
            ref_path = os.path.join(voice_dir, ref_voice)
            if os.path.exists(ref_path):
                sovits_override = {
                    "host": "127.0.0.1",
                    "port": 9880,
                    "ref_audio": ref_path,
                    "ref_text": body.get("sovits_ref_text", ""),
                    "speed": 1.0,
                }
    except Exception:
        pass

    resume_pipeline(db_ch, db, job_id, tts_voice=tts_voice, tts_rate=tts_rate,
                    tts_engine=tts_engine, sovits_cfg=sovits_override)
    return {"ok": True, "message": "Phase B queued"}


@app.get("/api/queue")
async def api_queue_status():
    """Phase B 큐 상태 조회"""
    return get_queue_status()


@app.get("/api/dashboard")
async def api_dashboard():
    """대시보드용 — 채널별 + job별 데이터"""
    channels = list_channels(db_ch, db)
    result = []
    for ch in channels:
        jobs = list_jobs(db, channel_id=ch["id"])
        total = len(jobs)
        completed = sum(1 for j in jobs if j["status"] == "completed")
        running = sum(1 for j in jobs if j["status"] == "running")
        failed = sum(1 for j in jobs if j["status"] == "failed")
        waiting = sum(1 for j in jobs if j["status"] == "waiting_slides")
        queued = sum(1 for j in jobs if j["status"] == "queued")

        # job별 상세 (카드용) + 단계별 집계 — 1회 쿼리로 통합
        job_cards = []
        steps_agg = {}
        for step_def in STEP_DEFINITIONS:
            steps_agg[step_def["name"]] = {
                "order": step_def["order"],
                "completed": 0, "running": 0,
                "failed": 0, "pending": 0, "skipped": 0,
            }
        for job in jobs:
            steps = get_job_steps(db, job["id"])
            steps_info = {}
            for s in steps:
                name = s["step_name"]
                st = s["status"] or "pending"
                steps_info[name] = st
                if name in steps_agg and st in steps_agg[name]:
                    steps_agg[name][st] += 1

            card = {
                "id": job["id"],
                "topic": job["topic"],
                "status": job["status"],
                "category": job.get("category", ""),
                "created_at": job.get("created_at", ""),
                "updated_at": job.get("updated_at", ""),
                "output_path": job.get("output_path", ""),
                "steps": steps_info,
            }
            if job["status"] == "queued":
                card["queue_position"] = get_queue_position(job["id"])
            if job["status"] == "waiting_slides":
                bg_dir = os.path.join(config.output_dir(), job["id"], "backgrounds")
                bg_count = 0
                if os.path.isdir(bg_dir):
                    bg_count = sum(1 for f in os.listdir(bg_dir)
                                   if any(f.lower().endswith(e) for e in
                                          (".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4")))
                card["uploaded_bg_count"] = bg_count
            job_cards.append(card)

        last_job = jobs[0] if jobs else None
        result.append({
            **ch,
            "total_jobs": total,
            "completed_jobs": completed,
            "running_jobs": running,
            "failed_jobs": failed,
            "waiting_jobs": waiting,
            "queued_jobs": queued,
            "steps": steps_agg,
            "jobs": job_cards,
            "last_created": last_job["created_at"] if last_job else None,
            "has_intro_bg": _find_channel_image(ch["id"], "intro_bg") is not None,
            "has_outro_bg": _find_channel_image(ch["id"], "outro_bg") is not None,
        })
    return result


@app.get("/api/bgm")
async def api_list_bgm():
    """data/bgm/ 폴더의 배경음악 목록"""
    bgm_dir = os.path.join(config.root_dir(), "data", "bgm")
    os.makedirs(bgm_dir, exist_ok=True)
    files = []
    for fname in sorted(os.listdir(bgm_dir)):
        if fname.lower().endswith((".mp3", ".wav", ".ogg", ".m4a")):
            files.append(fname)
    return files


@app.get("/api/bgm/{filename}")
async def api_get_bgm(filename: str):
    """배경음악 파일 서빙"""
    bgm_dir = os.path.join(config.root_dir(), "data", "bgm")
    path = os.path.join(bgm_dir, filename)
    if not os.path.exists(path):
        raise HTTPException(404, "BGM 파일이 없습니다")
    ext = filename.rsplit(".", 1)[-1].lower()
    return FileResponse(path, media_type=f"audio/{ext}")


@app.get("/api/sfx")
async def api_list_sfx():
    """data/sfx/ 폴더의 효과음 목록"""
    sfx_dir = os.path.join(config.root_dir(), "data", "sfx")
    os.makedirs(sfx_dir, exist_ok=True)
    files = []
    for fname in sorted(os.listdir(sfx_dir)):
        if fname.lower().endswith((".mp3", ".wav", ".ogg", ".m4a")):
            files.append(fname)
    return files


@app.get("/api/ref-voices")
async def api_list_ref_voices():
    """data/ref_voices/ 폴더의 참조 음성 목록"""
    voice_dir = os.path.join(config.root_dir(), "data", "ref_voices")
    os.makedirs(voice_dir, exist_ok=True)
    voices = []
    for fname in sorted(os.listdir(voice_dir)):
        if fname.lower().endswith((".mp3", ".wav", ".m4a", ".ogg")):
            fpath = os.path.join(voice_dir, fname)
            size_kb = round(os.path.getsize(fpath) / 1024, 1)
            name = fname.rsplit(".", 1)[0]
            voices.append({"filename": fname, "name": name, "size_kb": size_kb})
    return voices


@app.get("/api/sfx/{filename}")
async def api_get_sfx(filename: str):
    """효과음 파일 서빙"""
    sfx_dir = os.path.join(config.root_dir(), "data", "sfx")
    path = os.path.join(sfx_dir, filename)
    if not os.path.exists(path):
        raise HTTPException(404, "효과음 파일이 없습니다")
    ext = filename.rsplit(".", 1)[-1].lower()
    return FileResponse(path, media_type=f"audio/{ext}")


@app.get("/api/ref-voices/{filename}")
async def api_get_ref_voice(filename: str):
    """참조 음성 파일 서빙"""
    voice_dir = os.path.join(config.root_dir(), "data", "ref_voices")
    path = os.path.join(voice_dir, filename)
    if not os.path.exists(path):
        raise HTTPException(404, "참조 음성 파일이 없습니다")
    ext = filename.rsplit(".", 1)[-1].lower()
    return FileResponse(path, media_type=f"audio/{ext}")


@app.post("/api/ref-voices")
async def api_upload_ref_voice(file: UploadFile = File(...)):
    """참조 음성 파일 추가 업로드"""
    voice_dir = os.path.join(config.root_dir(), "data", "ref_voices")
    os.makedirs(voice_dir, exist_ok=True)

    original = file.filename or "voice.mp3"
    out_path = os.path.join(voice_dir, original)
    content = await file.read()
    with open(out_path, "wb") as f:
        f.write(content)
    return {"filename": original, "size_kb": round(len(content) / 1024, 1)}


@app.get("/api/tts/preview")
async def api_tts_preview(voice: str = "ko-KR-SunHiNeural", rate: int = 0):
    """TTS 음성 미리듣기용 샘플 생성 (Edge TTS / Google Cloud TTS)"""
    from pipeline.tts_generator import GOOGLE_CLOUD_VOICES, _get_google_tts_token
    import base64

    sample_text = "오늘의 핵심 뉴스를 60초로 전해드립니다."
    preview_dir = os.path.join(config.root_dir(), "data", "tts_preview")
    os.makedirs(preview_dir, exist_ok=True)

    cache_name = f"{voice}_r{rate}.mp3" if rate != 0 else f"{voice}.mp3"
    out_path = os.path.join(preview_dir, cache_name)

    if not os.path.exists(out_path):
        if voice in GOOGLE_CLOUD_VOICES:
            import requests as http_requests
            try:
                token = _get_google_tts_token()
            except RuntimeError as e:
                raise HTTPException(400, str(e))
            speaking_rate = 1.0 + rate / 100.0
            speaking_rate = max(0.25, min(4.0, speaking_rate))
            resp = http_requests.post(
                "https://texttospeech.googleapis.com/v1/text:synthesize",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "input": {"text": sample_text},
                    "voice": {"languageCode": "ko-KR", "name": voice},
                    "audioConfig": {"audioEncoding": "MP3", "speakingRate": speaking_rate},
                },
                timeout=15,
            )
            if resp.status_code != 200:
                raise HTTPException(502, f"Google Cloud TTS 오류: {resp.text[:200]}")
            audio_bytes = base64.b64decode(resp.json()["audioContent"])
            with open(out_path, "wb") as f:
                f.write(audio_bytes)
        else:
            import edge_tts
            rate_str = f"+{rate}%" if rate >= 0 else f"{rate}%"
            communicate = edge_tts.Communicate(sample_text, voice, rate=rate_str)
            await communicate.save(out_path)

    return FileResponse(out_path, media_type="audio/mpeg")


@app.post("/api/tts/preview-sovits")
async def api_tts_preview_sovits(request: Request):
    """GPT-SoVITS 미리듣기 — 참조 음성으로 샘플 생성"""
    import requests as http_requests

    body = await request.json()
    ref_voice = body.get("ref_voice", "")
    ref_text = body.get("ref_text", "")

    # ref_voices 폴더에서 참조 음성 경로
    ref_audio = ""
    if ref_voice:
        voice_dir = os.path.join(config.root_dir(), "data", "ref_voices")
        p = os.path.join(voice_dir, ref_voice)
        if os.path.exists(p):
            ref_audio = p

    if not ref_audio:
        raise HTTPException(400, "참조 음성을 선택하세요")

    sample_text = "오늘의 핵심 뉴스를 60초로 전해드립니다."

    def _call_sovits():
        resp = http_requests.post("http://127.0.0.1:9880/tts", json={
            "text": sample_text,
            "text_lang": "ko",
            "ref_audio_path": ref_audio,
            "prompt_text": ref_text,
            "prompt_lang": "ko",
            "text_split_method": "cut5",
            "media_type": "wav",
        }, timeout=60)
        if resp.status_code != 200:
            raise RuntimeError(f"GPT-SoVITS 오류: {resp.text[:200]}")
        return resp.content

    audio_data = await asyncio.to_thread(_call_sovits)

    preview_dir = os.path.join(config.root_dir(), "data", "tts_preview")
    os.makedirs(preview_dir, exist_ok=True)
    cache_name = ref_voice.rsplit(".", 1)[0] if ref_voice else "default"
    out_path = os.path.join(preview_dir, f"sovits_{cache_name}.wav")
    with open(out_path, "wb") as f:
        f.write(audio_data)

    return FileResponse(out_path, media_type="audio/wav")


@app.get("/api/sovits/status")
async def api_sovits_status():
    """GPT-SoVITS 서버 연결 상태"""
    from pipeline.tts_generator import check_sovits_available
    available = check_sovits_available()
    return {"available": available}


@app.post("/api/oauth/youtube")
async def api_oauth_youtube(request: Request):
    """브라우저에서 OAuth 인증 → Refresh Token 반환"""
    from google_auth_oauthlib.flow import Flow

    body = await request.json()
    client_id = body.get("client_id", "").strip()
    client_secret = body.get("client_secret", "").strip()
    if not client_id or not client_secret:
        raise HTTPException(400, "client_id와 client_secret이 필요합니다")

    client_config = {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost"]
        }
    }

    def run_oauth():
        flow = Flow.from_client_config(
            client_config,
            scopes=["https://www.googleapis.com/auth/youtube.upload"],
            redirect_uri="http://localhost:8090/"
        )
        auth_url, _ = flow.authorization_url(
            access_type="offline", prompt="consent"
        )
        import webbrowser
        webbrowser.open(auth_url)

        # 로컬 서버로 code 수신
        from http.server import HTTPServer, BaseHTTPRequestHandler
        from urllib.parse import urlparse, parse_qs
        auth_code = None

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                nonlocal auth_code
                qs = parse_qs(urlparse(self.path).query)
                auth_code = qs.get("code", [None])[0]
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write("✅ 인증 완료! 이 창을 닫아도 됩니다.".encode("utf-8"))

            def log_message(self, *args):
                pass

        server = HTTPServer(("localhost", 8090), Handler)
        server.timeout = 120
        server.handle_request()
        server.server_close()

        if not auth_code:
            raise RuntimeError("인증 코드를 받지 못했습니다")

        flow.fetch_token(code=auth_code)
        return flow.credentials.refresh_token

    token = await asyncio.to_thread(run_oauth)
    return {"refresh_token": token}


@app.delete("/api/jobs/{job_id}")
async def api_delete_job(job_id: str):
    job = get_job(db, job_id)
    if not job:
        raise HTTPException(404, "Job not found")

    # 디스크 파일 삭제
    job_dir = os.path.join(config.output_dir(), job_id)
    if os.path.isdir(job_dir):
        shutil.rmtree(job_dir, ignore_errors=True)

    if job.get("status") == "completed":
        # 완료된 작업: 소프트 삭제 (중복 필터용 topic 유지)
        db.execute(
            "UPDATE jobs SET status = 'deleted', updated_at = ? WHERE id = ?",
            [datetime.now().strftime("%Y-%m-%d %H:%M:%S"), job_id]
        )
    else:
        # 완료 전 작업: DB에서 완전 삭제
        delete_job(db, job_id)

    return {"ok": True}


@app.get("/api/jobs/{job_id}/video")
async def api_get_video(job_id: str):
    """완성된 영상 파일 서빙"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job or not job.get("output_path"):
        raise HTTPException(404, "Video not found")
    if not os.path.exists(job["output_path"]):
        raise HTTPException(404, "Video file not found")
    return FileResponse(job["output_path"], media_type="video/mp4")


@app.get("/api/channels-db")
async def api_export_channels_db():
    """channels.db 다운로드 (WAL 체크포인트 후 단일 파일)"""
    db_ch.checkpoint()
    return FileResponse(config.channels_db_path(),
                        media_type="application/octet-stream",
                        filename="channels.db")


if __name__ == "__main__":
    cfg = config.load()
    uvicorn.run(app,
                host=cfg["server"]["host"],
                port=cfg["server"]["port"])
