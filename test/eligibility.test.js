'use strict';
// 资格校验：体重不符拒绝并释放车辆；雨罩缺失的处理路径
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld } = require('./helpers');

test('体重超过适用上限：拒绝借出并给出换车建议，车辆释放回可借', () => {
  const { service } = makeWorld();
  const lock = service.beginCheckout({ vehicleCode: 'ST-A1', pointId: 1, staff: 's' }); // 上限 22kg
  assert.throws(
    () => service.confirmCheckout({
      lockToken: lock.lockToken, touristName: '重游客', touristPhone: '139',
      childWeightKg: 25, period: '2h', checks: { brakeOk: true, beltOk: true, accessoriesOk: true }, staff: 's',
    }),
    (e) => e.code === 'WEIGHT_EXCEEDED'
  );
  // 车辆已释放，可再次锁定
  const again = service.beginCheckout({ vehicleCode: 'ST-A1', pointId: 1, staff: 's' });
  assert.ok(again.lockToken);
  // 体重合格则借出成功
  const ok = service.confirmCheckout({
    lockToken: again.lockToken, touristName: '合格游客', touristPhone: '139',
    childWeightKg: 20, period: '2h', checks: { brakeOk: true, beltOk: true, accessoriesOk: true }, staff: 's',
  });
  assert.equal(ok.rental.status, 'active');
  assert.equal(ok.rental.deposit_status, 'held');
  assert.match(ok.receipt.receiptNo, /^PAY-/);
});

test('刹车异常：借出检查不通过 → 自动下架并生成维修工单', () => {
  const { service } = makeWorld();
  const lock = service.beginCheckout({ vehicleCode: 'ST-A1', pointId: 1, staff: 's' });
  assert.throws(
    () => service.confirmCheckout({
      lockToken: lock.lockToken, touristName: '某游客', touristPhone: '139',
      childWeightKg: 10, period: '2h', checks: { brakeOk: false, beltOk: true, accessoriesOk: true }, staff: 's',
    }),
    (e) => e.code === 'BRAKE_FAULT'
  );
  const v = service.getVehicle('ST-A1');
  assert.equal(v.status, 'repair');
  const repairs = service.listRepairs();
  assert.equal(repairs.length, 1);
  assert.match(repairs[0].issue, /刹车异常/);
});

test('雨罩缺失：需游客确认「无雨罩继续」，归还时豁免该配件扣款', () => {
  const { service } = makeWorld();
  const lock = service.beginCheckout({ vehicleCode: 'ST-A1', pointId: 1, staff: 's' }); // 该车应有雨罩
  // 未确认 → 拒绝，但保留锁定等待终端二次确认
  assert.throws(
    () => service.confirmCheckout({
      lockToken: lock.lockToken, touristName: '某游客', touristPhone: '139',
      childWeightKg: 10, period: '2h', checks: { brakeOk: true, beltOk: true, accessoriesOk: true, rainCoverOk: false }, staff: 's',
    }),
    (e) => e.code === 'RAIN_COVER_MISSING' && e.details.canAccept === true
  );
  // 游客确认无雨罩继续
  const ok = service.confirmCheckout({
    lockToken: lock.lockToken, touristName: '某游客', touristPhone: '139',
    childWeightKg: 10, period: '2h', checks: { brakeOk: true, beltOk: true, accessoriesOk: true, rainCoverOk: false },
    acceptNoRainCover: true, staff: 's',
  });
  assert.equal(ok.rental.status, 'active');
  assert.deepEqual(JSON.parse(ok.rental.waived_accessories), ['rain_cover']);
  // 归还时报「雨罩缺失」不计扣款（借出时已豁免）
  const ret = service.returnRental({ rentalCode: ok.rental.code, pointId: 1, staff: 's', missingAccessories: ['rain_cover'] });
  assert.equal(ret.deduction, 0);
  assert.equal(ret.refund.amount, 20000);
});
