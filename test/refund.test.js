'use strict';
// 退款幂等：重复归还不再次退款；超时与遗失配件从押金扣减
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld } = require('./helpers');

const T0 = '2026-09-30T08:00:00.000Z';
const plus = (h) => new Date(new Date(T0).getTime() + h * 3600 * 1000).toISOString();

function rentAt(service, vehicleCode, pointId, now) {
  const lock = service.beginCheckout({ vehicleCode, pointId, staff: 's' }, now);
  const { rental } = service.confirmCheckout({
    lockToken: lock.lockToken, touristName: '退款游客', touristPhone: '139',
    childWeightKg: 10, period: '2h', checks: { brakeOk: true, beltOk: true, accessoriesOk: true }, staff: 's',
  }, now);
  return rental;
}

test('重复归还：押金只退一次，第二次返回同一回执', () => {
  const { service, adapters } = makeWorld();
  const rental = rentAt(service, 'ST-A1', 1, T0);

  const first = service.returnRental({ rentalCode: rental.code, pointId: 1, staff: 's' }, plus(1));
  assert.equal(first.alreadyReturned, false);
  assert.equal(first.refund.amount, 20000);
  assert.match(first.refund.receiptNo, /^REF-/);
  assert.equal(adapters.stats.refundCalls, 1);

  // 重复归还（终端重试 / 网络重发）：不得再次退款
  const second = service.returnRental({ rentalCode: rental.code, pointId: 1, staff: 's' }, plus(1.1));
  assert.equal(second.alreadyReturned, true);
  assert.equal(second.refund.receiptNo, first.refund.receiptNo, '应返回同一退款回执');
  assert.equal(adapters.stats.refundCalls, 1, '退款适配器不应被再次调用');

  const r = service.listRentals('returned').find((x) => x.code === rental.code);
  assert.equal(r.deposit_status, 'refunded');
  assert.equal(r.refund_receipt, first.refund.receiptNo);
});

test('游客超时与遗失配件：从押金扣减后部分退款', () => {
  const { service } = makeWorld();
  const rental = rentAt(service, 'ST-A1', 1, T0); // 2h 时段，到期 T0+2h
  // T0+3.2h 归还：超时 72 分钟 → 3 个计费单位 × ¥10 = ¥30；遗失配件 1 件 ¥50
  const ret = service.returnRental(
    { rentalCode: rental.code, pointId: 1, staff: 's', missingAccessories: ['canopy_clip'] },
    plus(3.2)
  );
  assert.equal(ret.overtime.minutes, 72);
  assert.equal(ret.overtime.fee, 3000);
  assert.equal(ret.deduction, 3000 + 5000);
  assert.equal(ret.refund.amount, 20000 - 8000);
  const r = service.listRentals('returned')[0];
  assert.equal(r.deposit_status, 'partial_refunded');
  assert.deepEqual(JSON.parse(r.missing_accessories), ['canopy_clip']);
});

test('进程内任务：到期未还标记超时并生成提醒（去重）', () => {
  const { service } = makeWorld();
  rentAt(service, 'ST-A1', 1, T0);
  const r1 = service.tick(plus(2.5));
  assert.equal(r1.overdue, 1);
  assert.equal(service.listRentals('overdue').length, 1);
  const notes = service.listNotifications();
  assert.ok(notes.some((n) => n.type === 'overdue'));
  // 再次 tick 不重复提醒
  service.tick(plus(2.6));
  const overdueNotes = service.listNotifications().filter((n) => n.type === 'overdue');
  assert.equal(overdueNotes.length, 1);
});
