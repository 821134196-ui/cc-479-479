'use strict';
// 跨点归还：归属位置改变；跨点满仓拒绝；维修中车辆不能调拨
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld } = require('./helpers');

function rent(service, vehicleCode, pointId, tourist) {
  const lock = service.beginCheckout({ vehicleCode, pointId, staff: 's' });
  const { rental } = service.confirmCheckout({
    lockToken: lock.lockToken, touristName: tourist, touristPhone: '139',
    childWeightKg: 10, period: '2h', checks: { brakeOk: true, beltOk: true, accessoriesOk: true }, staff: 's',
  });
  return rental;
}

test('跨点归还改变车辆归属位置并记录事件', () => {
  const { service } = makeWorld();
  const rental = rent(service, 'ST-A1', 1, '跨点游客');
  const ret = service.returnRental({ rentalCode: rental.code, pointId: 2, staff: 's' });
  assert.equal(ret.crossPoint, true);
  const v = service.getVehicle('ST-A1');
  assert.equal(v.point_id, 2, '车辆归属位置应变为乙服务点');
  assert.equal(v.home_point_id, 1, '登记归属不变');
  const events = service.listEvents({ vehicleId: v.id });
  assert.ok(events.some((e) => e.type === 'cross_point_return'), '应有跨点归还事件');
  // 此后只能在乙服务点借出该车
  assert.equal(v.status, 'pending_clean');
});

test('跨点满仓：目标点车位已满时拒绝归还并提示原租借点', () => {
  const { service } = makeWorld();
  // 乙服务点容量 2：ST-B1 在架 + ST-A1 跨点归还后 = 满仓
  const r1 = rent(service, 'ST-A1', 1, '游客一');
  service.returnRental({ rentalCode: r1.code, pointId: 2, staff: 's' });
  assert.equal(service.physicalCount(2), 2);

  // 再租 ST-A2 尝试还到乙 → 满仓拒绝
  const r2 = rent(service, 'ST-A2', 1, '游客二');
  assert.throws(
    () => service.returnRental({ rentalCode: r2.code, pointId: 2, staff: 's' }),
    (e) => e.code === 'CROSS_POINT_FULL' && e.status === 409
  );
  // 仍可在原租借点归还
  const ret = service.returnRental({ rentalCode: r2.code, pointId: 1, staff: 's' });
  assert.equal(ret.crossPoint, false);
});

test('维修中的车辆不能调拨', () => {
  const { service } = makeWorld();
  service.reportRepair({ vehicleId: service.getVehicle('ST-A2').id, issue: '刹车异响', staff: '员工-普通' });
  assert.equal(service.getVehicle('ST-A2').status, 'repair');
  assert.throws(
    () => service.transferVehicle({ vehicleId: service.getVehicle('ST-A2').id, toPointId: 2, staff: 's' }),
    (e) => e.code === 'REPAIR_LOCKED'
  );
  // 可借车辆正常调拨
  const moved = service.transferVehicle({ vehicleId: service.getVehicle('ST-B1').id, toPointId: 1, staff: 's' });
  assert.equal(moved.point_id, 1);
});
