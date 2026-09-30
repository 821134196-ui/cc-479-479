"""模拟适配器：车辆二维码扫码 + 第三方付款回执。

真实环境中这两个适配器会走硬件 SDK / 支付网关；
此处全部本地模拟，付款回执带幂等键，重复退款不会重复出账。
"""
from __future__ import annotations

import itertools
import threading
from datetime import datetime


class ScanError(Exception):
    """扫码失败（码损坏 / 非本平台车辆）。"""


class PaymentError(Exception):
    """支付渠道返回失败。"""


class ScanAdapter:
    """模拟扫码枪：校验二维码格式 VHC-<车辆编号>。"""

    PREFIX = "VHC-"

    def scan(self, qr_code: str) -> str:
        if not qr_code or not qr_code.startswith(self.PREFIX):
            raise ScanError(f"二维码无效：{qr_code!r}（应以 {self.PREFIX} 开头）")
        vehicle_id = qr_code[len(self.PREFIX):]
        # 样例：损坏码
        if vehicle_id in {"BADCODE", "???"}:
            raise ScanError("二维码污损，无法识别，请手动输入车辆编号")
        return vehicle_id


class PaymentAdapter:
    """模拟支付渠道：押金预授权 / 退款 / 扣款，均给回执号。

    用 idempotency_key 保证同一笔退款只出账一次。
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._seq = itertools.count(1)
        self._seen_keys: dict[str, str] = {}  # idempotency_key -> receipt_no
        # 测试钩子：可让下一笔交易失败
        self.fail_next = False

    def _receipt(self, kind: str) -> str:
        ts = datetime.now().strftime("%Y%m%d%H%M%S")
        return f"SIM-{kind[:3].upper()}-{ts}-{next(self._seq):04d}"

    def _submit(self, kind: str, amount_cents: int, idempotency_key: str | None) -> str:
        with self._lock:
            if self.fail_next:
                self.fail_next = False
                raise PaymentError("支付渠道超时，请稍后重试")
            if idempotency_key and idempotency_key in self._seen_keys:
                # 渠道侧幂等：返回首次回执，不重复出账
                return self._seen_keys[idempotency_key]
            receipt = self._receipt(kind)
            if idempotency_key:
                self._seen_keys[idempotency_key] = receipt
            return receipt

    def hold_deposit(self, rental_id: str, amount_cents: int) -> str:
        return self._submit("HOLD", amount_cents, f"hold:{rental_id}")

    def refund_deposit(self, rental_id: str, amount_cents: int) -> str:
        # 退款幂等键固定绑定租借单：重复归还/重复复核拿到同一张回执
        return self._submit("REFUND", amount_cents, f"refund:{rental_id}")

    def deduct_deposit(self, rental_id: str, amount_cents: int) -> str:
        return self._submit("DEDUCT", amount_cents, f"deduct:{rental_id}")
