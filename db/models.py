"""Channel, Job, JobStep 모델 헬퍼"""
from __future__ import annotations
import json
from datetime import datetime

from pipeline.runner import STEP_DEFINITIONS


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
    data = {
        "id": cid,
        "name": name,
        "handle": handle,
        "description": description,
        "instructions": instructions,
        "default_topics": default_topics,
        "config": json.dumps(cfg or {}, ensure_ascii=False),
    }
    db_ch.insert("channels", data)
    return db_ch.fetchone("SELECT * FROM channels WHERE id = ?", [cid])


def list_channels(db_ch, db) -> list[dict]:
    channels = db_ch.fetchall("SELECT * FROM channels ORDER BY CAST(COALESCE(sort_order, '0') AS INTEGER), created_at")
    for ch in channels:
        cnt = db.fetchone(
            "SELECT COUNT(*) as cnt FROM jobs WHERE channel_id = ?",
            [ch["id"]]
        )
        ch["job_count"] = cnt["cnt"] if cnt else 0
    return channels


def get_channel(db_ch, channel_id: str) -> dict | None:
    return db_ch.fetchone("SELECT * FROM channels WHERE id = ?", [channel_id])


def update_channel(db_ch, channel_id: str, **kwargs) -> dict | None:
    allowed = {"name", "handle", "description", "instructions", "default_topics", "config"}
    updates = {k: v for k, v in kwargs.items() if k in allowed and v is not None}
    if not updates:
        return get_channel(db_ch, channel_id)
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
