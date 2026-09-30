'use strict';
// 清洁阻断：归还后必须完成清洁并通过主管安全复检，车辆才恢复可借
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld } = require('./helpers');

function rentAndReturn(service) {
  const lock = service.beginCheckout({ vehicleCode: 'ST-A1', pointId: 1, staff: 's' });
  const { rental } = service.confirmCheckout({
    lockToken: lock.lockToken, touristName: '周转游客', touristPhone: '139',
    childWeightKg: 10, period: '2h', checks: { brakeOk: true, beltOk: true, accessoriesOk: true }, staff: 's',
  });
  service.returnRental({ rentalCode: rental.code, pointId: 1, staff: 's' });
  return rental;
}

test('归还 → 待清洁 → 清洁中 → 待复检 → 主管复检通过 → 恢复可借', () => {
  const { service } = makeWorld();
  rentAndReturn(service);

  // 待清洁：不可借
  assert.equal(service.getVehicle('ST-A1').status, 'pending_clean');
  assert.throws(() => service.beginCheckout({ vehicleCode: 'ST-A1', pointId: 1, staff: 's' }),
    (e) => e.code === 'VEHICLE_UNAVAILABLE');

  // 清洁完成：进入待复检，仍不可借
  const tasks = service.listCleaning(1).filter((t) => t.status !== 'done');
  assert.equal(tasks.length, 1);
  service.startCleaning(tasks[0].id, '保洁-甲');
  assert.equal(service.getVehicle('ST-A1').status, 'cleaning');
  service.finishCleaning(tasks[0].id, '保洁-甲');
  assert.equal(service.getVehicle('ST-A1').status, 'pending_inspect');
  assert.throws(() => service.beginCheckout({ vehicleCode: 'ST-A1', pointId: 1, staff: 's' }),
    (e) => e.code === 'VEHICLE_UNAVAILABLE');

  // 普通员工无权安全复检
  assert.throws(
    () => service.inspect({ vehicleId: service.getVehicle('ST-A1').id, kind: 'post_clean', brakeOk: true, beltOk: true, accessoriesOk: true, inspector: '员工-乙', role: 'staff' }),
    (e) => e.code === 'FORBIDDEN_ROLE' && e.status === 403
  );
  assert.equal(service.getVehicle('ST-A1').status, 'pending_inspect');

  // 点位主管复检通过 → 恢复可借
  const res = service.inspect({ vehicleId: service.getVehicle('ST-A1').id, kind: 'post_clean', brakeOk: true, beltOk: true, accessoriesOk: true, inspector: '主管-丙', role: 'supervisor' });
  assert.equal(res.result, 'pass');
  assert.equal(service.getVehicle('ST-A1').status, 'available');
  const lock = service.beginCheckout({ vehicleCode: 'ST-A1', pointId: 1, staff: 's' });
  assert.ok(lock.lockToken);
});

test('主管复检不通过：车辆转维修并生成工单', () => {
  const { service } = makeWorld();
  rentAndReturn(service);
  const task = service.listCleaning(1).find((t) => t.status !== 'done');
  service.finishCleaning(task.id, '保洁-甲');
  const res = service.inspect({
    vehicleId: service.getVehicle('ST-A1').id, kind: 'post_clean',
    brakeOk: false, beltOk: true, accessoriesOk: true,
    inspector: '主管-丙', role: 'supervisor', note: '刹车回弹无力',
  });
  assert.equal(res.result, 'fail');
  assert.equal(service.getVehicle('ST-A1').status, 'repair');
  assert.match(service.listRepairs()[0].issue, /安全复检未通过/);
});
