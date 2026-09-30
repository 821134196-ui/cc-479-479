"""领域规则测试：库存竞争、资格校验、清洁阻断、跨点归属、退款幂等等。

直接覆盖要求的五类关键场景，全部使用临时目录中的 SQLite 文件库，
并发用例通过多连接 + 共享适配器/锁模拟两个终端。
"""
from __future__ import annotations

import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path

from stroller.adapters import PaymentAdapter
from stroller.db import connect, init_db
from stroller.seed import seed
from stroller.service import DomainError, StrollerService


class ServiceTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.db_path = root / "test.db"
        self.photo_dir = str(root / "photos")
        self.conn = connect(self.db_path)
        seed(self.conn, self.photo_dir)
        self.payment = PaymentAdapter()
        self.svc = StrollerService(self.conn, self.photo_dir, payment=self.payment)

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp.cleanup()

    def new_service(self) -> StrollerService:
        """模拟另一个终端：独立连接，共享支付适配器与进程锁。"""
        return StrollerService(connect(self.db_path), self.photo_dir,
                               payment=self.payment, shared_lock=self.svc._lock)

    # -- 辅助：快速走完整借出流程 --
    def checkout(self, svc, vehicle_id, point_id, *, actor="E01", weight=12,
                 name="测试游客（样例）") -> str:
        svc.pre_rent_inspection(vehicle_id=vehicle_id, pickup_point_id=point_id,
                                brakes_ok=True, harness_ok=True, canopy_ok=True,
                                rain_cover_ok=True, actor_id=actor)
        r = svc.lock_vehicle(vehicle_id=vehicle_id, visitor_id="V-T",
                             visitor_name=name, visitor_weight=weight,
                             pickup_point_id=point_id, actor_id=actor)
        svc.sign_and_checkout(rental_id=r["rental_id"], signature=name, actor_id=actor)
        return r["rental_id"]

    def clean_and_recheck(self, svc, vehicle_id, *, actor_staff="E01",
                          actor_sup="M01") -> None:
        svc.complete_cleaning(vehicle_id=vehicle_id, actor_id=actor_staff)
        svc.safety_recheck(vehicle_id=vehicle_id, actor_id=actor_sup, passed=True)


class TestInventoryRace(ServiceTestBase):
    """最后一辆车被两处终端请求时仅一笔成功。"""

    def test_two_terminals_only_one_wins(self) -> None:
        # S-001 是南门最后可借车的竞争对象：先把其他可借车清走
        for vid in ["S-002", "S-003", "S-004"]:
            self.svc.report_repair(vehicle_id=vid, issue="占用：例行检修", actor_id="E01")
        # S-005 雨罩缺失本来就借不出
        results: list[str] = []
        barrier = threading.Barrier(2)

        def terminal(tag: str) -> None:
            svc = self.new_service()
            try:
                svc.pre_rent_inspection(
                    vehicle_id="S-001", pickup_point_id="P-GATE",
                    brakes_ok=True, harness_ok=True, canopy_ok=True,
                    rain_cover_ok=True, actor_id="E01")
                barrier.wait()  # 同时点下锁定
                r = svc.lock_vehicle(
                    vehicle_id="S-001", visitor_id=f"V-{tag}",
                    visitor_name=f"游客{tag}（样例）", visitor_weight=10,
                    pickup_point_id="P-GATE", actor_id="E01")
                results.append("win:" + r["rental_id"])
            except DomainError as e:
                results.append("lose:" + e.code)

        t1 = threading.Thread(target=terminal, args=("A",))
        t2 = threading.Thread(target=terminal, args=("B",))
        t1.start(); t2.start(); t1.join(); t2.join()

        wins = [r for r in results if r.startswith("win:")]
        loses = [r for r in results if r.startswith("lose:")]
        self.assertEqual(len(wins), 1, f"应只有一笔成功，实际 {results}")
        self.assertEqual(len(loses), 1)
        self.assertEqual(loses[0], "lose:no_stock")
        row = self.conn.execute(
            "SELECT status FROM vehicles WHERE id='S-001'").fetchone()
        self.assertEqual(row["status"], "reserved")
        holds = self.conn.execute(
            "SELECT COUNT(*) c FROM payments p JOIN rentals r ON r.id=p.rental_id "
            "WHERE p.kind='deposit_hold' AND r.vehicle_id='S-001'").fetchone()["c"]
        self.assertEqual(holds, 1, "输家不得产生押金流水")

    def test_sold_out_point_has_no_available(self) -> None:
        inv = {p["id"]: p for p in self.svc.inventory()}
        self.assertEqual(inv["P-HILL"]["available"], 0)
        self.assertTrue(inv["P-HILL"]["available"] == 0)


