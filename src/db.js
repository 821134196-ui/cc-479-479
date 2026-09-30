'use strict';
// SQLite 连接与 schema。使用 Node 内置 node:sqlite，无外部依赖。
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS service_points (
  id          INTEGER PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  map_x       REAL NOT NULL DEFAULT 0,   -- 简版地图坐标 (0-100)
  map_y       REAL NOT NULL DEFAULT 0,
  capacity    INTEGER NOT NULL DEFAULT 8 -- 点位物理容量，用于跨点满仓判断
);

CREATE TABLE IF NOT EXISTS vehicles (
  id              INTEGER PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,        -- 车辆编号，如 ST-001
  home_point_id   INTEGER NOT NULL REFERENCES service_points(id), -- 登记归属点
  point_id        INTEGER NOT NULL REFERENCES service_points(id), -- 当前所在/归属位置（跨点归还会改变）
  max_weight_kg   REAL NOT NULL,               -- 适用体重上限
  has_canopy      INTEGER NOT NULL DEFAULT 1,  -- 遮阳篷
  has_rain_cover  INTEGER NOT NULL DEFAULT 1,  -- 雨罩
  status          TEXT NOT NULL DEFAULT 'available'
                  CHECK(status IN ('available','locked','rented','pending_clean','cleaning','pending_inspect','repair')),
  lock_token      TEXT,
  lock_expires_at TEXT,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vehicles_point ON vehicles(point_id, status);

CREATE TABLE IF NOT EXISTS rentals (
  id                 INTEGER PRIMARY KEY,
  code               TEXT UNIQUE NOT NULL,      -- 租借单号 R-xxxxxx
  vehicle_id         INTEGER NOT NULL REFERENCES vehicles(id),
  rent_point_id      INTEGER NOT NULL REFERENCES service_points(id),
  return_point_id    INTEGER REFERENCES service_points(id),
  tourist_name       TEXT NOT NULL,             -- 样例游客
  tourist_phone      TEXT NOT NULL,
  child_weight_kg    REAL NOT NULL,
  period             TEXT NOT NULL,             -- 租借时段: 2h | halfday | fullday
  start_at           TEXT NOT NULL,
  due_at             TEXT NOT NULL,
  returned_at        TEXT,
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK(status IN ('active','overdue','returned')),
  deposit_amount     INTEGER NOT NULL,          -- 押金（分）
  deposit_status     TEXT NOT NULL DEFAULT 'held'
                     CHECK(deposit_status IN ('held','refunded','partial_refunded','disputed')),
  pay_receipt        TEXT,                      -- 模拟付款回执
  refund_receipt     TEXT,                      -- 模拟退款回执（幂等）
  overtime_minutes   INTEGER NOT NULL DEFAULT 0,
  overtime_fee       INTEGER NOT NULL DEFAULT 0,
  missing_accessories TEXT NOT NULL DEFAULT '[]', -- 归还时遗失配件
  waived_accessories  TEXT NOT NULL DEFAULT '[]', -- 借出时已豁免（如雨罩缺失游客确认）
  deduction          INTEGER NOT NULL DEFAULT 0,  -- 押金扣款合计（分）
  damage_note        TEXT,
  signature          TEXT,                      -- 游客签署（样例文本）
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rentals_status ON rentals(status);
CREATE INDEX IF NOT EXISTS idx_rentals_vehicle ON rentals(vehicle_id);

CREATE TABLE IF NOT EXISTS events (              -- 车辆与租借事件日志
  id         INTEGER PRIMARY KEY,
  vehicle_id INTEGER,
  rental_id  INTEGER,
  point_id   INTEGER,
  type       TEXT NOT NULL,
  actor      TEXT,
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_vehicle ON events(vehicle_id);

CREATE TABLE IF NOT EXISTS cleaning_tasks (      -- 清洁队列
  id         INTEGER PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  point_id   INTEGER NOT NULL REFERENCES service_points(id),
  status     TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','in_progress','done')),
  assignee   TEXT,
  created_at TEXT NOT NULL,
  done_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_cleaning_point ON cleaning_tasks(point_id, status);

CREATE TABLE IF NOT EXISTS inspections (         -- 车辆检查（借出检查 / 安全复检）
  id              INTEGER PRIMARY KEY,
  vehicle_id      INTEGER NOT NULL REFERENCES vehicles(id),
  rental_id       INTEGER,
  kind            TEXT NOT NULL CHECK(kind IN ('pre_rental','post_clean','post_repair')),
  brake_ok        INTEGER,
  belt_ok         INTEGER,
  accessories_ok  INTEGER,
  result          TEXT NOT NULL CHECK(result IN ('pass','fail')),
  inspector       TEXT NOT NULL,
  role            TEXT NOT NULL,                -- staff | supervisor（安全复检须主管）
  note            TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repair_orders (       -- 维修工单（普通员工可报修）
  id          INTEGER PRIMARY KEY,
  vehicle_id  INTEGER NOT NULL REFERENCES vehicles(id),
  point_id    INTEGER NOT NULL REFERENCES service_points(id),
  reported_by TEXT NOT NULL,
  issue       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_repair','fixed')),
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS damage_photos (       -- 损伤照片（文件存本地目录，库内存路径）
  id         INTEGER PRIMARY KEY,
  rental_id  INTEGER,
  vehicle_id INTEGER NOT NULL,
  path       TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deposit_reviews (     -- 押金复核（押金争议处理路径）
  id            INTEGER PRIMARY KEY,
  rental_id     INTEGER NOT NULL REFERENCES rentals(id),
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved')),
  resolution    TEXT,
  refund_amount INTEGER,
  resolved_by   TEXT,
  created_at    TEXT NOT NULL,
  resolved_at   TEXT
);

CREATE TABLE IF NOT EXISTS notifications (       -- 进程内任务产生的提醒（超时 / 调拨 / 缺车）
  id         INTEGER PRIMARY KEY,
  type       TEXT NOT NULL CHECK(type IN ('overdue','transfer_reminder','stockout')),
  point_id   INTEGER,
  rental_id  INTEGER,
  message    TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,                        -- 去重，避免重复提醒
  created_at TEXT NOT NULL
);
`;

function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
