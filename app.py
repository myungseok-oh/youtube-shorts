"""이슈60초 — FastAPI 백엔드"""
import json
import asyncio
import os
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
from pipeline.trend_collector import collect_trends, format_trend_context
from pipeline.sd_generator import (
    generate_image, generate_video, generate_sd_prompts, generate_all_prompts,
    agent_generate_image,
    check_available as sd_check_available,
)
from pipeline.slide_generator import generate_slides, generate_chart, generate_infographic
from pipeline.gemini_generator import generate_image as gemini_gen_image

db = Database(config.db_path())

DEFAULT_INSTRUCTIONS = """\
# 유튜브 쇼츠 뉴스 브리핑 에이전트 - 이슈60초

너는 유튜브 쇼츠 뉴스 영상 제작 전문가야.
주어진 주제에 대해 최신 뉴스를 검색/분석해서
60초 쇼츠 뉴스 브리핑 영상을 만들어줘.

## 채널 정보
- 채널명: 이슈60초
- 컨셉: 바쁜 현대인을 위한 60초 핵심 뉴스 브리핑
- 톤: 깔끔하고 신뢰감 있는 뉴스 앵커 스타일
- 타겟: 20~50대 직장인

## 주제 선정 방식
- 트렌드 데이터(Google Trends, YouTube Trending)가 함께 제공될 수 있음
- 트렌드 데이터가 있으면 해당 데이터에서 요청 카테고리에 맞는 주제를 우선 선정
- 트렌드 데이터가 없으면 웹 검색으로 직접 오늘의 화제 뉴스를 찾아서 선정

## 대본 구조 (60초) — 하나의 기사를 논리적으로 전개
하나의 뉴스 기사를 아래 흐름으로 풀어낸다. 각 슬라이드는 독립된 주제가 아니라 같은 기사의 다른 측면이다.
- [0~3초] 훅: 충격적 사실 or 핵심 수치로 시작 (시청자 주목)
- [3~15초] 핵심 요약: 무슨 일이 일어났는지 한마디로
- [15~35초] 원인/배경 → 영향/파장: 왜 일어났는지, 어떤 파급이 있는지
- [35~55초] 전망/의미: 앞으로 어떻게 될 것인지, 전문가 의견
- [55~60초] 마무리: 짧은 마무리 멘트
- 슬라이드 사이는 자연스럽게 연결 ("이런 가운데", "그 배경에는", "전문가들은" 등)
- 처음부터 끝까지 이어 읽으면 하나의 완결된 뉴스 내레이션이 되어야 함

## 대본 규칙
- 존댓말 기반이되, 문장 끝을 다양하게: ~입니다, ~인데요, ~한 상황, ~일까요?, ~됩니다, ~했는데요
- "~습니다"만 반복 금지. 3문장 연속 같은 어미 사용하지 않기
- 한 문장 20자 이내
- 수치/데이터 1개 이상 포함
- 감정적 표현 자제, 팩트 중심

## 영상 조건
- 길이: 50~60초
- 비율: 9:16 세로

## 제목: 40자 이내
## 해시태그: #이슈60초 #오늘뉴스 #경제뉴스 #국제뉴스 #쇼츠뉴스 + 주제별 5개
## 설명: 100자 이내
"""


@asynccontextmanager
async def lifespan(app):
    channels = list_channels(db)
    if not channels:
        create_channel(db, name="이슈60초", handle="@issue60sec",
                       description="60초 뉴스 브리핑",
                       instructions=DEFAULT_INSTRUCTIONS,
                       default_topics="오늘 경제/국제 뉴스 3개 만들어줘")
    else:
        # 기존 채널의 지침이 구버전이면 자동 업데이트
        for ch in channels:
            old = ch.get("instructions", "")
            if old and "한 문장 20자 이내" in old and "문장 끝을 다양하게" not in old:
                update_channel(db, ch["id"], instructions=DEFAULT_INSTRUCTIONS)
    yield

