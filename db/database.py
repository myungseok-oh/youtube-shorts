"""SQLite WAL 모드 래퍼 — 스레드 안전"""
from __future__ import annotations
import os
import sqlite3
import threading


class Database:
    def __init__(self, db_path: str):
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self._path = db_path
        self._local = threading.local()
        self._init_schema()

    def _get_conn(self) -> sqlite3.Connection:
        if not hasattr(self._local, "conn") or self._local.conn is None:
            conn = sqlite3.connect(self._path, check_same_thread=False, timeout=30)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=30000")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.row_factory = sqlite3.Row
            self._local.conn = conn
        return self._local.conn

    def _init_schema(self):
        conn = self._get_conn()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS channels (
                id              TEXT PRIMARY KEY,
                name            TEXT NOT NULL,
                handle          TEXT,
                description     TEXT,
                instructions    TEXT,
                default_topics  TEXT,
                config          TEXT,
                created_at      TEXT DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS jobs (
                id          TEXT PRIMARY KEY,
                channel_id  TEXT NOT NULL,
                topic       TEXT NOT NULL,
                category    TEXT,
                status      TEXT DEFAULT 'pending',
                script_json TEXT,
                output_path TEXT,
                created_at  TEXT DEFAULT (datetime('now','localtime')),
                updated_at  TEXT DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (channel_id) REFERENCES channels(id)
            );

            CREATE TABLE IF NOT EXISTS job_steps (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id       TEXT NOT NULL,
                step_name    TEXT NOT NULL,
                step_order   INTEGER NOT NULL,
                status       TEXT DEFAULT 'pending',
                started_at   TEXT,
                completed_at TEXT,
                output_data  TEXT,
                error_msg    TEXT,
                updated_at   TEXT DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (job_id) REFERENCES jobs(id)
            );
        """)
        conn.commit()

        # 마이그레이션: meta_json 컬럼 추가
        try:
            conn.execute("SELECT meta_json FROM jobs LIMIT 1")
        except sqlite3.OperationalError:
            conn.execute("ALTER TABLE jobs ADD COLUMN meta_json TEXT")
            conn.commit()

        # 마이그레이션: 기존 작업에 qa step 추가
        missing = conn.execute("""
            SELECT DISTINCT j.id FROM jobs j
            WHERE NOT EXISTS (
                SELECT 1 FROM job_steps js WHERE js.job_id = j.id AND js.step_name = 'qa'
            )
        """).fetchall()
        for row in missing:
            conn.execute(
                "INSERT INTO job_steps (job_id, step_name, step_order, status) VALUES (?, 'qa', 6, 'skipped')",
                [row[0]])
            # upload step_order도 7로 업데이트
            conn.execute(
                "UPDATE job_steps SET step_order = 7 WHERE job_id = ? AND step_name = 'upload'",
                [row[0]])
        if missing:
            conn.commit()

        # 마이그레이션: channels에 sort_order, cloned_from 컬럼 추가
        for col, default in [("sort_order", "0"), ("cloned_from", "NULL")]:
            try:
                conn.execute(f"SELECT {col} FROM channels LIMIT 1")
            except sqlite3.OperationalError:
                conn.execute(f"ALTER TABLE channels ADD COLUMN {col} TEXT DEFAULT {default}")
                conn.commit()

    def execute(self, sql: str, params=None):
        conn = self._get_conn()
        conn.execute(sql, params or [])
        conn.commit()

    def fetchone(self, sql: str, params=None) -> dict | None:
        conn = self._get_conn()
        row = conn.execute(sql, params or []).fetchone()
        return dict(row) if row else None

    def fetchall(self, sql: str, params=None) -> list[dict]:
        conn = self._get_conn()
        rows = conn.execute(sql, params or []).fetchall()
        return [dict(r) for r in rows]

    def insert(self, table: str, data: dict):
        cols = ", ".join(data.keys())
        placeholders = ", ".join("?" for _ in data)
        sql = f"INSERT INTO {table} ({cols}) VALUES ({placeholders})"
        self.execute(sql, list(data.values()))

    def checkpoint(self):
        """WAL을 메인 DB 파일로 플러시. 복사 전 호출하면 .db 파일만으로 완전."""
        conn = self._get_conn()
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
