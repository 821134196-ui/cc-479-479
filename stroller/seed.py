"""种子数据：服务点、人员、车辆与在途/历史租借样例。

内置三类要求的演示样例：
1. 缺车：P-HILL 观景台点 0 辆可借（后台任务会自动生成调拨提醒）；
2. 跨点：S-103 由南门借出、萌宠园跨点归还（归属已变更，在清洁队列）；
   萌宠园同时处于满仓状态，跨点还入将被拒绝并引导改还；
3. 刹车异常：S-006 维修中且有未结工单，禁止借出、禁止调拨。
另含雨罩缺失、超时未还、押金争议样例。游客与付款均为样例数据。
"""
from __future__ import annotations

import base64
import json
import os
import sqlite3
from datetime import datetime, timedelta

from .db import connect, init_db

# 1x1 PNG，作为损伤照片样例文件
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9aw"
    "AAAABJRU5ErkJggg==")

POINTS = [
    ("P-GATE", "南门主入口服务点", 18, 72, 8),
    ("P-LAKE", "湖畔服务点",       48, 30, 6),
    ("P-ZOO",  "萌宠园服务点",     78, 60, 3),
    ("P-HILL", "观景台服务点",     70, 16, 4),
]

STAFF = [
    ("E01", "王磊", "P-GATE", "staff"),
    ("E02", "李晓", "P-LAKE", "staff"),
    ("M01", "陈主管", "P-GATE", "supervisor"),
    ("M02", "赵主管", "P-LAKE", "supervisor"),
]

# id, home, current, 体重上限, 篷, 安全带, 雨罩, 刹车, 状态, 清洁度
VEHICLES = [
    ("S-001", "P-GATE", "P-GATE", 15, 1, 1, 1, 1, "available",   "clean"),
    ("S-002", "P-GATE", "P-GATE", 20, 1, 1, 1, 1, "available",   "clean"),
    ("S-003", "P-GATE", "P-GATE", 25, 1, 1, 1, 1, "available",   "clean"),
    ("S-004", "P-GATE", "P-GATE", 15, 1, 1, 1, 1, "available",   "clean"),
    ("S-005", "P-GATE", "P-GATE", 20, 1, 1, 0, 1, "available",   "clean"),  # 雨罩缺失
    ("S-006", "P-GATE", "P-GATE", 20, 1, 1, 1, 0, "maintenance", "clean"),  # 刹车异常
    ("S-007", "P-GATE", "P-GATE", 15, 1, 1, 1, 1, "cleaning",    "dirty"),  # 待清洁
    ("S-101", "P-LAKE", "P-LAKE", 20, 1, 1, 1, 1, "available",   "clean"),
    ("S-102", "P-LAKE", "P-LAKE", 15, 1, 1, 1, 1, "on_rent",     "clean"),  # 超时样例
    ("S-104", "P-LAKE", "P-LAKE", 20, 1, 1, 1, 1, "cleaning",    "dirty"),  # 押金争议样例
    ("S-103", "P-GATE", "P-ZOO",  20, 1, 1, 1, 1, "cleaning",    "dirty"),  # 跨点归还样例
    ("S-201", "P-ZOO",  "P-ZOO",  15, 1, 1, 1, 1, "available",   "clean"),
    ("S-202", "P-ZOO",  "P-ZOO",  25, 1, 1, 1, 1, "maintenance", "clean"),  # 萌宠园占仓
]


def _ve(conn, vid, etype, detail, actor=None):
    conn.execute(
        "INSERT INTO vehicle_events(vehicle_id,event_type,detail,actor,created_at)"
        " VALUES(?,?,?,?,datetime('now','localtime'))",
        (vid, etype, json.dumps(detail, ensure_ascii=False), actor))


def _re(conn, rid, etype, detail, actor=None):
    conn.execute(
        "INSERT INTO rental_events(rental_id,event_type,detail,actor)"
        " VALUES(?,?,?,?)",
        (rid, etype, json.dumps(detail, ensure_ascii=False), actor))