class TestEligibility(ServiceTestBase):
    """体重不符 / 雨罩缺失 / 刹车异常的处理路径。"""

    def test_weight_exceeded_rejected(self) -> None:
        r = self.svc.check_eligibility("S-001", 18, "P-GATE")  # 上限 15kg
        self.assertFalse(r["eligible"])
        self.assertIn("weight_exceeded", [p["code"] for p in r["problems"]])
        with self.assertRaises(DomainError) as cm:
            self.svc.pre_rent_inspection(
                vehicle_id="S-001", pickup_point_id="P-GATE",
                brakes_ok=True, harness_ok=True, canopy_ok=True,
                rain_cover_ok=True, actor_id="E01")
            self.svc.lock_vehicle(
                vehicle_id="S-001", visitor_id="V-T", visitor_name="重宝宝（样例）",
                visitor_weight=18, pickup_point_id="P-GATE", actor_id="E01")
        self.assertEqual(cm.exception.code, "weight_exceeded")
        self.assertEqual(self.svc.get_vehicle("S-001")["status"], "available")

    def test_rain_cover_missing_blocks_rent(self) -> None:
        # S-005 雨罩缺失
        self.svc.pre_rent_inspection(
            vehicle_id="S-005", pickup_point_id="P-GATE",
            brakes_ok=True, harness_ok=True, canopy_ok=True,
            rain_cover_ok=True, actor_id="E01")
        with self.assertRaises(DomainError) as cm:
            self.svc.lock_vehicle(
                vehicle_id="S-005", visitor_id="V-T", visitor_name="游客（样例）",
                visitor_weight=12, pickup_point_id="P-GATE", actor_id="E01")
        self.assertEqual(cm.exception.code, "rain_cover_missing")
        # 车辆保持可借状态（已解锁），无押金流水
        self.assertEqual(self.svc.get_vehicle("S-005")["status"], "available")

    def test_brake_fault_blocks_rent_and_reports(self) -> None:
        # 员工借出检查时发现刹车异常 → 挂维修 + 工单
        with self.assertRaises(DomainError) as cm:
            self.svc.pre_rent_inspection(
                vehicle_id="S-001", pickup_point_id="P-GATE",
                brakes_ok=False, harness_ok=True, canopy_ok=True,
                rain_cover_ok=True, actor_id="E01")
        self.assertEqual(cm.exception.code, "inspection_failed")
        v = self.svc.get_vehicle("S-001")
        self.assertEqual(v["status"], "maintenance")
        self.assertEqual(v["brakes_ok"], 0)
        wo = self.conn.execute(
            "SELECT COUNT(*) c FROM work_orders WHERE vehicle_id='S-001' "
            "AND status='open'").fetchone()["c"]
        self.assertGreaterEqual(wo, 1)
        # 维修中禁止调拨
        with self.assertRaises(DomainError) as cm2:
            self.svc.transfer(vehicle_id="S-001", to_point_id="P-HILL", actor_id="E01")
        self.assertEqual(cm2.exception.code, "maintenance_no_transfer")


