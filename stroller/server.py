"""HTTP 服务（标准库）+ 进程内后台任务。

- ThreadingHTTPServer 提供 JSON API 与静态页面；
- 守护线程每 20s 执行一次超时扫描与调拨提醒；
- 损伤照片通过 multipart 上传落地到本地目录 data/photos。

启动：python3 -m stroller.server --reset
"""
from __future__ import annotations

import argparse
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from .db import connect, init_db
from .seed import seed
from .service import DomainError, StrollerService

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
DB_PATH = ROOT / "data" / "stroller.db"
PHOTO_DIR = ROOT / "data" / "photos"

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class TaskLog:
    """后台任务最近运行记录（进程内），供页面提示。"""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.entries: list[dict] = []

    def add(self, kind: str, result: list) -> None:
        from datetime import datetime
        with self.lock:
            self.entries.insert(0, {"at": datetime.now().strftime("%H:%M:%S"),
                                    "kind": kind, "result": result})
            del self.entries[20:]

    def recent(self) -> list[dict]:
        with self.lock:
            return list(self.entries)


def background_worker(svc: StrollerService, log: TaskLog, stop: threading.Event) -> None:
    """进程内任务：超时标记 + 缺车调拨提醒。"""
    while not stop.wait(20):
        try:
            overdue = svc.scan_overdue()
            if overdue:
                log.add("overdue", overdue)
            reminders = svc.scan_transfer_needs()
            if reminders:
                log.add("transfer_reminder", reminders)
        except Exception as e:  # 守护任务不能把线程跑死
            log.add("error", [str(e)])


def parse_multipart(body: bytes, content_type: str) -> dict[str, dict]:
    """极简 multipart/form-data 解析：返回 {字段名: {filename?, data: bytes}}。"""
    boundary = content_type.split("boundary=", 1)[1].strip().encode()
    delim = b"--" + boundary
    fields: dict[str, dict] = {}
    for part in body.split(delim):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        head, _, data = part.partition(b"\r\n\r\n")
        headers = head.decode("utf-8", "replace")
        name = None
        filename = None
        for line in headers.split("\r\n"):
            if line.lower().startswith("content-disposition"):
                for token in line.split(";"):
                    token = token.strip()
                    if token.startswith("name="):
                        name = token[5:].strip('"')
                    if token.startswith("filename="):
                        filename = token[9:].strip('"')
        if name:
            fields[name] = {"filename": filename, "data": data.rstrip(b"\r\n")}
    return fields


