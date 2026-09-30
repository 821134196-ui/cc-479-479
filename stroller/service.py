"""领域服务：租借周转全部业务规则。

车辆生命周期：
    available ──借出检查通过+押金锁定──▶ reserved ──游客签署──▶ on_rent
    on_rent ──归还检查──▶ cleaning ──清洁完成──▶ (待安全复检)
        ──主管复检通过──▶ available
        ──主管复检不通过──▶ maintenance（自动开工单）
    任何状态下普通员工都可报修 ──▶ maintenance，主管修复 ──▶ cleaning（修复后仍需清洁复检）

借出顺序：扫码 → 资格核验（体重/库存/雨罩）→ 借出检查（刹车/安全带/篷/雨罩）
         → 锁定车辆并预授权押金 → 游客签署交车。
    两个终端同时借最后一辆车时，两边检查都可能通过，但锁定步的条件更新只放行一笔。

规则要点：
- 体重超限 / 服务点缺车 / 雨罩缺失 / 刹车异常 → 各自处理路径；
- 跨点归还改变归属位置；维修中车辆禁止调拨；目标点满仓时拒绝跨点归还/调拨；
- 押金退款按租借单幂等，重复归还不二次退款；押金争议挂起，由主管复核；
- 普通员工可报修，安全复检仅点位主管可执行。
"""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timedelta

from .adapters import PaymentAdapter, PaymentError, ScanAdapter, ScanError

# 借用规则常量
DEFAULT_DEPOSIT_CENTS = 300_00          # 押金 ¥300.00
OVERDUE_GRACE_MIN = 15                  # 超时宽限
OVERDUE_FEE_CENTS = 50_00               # 超时费 ¥50（样例，争议时可申诉）
RENTAL_SLOT_HOURS = 4                   # 样例时段长度