class TestCleaningBlock(ServiceTestBase):
    """归还后必须 清洁完成 + 主管复检通过 才可再借。"""

    def test_cleaning_vehicle_not_borrowable(self) -> None:
        rid = self.checkout(self.svc, "S-001", "P-GATE")
        self.svc.return_rental(rental_id=rid, return_point_id="P-GATE",
                               actor_id="E01", appearance_ok=True, accessories_ok=True)
        v = self.svc.get_vehicle("S-001")
        self.assertEqual(v["status"], "cleaning")
        self.assertEqual(v["cleanliness"], "dirty")
        # 待清洁车不能做借出检查
        with self.assertRaises(DomainError) as cm:
            self.svc.pre_rent_inspection(
                vehicle_id="S-001", pickup_point_id="P-GATE",
                brakes_ok=True, harness_ok=True, canopy_ok=True,
                rain_cover_ok=True, actor_id="E01")
        self.assertEqual(cm.exception.code, "not_available")

    def test_cleaning_done_still_needs_recheck(self) -> None:
        rid = self.checkout(self.svc, "S-001", "P-GATE")
        self.svc.return_rental(rental_id=rid, return_point_id="P-GATE",
                               actor_id="E01", appearance_ok=True, accessories_ok=True)
        self.svc.complete_cleaning(vehicle_id="S-001", actor_id="E02")
        # 仅清洁完成仍是 cleaning，不可借
        self.assertEqual(self.svc.get_vehicle("S-001")["status"], "cleaning")

    def test_staff_cannot_recheck(self) -> None:
        rid = self.checkout(self.svc, "S-001", "P-GATE")
        self.svc.return_rental(rental_id=rid, return_point_id="P-GATE",
                               actor_id="E01", appearance_ok=True, accessories_ok=True)
        self.svc.complete_cleaning(vehicle_id="S-001", actor_id="E02")
        with self.assertRaises(DomainError) as cm:
            self.svc.safety_recheck(vehicle_id="S-001", actor_id="E01", passed=True)
        self.assertEqual(cm.exception.code, "forbidden_supervisor_only")

    def test_recheck_requires_cleaning_done(self) -> None:
        # 种子里的 S-007 在清洁中且未清洁 → 主管复检也不能放行
        with self.assertRaises(DomainError) as cm:
            self.svc.safety_recheck(vehicle_id="S-007", actor_id="M01", passed=True)
        self.assertEqual(cm.exception.code, "cleaning_blocked")

    def test_full_cycle_returns_available(self) -> None:
        rid = self.checkout(self.svc, "S-002", "P-GATE")
        self.svc.return_rental(rental_id=rid, return_point_id="P-GATE",
                               actor_id="E01", appearance_ok=True, accessories_ok=True)
        self.clean_and_recheck(self.svc, "S-002")
        self.assertEqual(self.svc.get_vehicle("S-002")["status"], "available")

    def test_staff_can_report_repair_supervisor_resolves(self) -> None:
        self.svc.report_repair(vehicle_id="S-003", issue="安全带卡扣松", actor_id="E02")
        wo = self.conn.execute(
            "SELECT id FROM work_orders WHERE vehicle_id='S-003' AND status!='done'"
        ).fetchone()["id"]
        # 员工不能完工
        with self.assertRaises(DomainError):
            self.svc.resolve_repair(work_order_id=wo, actor_id="E02")
        self.svc.resolve_repair(work_order_id=wo, actor_id="M01")
        # 维修完工 → 清洁 → 复检 → 可借
        self.assertEqual(self.svc.get_vehicle("S-003")["status"], "cleaning")
        self.clean_and_recheck(self.svc, "S-003")
        self.assertEqual(self.svc.get_vehicle("S-003")["status"], "available")