def seed(conn: sqlite3.Connection, photo_dir: str) -> None:
    init_db(conn)
    conn.execute("BEGIN IMMEDIATE")
    for t in ["damage_photos", "transfer_reminders", "work_orders", "inspections",
              "payments", "rental_events", "rentals", "vehicle_events",
              "vehicles", "staff", "service_points"]:
        conn.execute(f"DELETE FROM {t}")

    conn.executemany("INSERT INTO service_points VALUES(?,?,?,?,?)", POINTS)
    conn.executemany("INSERT INTO staff VALUES(?,?,?,?)", STAFF)
    conn.executemany(
        "INSERT INTO vehicles(id,home_point_id,current_point_id,weight_limit,"
        "canopy,harness,rain_cover,brakes_ok,status,cleanliness) VALUES(?,?,?,?,?,?,?,?,?,?)",
        VEHICLES)

    now = datetime.now()
    fmt = "%Y-%m-%d %H:%M"
    for vid, *_ in VEHICLES:
        _ve(conn, vid, "registered", {"note": "种子建档"})

    # 刹车异常工单（S-006）
    conn.execute(
        "INSERT INTO work_orders(id,vehicle_id,issue,status,reported_by,created_at)"
        " VALUES('WO-S006-SEED','S-006','归还时发现刹车疲软，制动距离变长','open','E02',?)",
        ((now - timedelta(hours=3)).strftime("%Y-%m-%d %H:%M:%S"),))
    _ve(conn, "S-006", "repair_reported",
        {"work_order": "WO-S006-SEED", "issue": "刹车疲软"}, "E02")
    conn.execute(
        "INSERT INTO work_orders(id,vehicle_id,issue,status,reported_by,created_at)"
        " VALUES('WO-S202-SEED','S-202','前轮万向轮卡顿','in_repair','E02',?)",
        ((now - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S"),))

    # 押金 ¥300
    D = 30000

    # 1) 超时未还样例（S-102，应还时间在昨天，启动后被后台任务标记 overdue）
    rid = "R-SEED-OVE"
    conn.execute(
        """INSERT INTO rentals(id,vehicle_id,visitor_id,visitor_name,visitor_weight,
               pickup_point_id,return_point_id,deposit_cents,status,
               booked_from,booked_to,picked_at,deposit_refunded)
           VALUES(?,?,?,?,?,?,?,?, 'active', ?,?, ?,0)""",
        (rid, "S-102", "V-DEMO-01", "张小明（样例）", 12, "P-LAKE", None, D,
         (now - timedelta(hours=28)).strftime(fmt), (now - timedelta(hours=24)).strftime(fmt),
         (now - timedelta(hours=28)).strftime("%Y-%m-%d %H:%M:%S")))
    conn.execute(
        "INSERT INTO payments(id,rental_id,kind,amount_cents,status,receipt_no,idempotency_key)"
        " VALUES('P-SEED-OVE-H',?,'deposit_hold',?,'ok','SIM-HOLD-SEED-OVE','hold:R-SEED-OVE')",
        (rid, D))
    _ve(conn, "S-102", "checked_out", {"rental_id": rid}, "E02")

    # 2) 跨点归还样例（S-103：南门借 → 萌宠园还，归属已变更，待清洁）
    rid = "R-SEED-CROS"
    conn.execute(
        """INSERT INTO rentals(id,vehicle_id,visitor_id,visitor_name,visitor_weight,
               pickup_point_id,return_point_id,deposit_cents,status,
               booked_from,booked_to,picked_at,returned_at,deposit_refunded,refund_ref)
           VALUES(?,?,?,?,?,?,?,?, 'returned', ?,?,?, ?,1,'SIM-REFUND-SEED-CROS')""",
        (rid, "S-103", "V-DEMO-02", "林朵朵（样例）", 14, "P-GATE", "P-ZOO", D,
         (now - timedelta(hours=6)).strftime(fmt), (now - timedelta(hours=2)).strftime(fmt),
         (now - timedelta(hours=6)).strftime("%Y-%m-%d %H:%M:%S"),
         (now - timedelta(minutes=40)).strftime("%Y-%m-%d %H:%M:%S")))
    conn.execute(
        "INSERT INTO payments(id,rental_id,kind,amount_cents,status,receipt_no,idempotency_key)"
        " VALUES('P-SEED-CROS-H',?,'deposit_hold',?,'ok','SIM-HOLD-SEED-CROS','hold:R-SEED-CROS')",
        ("R-SEED-CROS", D))
    conn.execute(
        "INSERT INTO payments(id,rental_id,kind,amount_cents,status,receipt_no,idempotency_key)"
        " VALUES('P-SEED-CROS-R',?,'deposit_refund',?,'ok','SIM-REFUND-SEED-CROS',"
        "'refund:R-SEED-CROS')", ("R-SEED-CROS", D))
    _ve(conn, "S-103", "checked_out", {"rental_id": rid}, "E01")
    _ve(conn, "S-103", "returned", {"rental_id": rid, "return_point": "P-ZOO",
                                    "cross_point": True}, "E02")
    _ve(conn, "S-103", "location_changed",
         {"from": "P-GATE", "to": "P-ZOO", "reason": "跨点归还"}, "E02")
    conn.execute(
        "INSERT INTO inspections(vehicle_id,stage,passed,brakes_ok,harness_ok,canopy_ok,"
        "rain_cover_ok,note,inspector) VALUES('S-103','return_check',1,1,1,1,1,'跨点归还','E02')")

    # 3) 押金争议样例（S-104：归还称篷布有划痕，押金冻结待主管复核）
    rid = "R-SEED-DISP"
    conn.execute(
        """INSERT INTO rentals(id,vehicle_id,visitor_id,visitor_name,visitor_weight,
               pickup_point_id,return_point_id,deposit_cents,status,
               booked_from,booked_to,picked_at,returned_at,deposit_refunded)
           VALUES(?,?,?,?,?,?,?,?, 'disputed', ?,?,?, ?,0)""",
        (rid, "S-104", "V-DEMO-03", "王大壮（样例）", 18, "P-LAKE", "P-LAKE", D,
         (now - timedelta(hours=5)).strftime(fmt), (now - timedelta(hours=1, minutes=5)).strftime(fmt),
         (now - timedelta(hours=5)).strftime("%Y-%m-%d %H:%M:%S"),
         (now - timedelta(minutes=20)).strftime("%Y-%m-%d %H:%M:%S")))
    conn.execute(
        "INSERT INTO payments(id,rental_id,kind,amount_cents,status,receipt_no,idempotency_key)"
        " VALUES('P-SEED-DISP-H',?,'deposit_hold',?,'ok','SIM-HOLD-SEED-DISP','hold:R-SEED-DISP')",
        (rid, D))
    _ve(conn, "S-104", "checked_out", {"rental_id": rid}, "E02")
    _ve(conn, "S-104", "returned", {"rental_id": rid, "return_point": "P-LAKE",
                                    "accessories_ok": 0}, "E02")
    _re(conn, rid, "deposit_disputed", {"reason": "外观或附件异常", "note": "遮阳篷表面划痕"})
    conn.execute(
        "INSERT INTO inspections(vehicle_id,stage,passed,brakes_ok,harness_ok,canopy_ok,"
        "rain_cover_ok,note,inspector) VALUES('S-104','return_check',0,1,1,0,1,"
        "'篷布有划痕，游客不认可赔偿','E02')")

    os.makedirs(photo_dir, exist_ok=True)
    photo_path = os.path.join(photo_dir, "S-104_seed_canopy_scratch.png")
    with open(photo_path, "wb") as f:
        f.write(_PNG)
    conn.execute(
        "INSERT INTO damage_photos(vehicle_id,rental_id,file_name,note)"
        " VALUES('S-104','R-SEED-DISP','S-104_seed_canopy_scratch.png','篷布划痕样例')")

    conn.commit()


if __name__ == "__main__":
    import pathlib
    root = pathlib.Path(__file__).resolve().parent.parent
    db_path = root / "data" / "stroller.db"
    db_path.parent.mkdir(exist_ok=True)
    c = connect(db_path)
    seed(c, str(root / "data" / "photos"))
    print(f"seeded -> {db_path}")