def make_handler(svc: StrollerService, task_log: TaskLog,
                 shared_lock: threading.RLock):
    # 每个 HTTP 线程使用自己的 SQLite 连接（WAL 允许读写并发）；
    # 支付/扫码适配器与领域锁线程间共享，保证跨线程的状态变更互斥。
    local = threading.local()

    def get_svc() -> StrollerService:
        if not hasattr(local, "svc"):
            conn = connect(DB_PATH)
            local.svc = StrollerService(conn, str(PHOTO_DIR),
                                        payment=svc.payment, scanner=svc.scanner,
                                        shared_lock=shared_lock)
        return local.svc

    class Handler(BaseHTTPRequestHandler):
        server_version = "StrollerPlatform/1.0"

        def log_message(self, fmt, *args):  # 静默默认访问日志
            pass

        # ---------- 响应工具 ----------

        def _json(self, obj, status: int = 200) -> None:
            raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _file(self, path: Path) -> None:
            if not path.is_file():
                self.send_error(404, "Not found")
                return
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type",
                             CONTENT_TYPES.get(path.suffix, "application/octet-stream"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _body_json(self) -> dict:
            length = int(self.headers.get("Content-Length", 0))
            if not length:
                return {}
            raw = self.rfile.read(length)
            try:
                return json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                raise DomainError("bad_json", "请求体不是合法 JSON")

        def _call(self, fn, *args, **kwargs):
            try:
                return self._json(fn(*args, **kwargs))
            except DomainError as e:
                return self._json({"error": e.code, "message": e.message, "extra": e.extra}, 409)

        # ---------- 路由 ----------

        def do_GET(self) -> None:
            svc = get_svc()
            parsed = urlparse(self.path)
            path = parsed.path
            qs = parse_qs(parsed.query)
            try:
                if path == "/":
                    return self._file(WEB_DIR / "index.html")
                if path.startswith("/static/"):
                    target = (WEB_DIR / path[len("/static/"):]).resolve()
                    if WEB_DIR.resolve() not in target.parents and target != WEB_DIR.resolve():
                        return self.send_error(403)
                    return self._file(target)
                if path.startswith("/photos/"):
                    name = os.path.basename(path)
                    return self._file(PHOTO_DIR / name)
                if path == "/api/overview":
                    return self._json({
                        "points": svc.inventory(),
                        "vehicles": svc.list_vehicles(qs.get("point", [None])[0]),
                        "staff": [dict(r) for r in svc.conn.execute(
                            "SELECT * FROM staff ORDER BY id")],
                        "reminders": svc.pending_transfer_reminders(),
                        "tasks": task_log.recent(),
                    })
                if path == "/api/vehicles":
                    return self._json(svc.list_vehicles(qs.get("point", [None])[0]))
                if path == "/api/rentals":
                    return self._json(svc.list_rentals(qs.get("status", [None])[0]))
                if path == "/api/workorders":
                    return self._json(svc.list_work_orders(
                        qs.get("all", ["0"])[0] == "1"))
                if path == "/api/cleaning":
                    return self._json(svc.cleaning_queue())
                if path == "/api/timeline":
                    return self._json(svc.vehicle_timeline(qs["vehicle_id"][0]))
                if path == "/api/photos":
                    return self._json(svc.list_damage_photos(
                        qs.get("vehicle_id", [None])[0]))
                return self.send_error(404, "Not found")
            except DomainError as e:
                return self._json({"error": e.code, "message": e.message}, 409)

        def do_POST(self) -> None:
            svc = get_svc()
            path = urlparse(self.path).path
            try:
                # 损伤照片：multipart 上传
                if path == "/api/photo":
                    ctype = self.headers.get("Content-Type", "")
                    if "multipart/form-data" not in ctype:
                        raise DomainError("bad_content_type", "请使用 multipart 上传照片")
                    length = int(self.headers.get("Content-Length", 0))
                    fields = parse_multipart(self.rfile.read(length), ctype)
                    meta = json.loads(fields["meta"]["data"].decode("utf-8"))
                    f = fields.get("file") or fields.get("photo")
                    if not f or not f["data"]:
                        raise DomainError("no_file", "缺少照片文件")
                    return self._json(svc.save_damage_photo(
                        vehicle_id=meta["vehicle_id"],
                        rental_id=meta.get("rental_id"),
                        filename=f["filename"] or "damage.png",
                        data=f["data"], note=meta.get("note", "")))

                b = self._body_json()

                if path == "/api/scan":
                    return self._call(svc.scan, b["qr"])
                if path == "/api/eligibility":
                    return self._call(svc.check_eligibility,
                                      b["vehicle_id"], float(b["visitor_weight"]),
                                      b["pickup_point_id"])
                if path == "/api/inspect/pre":
                    return self._call(svc.pre_rent_inspection,
                        vehicle_id=b["vehicle_id"], pickup_point_id=b["pickup_point_id"],
                        brakes_ok=bool(b["brakes_ok"]), harness_ok=bool(b["harness_ok"]),
                        canopy_ok=bool(b["canopy_ok"]), rain_cover_ok=bool(b["rain_cover_ok"]),
                        note=b.get("note", ""), actor_id=b["actor_id"])
                if path == "/api/lock":
                    return self._call(svc.lock_vehicle,
                        vehicle_id=b["vehicle_id"], visitor_id=b.get("visitor_id", "V-SAMPLE"),
                        visitor_name=b["visitor_name"], visitor_weight=float(b["visitor_weight"]),
                        pickup_point_id=b["pickup_point_id"], actor_id=b["actor_id"])
                if path == "/api/checkout":
                    return self._call(svc.sign_and_checkout,
                        rental_id=b["rental_id"], signature=b["signature"],
                        actor_id=b["actor_id"])
                if path == "/api/return":
                    return self._call(svc.return_rental,
                        rental_id=b["rental_id"], return_point_id=b["return_point_id"],
                        actor_id=b["actor_id"], appearance_ok=bool(b["appearance_ok"]),
                        accessories_ok=bool(b["accessories_ok"]),
                        damage_note=b.get("damage_note", ""), dispute=bool(b.get("dispute")))
                if path == "/api/cleaning/complete":
                    return self._call(svc.complete_cleaning,
                        vehicle_id=b["vehicle_id"], actor_id=b["actor_id"],
                        note=b.get("note", ""))
                if path == "/api/recheck":
                    return self._call(svc.safety_recheck,
                        vehicle_id=b["vehicle_id"], actor_id=b["actor_id"],
                        passed=bool(b["passed"]), brakes_ok=bool(b.get("brakes_ok", True)),
                        note=b.get("note", ""))
                if path == "/api/repair":
                    return self._call(svc.report_repair,
                        vehicle_id=b["vehicle_id"], issue=b["issue"],
                        actor_id=b["actor_id"])
                if path == "/api/repair/resolve":
                    return self._call(svc.resolve_repair,
                        work_order_id=b["work_order_id"], actor_id=b["actor_id"],
                        rain_cover_fitted=bool(b.get("rain_cover_fitted")))
                if path == "/api/transfer":
                    return self._call(svc.transfer,
                        vehicle_id=b["vehicle_id"], to_point_id=b["to_point_id"],
                        actor_id=b["actor_id"])
                if path == "/api/deposit/review":
                    return self._call(svc.review_deposit,
                        rental_id=b["rental_id"], actor_id=b["actor_id"],
                        deduct_cents=int(b["deduct_cents"]), note=b.get("note", ""))
                return self.send_error(404, "Not found")
            except DomainError as e:
                return self._json({"error": e.code, "message": e.message,
                                   "extra": getattr(e, "extra", {})}, 409)
            except KeyError as e:
                return self._json({"error": "missing_field",
                                   "message": f"缺少字段：{e.args[0]}"}, 400)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="景区婴儿车租借与清洁周转平台")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reset", action="store_true", help="重置并重新写入种子数据")
    args = parser.parse_args()

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    PHOTO_DIR.mkdir(parents=True, exist_ok=True)
    conn = connect(DB_PATH)
    init_db(conn)
    if args.reset or not conn.execute("SELECT COUNT(*) c FROM service_points").fetchone()["c"]:
        seed(conn, str(PHOTO_DIR))

    svc = StrollerService(conn, str(PHOTO_DIR),
                          shared_lock=threading.RLock())
    task_log = TaskLog()
    stop = threading.Event()
    t = threading.Thread(target=background_worker, args=(svc, task_log, stop),
                         daemon=True, name="bg-tasks")
    t.start()

    httpd = ThreadingHTTPServer(
        (args.host, args.port), make_handler(svc, task_log, svc._lock))
    print(f"婴儿车周转平台已启动：http://{args.host}:{args.port}")
    print("（样例工号 E01/E02 普通员工，M01/M02 点位主管；后台每 20s 扫描超时与调拨）")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        httpd.server_close()


if __name__ == "__main__":
    main()
