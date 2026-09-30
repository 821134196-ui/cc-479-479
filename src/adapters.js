'use strict';
// 模拟适配器：扫码枪与付款渠道。真实部署时替换为硬件/支付网关实现，接口保持不变。
function createAdapters() {
  const receipts = new Map(); // key -> receiptNo，退款按 key 幂等
  const stats = { chargeCalls: 0, refundCalls: 0, scanCalls: 0 };

  return {
    stats,
    scanner: {
      // 模拟扫码：终端扫车辆/租借单二维码
      scan(code) {
        stats.scanCalls += 1;
        return { code: String(code).trim(), raw: `MOCK-SCAN:${code}`, at: new Date().toISOString() };
      },
    },
    payment: {
      // 收取押金（样例游客、样例付款）
      chargeDeposit({ rentalCode, amount, touristName }) {
        stats.chargeCalls += 1;
        const receiptNo = `PAY-${rentalCode}`;
        receipts.set(`pay:${rentalCode}`, receiptNo);
        return { receiptNo, amount, channel: 'mock-pay', status: 'paid', payer: touristName };
      },
      // 退款：同一 key 重复调用返回同一回执，不会重复出款
      refund({ key, amount, reason }) {
        stats.refundCalls += 1;
        const k = `ref:${key}`;
        if (receipts.has(k)) {
          return { receiptNo: receipts.get(k), amount, channel: 'mock-pay', status: 'refunded', duplicate: true, reason };
        }
        const receiptNo = `REF-${key}`;
        receipts.set(k, receiptNo);
        return { receiptNo, amount, channel: 'mock-pay', status: 'refunded', reason };
      },
    },
  };
}

module.exports = { createAdapters };