class TestCrossPoint(ServiceTestBase):
    """跨点归还改变归属；满仓拒绝；维修中不可调拨。"""

    def test_cross_return_changes_location(self) -> None:
        rid = self.checkout(self.svc, "S-001", "P-GATE")
        res = self.svc.return_rental(
            rental_id=rid, return_point_id="P-HILL", actor_id="E01",
            appearance_ok=True, accessories_ok=True)
        self.assertEqual(res["status"], "returned")
        self.assertEqual(self.svc.get_vehicle("S-001")["current_point_id"], "P-HILL")
        # 事件流留痕
        ev = self.conn.execute(
            "SELECT detail FROM vehicle_events WHERE vehicle_id='S-001' "
            "AND event_type='location_changed' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        self.assertIn("P-HILL", ev["detail"])

    def test_cross_return_full_warehouse_rejected(self) -> None:
        # P-ZOO 满仓（3/3）；借一辆南门的车还过去应被拒
        rid = self.checkout(self.svc, "S-002", "P-GATE")
        with self.assertRaises(DomainError) as cm:
            self.svc.return_rental(
                rental_id=rid, return_point_id="P-ZOO", actor_id="E01",
                appearance_ok=True, accessories_ok=True)
        self.assertEqual(cm.exception.code, "cross_point_full")
        # 车辆仍在租，归属未变，押金未退
        self.assertEqual(self.svc.get_vehicle("S-002")["status"], "on_rent")
        r = self.conn.execute("SELECT * FROM rentals WHERE id=?", (rid,)).fetchone()
        self.assertEqual(r["deposit_refunded"], 0)
        alts = cm.exception.extra["alternatives"]
        self.assertTrue(any(a["id"] == "P-HILL" for a in alts))

    def test_transfer_to_full_rejected(self) -> None:
        with self.assertRaises(DomainError) as cm:
            self.svc.transfer(vehicle_id="S-001", to_point_id="P-ZOO", actor_id="E01")
        self.assertEqual(cm.exception.code, "cross_point_full")

    def test_transfer_reminder_skips_maintenance(self) -> None:
        # P-HILL 缺车，候选只能是 available；把 S-001/S-002/S-003/S-004 全报修后，
        # S-005（雨罩缺失但仍 available）会成为候选 —— 再把它也报修，
        # 则仅剩湖畔 S-101 可推荐，维修车 S-006 绝不出现。
        for vid in ["S-001", "S-002", "S-003", "S-004", "S-005"]:
            self.svc.report_repair(vehicle_id=vid, issue="占用", actor_id="E01")
        reminders = self.svc.scan_transfer_needs()
        self.assertTrue(reminders)
        for rem in reminders:
            self.assertNotIn(rem["vehicle_id"], {"S-006", "S-202"})


class TestDepositRefund(ServiceTestBase):
    """退款幂等：重复归还不得再次退款。"""

    def test_duplicate_return_no_double_refund(self) -> None:
        rid = self.checkout(self.svc, "S-001", "P-GATE")
        first = self.svc.return_rental(
            rental_id=rid, return_point_id="P-GATE", actor_id="E01",
            appearance_ok=True, accessories_ok=True)
        self.assertEqual(first["status"], "returned")
        receipt1 = first["refund_ref"]

        # 另一终端重复发起归还
        svc2 = self.new_service()
        second = svc2.return_rental(
            rental_id=rid, return_point_id="P-GATE", actor_id="E02",
            appearance_ok=True, accessories_ok=True)
        self.assertTrue(second["idempotent"])
        self.assertEqual(second["refund_ref"], receipt1)

        # 退款流水恰好一条，金额等于押金
        refunds = self.conn.execute(
            "SELECT * FROM payments WHERE rental_id=? AND kind='deposit_refund'",
            (rid,)).fetchall()
        self.assertEqual(len(refunds), 1)
        self.assertEqual(refunds[0]["amount_cents"], 30000)

    def test_payment_adapter_idempotency_key(self) -> None:
        r1 = self.payment.refund_deposit("RX", 30000)
        r2 = self.payment.refund_deposit("RX", 30000)
        self.assertEqual(r1, r2)

    def test_dispute_freezes_deposit_then_supervisor_reviews(self) -> None:
        rid = self.checkout(self.svc, "S-003", "P-GATE")
        res = self.svc.return_rental(
            rental_id=rid, return_point_id="P-GATE", actor_id="E01",
            appearance_ok=True, accessories_ok=True, dispute=True,
            damage_note="游客不认可篷布划痕赔偿")
        self.assertEqual(res["status"], "disputed")
        self.assertEqual(self.svc.get_vehicle("S-003")["status"], "cleaning")
        row = self.conn.execute("SELECT deposit_refunded FROM rentals WHERE id=?",
                                (rid,)).fetchone()
        self.assertEqual(row["deposit_refunded"], 0)
        # 员工不能复核
        with self.assertRaises(DomainError):
            self.svc.review_deposit(rental_id=rid, actor_id="E01", deduct_cents=0)
        # 主管扣 80 元，退 220
        out = self.svc.review_deposit(rental_id=rid, actor_id="M01",
                                      deduct_cents=8000, note="篷布划痕赔 80")
        refunds = self.conn.execute(
            "SELECT amount_cents FROM payments WHERE rental_id=? AND kind='deposit_refund'",
            (rid,)).fetchall()
        self.assertEqual(len(refunds), 1)
        self.assertEqual(refunds[0]["amount_cents"], 22000)
        self.assertTrue(out["refund_ref"])

    def test_overdue_charges_fee_once(self) -> None:
        # 种子超时单 R-SEED-OVE：扫描置 overdue 后归还，扣 ¥50 退 ¥250
        self.svc.scan_overdue()
        res = self.svc.return_rental(
            rental_id="R-SEED-OVE", return_point_id="P-LAKE", actor_id="E02",
            appearance_ok=True, accessories_ok=True)
        self.assertEqual(res["status"], "returned")
        self.assertEqual(res["fee_cents"], 5000)
        refund = self.conn.execute(
            "SELECT amount_cents FROM payments WHERE rental_id='R-SEED-OVE' "
            "AND kind='deposit_refund'").fetchone()
        self.assertEqual(refund["amount_cents"], 25000)
        # 重复归还幂等，不产生新扣费
        again = self.new_service().return_rental(
            rental_id="R-SEED-OVE", return_point_id="P-LAKE", actor_id="E02",
            appearance_ok=True, accessories_ok=True)
        self.assertTrue(again["idempotent"])
        deducts = self.conn.execute(
            "SELECT COUNT(*) c FROM payments WHERE rental_id='R-SEED-OVE' "
            "AND kind='deposit_deduct'").fetchone()["c"]
        self.assertEqual(deducts, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