class DomainError(Exception):
    """可预期的业务拒绝，code 供前端分支处理。"""

    def __init__(self, code: str, message: str, extra: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.extra = extra or {}


def _now() -> datetime:
    return datetime.now()


def _slot(from_time: datetime | None = None) -> tuple[str, str]:
    start = from_time or _now()
    end = start + timedelta(hours=RENTAL_SLOT_HOURS)
    return start.strftime("%Y-%m-%d %H:%M"), end.strftime("%Y-%m-%d %H:%M")


class StrollerService:
    def __init__(self, conn: sqlite3.Connection, photo_dir: str,
                 payment: PaymentAdapter | None = None,
                 scanner: ScanAdapter | None = None,
                 shared_lock: threading.RLock | None = None):
        self.conn = conn
        self.photo_dir = photo_dir
        self.payment = payment or PaymentAdapter()
        self.scanner = scanner or ScanAdapter()
        # 进程内互斥：同一时刻只允许一笔改变车辆/租借状态的事务，
        # 保证「最后一辆车两处请求仅一笔成功」。多连接（多 HTTP 线程）
        # 场景下必须传入同一个共享锁。
        self._lock = shared_lock or threading.RLock()

    # ---------- 基础工具 ----------

    def _vehicle_event(self, vehicle_id: str, event_type: str, detail: dict | None = None,
                       actor: str | None = None) -> None:
        self.conn.execute(
            "INSERT INTO vehicle_events(vehicle_id,event_type,detail,actor) VALUES(?,?,?,?)",
            (vehicle_id, event_type, json.dumps(detail or {}, ensure_ascii=False), actor))

    def _rental_event(self, rental_id: str, event_type: str, detail: dict | None = None,
                      actor: str | None = None) -> None:
        self.conn.execute(
            "INSERT INTO rental_events(rental_id,event_type,detail,actor) VALUES(?,?,?,?)",
            (rental_id, event_type, json.dumps(detail or {}, ensure_ascii=False), actor))

    def get_vehicle(self, vehicle_id: str) -> sqlite3.Row:
        row = self.conn.execute("SELECT * FROM vehicles WHERE id=?", (vehicle_id,)).fetchone()
        if not row:
            raise DomainError("vehicle_not_found", f"车辆 {vehicle_id} 不存在")
        return row

    def get_point(self, point_id: str) -> sqlite3.Row:
        row = self.conn.execute("SELECT * FROM service_points WHERE id=?", (point_id,)).fetchone()
        if not row:
            raise DomainError("point_not_found", f"服务点 {point_id} 不存在")
        return row

    def _require_actor(self, actor_id: str) -> sqlite3.Row:
        row = self.conn.execute("SELECT * FROM staff WHERE id=?", (actor_id,)).fetchone()
        if not row:
            raise DomainError("unknown_staff", f"工号 {actor_id} 不存在，请刷卡或选择员工")
        return row

    def _point_occupancy(self, point_id: str) -> int:
        return self.conn.execute(
            "SELECT COUNT(*) c FROM vehicles WHERE current_point_id=?", (point_id,)
        ).fetchone()["c"]

    # ---------- 查询 ----------

    def inventory(self) -> list[dict]:
        """点位库存：容量、在库数、各状态数。"""
        points = [dict(r) for r in self.conn.execute(
            "SELECT * FROM service_points ORDER BY id")]
        for p in points:
            counts = self.conn.execute(
                """SELECT status, COUNT(*) c FROM vehicles
                   WHERE current_point_id=? GROUP BY status""", (p["id"],)).fetchall()
            p["by_status"] = {r["status"]: r["c"] for r in counts}
            p["onsite"] = p["by_status"].get("available", 0) + p["by_status"].get("cleaning", 0) \
                + p["by_status"].get("maintenance", 0) + p["by_status"].get("reserved", 0)
            p["available"] = p["by_status"].get("available", 0)
            p["full"] = p["onsite"] >= p["capacity"]
        return points

    def list_vehicles(self, point_id: str | None = None) -> list[dict]:
        sql = "SELECT * FROM vehicles"
        args: tuple = ()
        if point_id:
            sql += " WHERE current_point_id=?"
            args = (point_id,)
        sql += " ORDER BY id"
        rows = [dict(r) for r in self.conn.execute(sql, args)]
        for v in rows:
            wo = self.conn.execute(
                "SELECT COUNT(*) c FROM work_orders WHERE vehicle_id=? AND status!='done'",
                (v["id"],)).fetchone()["c"]
            v["open_work_orders"] = wo
        return rows

    def list_rentals(self, status: str | None = None) -> list[dict]:
        sql = "SELECT * FROM rentals"
        args: tuple = ()
        if status:
            sql += " WHERE status=?"
            args = (status,)
        sql += " ORDER BY created_at DESC, id DESC"
        return [dict(r) for r in self.conn.execute(sql, args)]

    def list_work_orders(self, only_open: bool = True) -> list[dict]:
        sql = "SELECT * FROM work_orders"
        if only_open:
            sql += " WHERE status!='done'"
        sql += " ORDER BY created_at DESC"
        return [dict(r) for r in self.conn.execute(sql)]

    def vehicle_timeline(self, vehicle_id: str) -> list[dict]:
        self.get_vehicle(vehicle_id)
        return [dict(r) for r in self.conn.execute(
            "SELECT event_type,detail,actor,created_at FROM vehicle_events "
            "WHERE vehicle_id=? ORDER BY id", (vehicle_id,))]

    # ---------- 扫码 ----------

    def scan(self, qr_code: str) -> dict:
        try:
            vehicle_id = self.scanner.scan(qr_code)
        except ScanError as e:
            raise DomainError("bad_qr", str(e))
        v = self.get_vehicle(vehicle_id)
        return {"vehicle_id": vehicle_id, "vehicle": dict(v)}

    # ---------- 借用核验 ----------

    def check_eligibility(self, vehicle_id: str, visitor_weight: float,
                          pickup_point_id: str) -> dict:
        """借出前核验：体重、库存、雨罩、车辆状态。不产生副作用，供前端预检。"""
        v = self.get_vehicle(vehicle_id)
        problems: list[dict] = []
        if visitor_weight > v["weight_limit"]:
            problems.append({"code": "weight_exceeded",
                             "message": f"游客体重 {visitor_weight:g}kg 超过车辆上限 {v['weight_limit']}kg，"
                                        f"请改借承重 {int(visitor_weight)}kg 以上车型"})
        if v["current_point_id"] != pickup_point_id:
            problems.append({"code": "wrong_point",
                             "message": f"该车辆当前位于 {v['current_point_id']}，不在本服务点"})
        if v["status"] != "available":
            problems.append({"code": "not_available",
                             "message": f"车辆当前状态为 {v['status']}，暂不可借"})
        if not v["rain_cover"]:
            problems.append({"code": "rain_cover_missing",
                             "message": "雨罩缺失，不能借出；请先报修或更换车辆"})
        if not v["brakes_ok"]:
            problems.append({"code": "brake_fault", "message": "刹车异常，禁止借出"})
        return {"eligible": not problems, "problems": problems}

    def pre_rent_inspection(self, *, vehicle_id: str, pickup_point_id: str,
                            brakes_ok: bool, harness_ok: bool, canopy_ok: bool,
                            rain_cover_ok: bool, note: str = "", actor_id: str) -> dict:
        """借出前检查刹车、安全带、遮阳篷与雨罩（此时车辆尚未锁定）。

        按流程：先检查并向游客逐项确认，全部通过后调用 lock_vehicle 原子锁定；
        两个终端可同时通过检查，但只有一笔锁定成功。
        检查不通过：车辆立即挂维修并自动开工单（普通员工即可发起），请游客换车。
        """
        actor = self._require_actor(actor_id)
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                v = self.get_vehicle(vehicle_id)
                point = self.get_point(pickup_point_id)
                if v["current_point_id"] != pickup_point_id:
                    raise DomainError("wrong_point",
                        f"车辆当前位于 {v['current_point_id']}，不在 {point['name']}")
                if v["status"] != "available":
                    raise DomainError("not_available",
                        f"车辆当前为 {v['status']}，无法做借出检查")
                passed = all([brakes_ok, harness_ok, canopy_ok, rain_cover_ok])
                self.conn.execute(
                    """INSERT INTO inspections(vehicle_id,stage,passed,brakes_ok,harness_ok,
                           canopy_ok,rain_cover_ok,note,inspector)
                       VALUES(?,'pre_rent',?,?,?,?,?,?,?)""",
                    (vehicle_id, int(passed), int(brakes_ok), int(harness_ok),
                     int(canopy_ok), int(rain_cover_ok), note, actor["id"]))
                if not passed:
                    faults = []
                    if not brakes_ok: faults.append("刹车")
                    if not harness_ok: faults.append("安全带")
                    if not canopy_ok: faults.append("遮阳篷")
                    if not rain_cover_ok: faults.append("雨罩")
                    self.conn.execute(
                        "UPDATE vehicles SET status='maintenance', brakes_ok=? WHERE id=?",
                        (int(brakes_ok), vehicle_id))
                    self.conn.execute(
                        "INSERT INTO work_orders(id,vehicle_id,issue,status,reported_by) "
                        "VALUES(?,?,?,'open',?)",
                        (f"WO-{vehicle_id}-{_now().strftime('%H%M%S')}", vehicle_id,
                         "借出检查未过：" + "、".join(faults), actor["id"]))
                    self._vehicle_event(vehicle_id, "inspection_failed",
                                        {"faults": faults}, actor["id"])
                    self.conn.commit()
                    raise DomainError("inspection_failed",
                        f"车辆 {vehicle_id} 借出检查未过（{'、'.join(faults)}），已挂维修，"
                        f"请为游客改选其他车辆",
                        {"faults": faults})
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return {"passed": True, "vehicle_id": vehicle_id,
                "message": "检查通过，请确认锁定车辆并完成押金预授权"}

    def lock_vehicle(self, *, vehicle_id: str, visitor_id: str, visitor_name: str,
                     visitor_weight: float, pickup_point_id: str, actor_id: str) -> dict:
        """检查通过后：资格复核 + 押金预授权 + 原子锁定车辆（reserved）。

        两个终端同时请求最后一辆车时，进程锁 + 状态条件更新保证仅一笔成功；
        输家得到 no_stock（缺车）处理路径，不会产生押金流水。
        """
        actor = self._require_actor(actor_id)
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                v = self.get_vehicle(vehicle_id)
                point = self.get_point(pickup_point_id)
                # 必须有该车最新一条「通过」的借出检查记录
                insp = self.conn.execute(
                    "SELECT * FROM inspections WHERE vehicle_id=? ORDER BY id DESC LIMIT 1",
                    (vehicle_id,)).fetchone()
                if not insp or insp["stage"] != "pre_rent" or not insp["passed"]:
                    raise DomainError("inspection_required",
                        "请先完成并通过借出前安全检查（刹车/安全带/遮阳篷/雨罩）")
                # 1) 体重条件
                if visitor_weight > v["weight_limit"]:
                    raise DomainError("weight_exceeded",
                        f"体重 {visitor_weight:g}kg 超出该车上限 {v['weight_limit']}kg，"
                        f"请在 {point['name']} 选择承重更高的车型")
                if v["current_point_id"] != pickup_point_id:
                    raise DomainError("wrong_point",
                        f"车辆不在 {point['name']}，请在车辆当前所在点办理")
                # 2) 原子竞争：仍是 available 才锁定成功
                cur = self.conn.execute(
                    """UPDATE vehicles SET status='reserved'
                       WHERE id=? AND status='available' AND current_point_id=?""",
                    (vehicle_id, pickup_point_id))
                if cur.rowcount == 0:
                    raise DomainError("no_stock",
                        f"{point['name']} 该车辆刚被其他终端借走（最后一辆竞争失败），"
                        f"请选择其他车辆或稍后重试")
                # 3) 雨罩为借出硬性配件（检查之外再兜底一次）
                if not v["rain_cover"]:
                    self.conn.execute(
                        "UPDATE vehicles SET status='available' WHERE id=?", (vehicle_id,))
                    raise DomainError("rain_cover_missing",
                        "雨罩缺失，无法借出。车辆已解锁，请补齐雨罩或为游客换车")
                # 4) 押金预授权（模拟支付）
                rental_id = f"R{_now().strftime('%Y%m%d%H%M%S')}-{vehicle_id}"
                try:
                    receipt = self.payment.hold_deposit(rental_id, DEFAULT_DEPOSIT_CENTS)
                except PaymentError as e:
                    self.conn.execute(
                        "UPDATE vehicles SET status='available' WHERE id=?", (vehicle_id,))
                    raise DomainError("payment_failed", f"押金预授权失败：{e}。车辆已解锁")
                frm, to = _slot()
                self.conn.execute(
                    """INSERT INTO rentals(id,vehicle_id,visitor_id,visitor_name,visitor_weight,
                           pickup_point_id,deposit_cents,status,booked_from,booked_to)
                       VALUES(?,?,?,?,?,?,?,'held',?,?)""",
                    (rental_id, vehicle_id, visitor_id, visitor_name, visitor_weight,
                     pickup_point_id, DEFAULT_DEPOSIT_CENTS, frm, to))
                self.conn.execute(
                    "INSERT INTO payments(id,rental_id,kind,amount_cents,status,receipt_no,idempotency_key)"
                    " VALUES(?,?, 'deposit_hold', ?, 'ok', ?, ?)",
                    (f"P-{rental_id}-H", rental_id, DEFAULT_DEPOSIT_CENTS, receipt,
                     f"hold:{rental_id}"))
                self._vehicle_event(vehicle_id, "reserved",
                                    {"rental_id": rental_id, "deposit_receipt": receipt}, actor["id"])
                self._rental_event(rental_id, "deposit_held",
                                   {"amount_cents": DEFAULT_DEPOSIT_CENTS, "receipt": receipt},
                                   actor["id"])
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return {"rental_id": rental_id, "deposit_receipt": receipt,
                "booked_from": frm, "booked_to": to}

    def sign_and_checkout(self, *, rental_id: str, signature: str, actor_id: str) -> dict:
        """游客签署（大按钮短文本页）→ 正式交车 on_rent。"""
        actor = self._require_actor(actor_id)
        if not signature or not signature.strip():
            raise DomainError("signature_required", "请游客完成签署后再交车")
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                r = self.conn.execute("SELECT * FROM rentals WHERE id=?", (rental_id,)).fetchone()
                if not r:
                    raise DomainError("rental_not_found", f"租借单 {rental_id} 不存在")
                if r["status"] != "held":
                    raise DomainError("bad_state", f"租借单状态为 {r['status']}，无法交车")
                insp = self.conn.execute(
                    "SELECT passed FROM inspections WHERE vehicle_id=? AND stage='pre_rent' "
                    "ORDER BY id DESC LIMIT 1", (r["vehicle_id"],)).fetchone()
                if not insp or not insp["passed"]:
                    raise DomainError("inspection_required", "请先完成借出前安全检查")
                self.conn.execute(
                    "UPDATE rentals SET status='active', signature=?, picked_at=? WHERE id=?",
                    (signature.strip(), _now().strftime("%Y-%m-%d %H:%M:%S"), rental_id))
                self.conn.execute(
                    "UPDATE vehicles SET status='on_rent' WHERE id=?", (r["vehicle_id"],))
                self._vehicle_event(r["vehicle_id"], "checked_out",
                                    {"rental_id": rental_id, "signature": signature.strip()},
                                    actor["id"])
                self._rental_event(rental_id, "signed_and_checked_out",
                                   {"signature": signature.strip()}, actor["id"])
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return {"rental_id": rental_id, "status": "active"}

    # ---------- 归还 ----------

    def return_rental(self, *, rental_id: str, return_point_id: str, actor_id: str,
                      appearance_ok: bool, accessories_ok: bool,
                      damage_note: str = "", dispute: bool = False) -> dict:
        """归还：复核外观与附件 → 车辆进入待清洁；处理超时 / 争议 / 退款。

        - 跨点满仓：目标点容量已满直接拒绝，引导改还其他点；
        - 跨点归还：复核通过后归属位置改为归还点；
        - 重复归还：已归还单直接返回既有回执，绝不二次退款；
        - 超时：扣除超时费后退还余额；游客有异议走押金争议；
        - 争议：挂 disputed，押金冻结，等点位主管复核。
        """
        actor = self._require_actor(actor_id)
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                r = self.conn.execute("SELECT * FROM rentals WHERE id=?", (rental_id,)).fetchone()
                if not r:
                    raise DomainError("rental_not_found", f"租借单 {rental_id} 不存在")
                # 重复归还幂等
                if r["status"] in ("returned", "disputed"):
                    return {"rental_id": rental_id, "status": r["status"], "idempotent": True,
                            "refund_ref": r["refund_ref"],
                            "message": "该单已归还，未重复退款"}
                if r["status"] not in ("active", "overdue"):
                    raise DomainError("bad_state", f"租借单状态为 {r['status']}，不能归还")

                vehicle_id = r["vehicle_id"]
                v = self.get_vehicle(vehicle_id)
                dest = self.get_point(return_point_id)

                # 跨点满仓校验（本车仍在租，不计入在库数）
                if return_point_id != v["current_point_id"]:
                    if self._point_occupancy(return_point_id) >= dest["capacity"]:
                        others = [p["name"] for p in self.inventory() if not p["full"]]
                        raise DomainError("cross_point_full",
                            f"{dest['name']} 车位已满（容量 {dest['capacity']}），"
                            f"无法跨点归还，请引导游客改还：{'、'.join(others) or '其他点位'}",
                            {"full_point": return_point_id,
                             "alternatives": [p for p in self.inventory() if not p["full"]]})

                # 归还检查记录
                passed = appearance_ok and accessories_ok
                self.conn.execute(
                    """INSERT INTO inspections(vehicle_id,stage,passed,brakes_ok,harness_ok,
                           canopy_ok,rain_cover_ok,note,inspector)
                       VALUES(?,'return_check',?,1,?,?,?,? ,?)""",
                    (vehicle_id, int(passed), int(accessories_ok), int(accessories_ok),
                     int(accessories_ok), damage_note, actor["id"]))

                overdue = r["status"] == "overdue" or _now() > datetime.strptime(
                    r["booked_to"], "%Y-%m-%d %H:%M") + timedelta(minutes=OVERDUE_GRACE_MIN)

                now_s = _now().strftime("%Y-%m-%d %H:%M:%S")
                self.conn.execute(
                    "UPDATE vehicles SET status='cleaning', cleanliness='dirty' WHERE id=?",
                    (vehicle_id,))
                self._vehicle_event(vehicle_id, "returned",
                                    {"rental_id": rental_id, "return_point": return_point_id,
                                     "appearance_ok": appearance_ok,
                                     "accessories_ok": accessories_ok,
                                     "damage_note": damage_note, "overdue": overdue,
                                     "cross_point": return_point_id != v["current_point_id"]},
                                    actor["id"])

                result: dict = {"rental_id": rental_id, "overdue": overdue}

                if dispute:
                    # 押金争议：冻结押金，等待主管复核（跨点归属仍立即生效）
                    self._apply_location(vehicle_id, return_point_id, actor["id"],
                                         reason="跨点归还（押金争议挂起）")
                    self.conn.execute(
                        "UPDATE rentals SET status='disputed', return_point_id=?, returned_at=? "
                        "WHERE id=?", (return_point_id, now_s, rental_id))
                    self._rental_event(rental_id, "deposit_disputed",
                                       {"note": damage_note, "overdue": overdue}, actor["id"])
                    self.conn.commit()
                    result.update(status="disputed",
                                  message="已登记押金争议，押金暂时冻结，由点位主管复核")
                    return result

                if not passed:
                    # 外观/附件异常：同样进入争议，等待主管核损，不自动退款
                    self._apply_location(vehicle_id, return_point_id, actor["id"],
                                         reason="跨点归还（外观/附件异常待核损）")
                    self.conn.execute(
                        "UPDATE rentals SET status='disputed', return_point_id=?, returned_at=? "
                        "WHERE id=?", (return_point_id, now_s, rental_id))
                    self._rental_event(rental_id, "deposit_disputed",
                                       {"reason": "外观或附件异常", "note": damage_note},
                                       actor["id"])
                    self.conn.commit()
                    result.update(status="disputed",
                                  message="归还检查发现外观/附件异常，押金冻结，转主管核损")
                    return result

                # 正常归还：跨点归属变更
                self._apply_location(vehicle_id, return_point_id, actor["id"],
                                     reason="跨点归还" if return_point_id != v["current_point_id"]
                                            else "原點归还")

                if overdue:
                    receipt = self.payment.deduct_deposit(rental_id, OVERDUE_FEE_CENTS)
                    self.conn.execute(
                        "INSERT INTO payments(id,rental_id,kind,amount_cents,status,receipt_no,"
                        "idempotency_key) VALUES(?,?, 'deposit_deduct', ?, 'ok', ?, ?)",
                        (f"P-{rental_id}-D", rental_id, OVERDUE_FEE_CENTS, receipt,
                         f"deduct:{rental_id}"))
                    refund_receipt = self._refund(
                        r, actor["id"],
                        amount=r["deposit_cents"] - OVERDUE_FEE_CENTS,
                        reason=f"超时归还，扣除超时费 ¥{OVERDUE_FEE_CENTS/100:.0f}")
                    self._rental_event(rental_id, "overdue_fee",
                                       {"fee_cents": OVERDUE_FEE_CENTS, "receipt": receipt},
                                       actor["id"])
                    result["fee_cents"] = OVERDUE_FEE_CENTS
                    result["deduction_receipt"] = receipt
                else:
                    refund_receipt = self._refund(r, actor["id"], reason="正常归还，全额退押")

                self.conn.execute(
                    "UPDATE rentals SET status='returned', return_point_id=?, returned_at=? "
                    "WHERE id=?", (return_point_id, now_s, rental_id))
                self.conn.commit()
                result.update(status="returned", refund_ref=refund_receipt,
                              message=("已扣超时费并退还剩余押金" if overdue else "押金已全额退回")
                                      + f"，车辆进入待清洁队列：{refund_receipt}")
                return result
            except Exception:
                self.conn.rollback()
                raise

    def _refund(self, r: sqlite3.Row, actor_id: str, *, amount: int | None = None,
                reason: str = "") -> str:
        """内部退款：押金只退一次（deposit_refunded 标记 + 支付幂等键双保险）。"""
        rental_id = r["id"]
        if r["deposit_refunded"]:
            return r["refund_ref"] or "已退款（幂等返回）"
        amount = r["deposit_cents"] if amount is None else amount
        receipt = self.payment.refund_deposit(rental_id, amount)
        self.conn.execute(
            "INSERT INTO payments(id,rental_id,kind,amount_cents,status,receipt_no,idempotency_key)"
            " VALUES(?,?, 'deposit_refund', ?, 'ok', ?, ?)",
            (f"P-{rental_id}-R", rental_id, amount, receipt, f"refund:{rental_id}"))
        self.conn.execute(
            "UPDATE rentals SET deposit_refunded=1, refund_ref=? WHERE id=?",
            (receipt, rental_id))
        self._rental_event(rental_id, "deposit_refunded",
                           {"amount_cents": amount, "receipt": receipt, "reason": reason},
                           actor_id)
        return receipt

    def _apply_location(self, vehicle_id: str, point_id: str, actor_id: str, *,
                        reason: str) -> None:
        old = self.get_vehicle(vehicle_id)
        if old["current_point_id"] == point_id:
            return
        self.conn.execute("UPDATE vehicles SET current_point_id=? WHERE id=?",
                          (point_id, vehicle_id))
        self._vehicle_event(vehicle_id, "location_changed",
                            {"from": old["current_point_id"], "to": point_id, "reason": reason},
                            actor_id)

    # ---------- 清洁队列 ----------

    def cleaning_queue(self) -> list[dict]:
        return [dict(r) for r in self.conn.execute(
            """SELECT v.id vehicle_id, v.current_point_id, sp.name point_name, r.id rental_id,
                      v.cleanliness, ve.created_at returned_at
               FROM vehicles v
               JOIN service_points sp ON sp.id=v.current_point_id
               LEFT JOIN rentals r ON r.vehicle_id=v.id AND r.status IN ('returned','disputed')
               LEFT JOIN vehicle_events ve ON ve.vehicle_id=v.id AND ve.event_type='returned'
               WHERE v.status='cleaning'
               ORDER BY ve.id DESC""")]

    def complete_cleaning(self, *, vehicle_id: str, actor_id: str, note: str = "") -> dict:
        """清洁消毒完成：车辆仍不可借，须主管安全复检通过后恢复 available。"""
        actor = self._require_actor(actor_id)
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                v = self.get_vehicle(vehicle_id)
                if v["status"] != "cleaning":
                    raise DomainError("not_cleaning",
                        f"车辆 {vehicle_id} 当前为 {v['status']}，不在清洁队列")
                self.conn.execute(
                    "UPDATE vehicles SET cleanliness='clean' WHERE id=?", (vehicle_id,))
                self._vehicle_event(vehicle_id, "cleaned",
                                    {"note": note, "awaiting": "safety_recheck"}, actor["id"])
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return {"vehicle_id": vehicle_id, "cleanliness": "clean",
                "message": "清洁消毒完成，等待点位主管安全复检"}

    # ---------- 安全复检（仅主管） ----------

    def safety_recheck(self, *, vehicle_id: str, actor_id: str, passed: bool,
                       brakes_ok: bool = True, note: str = "") -> dict:
        actor = self._require_actor(actor_id)
        if actor["role"] != "supervisor":
            raise DomainError("forbidden_supervisor_only",
                f"安全复检须由点位主管完成，{actor['name']}（{actor['role']}）无权操作")
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                v = self.get_vehicle(vehicle_id)
                if v["status"] not in ("cleaning", "maintenance"):
                    raise DomainError("bad_state",
                        f"车辆 {vehicle_id} 当前为 {v['status']}，无需安全复检")
                if v["cleanliness"] != "clean" and v["status"] == "cleaning":
                    raise DomainError("cleaning_blocked",
                        "清洁消毒尚未完成，安全复检不能通过（清洁阻断）")
                self.conn.execute(
                    """INSERT INTO inspections(vehicle_id,stage,passed,brakes_ok,harness_ok,
                           canopy_ok,rain_cover_ok,note,inspector)
                       VALUES(?,'safety_recheck',?,?,1,1,1,?,?)""",
                    (vehicle_id, int(passed), int(brakes_ok), note, actor["id"]))
                if passed:
                    self.conn.execute(
                        "UPDATE vehicles SET status='available', brakes_ok=1 WHERE id=?",
                        (vehicle_id,))
                    # 关闭该车所有未结维修单
                    self.conn.execute(
                        """UPDATE work_orders SET status='done', resolved_by=?,
                               resolved_at=? WHERE vehicle_id=? AND status!='done'""",
                        (actor["id"], _now().strftime("%Y-%m-%d %H:%M:%S"), vehicle_id))
                    self._vehicle_event(vehicle_id, "recheck_passed",
                                        {"note": note}, actor["id"])
                else:
                    self.conn.execute(
                        "UPDATE vehicles SET status='maintenance', brakes_ok=? WHERE id=?",
                        (int(brakes_ok), vehicle_id))
                    self.conn.execute(
                        "INSERT INTO work_orders(id,vehicle_id,issue,status,reported_by) "
                        "VALUES(?,?,?,'open',?)",
                        (f"WO-{vehicle_id}-{_now().strftime('%H%M%S')}", vehicle_id,
                         f"安全复检未通过：{note or '存在安全隐患'}", actor["id"]))
                    self._vehicle_event(vehicle_id, "recheck_failed",
                                        {"note": note}, actor["id"])
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return {"vehicle_id": vehicle_id, "passed": passed,
                "status": "available" if passed else "maintenance"}

    # ---------- 维修（员工可报修，主管修复） ----------

    def report_repair(self, *, vehicle_id: str, issue: str, actor_id: str) -> dict:
        """普通员工即可报修；车辆立即进入 maintenance，不参与调拨。"""
        actor = self._require_actor(actor_id)
        if not issue.strip():
            raise DomainError("issue_required", "请填写故障描述")
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                v = self.get_vehicle(vehicle_id)
                wo_id = f"WO-{vehicle_id}-{_now().strftime('%H%M%S')}"
                brake_issue = "刹车" in issue
                self.conn.execute(
                    "INSERT INTO work_orders(id,vehicle_id,issue,status,reported_by) "
                    "VALUES(?,?,?,'open',?)", (wo_id, vehicle_id, issue, actor["id"]))
                if v["status"] != "maintenance":
                    self.conn.execute(
                        "UPDATE vehicles SET status='maintenance', brakes_ok=? WHERE id=?",
                        (0 if brake_issue else v["brakes_ok"], vehicle_id))
                elif brake_issue:
                    self.conn.execute("UPDATE vehicles SET brakes_ok=0 WHERE id=?", (vehicle_id,))
                self._vehicle_event(vehicle_id, "repair_reported",
                                    {"work_order": wo_id, "issue": issue}, actor["id"])
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return {"work_order_id": wo_id}

    def resolve_repair(self, *, work_order_id: str, actor_id: str,
                       rain_cover_fitted: bool = False) -> dict:
        """主管完成维修 → 进入清洁队列（修后仍需清洁+复检才能再借）。"""
        actor = self._require_actor(actor_id)
        if actor["role"] != "supervisor":
            raise DomainError("forbidden_supervisor_only", "维修完工须由点位主管确认")
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                wo = self.conn.execute(
                    "SELECT * FROM work_orders WHERE id=?", (work_order_id,)).fetchone()
                if not wo:
                    raise DomainError("wo_not_found", f"工单 {work_order_id} 不存在")
                if wo["status"] == "done":
                    raise DomainError("bad_state", "工单已完成")
                vehicle_id = wo["vehicle_id"]
                self.conn.execute(
                    "UPDATE work_orders SET status='done', resolved_by=?, resolved_at=? WHERE id=?",
                    (actor["id"], _now().strftime("%Y-%m-%d %H:%M:%S"), work_order_id))
                self.conn.execute(
                    "UPDATE vehicles SET status='cleaning', cleanliness='dirty', brakes_ok=1,"
                    " rain_cover=? WHERE id=?", (int(rain_cover_fitted), vehicle_id))
                self._vehicle_event(vehicle_id, "repair_done",
                                    {"work_order": work_order_id,
                                     "rain_cover_fitted": rain_cover_fitted}, actor["id"])
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return {"work_order_id": work_order_id, "vehicle_status": "cleaning"}

    # ---------- 调拨（跨点） ----------

    def transfer(self, *, vehicle_id: str, to_point_id: str, actor_id: str) -> dict:
        """人工调拨：维修中车辆禁止调拨；目标点满仓拒绝。"""
        actor = self._require_actor(actor_id)
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                v = self.get_vehicle(vehicle_id)
                dest = self.get_point(to_point_id)
                if v["status"] == "maintenance":
                    raise DomainError("maintenance_no_transfer",
                        f"车辆 {vehicle_id} 维修中，不能调拨，请完工后再调")
                if v["status"] == "on_rent" or v["status"] == "reserved":
                    raise DomainError("in_use_no_transfer",
                        f"车辆 {vehicle_id} 状态为 {v['status']}，不能调拨")
                if v["current_point_id"] == to_point_id:
                    raise DomainError("same_point", "车辆已在该点位")
                if self._point_occupancy(to_point_id) >= dest["capacity"]:
                    raise DomainError("cross_point_full",
                        f"{dest['name']} 仓位已满（{dest['capacity']} 个位），无法调入")
                old = v["current_point_id"]
                self.conn.execute(
                    "UPDATE vehicles SET current_point_id=? WHERE id=?", (to_point_id, vehicle_id))
                self._vehicle_event(vehicle_id, "transferred",
                                    {"from": old, "to": to_point_id}, actor["id"])
                self.conn.execute(
                    "INSERT INTO transfer_reminders(vehicle_id,from_point,to_point,reason,status)"
                    " VALUES(?,?,?,?,'done')",
                    (vehicle_id, old, to_point_id, "人工调拨"))
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return {"vehicle_id": vehicle_id, "current_point_id": to_point_id}

    # ---------- 押金复核（主管） ----------

    def review_deposit(self, *, rental_id: str, actor_id: str, deduct_cents: int,
                       note: str = "") -> dict:
        """主管处理押金争议：deduct_cents=0 全额退，>0 扣除后退余额。"""
        actor = self._require_actor(actor_id)
        if actor["role"] != "supervisor":
            raise DomainError("forbidden_supervisor_only", "押金复核须点位主管处理")
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                r = self.conn.execute("SELECT * FROM rentals WHERE id=?", (rental_id,)).fetchone()
                if not r:
                    raise DomainError("rental_not_found", f"租借单 {rental_id} 不存在")
                if r["status"] != "disputed":
                    raise DomainError("not_disputed",
                        f"租借单状态为 {r['status']}，无需押金复核")
                if deduct_cents < 0 or deduct_cents > r["deposit_cents"]:
                    raise DomainError("bad_amount",
                        f"扣除金额须在 0 与押金 ¥{r['deposit_cents']/100:.0f} 之间")
                if deduct_cents:
                    receipt_d = self.payment.deduct_deposit(rental_id, deduct_cents)
                    self.conn.execute(
                        "INSERT INTO payments(id,rental_id,kind,amount_cents,status,receipt_no,"
                        "idempotency_key) VALUES(?,?, 'deposit_deduct', ?, 'ok', ?, ?)",
                        (f"P-{rental_id}-D", rental_id, deduct_cents, receipt_d,
                         f"deduct:{rental_id}"))
                refund_receipt = self._refund(
                    r, actor["id"], amount=r["deposit_cents"] - deduct_cents,
                    reason=f"主管复核：扣 ¥{deduct_cents/100:.2f}。{note}")
                self.conn.execute(
                    "UPDATE rentals SET status='returned' WHERE id=?", (rental_id,))
                self._rental_event(rental_id, "deposit_reviewed",
                                   {"deduct_cents": deduct_cents, "note": note,
                                    "refund": refund_receipt}, actor["id"])
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return {"rental_id": rental_id, "deduct_cents": deduct_cents,
                "refund_ref": refund_receipt}

    # ---------- 损伤照片 ----------

    def save_damage_photo(self, *, vehicle_id: str, rental_id: str | None,
                          filename: str, data: bytes, note: str = "") -> dict:
        import os
        self.get_vehicle(vehicle_id)
        os.makedirs(self.photo_dir, exist_ok=True)
        safe = os.path.basename(filename).replace("..", "_")
        stored = f"{vehicle_id}_{_now().strftime('%Y%m%d%H%M%S')}_{safe}"
        path = os.path.join(self.photo_dir, stored)
        with open(path, "wb") as f:
            f.write(data)
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                cur = self.conn.execute(
                    "INSERT INTO damage_photos(vehicle_id,rental_id,file_name,note) VALUES(?,?,?,?)",
                    (vehicle_id, rental_id, stored, note))
                pid = cur.lastrowid
                self._vehicle_event(vehicle_id, "damage_photo",
                                    {"file": stored, "note": note})
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return {"photo_id": pid, "file_name": stored}

    def list_damage_photos(self, vehicle_id: str | None = None) -> list[dict]:
        sql = "SELECT * FROM damage_photos"
        args: tuple = ()
        if vehicle_id:
            sql += " WHERE vehicle_id=?"
            args = (vehicle_id,)
        sql += " ORDER BY id DESC"
        return [dict(r) for r in self.conn.execute(sql, args)]

    # ---------- 后台任务：超时扫描 ----------

    def scan_overdue(self) -> list[str]:
        """超过应还时间 + 宽限仍未归还的单子置 overdue。由进程内定时任务调用。"""
        flagged: list[str] = []
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                rows = self.conn.execute(
                    "SELECT * FROM rentals WHERE status='active'").fetchall()
                for r in rows:
                    deadline = datetime.strptime(r["booked_to"], "%Y-%m-%d %H:%M") \
                        + timedelta(minutes=OVERDUE_GRACE_MIN)
                    if _now() > deadline:
                        self.conn.execute(
                            "UPDATE rentals SET status='overdue' WHERE id=?", (r["id"],))
                        self._rental_event(r["id"], "marked_overdue",
                                           {"booked_to": r["booked_to"],
                                            "grace_min": OVERDUE_GRACE_MIN}, "system")
                        flagged.append(r["id"])
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return flagged

    # ---------- 后台任务：调拨提醒 ----------

    def scan_transfer_needs(self) -> list[dict]:
        """缺车点位（0 辆可借）且其他点有闲置可借车时，生成一条调拨提醒。

        维修中车辆永不进入提醒；满仓目标点不生成。
        """
        reminders: list[dict] = []
        with self._lock:
            inv = self.inventory()
            for p in inv:
                if p["available"] == 0 and not p["full"]:
                    cand = self.conn.execute(
                        """SELECT * FROM vehicles WHERE status='available'
                           AND current_point_id!=? ORDER BY id LIMIT 1""",
                        (p["id"],)).fetchone()
                    if cand:
                        exists = self.conn.execute(
                            "SELECT id FROM transfer_reminders WHERE vehicle_id=? AND to_point=? "
                            "AND status='pending'", (cand["id"], p["id"])).fetchone()
                        if not exists:
                            cur = self.conn.execute(
                                "INSERT INTO transfer_reminders(vehicle_id,from_point,to_point,"
                                "reason) VALUES(?,?,?,'目标点无可借车辆')",
                                (cand["id"], cand["current_point_id"], p["id"]))
                            reminders.append({"id": cur.lastrowid, "vehicle_id": cand["id"],
                                              "from_point": cand["current_point_id"],
                                              "to_point": p["id"]})
            self.conn.commit()
        return reminders

    def pending_transfer_reminders(self) -> list[dict]:
        return [dict(r) for r in self.conn.execute(
            """SELECT t.*, v.id vid FROM transfer_reminders t
               JOIN vehicles v ON v.id=t.vehicle_id
               WHERE t.status='pending' ORDER BY t.id DESC""")]
