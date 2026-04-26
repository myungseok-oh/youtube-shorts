"""Channel, Job, JobStep 모델 헬퍼"""
from __future__ import annotations
import json
import os
from datetime import datetime

from pipeline.runner import STEP_DEFINITIONS

# 채널 config 중 git에 올리지 않을 시크릿 키 (별도 JSON 파일에 저장)
SECRET_KEYS = {
    "gemini_api_key",
    "youtube_api_key",
    "youtube_client_id",
    "youtube_client_secret",
    "youtube_refresh_token",
}

SECRETS_PATH = os.path.join("data", "channel_secrets.json")


def _load_secrets() -> dict:
    if not os.path.exists(SECRETS_PATH):
        return {}
    try:
        with open(SECRETS_PATH, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except (json.JSONDecodeError, OSError):
        return {}


def _save_secrets(secrets: dict) -> None:
    os.makedirs(os.path.dirname(SECRETS_PATH), exist_ok=True)
    with open(SECRETS_PATH, "w", encoding="utf-8") as f:
        json.dump(secrets, f, ensure_ascii=False, indent=2)


def _split_config(cfg: dict) -> tuple[dict, dict]:
    """config dict를 (public, secret) 쌍으로 분리."""
    public = {k: v for k, v in cfg.items() if k not in SECRET_KEYS}
    secret = {k: v for k, v in cfg.items() if k in SECRET_KEYS and v not in (None, "")}
    return public, secret


def _merge_secrets_into_channel(ch: dict, secrets_cache: dict = None) -> dict:
    """채널 row의 config에 시크릿 JSON을 머지."""
    if not ch:
        return ch
    secrets = secrets_cache if secrets_cache is not None else _load_secrets()
    cfg_str = ch.get("config") or "{}"
    try:
        cfg = json.loads(cfg_str)
    except (json.JSONDecodeError, TypeError):
        cfg = {}
    cfg.update(secrets.get(ch["id"], {}))
    ch["config"] = json.dumps(cfg, ensure_ascii=False)
    return ch


def _now():
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _next_channel_id(db_ch) -> str:
    row = db_ch.fetchone("SELECT COUNT(*) as cnt FROM channels")
    n = (row["cnt"] if row else 0) + 1
    return f"ch-{n:04d}"


def _next_job_id(db) -> str:
    date_str = datetime.now().strftime("%Y%m%d")
    row = db.fetchone(
        "SELECT MAX(CAST(SUBSTR(id, -3) AS INTEGER)) as max_n FROM jobs WHERE id LIKE ?",
        [f"job-{date_str}-%"]
    )
    n = (row["max_n"] if row and row["max_n"] else 0) + 1
    return f"job-{date_str}-{n:03d}"


# --- Channel ---

def create_channel(db_ch, name: str, handle: str = "",
                   description: str = "", instructions: str = "",
                   default_topics: str = "", cfg: dict = None) -> dict:
    cid = _next_channel_id(db_ch)
    public_cfg, secret_cfg = _split_config(cfg or {})
    data = {
        "id": cid,
        "name": name,
        "handle": handle,
        "description": description,
        "instructions": instructions,
        "default_topics": default_topics,
        "config": json.dumps(public_cfg, ensure_ascii=False),
    }
    db_ch.insert("channels", data)
    if secret_cfg:
        secrets = _load_secrets()
        secrets[cid] = secret_cfg
        _save_secrets(secrets)
    row = db_ch.fetchone("SELECT * FROM channels WHERE id = ?", [cid])
    return _merge_secrets_into_channel(row)


def list_channels(db_ch, db) -> list[dict]:
    channels = db_ch.fetchall("SELECT * FROM channels ORDER BY CAST(COALESCE(sort_order, '0') AS INTEGER), created_at")
    secrets = _load_secrets()
    for ch in channels:
        _merge_secrets_into_channel(ch, secrets)
        cnt = db.fetchone(
            "SELECT COUNT(*) as cnt FROM jobs WHERE channel_id = ?",
            [ch["id"]]
        )
        ch["job_count"] = cnt["cnt"] if cnt else 0
    return channels


def get_channel(db_ch, channel_id: str) -> dict | None:
    row = db_ch.fetchone("SELECT * FROM channels WHERE id = ?", [channel_id])
    return _merge_secrets_into_channel(row) if row else None


def update_channel(db_ch, channel_id: str, **kwargs) -> dict | None:
    allowed = {"name", "handle", "description", "instructions", "default_topics", "config"}
    updates = {k: v for k, v in kwargs.items() if k in allowed and v is not None}

    # config가 들어오면 시크릿을 분리해서 별도 저장
    if "config" in updates:
        try:
            cfg = json.loads(updates["config"]) if isinstance(updates["config"], str) else dict(updates["config"])
        except (json.JSONDecodeError, TypeError):
            cfg = {}
        public_cfg, secret_cfg = _split_config(cfg)
        updates["config"] = json.dumps(public_cfg, ensure_ascii=False)

        secrets = _load_secrets()
        existing = secrets.get(channel_id, {})
        # 시크릿 키가 config에 포함된 경우만 갱신 (전체 덮어쓰기)
        existing.update(secret_cfg)
        # 빈 값으로 들어온 시크릿은 제거
        for k in SECRET_KEYS:
            if k in cfg and cfg[k] in (None, ""):
                existing.pop(k, None)
        if existing:
            secrets[channel_id] = existing
        else:
            secrets.pop(channel_id, None)
        _save_secrets(secrets)

    if updates:
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        db_ch.execute(
            f"UPDATE channels SET {set_clause} WHERE id = ?",
            list(updates.values()) + [channel_id]
        )
    return get_channel(db_ch, channel_id)


def delete_channel(db_ch, db, channel_id: str):
    db.execute("DELETE FROM job_steps WHERE job_id IN (SELECT id FROM jobs WHERE channel_id = ?)",
               [channel_id])
    db.execute("DELETE FROM jobs WHERE channel_id = ?", [channel_id])
    db_ch.execute("DELETE FROM channels WHERE id = ?", [channel_id])
    secrets = _load_secrets()
    if secrets.pop(channel_id, None) is not None:
        _save_secrets(secrets)


# --- Job ---

def create_job(db, channel_id: str, topic: str, category: str = "",
               script_json: dict = None) -> dict:
    jid = _next_job_id(db)
    data = {
        "id": jid,
        "channel_id": channel_id,
        "topic": topic,
        "category": category,
        "status": "pending",
        "script_json": json.dumps(script_json, ensure_ascii=False) if script_json else None,
    }
    db.insert("jobs", data)

    # 파이프라인 단계 초기화
    for step in STEP_DEFINITIONS:
        db.insert("job_steps", {
            "job_id": jid,
            "step_name": step["name"],
            "step_order": step["order"],
            "status": "pending",
        })

    return db.fetchone("SELECT * FROM jobs WHERE id = ?", [jid])


def list_jobs(db, channel_id: str = None, status: str = None,
              include_deleted: bool = False) -> list[dict]:
    sql = "SELECT * FROM jobs WHERE 1=1"
    params = []
    if not include_deleted:
        sql += " AND status != 'deleted'"
    if channel_id:
        sql += " AND channel_id = ?"
        params.append(channel_id)
    if status:
        sql += " AND status = ?"
        params.append(status)
    sql += " ORDER BY created_at DESC"
    return db.fetchall(sql, params)


def get_job(db, job_id: str) -> dict | None:
    job = db.fetchone("SELECT * FROM jobs WHERE id = ?", [job_id])
    if job:
        job["steps"] = get_job_steps(db, job_id)
    return job


def get_job_steps(db, job_id: str) -> list[dict]:
    return db.fetchall(
        "SELECT * FROM job_steps WHERE job_id = ? ORDER BY step_order",
        [job_id]
    )


def delete_job(db, job_id: str):
    db.execute("DELETE FROM job_steps WHERE job_id = ?", [job_id])
    db.execute("DELETE FROM jobs WHERE id = ?", [job_id])


# --- Topic History (channels.db — 머신 간 이식 가능한 주제 중복 검사) ---

def record_topic(db_ch, channel_id: str, topic: str):
    """주제를 topic_history에 기록."""
    db_ch.insert("topic_history", {
        "channel_id": channel_id,
        "topic": topic,
    })


def get_recent_topics(db_ch, channel_ids: list, hours: int = 24,
                      limit: int = 50) -> list[str]:
    """최근 N시간 내 주제 목록 반환 (중복 체크용).
    hours=0 이면 전체 기간 검색 (교양/상식 채널용)."""
    if not channel_ids:
        return []
    ph = ",".join("?" for _ in channel_ids)
    if hours > 0:
        rows = db_ch.fetchall(
            f"SELECT topic FROM topic_history "
            f"WHERE channel_id IN ({ph}) "
            f"AND created_at >= datetime('now', 'localtime', '-{hours} hours') "
            f"ORDER BY created_at DESC LIMIT ?",
            channel_ids + [limit]
        )
    else:
        # 전체 기간 (교양/상식 채널 — 주제 재사용 방지)
        rows = db_ch.fetchall(
            f"SELECT topic FROM topic_history "
            f"WHERE channel_id IN ({ph}) "
            f"ORDER BY created_at DESC LIMIT ?",
            channel_ids + [limit]
        )
    return [r["topic"] for r in rows] if rows else []
