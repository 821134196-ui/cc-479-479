"""SQLite 连接与建表。

车辆与租借均采用「当前状态 + 事件流」双写：
- *_state 表保存最新状态，便于查询；
- vehicle_events / rental_events 记录每一次变更，便于追溯与对账。
"""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS service_points (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    x           REAL NOT NULL,          -- 地图坐标（0-100 的简化平面坐标）
    y           REAL NOT NULL,
    capacity    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    point_id   TEXT,                    -- 主管所属点位（员工可流动）
    role       TEXT NOT NULL CHECK (role IN ('staff', 'supervisor'))
);

CREATE TABLE IF NOT EXISTS vehicles (
    id              TEXT PRIMARY KEY,                   -- 车辆编号，如 S-001
    home_point_id   TEXT NOT NULL REFERENCES service_points(id),
    current_point_id TEXT NOT NULL REFERENCES service_points(id),
    weight_limit    INTEGER NOT NULL,                   -- 适用体重上限 kg
    canopy          INTEGER NOT NULL DEFAULT 1,         -- 遮阳篷
    harness         INTEGER NOT NULL DEFAULT 1,         -- 安全带
    rain_cover      INTEGER NOT NULL DEFAULT 1,         -- 雨罩
    brakes_ok       INTEGER NOT NULL DEFAULT 1,         -- 刹车是否正常
    status          TEXT NOT NULL CHECK (
                        status IN ('available', 'reserved', 'on_rent',
                                   'cleaning', 'maintenance')),
    cleanliness     TEXT NOT NULL DEFAULT 'clean' CHECK (
                        cleanliness IN ('clean', 'dirty'))
);

CREATE TABLE IF NOT EXISTS vehicle_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id  TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT '{}',            -- JSON
    actor       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS rentals (
    id              TEXT PRIMARY KEY,
    vehicle_id      TEXT NOT NULL REFERENCES vehicles(id),
    visitor_id      TEXT NOT NULL,
    visitor_name    TEXT NOT NULL,
    visitor_weight  REAL NOT NULL,
    pickup_point_id TEXT NOT NULL REFERENCES service_points(id),
    return_point_id TEXT,                               -- 实际归还点（跨点时不同）
    deposit_cents   INTEGER NOT NULL,
    status          TEXT NOT NULL CHECK (
                        status IN ('held', 'active', 'returned',
                                   'overdue', 'disputed', 'cancelled')),
    booked_from     TEXT NOT NULL,
    booked_to       TEXT NOT NULL,
    picked_at       TEXT,
    returned_at     TEXT,
    deposit_refunded INTEGER NOT NULL DEFAULT 0,        -- 退款幂等关键标记
    refund_ref      TEXT,
    signature       TEXT,                               -- 游客签名（姓名/样例签字串）
    created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS rental_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    rental_id   TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT '{}',
    actor       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS payments (
    id              TEXT PRIMARY KEY,
    rental_id       TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('deposit_hold','deposit_refund','deposit_deduct')),
    amount_cents    INTEGER NOT NULL,
    status          TEXT NOT NULL,                      -- ok / failed
    receipt_no      TEXT NOT NULL,
    idempotency_key TEXT UNIQUE,                        -- 重复退款在适配器层唯一
    created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS inspections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id  TEXT NOT NULL,
    stage       TEXT NOT NULL CHECK (stage IN ('pre_rent','return_check','safety_recheck')),
    passed      INTEGER NOT NULL,
    brakes_ok   INTEGER NOT NULL,
    harness_ok  INTEGER NOT NULL,
    canopy_ok   INTEGER NOT NULL,
    rain_cover_ok INTEGER NOT NULL,
    note        TEXT DEFAULT '',
    inspector   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS work_orders (
    id          TEXT PRIMARY KEY,
    vehicle_id  TEXT NOT NULL REFERENCES vehicles(id),
    issue       TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('open','in_repair','done')),
    reported_by TEXT NOT NULL,
    resolved_by TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS damage_photos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id  TEXT NOT NULL,
    rental_id   TEXT,
    file_name   TEXT NOT NULL,
    note        TEXT DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS transfer_reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id  TEXT NOT NULL,
    from_point  TEXT NOT NULL,
    to_point    TEXT NOT NULL,
    reason      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
"""

_lock = threading.RLock()


def connect(db_path: str | Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    with _lock:
        conn.executescript(SCHEMA)
        conn.commit()