app = FastAPI(title="이슈60초", version="1.0.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


# ─── Dashboard ───

@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    channels = list_channels(db)
    return templates.TemplateResponse("dashboard.html", {
        "request": request,
        "channels": channels,
        "step_definitions": STEP_DEFINITIONS,
    })


# ─── Channel API ───

@app.get("/api/channels")
async def api_list_channels():
    return list_channels(db)


@app.post("/api/channels")
async def api_create_channel(request: Request):
    body = await request.json()
    name = body.get("name")
    if not name:
        raise HTTPException(400, "name is required")
    ch = create_channel(
        db, name=name,
        handle=body.get("handle", ""),
        description=body.get("description", ""),
        instructions=body.get("instructions", ""),
        cfg=body.get("config"),
    )
    return ch


@app.post("/api/channels/{channel_id}/clone")
async def api_clone_channel(channel_id: str):
    """기존 채널을 복사하여 새 채널 생성 (원본 채널만 가능)"""
    src = get_channel(db, channel_id)
    if not src:
        raise HTTPException(404, "Channel not found")
    if src.get("cloned_from"):
        raise HTTPException(400, "복사된 채널은 다시 복사할 수 없습니다. 원본 채널에서 복사하세요.")
    src_cfg = json.loads(src.get("config", "{}"))
    clone = create_channel(
        db,
        name=f"{src['name']} (복사)",
        handle=src.get("handle", ""),
        description=src.get("description", ""),
        instructions=src.get("instructions", ""),
        default_topics=src.get("default_topics", ""),
        cfg=src_cfg,
    )
    # cloned_from 기록
    db.execute("UPDATE channels SET cloned_from = ? WHERE id = ?", [channel_id, clone["id"]])
    clone["cloned_from"] = channel_id
    return clone


@app.put("/api/channels/reorder")
async def api_reorder_channels(request: Request):
    """채널 순서 변경"""
    body = await request.json()
    order = body.get("order", [])  # [channel_id, ...]
    for i, cid in enumerate(order):
        db.execute("UPDATE channels SET sort_order = ? WHERE id = ?", [i, cid])
    return {"ok": True}


@app.put("/api/channels/{channel_id}")
async def api_update_channel(channel_id: str, request: Request):
    if not get_channel(db, channel_id):
        raise HTTPException(404, "Channel not found")
    body = await request.json()
    return update_channel(db, channel_id, **body)


@app.delete("/api/channels/{channel_id}")
async def api_delete_channel(channel_id: str):
    if not get_channel(db, channel_id):
        raise HTTPException(404, "Channel not found")
    delete_channel(db, channel_id)
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
    if not get_channel(db, channel_id):
        raise HTTPException(404, "Channel not found")

    job = create_job(
        db, channel_id=channel_id,
        topic=topic,
        category=body.get("category", ""),
        script_json=script_json,
    )

    # script_json이 있으면 원스탑 파이프라인
    if script_json:
        start_pipeline_full(db, job["id"], script_json)

    return job


@app.post("/api/channels/{channel_id}/run")
async def api_run_channel(channel_id: str):
    """채널의 요청을 Claude가 해석 → 주제별 작업 생성 → Phase A (대본까지)"""
    import traceback, asyncio

    ch = get_channel(db, channel_id)
    if not ch:
        raise HTTPException(404, "Channel not found")
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

        # 동기 함수를 스레드에서 실행 (이벤트 루프 블록 방지)
        topics = await asyncio.to_thread(
            parse_request, request_text, instructions,
            trend_context=trend_context, recent_topics=recent_topics
        )

        production_mode = cfg.get("production_mode", "manual")
        channel_format = cfg.get("format", "single")

        jobs = []
        if channel_format == "roundup" and len(topics) > 1:
            # 라운드업: 여러 주제를 하나의 Job으로 합침
            combined_topic = " / ".join(topics)
            job = create_job(db, channel_id=channel_id, topic=combined_topic)
            jobs.append(job)
            if production_mode == "auto":
                start_pipeline_full(db, job["id"])
            else:
                start_pipeline(db, job["id"])
        else:
            for topic in topics:
                job = create_job(db, channel_id=channel_id, topic=topic)
                jobs.append(job)
                if production_mode == "auto":
                    start_pipeline_full(db, job["id"])
                else:
                    start_pipeline(db, job["id"])
        return {"created": len(jobs), "jobs": jobs, "mode": production_mode}

    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, detail=str(e))


@app.get("/api/channels/{channel_id}/trends")
async def api_get_channel_trends(channel_id: str):
    """트렌드 미리보기 — 채널 설정의 소스로 수집"""
    ch = get_channel(db, channel_id)
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
    channel = db.fetchone("SELECT config FROM channels WHERE id = ?", [job.get("channel_id", "")])
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

    channel = db.fetchone("SELECT * FROM channels WHERE id = ?", [job.get("channel_id", "")])
    brand = channel["name"] if channel else "이슈60초"

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

    channel = db.fetchone("SELECT * FROM channels WHERE id = ?", [job["channel_id"]])
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

    thumb_path = os.path.join(job_dir, "thumbnail.png")

    try:
        result = await asyncio.to_thread(
            upload_video,
            video_path=final_path,
            title=meta["title"][:100],
            description=meta["description"],
            tags=meta.get("tags", []),
            client_id=yt_client_id,
            client_secret=yt_client_secret,
            refresh_token=yt_refresh_token,
            privacy_status=yt_privacy,
            thumbnail_path=thumb_path if os.path.isfile(thumb_path) else "",
        )
    except Exception as e:
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

    channel = db.fetchone("SELECT config FROM channels WHERE id = ?", [job["channel_id"]])
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
    channel = db.fetchone("SELECT config FROM channels WHERE id = ?", [job["channel_id"]])
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
            await asyncio.to_thread(
                generate_video, prompts[i], output_path,
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
    channel = db.fetchone("SELECT config FROM channels WHERE id = ?", [job["channel_id"]])
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
                # Gemini 이미지 생성
                if not prompts[i]:
                    results.append({"index": idx, "ok": True, "skipped": True, "bg_type": bg_type})
                    continue
                if gemini_count > 0:
                    await asyncio.sleep(5)  # Gemini 분당 요청 제한 대응
                output_path = os.path.join(bg_dir, f"bg_{idx}.png")
                await asyncio.to_thread(
                    gemini_gen_image, prompts[i], output_path, gemini_key,
                    "9:16"
                )
                gemini_count += 1

            elif bg_type == "graph" and auto_bg_source != "gemini":
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
                    generate_video, prompts[i], output_path,
                    host=comfyui_cfg["host"], port=comfyui_cfg["port"],
                    layout=slide_layout
                )

            else:
                # SD 이미지 생성 (기본)
                output_path = os.path.join(bg_dir, f"bg_{idx}.jpg")
                await asyncio.to_thread(
                    generate_image, prompts[i], output_path,
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

    channel = db.fetchone("SELECT * FROM channels WHERE id = ?", [job["channel_id"]])
    brand = channel.get("name", "이슈60초") if channel else "이슈60초"
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
    """실패한 작업 재시도 (Phase B 다시 실행)"""
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] != "failed":
        raise HTTPException(400, f"Job status is '{job['status']}', expected 'failed'")

    # 실패한 단계부터 재시작 → waiting_slides로 되돌린 후 resume
    db.execute("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
               ["waiting_slides", datetime.now().strftime("%Y-%m-%d %H:%M:%S"), job_id])
    # 실패/pending 단계 초기화
    db.execute(
        "UPDATE job_steps SET status = 'pending', error_msg = NULL, output_data = NULL, started_at = NULL, completed_at = NULL WHERE job_id = ? AND step_name IN ('tts', 'render', 'qa', 'upload')",
        [job_id])

    # 기존 오디오 삭제 (재생성)
    audio_dir = os.path.join(config.output_dir(), job_id, "audio")
    if os.path.isdir(audio_dir):
        import shutil
        shutil.rmtree(audio_dir, ignore_errors=True)

    resume_pipeline(db, job_id)
    return {"ok": True, "message": "Retry queued"}


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
        "UPDATE job_steps SET status = 'pending', error_msg = NULL, output_data = NULL, started_at = NULL, completed_at = NULL WHERE job_id = ? AND step_name IN ('tts', 'render', 'qa', 'upload')",
        [job_id])

    # 기존 오디오 삭제
    audio_dir = os.path.join(config.output_dir(), job_id, "audio")
    if os.path.isdir(audio_dir):
        import shutil
        shutil.rmtree(audio_dir, ignore_errors=True)

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

    resume_pipeline(db, job_id, tts_voice=tts_voice, tts_rate=tts_rate,
                    tts_engine=tts_engine, sovits_cfg=sovits_override)
    return {"ok": True, "message": "Phase B queued"}


@app.get("/api/queue")
async def api_queue_status():
    """Phase B 큐 상태 조회"""
    return get_queue_status()


@app.get("/api/dashboard")
async def api_dashboard():
    """대시보드용 — 채널별 + job별 데이터"""
    channels = list_channels(db)
    result = []
    for ch in channels:
        jobs = list_jobs(db, channel_id=ch["id"])
        total = len(jobs)
        completed = sum(1 for j in jobs if j["status"] == "completed")
        running = sum(1 for j in jobs if j["status"] == "running")
        failed = sum(1 for j in jobs if j["status"] == "failed")
        waiting = sum(1 for j in jobs if j["status"] == "waiting_slides")
        queued = sum(1 for j in jobs if j["status"] == "queued")

        # job별 상세 (카드용)
        job_cards = []
        for job in jobs:
            steps = get_job_steps(db, job["id"])
            steps_info = {}
            for s in steps:
                steps_info[s["step_name"]] = s["status"] or "pending"

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
            job_cards.append(card)

        # 파이프라인 단계별 집계 (기존 호환)
        steps_agg = {}
        for step_def in STEP_DEFINITIONS:
            steps_agg[step_def["name"]] = {
                "order": step_def["order"],
                "completed": 0, "running": 0,
                "failed": 0, "pending": 0, "skipped": 0,
            }
        for job in jobs:
            steps = get_job_steps(db, job["id"])
            for s in steps:
                name = s["step_name"]
                if name in steps_agg:
                    st = s["status"] or "pending"
                    if st in steps_agg[name]:
                        steps_agg[name][st] += 1

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
        })
    return result


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
    """TTS 음성 미리듣기용 샘플 생성 (Edge TTS)"""
    sample_text = "오늘의 핵심 뉴스를 60초로 전해드립니다."
    preview_dir = os.path.join(config.root_dir(), "data", "tts_preview")
    os.makedirs(preview_dir, exist_ok=True)

    cache_name = f"{voice}_r{rate}.mp3" if rate != 0 else f"{voice}.mp3"
    out_path = os.path.join(preview_dir, cache_name)

    if not os.path.exists(out_path):
        if voice == "gtts":
            from gtts import gTTS
            tts = gTTS(text=sample_text, lang="ko", slow=False)
            tts.save(out_path)
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
        "web": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost:8090/"]
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
    if not get_job(db, job_id):
        raise HTTPException(404, "Job not found")
    # 소프트 삭제: status를 deleted로 변경 (중복 필터용 topic 유지)
    db.execute(
        "UPDATE jobs SET status = 'deleted', updated_at = ? WHERE id = ?",
        [datetime.now().strftime("%Y-%m-%d %H:%M:%S"), job_id]
    )
    # 디스크 파일만 삭제
    job_dir = os.path.join(config.output_dir(), job_id)
    if os.path.isdir(job_dir):
        shutil.rmtree(job_dir, ignore_errors=True)
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


if __name__ == "__main__":
    cfg = config.load()
    uvicorn.run(app,
                host=cfg["server"]["host"],
                port=cfg["server"]["port"])
